import type { BarcodeError } from "./types";

/**
 * GTIN — spec §12 (check digits) and §13 (GS1 Digital Link).
 *
 * The one rule that matters here: we never silently "fix" an identifier. A GTIN
 * that arrives with a wrong check digit is a data defect somewhere upstream —
 * in the spreadsheet, in the ERP export, in a typed-in field — and printing a
 * corrected value would hide the defect on 50,000 cards. The only correction
 * this module performs is APPENDING a check digit to a body that never had one,
 * which is a legitimate input form, and it says so in a note when it does.
 */

const DIGITS_RE = /^[0-9]+$/;

/** Lengths the GS1 General Specifications define for a GTIN. */
export const GTIN_LENGTHS = [8, 12, 13, 14] as const;
export type GtinLength = (typeof GTIN_LENGTHS)[number];

export function isDigits(s: string): boolean {
  return s.length > 0 && DIGITS_RE.test(s);
}

/**
 * Strip the separators humans and spreadsheets insert. Nothing else is removed,
 * so a value carrying a letter still fails `isDigits` and is reported rather
 * than quietly truncated.
 */
export function sanitiseDigits(raw: string): string {
  return raw.replace(/[\s _.\-]/g, "");
}

/**
 * GS1 modulo-10 check digit for a body that EXCLUDES the check digit.
 * Weights alternate 3, 1 starting from the RIGHTMOST body digit, which is what
 * makes the same routine work for GTIN-8/12/13/14 and SSCC alike.
 * Caller must have validated that `body` is all digits.
 */
export function calculateCheckDigit(body: string): number {
  let sum = 0;
  let weight = 3;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    sum += (body.charCodeAt(i) - 48) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10;
}

/** The body plus its computed check digit. Used by the spreadsheet importer. */
export function appendCheckDigit(body: string): string {
  return body + String(calculateCheckDigit(body));
}

/** True when the last digit of `full` is the correct check digit for the rest. */
export function hasValidCheckDigit(full: string): boolean {
  if (full.length < 2 || !isDigits(full)) return false;
  const expected = calculateCheckDigit(full.slice(0, -1));
  return expected === full.charCodeAt(full.length - 1) - 48;
}

/** Left-pad with zeros. GTIN-12 09312345678907 style widening is lossless. */
export function padGtin(gtin: string, to: GtinLength): string {
  return gtin.length >= to ? gtin : "0".repeat(to - gtin.length) + gtin;
}

/**
 * Narrow a GTIN by removing leading zeros, but only down to a length the
 * standard defines and only when the zeros really are padding. Returns null
 * when the value does not fit — callers must not truncate significant digits.
 */
export function narrowGtin(gtin: string, to: GtinLength): string | null {
  if (gtin.length === to) return gtin;
  if (gtin.length < to) return null;
  const drop = gtin.length - to;
  if (gtin.slice(0, drop) !== "0".repeat(drop)) return null;
  return gtin.slice(drop);
}

export function toGtin14(gtin: string): string {
  return padGtin(gtin, 14);
}

export type GtinNormalisation = {
  gtin: string;
  notes: string[];
};

export type GtinResult =
  | { ok: true; value: GtinNormalisation }
  | { ok: false; error: BarcodeError };

function err(code: BarcodeError["code"], message: string, value: string): GtinResult {
  return { ok: false, error: { code, message, value } };
}

export type NormaliseOptions = {
  /** Lengths accepted as a complete GTIN (check digit included). */
  accept: readonly GtinLength[];
  /**
   * Lengths accepted as a BODY, i.e. one digit short of a complete GTIN, in
   * which case the check digit is computed and appended. Passing an 11-digit
   * UPC body is a legitimate input form; passing a 12-digit one is not, because
   * 12 digits are indistinguishable from a complete GTIN-12.
   */
  acceptBodyOf?: readonly GtinLength[];
  /** Zero-pad the accepted value out to this length. */
  padTo?: GtinLength;
};

/**
 * Shared front door for every symbology. Order matters: charset first (so a
 * letter is reported as a charset problem, not a length one), then length, then
 * the check digit.
 */
export function normaliseGtin(raw: string, opts: NormaliseOptions): GtinResult {
  const original = raw;
  const digits = sanitiseDigits(raw.trim());
  if (digits.length === 0) {
    return err("EMPTY", "no barcode value supplied", original);
  }
  if (!isDigits(digits)) {
    return err("BAD_CHARSET", "a GTIN may contain digits only", original);
  }

  const notes: string[] = [];
  const bodyLengths = opts.acceptBodyOf ?? [];
  let complete: string;

  if (opts.accept.includes(digits.length as GtinLength)) {
    complete = digits;
    if (!hasValidCheckDigit(complete)) {
      return err(
        "BAD_CHECK_DIGIT",
        `check digit ${complete.slice(-1)} is wrong; ${calculateCheckDigit(
          complete.slice(0, -1),
        )} is correct for body ${complete.slice(0, -1)}`,
        original,
      );
    }
  } else if (bodyLengths.some((l) => l - 1 === digits.length)) {
    complete = appendCheckDigit(digits);
    notes.push(
      `check digit ${complete.slice(-1)} computed and appended to the ${digits.length}-digit body`,
    );
  } else {
    const wanted = [...opts.accept, ...bodyLengths.map((l) => l - 1)]
      .sort((a, b) => a - b)
      .join(" or ");
    return err(
      "BAD_LENGTH",
      `expected ${wanted} digits, received ${digits.length}`,
      original,
    );
  }

  if (opts.padTo !== undefined && complete.length < opts.padTo) {
    const padded = padGtin(complete, opts.padTo);
    notes.push(`GTIN-${complete.length} zero-padded to GTIN-${opts.padTo}`);
    complete = padded;
  }

  return { ok: true, value: { gtin: complete, notes } };
}

/** Normalise anything the data set might hold into the canonical GTIN-14. */
export function normaliseGtin14(raw: string): GtinResult {
  return normaliseGtin(raw, { accept: GTIN_LENGTHS, padTo: 14 });
}

/* ------------------------------------------------------- GS1 Digital Link */

export const DEFAULT_DIGITAL_LINK_DOMAIN = "https://id.gs1.org";

export type DigitalLinkOptions = {
  /** Resolver origin. Bare hosts are promoted to https, trailing "/" trimmed. */
  domain?: string;
  /** AI 10 — batch/lot, a path key qualifier. */
  lot?: string;
  /** AI 21 — serial, a path key qualifier. */
  serial?: string;
  /** AI 17 — expiry YYMMDD. A data attribute, so it rides in the query string. */
  expiry?: string;
};

/** Normalise a configured domain into an origin with no trailing slash. */
export function normaliseDigitalLinkDomain(domain: string): string {
  const trimmed = domain.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return DEFAULT_DIGITAL_LINK_DOMAIN;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Canonical GS1 Digital Link URI: `<domain>/01/<gtin14>` with the key
 * qualifiers in the order the standard fixes (10 before 21), and data
 * attributes as query parameters. `gtin` must already be a valid GTIN-14.
 */
export function digitalLinkUri(gtin: string, opts: DigitalLinkOptions = {}): string {
  const domain = normaliseDigitalLinkDomain(opts.domain ?? DEFAULT_DIGITAL_LINK_DOMAIN);
  let uri = `${domain}/01/${gtin}`;
  if (opts.lot) uri += `/10/${encodeURIComponent(opts.lot)}`;
  if (opts.serial) uri += `/21/${encodeURIComponent(opts.serial)}`;
  if (opts.expiry) uri += `?17=${encodeURIComponent(opts.expiry)}`;
  return uri;
}
