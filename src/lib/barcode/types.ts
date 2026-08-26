import type { PrintColor } from "@/lib/color/types";
import type { Upt } from "@/lib/units";
import type { BarcodeSymbology } from "@/lib/design/schema";

/**
 * BARCODE CONTRACT — spec §12.
 *
 * Every symbology reduces to the same thing: a set of axis-aligned rectangles in
 * µpt, plus optional human-readable text runs, plus the quiet zones that must
 * remain clear. The renderer (SVG in the editor, vector ops in the PDF) never
 * rasterises; it just draws these rects. That is what keeps a barcode a vector
 * in the production PDF.
 */

export type BarModule = {
  /** Offset from the left edge of the symbol's *quiet-zone-inclusive* box. */
  x: Upt;
  y: Upt;
  w: Upt;
  h: Upt;
};

export type HumanReadableRun = {
  text: string;
  /** Left edge of the text run, quiet-zone-inclusive coordinates. */
  x: Upt;
  /** Baseline y, quiet-zone-inclusive coordinates. */
  baseline: Upt;
  fontSize: Upt;
  /** left | center — UPC-A places the number system digit outside the guard bars. */
  align: "left" | "center";
  /** Width available for centring, when align === "center". */
  width: Upt;
};

export type BarcodeRender = {
  symbology: BarcodeSymbology;
  /** The value actually encoded, after normalisation. */
  encodedValue: string;
  /** Total symbol box INCLUDING quiet zones. */
  width: Upt;
  height: Upt;
  /** Module (X-dimension) width at the requested magnification. */
  moduleWidth: Upt;
  /** Quiet zones that must stay clear of other artwork. */
  quietLeft: Upt;
  quietRight: Upt;
  quietTop: Upt;
  quietBottom: Upt;
  bars: BarModule[];
  text: HumanReadableRun[];
  /** Non-fatal notes, e.g. "bar height truncated below nominal". */
  notes: string[];
};

export type BarcodeError = {
  code:
    | "EMPTY"
    | "BAD_LENGTH"
    | "BAD_CHARSET"
    | "BAD_CHECK_DIGIT"
    | "UNSUPPORTED"
    | "TOO_LONG";
  message: string;
  /** The value we were asked to encode, for the preflight finding. */
  value: string;
};

export type BarcodeResult =
  | { ok: true; render: BarcodeRender }
  | { ok: false; error: BarcodeError };

export type BarcodeRequest = {
  symbology: BarcodeSymbology;
  value: string;
  /** Basis points of nominal size. 10000 = 100 % (X = 0.0130 in for UPC-A). */
  magnificationBps: number;
  /** Requested bar height in µpt. Nominal for UPC-A at 100 % is 1.02 in. */
  barHeight: Upt;
  showHumanReadable: boolean;
  humanReadableFontSize: Upt;
  showLightMarginIndicator: boolean;
  /** Only used by gs1-digital-link. */
  digitalLinkDomain?: string;
  /** Fixed target width; the engine picks the magnification that fits. */
  fitWidth?: Upt;
};

/** GS1 General Specifications nominal X-dimension for EAN/UPC: 0.0130 in. */
export const NOMINAL_X_UPT = 936_000; // 0.013 in × 72_000_000
/** Nominal UPC-A symbol height (bars) at 100 %: 1.02 in. */
export const NOMINAL_UPCA_BAR_HEIGHT_UPT = 73_440_000;
/** GS1 permitted magnification range for EAN/UPC at retail POS: 80 %–200 %. */
export const MIN_MAGNIFICATION_BPS = 8_000;
export const MAX_MAGNIFICATION_BPS = 20_000;
/** UPC-A left quiet zone: 9X. Right: 9X. EAN-13: 11X left, 7X right. */
export const UPCA_QUIET_LEFT_X = 9;
export const UPCA_QUIET_RIGHT_X = 9;
export const EAN13_QUIET_LEFT_X = 11;
export const EAN13_QUIET_RIGHT_X = 7;

export type BarcodeStyle = {
  barColor: PrintColor;
  quietZoneFill: PrintColor;
};
