import { cmyk as pdfCmyk, grayscale as pdfGrayscale, type Color } from "pdf-lib";
import { TINT_MAX, toCmyk, type Cmyk, type PrintColor } from "@/lib/color/types";

/**
 * PRINT COLOUR → PDF COLOUR — spec §14.
 *
 * `PrintColor` stores ink coverage in tenths of a percent (0..1000). PDF's
 * colour operators take 0..1 components. This module is the only place that
 * conversion happens, so there is exactly one answer to "what ink did we ask
 * for" anywhere in the exporter.
 *
 * Three rules, all of them deliberate:
 *
 *  - NOTHING becomes RGB. pdf-lib can emit `rg`/`RG`, and this module never
 *    calls those helpers. A production card that specifies CMYK inks must reach
 *    the RIP as `k`/`K` operators, not as an RGB approximation the press then
 *    re-separates. (§32: "Do not fake CMYK.")
 *
 *  - GRAY defaults to DeviceCMYK 0/0/0/K rather than DeviceGray. Both are legal,
 *    but a RIP is free to re-separate DeviceGray across all four plates, which
 *    turns a K-only back into a four-colour job. Writing 0/0/0/K says exactly
 *    what the press should do. `"device-gray"` remains available for deployments
 *    whose RIP is configured the other way.
 *
 *  - SPOT converts to its CMYK alternate and the caller MUST record the
 *    conversion. pdf-lib cannot write a /Separation colour space, so a spot ink
 *    cannot survive this exporter. That is a limitation of the stack, and the
 *    honest response is a SPOT_CONVERTED preflight note next to the artwork —
 *    not a silently substituted process build. (§14, §32.)
 */

/** How a `gray` PrintColor should be written into the content stream. */
export type GrayPolicy = "device-cmyk" | "device-gray";

export const DEFAULT_GRAY_POLICY: GrayPolicy = "device-cmyk";

/** Tint (0..1000) → PDF component (0..1). */
export function tintToUnit(tint: number): number {
  return clampUnit(tint / TINT_MAX);
}

function clampUnit(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * `PrintColor` → a pdf-lib `Color`, or null when there is nothing to paint.
 * A null return means "emit no colour operator and no painting operator",
 * which is different from painting white.
 */
export function toPdfColor(
  color: PrintColor,
  grayPolicy: GrayPolicy = DEFAULT_GRAY_POLICY,
): Color | null {
  if (color.space === "none") return null;
  if (color.space === "gray" && grayPolicy === "device-gray") {
    // DeviceGray runs the other way from ink coverage: 0 is black, 1 is white.
    return pdfGrayscale(clampUnit(1 - color.k / TINT_MAX));
  }
  const ink = toCmyk(color);
  if (!ink) return null;
  return pdfCmyk(tintToUnit(ink.c), tintToUnit(ink.m), tintToUnit(ink.y), tintToUnit(ink.k));
}

/** The four ink components a colour resolves to, 0..1, for raw operator emission. */
export function toCmykComponents(
  color: PrintColor,
): { c: number; m: number; y: number; k: number } | null {
  const ink = toCmyk(color);
  if (!ink) return null;
  return {
    c: tintToUnit(ink.c),
    m: tintToUnit(ink.m),
    y: tintToUnit(ink.y),
    k: tintToUnit(ink.k),
  };
}

export function isPaintable(color: PrintColor): boolean {
  return color.space !== "none";
}

/** A spot ink the exporter had to flatten into process inks. */
export type SpotConversion = {
  name: string;
  /** Tint the spot was used at, in tenths of a percent. */
  tint: number;
  /** The CMYK build actually written to the PDF. */
  alternate: Cmyk;
};

/**
 * Collect every distinct spot ink in a set of colours, with the CMYK build each
 * one was flattened to. The caller turns these into SPOT_CONVERTED findings —
 * this module does not know what a preflight finding is.
 */
export function collectSpotConversions(colors: Iterable<PrintColor>): SpotConversion[] {
  const seen = new Map<string, SpotConversion>();
  for (const color of colors) {
    if (color.space !== "spot") continue;
    const key = `${color.name}@${color.tint}`;
    if (seen.has(key)) continue;
    const alternate = toCmyk(color);
    if (!alternate) continue;
    seen.set(key, { name: color.name, tint: color.tint, alternate });
  }
  return [...seen.values()].sort((a, b) =>
    a.name === b.name ? a.tint - b.tint : a.name.localeCompare(b.name),
  );
}

/**
 * The device colour spaces a set of colours will produce in the content stream.
 * Reported in `complianceStatus` so a caller can state what is in the file
 * without re-parsing it.
 */
export function deviceColorSpaces(
  colors: Iterable<PrintColor>,
  grayPolicy: GrayPolicy = DEFAULT_GRAY_POLICY,
): string[] {
  const spaces = new Set<string>();
  for (const color of colors) {
    if (color.space === "none") continue;
    if (color.space === "gray" && grayPolicy === "device-gray") spaces.add("DeviceGray");
    else spaces.add("DeviceCMYK");
  }
  return [...spaces].sort();
}
