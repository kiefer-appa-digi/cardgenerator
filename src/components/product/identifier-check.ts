import {
  calculateCheckDigit,
  hasValidCheckDigit,
  isDigits,
  normaliseGtin14,
  sanitiseDigits,
  type GtinLength,
} from "@/lib/barcode/gtin";
import { normaliseUpcA } from "@/lib/barcode/upc";

/**
 * Check-digit state for a stored product identifier.
 *
 * The `valid` column on product_identifiers records what the importer decided at
 * the time the row was written. That is provenance, not truth: a value edited
 * afterwards, or imported before a rule changed, would still carry the old
 * verdict. So the detail page recomputes the check digit here, from the value as
 * it stands now, and shows both — agreement is the normal case and a
 * disagreement is exactly the kind of thing an operator needs to see before
 * 50,000 cards carry the number.
 */

export type CheckDigitState =
  /** The identifier has no check digit defined for it (SKU, company prefix). */
  | { state: "not-applicable"; note: string }
  /** Digits and length are right, and the last digit is the correct one. */
  | { state: "valid"; found: string; expected: string; note: string }
  /** Digits and length are right, and the last digit is wrong. */
  | { state: "invalid"; found: string; expected: string; note: string }
  /** Nothing can be computed: empty, non-numeric, or the wrong length. */
  | { state: "unusable"; note: string };

/** Complete GTIN lengths, by the identifier kind the importer writes. */
const GTIN_KIND_LENGTHS: Record<string, GtinLength> = {
  gtin8: 8,
  gtin12: 12,
  gtin13: 13,
  gtin14: 14,
};

export const IDENTIFIER_LABELS: Record<string, string> = {
  gtin14: "GTIN-14",
  gtin13: "GTIN-13 (EAN)",
  gtin12: "UPC (GTIN-12)",
  gtin8: "GTIN-8",
  sku: "SKU",
  gs1CompanyPrefix: "GS1 company prefix",
};

/** Order the identifier table is read in: widest GTIN first, then the rest. */
const KIND_ORDER = ["gtin14", "gtin13", "gtin12", "gtin8", "sku", "gs1CompanyPrefix"];

export function identifierOrder(kind: string): number {
  const i = KIND_ORDER.indexOf(kind);
  return i === -1 ? KIND_ORDER.length : i;
}

export function checkIdentifier(kind: string, rawValue: string): CheckDigitState {
  const expectedLength = GTIN_KIND_LENGTHS[kind];
  if (expectedLength === undefined) {
    return {
      state: "not-applicable",
      note: "No check digit is defined for this identifier.",
    };
  }

  const trimmed = rawValue.trim();
  const digits = sanitiseDigits(trimmed);
  if (digits.length === 0) {
    return { state: "unusable", note: "No value is recorded." };
  }
  if (!isDigits(digits)) {
    return {
      state: "unusable",
      note: "Holds something other than digits, so no check digit can be computed.",
    };
  }
  if (digits.length !== expectedLength) {
    return {
      state: "unusable",
      note: `A GTIN-${expectedLength} is ${expectedLength} digits; this value has ${digits.length}.`,
    };
  }

  const body = digits.slice(0, -1);
  const found = digits.slice(-1);
  const expected = String(calculateCheckDigit(body));
  const separators = digits === trimmed ? "" : ` Separators were ignored in "${trimmed}".`;

  if (hasValidCheckDigit(digits)) {
    return {
      state: "valid",
      found,
      expected,
      note: `Check digit ${found} agrees with the GS1 modulo-10 sum over ${body}.${separators}`,
    };
  }
  return {
    state: "invalid",
    found,
    expected,
    note: `Check digit ${found} is wrong; ${expected} is correct for body ${body}.${separators}`,
  };
}

/**
 * The GTIN-14 a card would actually encode, derived from whatever GTIN the
 * product holds. Returns null when no held value normalises, which is the
 * honest answer rather than a zero-padded guess.
 *
 * A GTIN-14 is what an ITF-14 or a GS1 Digital Link QR carries. It is NOT what
 * the retail symbol on the front of the card carries — see `canonicalUpcA`.
 */
export function canonicalGtin14(values: string[]): string | null {
  for (const v of values) {
    if (!v.trim()) continue;
    const res = normaliseGtin14(v);
    if (res.ok) return res.value.gtin;
  }
  return null;
}

/**
 * The UPC-A the front of the card would encode, or null when none of the held
 * identifiers is one.
 *
 * Kept separate from `canonicalGtin14` because the two answers diverge, and the
 * difference is the whole point: a variable-measure GTIN-14 such as
 * 90810797030462 resolves perfectly well as a GTIN-14 and cannot be a UPC-A at
 * all, because its leading digits are an indicator, not padding. Reporting only
 * the GTIN-14 would tell an operator a barcode is available for a card whose
 * UPC-A element preflight is about to reject. This routine applies exactly the
 * rule preflight applies (lib/barcode/upc.ts), so the two cannot disagree.
 */
export function canonicalUpcA(values: string[]): string | null {
  for (const v of values) {
    if (!v.trim()) continue;
    const res = normaliseUpcA(v);
    if (res.ok) return res.value.gtin;
  }
  return null;
}
