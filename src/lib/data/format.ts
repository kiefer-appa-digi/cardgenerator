import type { TextTransform } from "@/lib/design/schema";

/**
 * FORMATTING — the transforms and pattern formatters behind `BindingSchema.format`.
 *
 * A binding may carry a format hint such as "0.00" or "MMM d, yyyy" (spec §10,
 * "formatting"). This module turns a raw context value plus that hint into the
 * exact characters that go on the card, and nothing else: it never reads a
 * ProductContext, never touches an element, and has no dependency on the text
 * layout engine.
 *
 * Two deliberate constraints, both about print reproducibility:
 *
 *  - No locale switching. The decimal separator is "." and the group separator
 *    is ",". A card's language is decided by the template that was approved,
 *    not by the locale of whichever machine happens to render the PDF. A
 *    template that needs "1.234,56" writes that as literal copy or gets a
 *    localised pattern feature later, on purpose.
 *  - Dates are read in UTC. The editor runs in the designer's timezone and the
 *    export worker runs in the server's; formatting off the local clock would
 *    let the same product print two different dates. UTC makes the preview and
 *    the plate agree.
 */

/* ------------------------------------------------------------------ casing */

/**
 * Case transform for a binding's resolved value.
 *
 * Kept byte-identical to `applyTransform` in lib/text/layout.ts rather than
 * imported from it: that module pulls the generated font metrics table in, and
 * resolving a binding must not drag a megabyte of glyph widths behind it.
 */
export function applyTextTransform(s: string, t: TextTransform): string {
  switch (t) {
    case "uppercase":
      return s.toUpperCase();
    case "lowercase":
      return s.toLowerCase();
    case "titlecase":
      return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
    default:
      return s;
  }
}

/* --------------------------------------------------------- format dispatch */

export type FormatKind = "none" | "number" | "date" | "unknown";

export type FormatIssue = {
  kind: "unknown-pattern" | "not-a-number" | "not-a-date";
  /** The pattern that was asked for. */
  format: string;
  /** The value as it would have printed without the pattern. */
  raw: string;
};

export type FormatOutcome = {
  text: string;
  /** False when the value printed unformatted, either by design or after a miss. */
  applied: boolean;
  issue?: FormatIssue;
};

/** Remove `'...'` literal sections so their contents cannot look like fields. */
function stripQuoted(pattern: string): string {
  return pattern.replace(/'[^']*'?/g, "");
}

/** Field letters `formatDate` understands. */
const DATE_FIELD_LETTERS = /^[yMdEHhmsa]+$/;

/**
 * Decide what a format hint means.
 *
 * A number pattern is the only one that carries a digit placeholder, so that
 * test runs first and a unit suffix like "0.00 in" still reads as a number. A
 * date pattern must then be made entirely of supported field letters: without
 * that, any word containing an "a" or an "h" would be mistaken for one and the
 * designer would be told their format is a broken date instead of nonsense.
 */
export function classifyFormat(format: string | undefined): FormatKind {
  if (format === undefined) return "none";
  const bare = stripQuoted(format);
  if (bare.trim() === "") return format.trim() === "" ? "none" : "unknown";
  if (/[0#]/.test(bare)) return "number";
  const letters = bare.replace(/[^A-Za-z]/g, "");
  if (letters !== "" && DATE_FIELD_LETTERS.test(letters)) return "date";
  return "unknown";
}

export function applyFormat(value: unknown, format: string | undefined): FormatOutcome {
  const kind = classifyFormat(format);
  const raw = stringifyScalar(value);
  if (kind === "none" || format === undefined) return { text: raw, applied: false };
  if (kind === "unknown") {
    return { text: raw, applied: false, issue: { kind: "unknown-pattern", format, raw } };
  }
  if (kind === "number") {
    const n = coerceNumber(value);
    if (n === null) return { text: raw, applied: false, issue: { kind: "not-a-number", format, raw } };
    return { text: formatNumber(n, format), applied: true };
  }
  const d = coerceDate(value);
  if (d === null) return { text: raw, applied: false, issue: { kind: "not-a-date", format, raw } };
  return { text: formatDate(d, format), applied: true };
}

/* ------------------------------------------------------------- scalar text */

/**
 * The unformatted printable form of a single value. Objects and arrays return
 * "" on purpose: the caller decides how a collection joins before it gets here,
 * and "[object Object]" must never reach a plate.
 */
export function stringifyScalar(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    // -0 prints as "0"; a minus sign in front of nothing reads as a typo.
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : formatDate(value, "yyyy-MM-dd");
  return "";
}

/* ---------------------------------------------------------------- coercion */

/** Accepts numbers and numeric strings, group separators included. */
export function coerceNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const s = value.trim().replace(/,/g, "");
    if (s === "" || !/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** ISO 8601 only. `Date.parse` of anything else is implementation-defined. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function coerceDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) {
    // A bare number under a date pattern is epoch milliseconds.
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!ISO_DATE.test(s)) return null;
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  return null;
}

/* ----------------------------------------------------------------- numbers */

export type NumberPattern = {
  prefix: string;
  suffix: string;
  minInt: number;
  minFrac: number;
  maxFrac: number;
  grouping: boolean;
  groupSize: number;
  /** 100 for a percent pattern, otherwise 1. */
  scale: number;
};

/**
 * Parse a "#,##0.00"-style pattern. `0` is a required digit, `#` an optional
 * one; everything outside the digit run is literal prefix/suffix.
 */
export function parseNumberPattern(pattern: string): NumberPattern | null {
  const first = pattern.search(/[0#]/);
  if (first < 0) return null;
  let last = first;
  for (let i = pattern.length - 1; i >= first; i--) {
    if (pattern[i] === "0" || pattern[i] === "#") {
      last = i;
      break;
    }
  }
  const core = pattern.slice(first, last + 1);
  const prefix = pattern.slice(0, first);
  const suffix = pattern.slice(last + 1);

  const dot = core.indexOf(".");
  const intPart = dot < 0 ? core : core.slice(0, dot);
  const fracPart = dot < 0 ? "" : core.slice(dot + 1).replace(/[^0#]/g, "");

  const intDigits = intPart.replace(/[^0#]/g, "");
  const minInt = (intDigits.match(/0/g) ?? []).length;
  const grouping = intPart.includes(",");
  const lastComma = intPart.lastIndexOf(",");
  const groupSize = grouping ? intPart.length - lastComma - 1 : 3;

  return {
    prefix,
    suffix,
    minInt,
    minFrac: (fracPart.match(/0/g) ?? []).length,
    maxFrac: fracPart.length,
    grouping,
    groupSize: groupSize > 0 ? groupSize : 3,
    scale: suffix.includes("%") || prefix.includes("%") ? 100 : 1,
  };
}

function groupDigits(digits: string, size: number): string {
  let out = "";
  for (let i = digits.length; i > 0; i -= size) {
    const start = Math.max(0, i - size);
    out = digits.slice(start, i) + (out === "" ? "" : "," + out);
  }
  return out;
}

export function formatNumber(value: number, pattern: string): string {
  const p = parseNumberPattern(pattern);
  if (p === null) return stringifyScalar(value);
  const scaled = value * p.scale;

  // toFixed carries JS double rounding. These are display quantities, not money
  // arithmetic, and the same double always rounds the same way, so the editor
  // preview and the exported PDF cannot disagree.
  const fixed = Math.abs(scaled).toFixed(p.maxFrac);
  const dot = fixed.indexOf(".");
  let intDigits = dot < 0 ? fixed : fixed.slice(0, dot);
  let fracDigits = dot < 0 ? "" : fixed.slice(dot + 1);

  let end = fracDigits.length;
  while (end > p.minFrac && fracDigits[end - 1] === "0") end--;
  fracDigits = fracDigits.slice(0, end);

  while (intDigits.length < p.minInt) intDigits = "0" + intDigits;
  // Unlike ICU, at least one integer digit always survives: a bare ".5" on a
  // printed card reads as a broken glyph, not as a number.
  if (intDigits === "") intDigits = "0";

  const allZero = !/[1-9]/.test(intDigits + fracDigits);
  const sign = (scaled < 0 || Object.is(scaled, -0)) && !allZero ? "-" : "";
  const body = (p.grouping ? groupDigits(intDigits, p.groupSize) : intDigits) +
    (fracDigits === "" ? "" : "." + fracDigits);
  return sign + p.prefix + body + p.suffix;
}

/* ------------------------------------------------------------------- dates */

export const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;
export const DAYS_LONG = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function dateField(d: Date, letter: string, count: number): string {
  const month = d.getUTCMonth();
  const hours = d.getUTCHours();
  switch (letter) {
    case "y": {
      const y = d.getUTCFullYear();
      return count === 2 ? pad(y % 100, 2) : pad(y, count);
    }
    case "M":
      if (count >= 4) return MONTHS_LONG[month];
      if (count === 3) return MONTHS_LONG[month].slice(0, 3);
      return pad(month + 1, count);
    case "d":
      return pad(d.getUTCDate(), count);
    case "E": {
      const name = DAYS_LONG[d.getUTCDay()];
      return count >= 4 ? name : name.slice(0, 3);
    }
    case "H":
      return pad(hours, count);
    case "h":
      return pad(((hours + 11) % 12) + 1, count);
    case "m":
      return pad(d.getUTCMinutes(), count);
    case "s":
      return pad(d.getUTCSeconds(), count);
    case "a":
      return hours < 12 ? "AM" : "PM";
    default:
      // An unsupported field letter prints as itself rather than vanishing, so
      // the designer sees the typo in the preview instead of a silent gap.
      return letter.repeat(count);
  }
}

/**
 * Format in UTC. `'` quotes literal text and `''` is a literal apostrophe.
 * Supported fields: y, M, d, E, H, h, m, s, a.
 */
export function formatDate(date: Date, pattern: string): string {
  if (Number.isNaN(date.getTime())) return "";
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "'") {
      if (pattern[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      let j = i + 1;
      while (j < pattern.length && pattern[j] !== "'") {
        out += pattern[j];
        j++;
      }
      i = j < pattern.length ? j + 1 : j;
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (j < pattern.length && pattern[j] === c) j++;
      out += dateField(date, c, j - i);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
