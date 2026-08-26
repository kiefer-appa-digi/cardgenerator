import { normalizeGtin } from "./gtin";

/**
 * GS1 DIGITAL LINK — URI construction and parsing (spec §13 "future support",
 * §12 `gs1-digital-link` symbology).
 *
 * This is the half of Digital Link that is fully implementable today and is not
 * a stub: turning identifiers into the canonical URI a QR code encodes, and
 * reading one back. It performs no I/O.
 *
 * The half that is deliberately absent is *resolution* — asking a resolver what
 * links exist for a GTIN. That is an adapter concern, exposed as the optional
 * `Gs1Adapter.resolveDigitalLink` method guarded by
 * `Gs1Capabilities.digitalLinkResolution`, so it can be added by writing a
 * provider rather than by changing this contract.
 */

/** Primary identifier plus the qualifiers permitted to follow it in the path. */
export const AI_GTIN = "01";
export const AI_CPV = "22";
export const AI_BATCH_LOT = "10";
export const AI_SERIAL = "21";

/**
 * Path-position qualifiers, in the order GS1 requires. A serial may only follow
 * a lot, which may only follow a CPV; anything out of order is not a Digital
 * Link, so the builder emits them in this fixed sequence.
 */
const PATH_QUALIFIER_ORDER = [AI_CPV, AI_BATCH_LOT, AI_SERIAL] as const;

/** Convenience aliases GS1 allows in place of the numeric AI. Both are parsed. */
const ALIAS_TO_AI: Record<string, string> = {
  gtin: AI_GTIN,
  cpv: AI_CPV,
  lot: AI_BATCH_LOT,
  ser: AI_SERIAL,
};

export type DigitalLinkQualifiers = {
  /** AI 22 — consumer product variant. */
  cpv?: string;
  /** AI 10 — batch or lot. */
  lot?: string;
  /** AI 21 — serial number. */
  serial?: string;
};

export type BuildDigitalLinkInput = {
  gtin: string;
  /** Resolver origin, e.g. "https://id.gs1.org". A trailing slash is tolerated. */
  domain?: string;
  qualifiers?: DigitalLinkQualifiers;
  /**
   * Data attributes appended as query parameters, keyed by AI, e.g.
   * `{ "17": "271231" }` for an expiry date.
   */
  dataAttributes?: Record<string, string>;
};

export type BuildDigitalLinkResult =
  | { ok: true; uri: string; gtin14: string }
  | { ok: false; reason: "invalid-gtin" | "invalid-domain" | "invalid-qualifier"; detail: string };

export const DEFAULT_RESOLVER_DOMAIN = "https://id.gs1.org";

/**
 * GS1 restricts AI values to CSET 82 — the 82 printable characters
 * `!"%&\'()*+,-./0-9:;<=>?A-Z_a-z`. Length is checked separately because it is
 * per-AI: the path qualifiers (AI 10 batch/lot, 21 serial, 22 CPV) are each
 * capped at 20 characters by the General Specifications, and emitting a longer
 * one produces a URI no conformant resolver will accept.
 */
const CSET_82 = /^[\x21-\x22\x25-\x2F\x30-\x39\x3A-\x3F\x41-\x5A\x5F\x61-\x7A]+$/;

/** GS1 General Specifications field lengths, by AI. */
const MAX_VALUE_LENGTH: Record<string, number> = {
  [AI_CPV]: 20,
  [AI_BATCH_LOT]: 20,
  [AI_SERIAL]: 20,
};
const DEFAULT_MAX_VALUE_LENGTH = 48;

function isSafeValue(ai: string, value: string): boolean {
  const max = MAX_VALUE_LENGTH[ai] ?? DEFAULT_MAX_VALUE_LENGTH;
  return value.length >= 1 && value.length <= max && CSET_82.test(value);
}

export function buildDigitalLinkUri(input: BuildDigitalLinkInput): BuildDigitalLinkResult {
  const gtin = normalizeGtin(input.gtin);
  if (!gtin.ok) {
    return { ok: false, reason: "invalid-gtin", detail: `Not a valid GTIN: ${gtin.reason}.` };
  }

  const rawDomain = (input.domain ?? DEFAULT_RESOLVER_DOMAIN).trim().replace(/\/+$/, "");
  let origin: URL;
  try {
    origin = new URL(rawDomain);
  } catch {
    return { ok: false, reason: "invalid-domain", detail: "Resolver domain is not a URL." };
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") {
    return { ok: false, reason: "invalid-domain", detail: "Resolver domain must be http or https." };
  }

  const q = input.qualifiers ?? {};
  const byAi: Record<string, string | undefined> = {
    [AI_CPV]: q.cpv,
    [AI_BATCH_LOT]: q.lot,
    [AI_SERIAL]: q.serial,
  };

  // Base path of the resolver is preserved: deployments often mount a resolver
  // under a prefix, and dropping it would produce a URI that resolves nowhere.
  const basePath = origin.pathname === "/" ? "" : origin.pathname.replace(/\/+$/, "");
  const segments = [`${AI_GTIN}/${gtin.gtin14}`];
  for (const ai of PATH_QUALIFIER_ORDER) {
    const value = byAi[ai];
    if (value === undefined || value === "") continue;
    if (!isSafeValue(ai, value)) {
      return {
        ok: false,
        reason: "invalid-qualifier",
        detail: `AI ${ai} value is not URI-safe or exceeds ${MAX_VALUE_LENGTH[ai] ?? DEFAULT_MAX_VALUE_LENGTH} characters.`,
      };
    }
    segments.push(`${ai}/${encodeURIComponent(value)}`);
  }

  const uri = new URL(`${origin.origin}${basePath}/${segments.join("/")}`);
  for (const [ai, value] of Object.entries(input.dataAttributes ?? {})) {
    if (value === "") continue;
    if (!/^[0-9]{2,4}$/.test(ai) || !isSafeValue(ai, value)) {
      return { ok: false, reason: "invalid-qualifier", detail: `AI ${ai} attribute is not valid.` };
    }
    uri.searchParams.set(ai, value);
  }

  return { ok: true, uri: uri.toString(), gtin14: gtin.gtin14 };
}

export type ParsedDigitalLink = {
  gtin14: string;
  /** Every AI found, path qualifiers and query attributes together. */
  qualifiers: Record<string, string>;
  domain: string;
};

export type ParseDigitalLinkResult =
  | { ok: true; value: ParsedDigitalLink }
  | { ok: false; reason: "not-a-url" | "no-gtin" | "invalid-gtin" | "malformed-encoding" };

/**
 * `decodeURIComponent` throws a URIError on a truncated or invalid escape such
 * as `%E0%A4%A`. A parser that reports every other malformed input as a value
 * must not throw on that one, or a scanned QR code with a damaged tail takes
 * down the caller instead of being rejected.
 */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Read a Digital Link URI back into identifiers. Accepts numeric AIs and the
 * GS1 short aliases, and tolerates a resolver path prefix before the `/01/`
 * segment, which is how most self-hosted resolvers are deployed.
 */
export function parseDigitalLinkUri(raw: string): ParseDigitalLinkResult {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "not-a-url" };
  }

  const parts = url.pathname.split("/").filter((p) => p !== "");
  const qualifiers: Record<string, string> = {};
  let gtinRaw = "";

  for (let i = 0; i + 1 < parts.length; i += 1) {
    const keyRaw = parts[i].toLowerCase();
    const ai = ALIAS_TO_AI[keyRaw] ?? (/^[0-9]{2,4}$/.test(keyRaw) ? keyRaw : "");
    if (ai === "") continue;
    const value = decodeSegment(parts[i + 1]);
    if (value === null) return { ok: false, reason: "malformed-encoding" };
    if (ai === AI_GTIN) gtinRaw = value;
    else qualifiers[ai] = value;
    i += 1; // consume the value segment
  }

  if (gtinRaw === "") return { ok: false, reason: "no-gtin" };
  const gtin = normalizeGtin(gtinRaw);
  if (!gtin.ok) return { ok: false, reason: "invalid-gtin" };

  for (const [name, value] of url.searchParams) {
    if (/^[0-9]{2,4}$/.test(name)) qualifiers[name] = value;
  }

  return {
    ok: true,
    value: { gtin14: gtin.gtin14, qualifiers, domain: url.origin },
  };
}
