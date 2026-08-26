import type { BarcodeError } from "./types";
import {
  GTIN_LENGTHS,
  calculateCheckDigit,
  isDigits,
  padGtin,
  sanitiseDigits,
  type GtinLength,
} from "./gtin";

/**
 * Code 128 / GS1-128 — spec §12 and the GS1 parts of §13.
 *
 * Every Code 128 character is 11 modules wide and is written as six element
 * widths, bar first: "212222" means bar 2, space 1, bar 2, space 2, bar 2,
 * space 2. The stop character is the one exception at seven elements and 13
 * modules. Two properties of the table below are worth knowing because the
 * tests assert them: every character's widths total 11, and every character's
 * BAR modules total an even number. A single mistyped digit breaks one or the
 * other, so the table is verifiable without a reference scanner.
 */
export const CODE128_PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

export const SHIFT = 98;
/** Subset switch codes. "CODE C" is 99 in both A and B, and so on. */
export const CODE_A = 101;
export const CODE_B = 100;
export const CODE_C = 99;
export const FNC1 = 102;
export const START_A = 103;
export const START_B = 104;
export const START_C = 105;
export const STOP = 106;

/** GS1-128 requires a light margin of at least 10X on each side. */
export const CODE128_QUIET_X = 10;

/**
 * GS1 General Specifications X-dimension for GS1-128: 0.250 mm minimum,
 * 0.495 mm target, 1.016 mm maximum. The target is treated as 100 %.
 */
export const NOMINAL_X_CODE128_UPT = 1_403_150; // 0.495 mm
export const CODE128_MIN_MAGNIFICATION_BPS = 5_100; // X = 0.2525 mm
export const CODE128_MAX_MAGNIFICATION_BPS = 20_500; // X = 1.0147 mm
/** GS1 minimum bar height for GS1-128 in general distribution: 32 mm. */
export const NOMINAL_CODE128_BAR_HEIGHT_UPT = 90_708_661;
/** GS1-128 carries at most 48 data characters, separators excluded. */
export const GS1_128_MAX_DATA_CHARACTERS = 48;

export type Code128Token = { kind: "char"; code: number } | { kind: "fnc1" };

export type Code128Symbol = {
  /** Symbol character values: start, data, check, stop excluded from `check`. */
  values: readonly number[];
  /** The modulo-103 check character value. */
  checkValue: number;
  /** Modules of "1"/"0", quiet zones excluded. */
  pattern: string;
  /** 11 per symbol character plus 13 for the stop character. */
  modules: number;
};

type Code128Encoding =
  | { ok: true; symbol: Code128Symbol }
  | { ok: false; error: BarcodeError };

const SUBSET_A = 0;
const SUBSET_B = 1;
const SUBSET_C = 2;
const SUBSETS = [SUBSET_A, SUBSET_B, SUBSET_C] as const;
/**
 * Tie-break order. Two subsets often cost the same — "AB12CD" is six characters
 * in either A or B — and the standard's own start-character rule reaches for B
 * unless the data actually needs A's control characters. Preferring B keeps our
 * output identical to every other encoder's for ordinary printable data.
 */
const SUBSET_PREFERENCE = [SUBSET_B, SUBSET_C, SUBSET_A] as const;
const START_FOR: readonly number[] = [START_A, START_B, START_C];
const SWITCH_TO: readonly number[] = [CODE_A, CODE_B, CODE_C];

/** Larger than any achievable cost; used instead of Infinity to stay integral. */
const UNREACHABLE = 1_000_000_000;

type ConsumeStep = { values: number[]; next: number };

function isDigitToken(t: Code128Token | undefined): boolean {
  return t !== undefined && t.kind === "char" && t.code >= 48 && t.code <= 57;
}

/**
 * Choose the subset sequence that needs the fewest symbol characters.
 *
 * The published heuristic ("switch to C when four or more digits follow, …") is
 * a set of special cases that is easy to get subtly wrong at the ends of a
 * string. A three-state shortest-path over the token list is the same size of
 * code, is provably optimal, and needs no special cases: `consume[i][s]` is the
 * cost of encoding token i onwards when the encoder is already in subset s and
 * must consume something, and `cost[i][s]` allows one subset switch first.
 * Switching twice in a row is never useful because every subset is one switch
 * away from every other, so one switch of lookahead is enough.
 */
function encodeTokens(tokens: readonly Code128Token[], raw: string): Code128Encoding {
  const n = tokens.length;
  if (n === 0) {
    return { ok: false, error: { code: "EMPTY", message: "nothing to encode", value: raw } };
  }

  const cost: number[][] = [];
  const consume: number[][] = [];
  const step: Array<Array<ConsumeStep | null>> = [];
  for (let i = 0; i <= n; i += 1) {
    cost.push([UNREACHABLE, UNREACHABLE, UNREACHABLE]);
    consume.push([UNREACHABLE, UNREACHABLE, UNREACHABLE]);
    step.push([null, null, null]);
  }
  cost[n] = [0, 0, 0];
  consume[n] = [0, 0, 0];

  for (let i = n - 1; i >= 0; i -= 1) {
    const t = tokens[i];

    const record = (subset: number, values: number[], next: number): void => {
      const tail = cost[next][subset];
      if (tail >= UNREACHABLE) return;
      const total = values.length + tail;
      if (total < consume[i][subset]) {
        consume[i][subset] = total;
        step[i][subset] = { values, next };
      }
    };

    if (t.kind === "fnc1") {
      // FNC1 is value 102 in all three subsets and does not disturb C pairing.
      record(SUBSET_A, [FNC1], i + 1);
      record(SUBSET_B, [FNC1], i + 1);
      record(SUBSET_C, [FNC1], i + 1);
    } else {
      const c = t.code;
      if (c >= 0 && c <= 95) {
        record(SUBSET_A, [c < 32 ? c + 64 : c - 32], i + 1);
      } else if (c >= 96 && c <= 127) {
        // Code A cannot hold lower case; SHIFT borrows one character from B.
        record(SUBSET_A, [SHIFT, c - 32], i + 1);
      }
      if (c >= 32 && c <= 127) {
        record(SUBSET_B, [c - 32], i + 1);
      } else if (c >= 0 && c < 32) {
        record(SUBSET_B, [SHIFT, c + 64], i + 1);
      }
      if (isDigitToken(t) && isDigitToken(tokens[i + 1])) {
        const next = tokens[i + 1];
        if (next.kind === "char") {
          record(SUBSET_C, [(c - 48) * 10 + (next.code - 48)], i + 2);
        }
      }
    }

    for (const s of SUBSETS) {
      let best = consume[i][s];
      for (const other of SUBSETS) {
        if (other === s) continue;
        if (consume[i][other] >= UNREACHABLE) continue;
        best = Math.min(best, 1 + consume[i][other]);
      }
      cost[i][s] = best;
    }
  }

  let startSubset = -1;
  let bestTotal = UNREACHABLE;
  for (const s of SUBSET_PREFERENCE) {
    if (cost[0][s] >= UNREACHABLE) continue;
    if (cost[0][s] < bestTotal) {
      bestTotal = cost[0][s];
      startSubset = s;
    }
  }
  if (startSubset < 0) {
    return {
      ok: false,
      error: {
        code: "BAD_CHARSET",
        message: "value contains characters outside the Code 128 character set (ASCII 0-127)",
        value: raw,
      },
    };
  }

  let subset = startSubset;
  const values: number[] = [START_FOR[subset]];
  let i = 0;
  while (i < n) {
    if (cost[i][subset] < consume[i][subset]) {
      let target = -1;
      for (const other of SUBSET_PREFERENCE) {
        if (other === subset) continue;
        if (consume[i][other] < UNREACHABLE && 1 + consume[i][other] === cost[i][subset]) {
          target = other;
          break;
        }
      }
      /* istanbul ignore next — cost[] is built from consume[], so a switch that
         the cost table promises always exists in the consume table. */
      if (target < 0) {
        return {
          ok: false,
          error: { code: "UNSUPPORTED", message: "no viable subset", value: raw },
        };
      }
      values.push(SWITCH_TO[target]);
      subset = target;
    }
    const chosen = step[i][subset];
    if (chosen === null) {
      return {
        ok: false,
        error: { code: "UNSUPPORTED", message: "no viable subset", value: raw },
      };
    }
    values.push(...chosen.values);
    i = chosen.next;
  }

  const checkValue = code128CheckValue(values);
  const all = [...values, checkValue, STOP];
  let widths = "";
  for (const v of all) widths += CODE128_PATTERNS[v];

  return {
    ok: true,
    symbol: {
      values,
      checkValue,
      pattern: widthsToModules(widths),
      modules: 11 * (values.length + 1) + 13,
    },
  };
}

/**
 * Modulo-103 check character. The start character is weighted 1 and each
 * following symbol character by its 1-based position.
 */
export function code128CheckValue(values: readonly number[]): number {
  let sum = values[0];
  for (let k = 1; k < values.length; k += 1) sum += k * values[k];
  return sum % 103;
}

/** Widths are bar/space alternating, bar first. Every character starts on a bar. */
export function widthsToModules(widths: string): string {
  let out = "";
  for (let i = 0; i < widths.length; i += 1) {
    const w = widths.charCodeAt(i) - 48;
    out += (i % 2 === 0 ? "1" : "0").repeat(w);
  }
  return out;
}

/** Plain Code 128 with no FNC1. Used for the published test vectors. */
export function encodeCode128Text(text: string): Code128Encoding {
  if (text.length === 0) {
    return { ok: false, error: { code: "EMPTY", message: "nothing to encode", value: text } };
  }
  const tokens: Code128Token[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 127) {
      return {
        ok: false,
        error: {
          code: "BAD_CHARSET",
          message: `character "${text[i]}" is outside the Code 128 character set`,
          value: text,
        },
      };
    }
    tokens.push({ kind: "char", code });
  }
  return encodeTokens(tokens, text);
}

/* ------------------------------------------------------------ GS1 elements */

export type AiElement = { ai: string; value: string };

/**
 * GS1 AI encodable character set 82 (General Specifications figure 7.11-1):
 * the 82 characters an AI data field may hold. It is NOT "printable ASCII" —
 * it excludes space, #, $, @, [, \, ], ^, `, {, |, } and ~. Encoding one of
 * those produces a symbol that scans but that a GS1 verifier rejects, so an AI
 * value carrying one is reported rather than encoded.
 */
const CSET_82 = /^[!"%&'()*+,\-./0-9:;<=>?A-Z_a-z]+$/;

/**
 * GS1 Application Identifiers of defined length (General Specifications figure
 * "GS1 Application Identifiers of defined length"), keyed by the first two
 * digits of the AI. The number is the total element length, AI included, so
 * "01" -> 16 is AI(2) + GTIN-14(14). Everything not listed here is variable
 * length and must be closed with an FNC1 separator unless it is last.
 */
const PREDEFINED_ELEMENT_LENGTH: Readonly<Record<string, number>> = {
  "00": 20,
  "01": 16,
  "02": 16,
  "03": 16,
  "04": 18,
  "11": 8,
  "12": 8,
  "13": 8,
  "14": 8,
  "15": 8,
  "16": 8,
  "17": 8,
  "18": 8,
  "19": 8,
  "20": 4,
  "31": 10,
  "32": 10,
  "33": 10,
  "34": 10,
  "35": 10,
  "36": 10,
  "41": 16,
};

function predefinedLength(ai: string): number | undefined {
  return PREDEFINED_ELEMENT_LENGTH[ai.slice(0, 2)];
}

export type AiParse =
  | { ok: true; elements: AiElement[]; notes: string[] }
  | { ok: false; error: BarcodeError };

/**
 * Parse the bracketed form the operator types, e.g.
 * "(01)00810797030124(17)261231(10)LOT42". A bare 12/13/14-digit GTIN is also
 * accepted and read as AI 01, because that is what nine out of ten users paste.
 */
export function parseAiString(raw: string): AiParse {
  const input = raw.trim();
  if (input.length === 0) {
    return { ok: false, error: { code: "EMPTY", message: "no barcode value supplied", value: raw } };
  }

  const notes: string[] = [];

  if (!input.includes("(")) {
    const digits = sanitiseDigits(input);
    if (!isDigits(digits)) {
      return {
        ok: false,
        error: {
          code: "BAD_CHARSET",
          message: "a value without Application Identifiers must be a bare GTIN",
          value: raw,
        },
      };
    }
    if (digits.length !== 12 && digits.length !== 13 && digits.length !== 14) {
      return {
        ok: false,
        error: {
          code: "BAD_LENGTH",
          message: `expected 12, 13 or 14 digits for a bare GTIN, received ${digits.length}`,
          value: raw,
        },
      };
    }
    notes.push("value read as AI (01) GTIN");
    return { ok: true, elements: [{ ai: "01", value: digits }], notes };
  }

  const elements: AiElement[] = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] !== "(") {
      return {
        ok: false,
        error: {
          code: "BAD_CHARSET",
          message: `expected "(" at position ${i}; Application Identifiers must be bracketed`,
          value: raw,
        },
      };
    }
    const close = input.indexOf(")", i);
    if (close < 0) {
      return {
        ok: false,
        error: { code: "BAD_CHARSET", message: 'unclosed "(" in the AI string', value: raw },
      };
    }
    const ai = input.slice(i + 1, close);
    if (ai.length < 2 || ai.length > 4 || !isDigits(ai)) {
      return {
        ok: false,
        error: {
          code: "BAD_CHARSET",
          message: `"(${ai})" is not an Application Identifier; expected 2 to 4 digits`,
          value: raw,
        },
      };
    }
    let end = input.indexOf("(", close + 1);
    if (end < 0) end = input.length;
    const value = input.slice(close + 1, end);
    if (value.length === 0) {
      return {
        ok: false,
        error: { code: "EMPTY", message: `AI (${ai}) has no data`, value: raw },
      };
    }
    elements.push({ ai, value });
    i = end;
  }

  return { ok: true, elements, notes };
}

export type Gs1_128Symbol = Code128Symbol & {
  /** Bracketed human-readable form, after AI normalisation. */
  humanReadable: string;
  elements: readonly AiElement[];
  notes: string[];
};

export type Gs1_128Result =
  | { ok: true; symbol: Gs1_128Symbol }
  | { ok: false; error: BarcodeError };

/**
 * GS1-128. FNC1 always occupies the first position after the start character —
 * that is what tells a decoder the data is a GS1 element string rather than
 * free Code 128 text. Variable-length elements are closed with a further FNC1
 * unless they are last in the string.
 */
export function encodeGs1_128(raw: string): Gs1_128Result {
  const parsed = parseAiString(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const notes = [...parsed.notes];
  const elements: AiElement[] = [];

  for (const el of parsed.elements) {
    let value = el.value;

    if (el.ai === "01" || el.ai === "02") {
      const digits = sanitiseDigits(value);
      if (!isDigits(digits)) {
        return {
          ok: false,
          error: {
            code: "BAD_CHARSET",
            message: `AI (${el.ai}) must be digits only`,
            value: raw,
          },
        };
      }
      // 8, 12, 13 and 14 are the only lengths the GS1 General Specifications
      // define for a GTIN. Accepting 9, 10 or 11 and zero-padding to 14 would
      // manufacture an identifier that names no product.
      if (!GTIN_LENGTHS.includes(digits.length as GtinLength)) {
        return {
          ok: false,
          error: {
            code: "BAD_LENGTH",
            message: `AI (${el.ai}) expects a GTIN of 8, 12, 13 or 14 digits, received ${digits.length}`,
            value: raw,
          },
        };
      }
      const expected = calculateCheckDigit(digits.slice(0, -1));
      if (expected !== digits.charCodeAt(digits.length - 1) - 48) {
        return {
          ok: false,
          error: {
            code: "BAD_CHECK_DIGIT",
            message: `check digit ${digits.slice(-1)} is wrong; ${expected} is correct for body ${digits.slice(0, -1)}`,
            value: raw,
          },
        };
      }
      if (digits.length < 14) notes.push(`GTIN-${digits.length} zero-padded to GTIN-14 for AI (${el.ai})`);
      value = padGtin(digits, 14);
    }

    if (!CSET_82.test(value)) {
      const offender = value
        .split("")
        .find((ch) => !CSET_82.test(ch));
      return {
        ok: false,
        error: {
          code: "BAD_CHARSET",
          message:
            `AI (${el.ai}) contains ${JSON.stringify(offender ?? value)}, which is outside ` +
            "GS1 encodable character set 82",
          value: raw,
        },
      };
    }

    const fixed = predefinedLength(el.ai);
    if (fixed !== undefined && el.ai.length + value.length !== fixed) {
      return {
        ok: false,
        error: {
          code: "BAD_LENGTH",
          message: `AI (${el.ai}) has a defined length of ${fixed - el.ai.length} data characters, received ${value.length}`,
          value: raw,
        },
      };
    }

    elements.push({ ai: el.ai, value });
  }

  const dataCharacters = elements.reduce((n, el) => n + el.ai.length + el.value.length, 0);
  if (dataCharacters > GS1_128_MAX_DATA_CHARACTERS) {
    return {
      ok: false,
      error: {
        code: "TOO_LONG",
        message: `GS1-128 carries at most ${GS1_128_MAX_DATA_CHARACTERS} data characters, received ${dataCharacters}`,
        value: raw,
      },
    };
  }

  const tokens: Code128Token[] = [{ kind: "fnc1" }];
  elements.forEach((el, index) => {
    for (const ch of el.ai) tokens.push({ kind: "char", code: ch.charCodeAt(0) });
    for (const ch of el.value) tokens.push({ kind: "char", code: ch.charCodeAt(0) });
    const isLast = index === elements.length - 1;
    if (!isLast && predefinedLength(el.ai) === undefined) {
      tokens.push({ kind: "fnc1" });
    }
  });

  const encoded = encodeTokens(tokens, raw);
  if (!encoded.ok) return encoded;

  const humanReadable = elements.map((el) => `(${el.ai})${el.value}`).join("");
  return { ok: true, symbol: { ...encoded.symbol, humanReadable, elements, notes } };
}
