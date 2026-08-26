/**
 * UNITS — the physical source of truth for the whole application.
 *
 * Every geometric quantity in this system is stored as an INTEGER number of
 * micro-points (µpt).
 *
 *   1 PDF point (pt) = 1_000_000 µpt
 *   1 inch          =        72 pt = 72_000_000 µpt
 *   1 millimetre    = 72/25.4 pt  ≈  2_834_645.669 µpt  (rounded on conversion)
 *
 * Why micro-points and not pixels, points-as-floats, or microns:
 *
 *  - PDF's native unit is the point, so µpt → pt is an exact decimal shift and
 *    the exported page geometry is never the result of an irrational scale.
 *  - Integers cannot accumulate floating point drift. Every add/subtract used by
 *    the layout engine, the snapping engine and the exporter is exact.
 *  - 1 µpt = 3.5e-7 in = 0.35 nm. Every dimension we were given (5 decimal
 *    places of an inch, e.g. 7.11175 in) maps to an exact integer:
 *    7.11175 in × 72_000_000 = 512_046_000 µpt.
 *  - A 100 in artboard is 7.2e9 µpt, comfortably inside Number.MAX_SAFE_INTEGER
 *    (9.007e15), so plain JS numbers are safe. Postgres columns are `bigint`.
 *
 * Millimetre entry is a user convenience only (§6 of the spec makes inches
 * primary and mm optional). mm → µpt rounds to the nearest µpt, i.e. to within
 * 0.35 nm, which is ~5 orders of magnitude finer than any imagesetter.
 */

/** Micro-points. The canonical internal unit. Always an integer. */
export type Upt = number;

export const UPT_PER_PT = 1_000_000;
export const PT_PER_IN = 72;
export const UPT_PER_IN = UPT_PER_PT * PT_PER_IN; // 72_000_000
export const MM_PER_IN = 25.4;
export const UPT_PER_MM = UPT_PER_IN / MM_PER_IN; // 2_834_645.669...

export type LengthUnit = "in" | "mm" | "pt";

/** Round half away from zero — deterministic and symmetric about 0. */
export function roundHalfAway(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

export function inToUpt(inches: number): Upt {
  return roundHalfAway(inches * UPT_PER_IN);
}
export function mmToUpt(mm: number): Upt {
  return roundHalfAway(mm * UPT_PER_MM);
}
export function ptToUpt(pt: number): Upt {
  return roundHalfAway(pt * UPT_PER_PT);
}

export function uptToIn(u: Upt): number {
  return u / UPT_PER_IN;
}
export function uptToMm(u: Upt): number {
  return u / UPT_PER_MM;
}
/** The only conversion the PDF writer is allowed to use. */
export function uptToPt(u: Upt): number {
  return u / UPT_PER_PT;
}

export function toUpt(value: number, unit: LengthUnit): Upt {
  switch (unit) {
    case "in":
      return inToUpt(value);
    case "mm":
      return mmToUpt(value);
    case "pt":
      return ptToUpt(value);
  }
}

export function fromUpt(u: Upt, unit: LengthUnit): number {
  switch (unit) {
    case "in":
      return uptToIn(u);
    case "mm":
      return uptToMm(u);
    case "pt":
      return uptToPt(u);
  }
}

/**
 * Inches get 5 places because the supplied presets carry 5 (7.11175 in). Showing
 * 4 would round a production dimension in the one place an operator reads it.
 */
const UNIT_DECIMALS: Record<LengthUnit, number> = { in: 5, mm: 4, pt: 3 };

/** Human display, e.g. formatLength(314460000, "in") === "4.3675" */
export function formatLength(u: Upt, unit: LengthUnit): string {
  const v = fromUpt(u, unit);
  const d = UNIT_DECIMALS[unit];
  // Trim trailing zeros but keep at least one decimal place.
  const s = v.toFixed(d).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, ".0");
  return s;
}

export function formatLengthWithUnit(u: Upt, unit: LengthUnit): string {
  return `${formatLength(u, unit)} ${unit}`;
}

/**
 * Parse free-form user input: `4.3675`, `4.3675in`, `4 3/8"`, `110.9mm`, `12pt`.
 * `fallbackUnit` is used when the string carries no unit suffix.
 * Returns null when the input cannot be understood — callers must not guess.
 */
export function parseLength(raw: string, fallbackUnit: LengthUnit): Upt | null {
  const s = raw.trim().toLowerCase().replace(/,/g, "");
  if (!s) return null;

  let unit: LengthUnit = fallbackUnit;
  let body = s;
  const m = s.match(/^(.*?)\s*(in|inch|inches|"|mm|millimeter|millimetre|pt|point|points)$/);
  if (m) {
    body = m[1].trim();
    const suffix = m[2];
    if (suffix === "mm" || suffix === "millimeter" || suffix === "millimetre") unit = "mm";
    else if (suffix === "pt" || suffix === "point" || suffix === "points") unit = "pt";
    else unit = "in";
  }
  if (!body) return null;

  // Mixed fraction: "4 3/8"
  const mixed = body.match(/^(-?\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) {
    const whole = Number(mixed[1]);
    const num = Number(mixed[2]);
    const den = Number(mixed[3]);
    if (!den) return null;
    const sign = whole < 0 ? -1 : 1;
    return toUpt(whole + sign * (num / den), unit);
  }
  // Bare fraction: "3/8"
  const frac = body.match(/^(-?\d+)\s*\/\s*(\d+)$/);
  if (frac) {
    const den = Number(frac[2]);
    if (!den) return null;
    return toUpt(Number(frac[1]) / den, unit);
  }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(body)) return null;
  const n = Number(body);
  if (!Number.isFinite(n)) return null;
  return toUpt(n, unit);
}

/** Angles are stored in millidegrees so rotation is exact too. */
export type MilliDeg = number;
export const MDEG_PER_DEG = 1000;
export function degToMdeg(deg: number): MilliDeg {
  return roundHalfAway(deg * MDEG_PER_DEG);
}
export function mdegToDeg(m: MilliDeg): number {
  return m / MDEG_PER_DEG;
}
export function mdegToRad(m: MilliDeg): number {
  return (mdegToDeg(m) * Math.PI) / 180;
}

/** Percentages (opacity, scale) are stored in basis points: 10000 = 100%. */
export type Bps = number;
export const BPS_FULL = 10_000;
export function pctToBps(pct: number): Bps {
  return roundHalfAway(pct * 100);
}
export function bpsToPct(b: Bps): number {
  return b / 100;
}
export function bpsToUnit(b: Bps): number {
  return b / BPS_FULL;
}
