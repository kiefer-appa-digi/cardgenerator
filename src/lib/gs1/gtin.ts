/**
 * GTIN NORMALISATION for the GS1 adapter.
 *
 * Scope note: the barcode engine owns symbology-level validation (what a UPC-A
 * symbol is allowed to encode, quiet zones, magnification). This file answers a
 * narrower question — "is this string a well-formed GS1 identifier, and what is
 * its canonical 14-digit form?" — because the adapter must be able to reject a
 * bad GTIN without spending a network round trip, and because every registry
 * lookup keys on the 14-digit form regardless of how the local record spells it.
 */

export const GTIN_LENGTHS = [8, 12, 13, 14] as const;
export type GtinLength = (typeof GTIN_LENGTHS)[number];

export type GtinNormalizeResult =
  | { ok: true; gtin14: string; originalLength: GtinLength; input: string }
  | { ok: false; reason: "empty" | "non-digit" | "bad-length" | "bad-check-digit"; input: string };

const SEPARATOR = /[\s\-.]/;

/**
 * Strip the separators humans and spreadsheets add: spaces, hyphens, dots.
 *
 * A separator is only a separator *between* digits. A leading "-" is a sign,
 * and "-810797030124" is a spreadsheet accident — a negated cell, a bad
 * formula — not a hyphenated GTIN. Stripping it would turn plainly wrong data
 * into a valid identifier that then gets printed on a card, so an edge
 * separator is left in place for the digits-only rule to reject.
 */
function clean(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (SEPARATOR.test(trimmed[0]) || SEPARATOR.test(trimmed[trimmed.length - 1])) return trimmed;
  return trimmed.replace(/[\s\-.]/g, "");
}

/**
 * Mod-10 check digit over the leading digits of a zero-padded 14-digit GTIN.
 * Weights alternate 3,1 from the left across the 13 data digits.
 */
export function gtinCheckDigit(first13: string): number {
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    const d = first13.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

export function normalizeGtin(raw: string): GtinNormalizeResult {
  const input = raw ?? "";
  const s = clean(input);
  if (s === "") return { ok: false, reason: "empty", input };
  if (!/^[0-9]+$/.test(s)) return { ok: false, reason: "non-digit", input };
  const len = s.length;
  if (!GTIN_LENGTHS.includes(len as GtinLength)) {
    return { ok: false, reason: "bad-length", input };
  }
  const gtin14 = s.padStart(14, "0");
  if (gtinCheckDigit(gtin14.slice(0, 13)) !== gtin14.charCodeAt(13) - 48) {
    return { ok: false, reason: "bad-check-digit", input };
  }
  return { ok: true, gtin14, originalLength: len as GtinLength, input };
}

export function isValidGtin(raw: string): boolean {
  return normalizeGtin(raw).ok;
}

/** Canonical 14-digit form, or "" when the input is not a valid GTIN. */
export function toGtin14(raw: string): string {
  const r = normalizeGtin(raw);
  return r.ok ? r.gtin14 : "";
}

const GTIN_REASON_TEXT: Record<
  Exclude<GtinNormalizeResult, { ok: true }>["reason"],
  string
> = {
  empty: "No GTIN was supplied.",
  "non-digit": "A GTIN must contain digits only.",
  "bad-length": "A GTIN must be 8, 12, 13 or 14 digits.",
  "bad-check-digit": "The GTIN check digit does not match the preceding digits.",
};

export function describeGtinFailure(result: GtinNormalizeResult): string {
  return result.ok ? "" : GTIN_REASON_TEXT[result.reason];
}
