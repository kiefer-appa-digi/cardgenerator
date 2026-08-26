import type { BarcodeError } from "./types";
import { GTIN_LENGTHS, isDigits, normaliseGtin, type GtinResult } from "./gtin";

/**
 * UPC-A and EAN-13 encodation — spec §12, GS1 General Specifications §5.2.
 *
 * Both symbologies are 95 modules wide: 3 (start guard) + 42 (six left
 * characters) + 5 (centre guard) + 42 (six right characters) + 3 (end guard).
 * The only differences are which parity set each left character uses and how
 * wide the light margins are. So one pattern builder serves both and the
 * caller supplies the quiet zone widths.
 *
 * Patterns are returned as strings of "1" (bar module) and "0" (space module)
 * rather than rectangles. Rect geometry needs the X-dimension, which is a
 * layout concern; keeping encodation free of units means the tables can be
 * checked module-by-module against the published figures.
 */

/** Set A — left hand, odd parity. */
export const L_CODES: readonly string[] = [
  "0001101",
  "0011001",
  "0010011",
  "0111101",
  "0100011",
  "0110001",
  "0101111",
  "0111011",
  "0110111",
  "0001011",
];

/** Set B — left hand, even parity. Each entry is its set C entry reversed. */
export const G_CODES: readonly string[] = [
  "0100111",
  "0110011",
  "0011011",
  "0100001",
  "0011101",
  "0111001",
  "0000101",
  "0010001",
  "0001001",
  "0010111",
];

/** Set C — right hand. Each entry is the ones complement of its set A entry. */
export const R_CODES: readonly string[] = [
  "1110010",
  "1100110",
  "1101100",
  "1000010",
  "1011100",
  "1001110",
  "1010000",
  "1000100",
  "1001000",
  "1110100",
];

export const START_GUARD = "101";
export const CENTRE_GUARD = "01010";
export const END_GUARD = "101";

/**
 * EAN-13's thirteenth digit is not encoded as a character. It is carried by the
 * choice of parity set for the six LEFT characters — "O" = set A (odd), "E" =
 * set B (even). Index is the leading digit.
 */
export const EAN13_PARITY: readonly string[] = [
  "OOOOOO",
  "OOEOEE",
  "OOEEOE",
  "OOEEEO",
  "OEOOEE",
  "OEEOOE",
  "OEEEOO",
  "OEOEOE",
  "OEOEEO",
  "OEEOEO",
];

/** Total modules of the symbol proper, quiet zones excluded. */
export const EAN_UPC_MODULES = 95;

/** Guard bars descend this far below the data bars (GS1 §5.2.6.6). */
export const GUARD_EXTENSION_X = 5;

/** Bars of a normal data character, versus bars drawn to the guard depth. */
export type BarClass = "data" | "guard";

export type EanUpcSymbol = {
  /** 12 digits for UPC-A, 13 for EAN-13. */
  digits: string;
  /** 95 characters of "1"/"0", left to right, quiet zones excluded. */
  pattern: string;
  /** Per-module height class, parallel to `pattern`. */
  classes: readonly BarClass[];
};

function digitAt(digits: string, i: number): number {
  return digits.charCodeAt(i) - 48;
}

/**
 * Precondition guard for the two encoders below.
 *
 * These take a value that a `normalise*` call has already vetted, so reaching
 * here with anything else is a programming error, not a data error — and the
 * cost of not saying so is a symbol built out of `undefined`: before this
 * guard, `encodeUpcA("12345")` returned a 109-module "pattern" containing the
 * literal text "undefined" and reported it as a valid symbol. A thrown error
 * cannot be mistaken for a barcode; a corrupted pattern can.
 */
function assertGtinDigits(digits: string, length: number, symbology: string): void {
  if (digits.length !== length || !isDigits(digits)) {
    throw new RangeError(
      `${symbology} needs ${length} validated digits; received ${JSON.stringify(digits)}`,
    );
  }
}

function classesFor(guardRanges: ReadonlyArray<readonly [number, number]>): BarClass[] {
  const classes: BarClass[] = new Array<BarClass>(EAN_UPC_MODULES).fill("data");
  for (const [start, end] of guardRanges) {
    for (let i = start; i < end; i += 1) classes[i] = "guard";
  }
  return classes;
}

/**
 * UPC-A. `digits12` must already be validated: twelve digits, correct check
 * digit. The number system character (position 0) and the check character
 * (position 11) are drawn to the guard depth because their human-readable
 * digits are set OUTSIDE the symbol, in the light margins, leaving no room for
 * them beneath their own bars.
 */
export function encodeUpcA(digits12: string): EanUpcSymbol {
  assertGtinDigits(digits12, 12, "UPC-A");
  let pattern = START_GUARD;
  for (let i = 0; i < 6; i += 1) pattern += L_CODES[digitAt(digits12, i)];
  pattern += CENTRE_GUARD;
  for (let i = 6; i < 12; i += 1) pattern += R_CODES[digitAt(digits12, i)];
  pattern += END_GUARD;

  // Module offsets: start guard 0-3, first character 3-10, centre guard 45-50,
  // last character 85-92, end guard 92-95.
  const classes = classesFor([
    [0, 3],
    [3, 10],
    [45, 50],
    [85, 92],
    [92, 95],
  ]);
  return { digits: digits12, pattern, classes };
}

/**
 * EAN-13. Only the three guard patterns descend; all twelve encoded characters
 * carry a human-readable digit beneath them, and the thirteenth digit sits in
 * the left light margin.
 */
export function encodeEan13(digits13: string): EanUpcSymbol {
  assertGtinDigits(digits13, 13, "EAN-13");
  const parity = EAN13_PARITY[digitAt(digits13, 0)];
  let pattern = START_GUARD;
  for (let i = 1; i <= 6; i += 1) {
    const d = digitAt(digits13, i);
    pattern += parity[i - 1] === "O" ? L_CODES[d] : G_CODES[d];
  }
  pattern += CENTRE_GUARD;
  for (let i = 7; i < 13; i += 1) pattern += R_CODES[digitAt(digits13, i)];
  pattern += END_GUARD;

  const classes = classesFor([
    [0, 3],
    [45, 50],
    [92, 95],
  ]);
  return { digits: digits13, pattern, classes };
}

/* ----------------------------------------------------------- normalisation */

/**
 * UPC-A accepts:
 *  - 12 digits, check digit validated and never corrected;
 *  - 11 digits, treated as a body and given a computed check digit;
 *  - 13 or 14 digits whose leading digits are padding zeros, i.e. the GTIN-13 /
 *    GTIN-14 representation of a UPC that our product data happens to store.
 */
export function normaliseUpcA(raw: string): GtinResult {
  const first = normaliseGtin(raw, { accept: [12], acceptBodyOf: [12] });
  if (first.ok) return first;
  if (first.error.code !== "BAD_LENGTH") return first;

  const wide = normaliseGtin(raw, { accept: [13, 14] });
  // Only a LENGTH failure means "none of the accepted forms"; a wrong check
  // digit on a well-formed 13/14-digit value is that value's own defect and
  // must be reported as such, not relabelled as a length problem.
  if (!wide.ok) {
    return wide.error.code === "BAD_LENGTH" ? badLength(raw, "11, 12, 13 or 14") : wide;
  }
  const digits = wide.value.gtin;
  const drop = digits.length - 12;
  if (digits.slice(0, drop) !== "0".repeat(drop)) {
    return {
      ok: false,
      error: {
        code: "BAD_LENGTH",
        message: `GTIN-${digits.length} ${digits} carries significant leading digits and is not a UPC-A`,
        value: raw,
      },
    };
  }
  return {
    ok: true,
    value: {
      gtin: digits.slice(drop),
      notes: [
        ...wide.value.notes,
        `GTIN-${digits.length} reduced to its GTIN-12 (UPC-A) form`,
      ],
    },
  };
}

/**
 * EAN-13 accepts 13 digits, or 12 digits read as a GTIN-12 (a UPC-A) which is
 * then zero-padded to 13. Twelve digits are deliberately NOT read as a
 * check-digit-less EAN-13 body: that reading is indistinguishable from a
 * complete GTIN-12, and guessing between them is how wrong barcodes get
 * printed. Fourteen digits are accepted when the leading digit is padding.
 */
export function normaliseEan13(raw: string): GtinResult {
  const direct = normaliseGtin(raw, { accept: [13] });
  if (direct.ok) return direct;
  if (direct.error.code !== "BAD_LENGTH") return direct;

  const twelve = normaliseGtin(raw, { accept: [12], padTo: 13 });
  if (twelve.ok) return twelve;
  if (twelve.error.code !== "BAD_LENGTH") return twelve;

  const fourteen = normaliseGtin(raw, { accept: [14] });
  if (!fourteen.ok) {
    return fourteen.error.code === "BAD_LENGTH" ? badLength(raw, "12, 13 or 14") : fourteen;
  }
  const digits = fourteen.value.gtin;
  if (!digits.startsWith("0")) {
    return {
      ok: false,
      error: {
        code: "BAD_LENGTH",
        message: `GTIN-14 ${digits} carries an indicator digit and cannot be shown as an EAN-13`,
        value: raw,
      },
    };
  }
  return {
    ok: true,
    value: {
      gtin: digits.slice(1),
      notes: [...fourteen.value.notes, "GTIN-14 reduced to its GTIN-13 (EAN-13) form"],
    },
  };
}

function badLength(raw: string, wanted: string): GtinResult {
  const error: BarcodeError = {
    code: "BAD_LENGTH",
    message: `expected ${wanted} digits`,
    value: raw,
  };
  return { ok: false, error };
}

/** Re-exported so the importer can validate against the same length table. */
export { GTIN_LENGTHS };
