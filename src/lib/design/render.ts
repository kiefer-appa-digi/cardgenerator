import type { Upt } from "@/lib/units";
import type { PrintColor } from "@/lib/color/types";
import type { BezierSeg, Rect } from "@/lib/geometry/types";
import type { BarcodeRender } from "@/lib/barcode/types";
import type { BindingIssue } from "@/lib/data/binding";
import type { DesignElement, SideKey } from "./schema";

/**
 * THE RENDER PLAN — one layout pass, two renderers.
 *
 * `planSide()` resolves a card side into a flat, ordered list of draw ops in
 * bleed space (µpt, y down). The SVG artboard maps ops to SVG nodes; the PDF
 * writer maps the same ops to PDF operators. Neither one re-decides where a line
 * of text breaks or how big a barcode is.
 *
 * That is what makes the on-screen preview a faithful preview: the two outputs
 * are not two implementations of the same intent, they are two serialisations of
 * the same resolved plan.
 *
 * Ops carry `elementId` so the editor can hit-test and highlight, and so a
 * preflight finding can point at the exact thing on the artboard.
 */

export type DrawOpBase = {
  elementId: string;
  /** Paint order within the side, ascending. */
  z: number;
  /** 0..10000. Already includes any inherited group opacity. */
  opacity: number;
  /** Rotation about the element frame's centre, millidegrees. */
  rotation: number;
  /** The element frame, for rotation pivot and hit testing. */
  frame: Rect;
};

export type PathOp = DrawOpBase & {
  op: "path";
  segs: BezierSeg[];
  fill: PrintColor;
  stroke: PrintColor;
  strokeWidth: Upt;
};

export type EllipseOp = DrawOpBase & {
  op: "ellipse";
  rect: Rect;
  fill: PrintColor;
  stroke: PrintColor;
  strokeWidth: Upt;
};

export type LineOp = DrawOpBase & {
  op: "line";
  x1: Upt;
  y1: Upt;
  x2: Upt;
  y2: Upt;
  stroke: PrintColor;
  strokeWidth: Upt;
};

export type TextSpanOp = {
  text: string;
  /** Left edge of the span, bleed space. */
  x: Upt;
  /** Baseline, bleed space. */
  y: Upt;
  /** Measured advance of the span, so the SVG preview can pin the exact width. */
  width: Upt;
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  fontSize: Upt;
  tracking: Upt;
  color: PrintColor;
  /** Resolved face id, e.g. "Inter:600". Empty when the family is missing. */
  faceKey: string;
  fontMissing: boolean;
};

export type TextOp = DrawOpBase & {
  op: "text";
  spans: TextSpanOp[];
  /** Fill painted behind the whole text box. */
  fill: PrintColor;
  /** Ink bounds of the laid text, for safe-area and overflow checks. */
  inkBounds: Rect;
  overflow: boolean;
  overflowAmount: Upt;
  /** Font size actually used after auto-fit shrinking. */
  usedFontSize: Upt;
  requestedFontSize: Upt;
  fontsMissing: string[];
  unmappedGlyphs: boolean;
};

export type ImageOp = DrawOpBase & {
  op: "image";
  assetId: string | null;
  /** Destination rect after fit/crop/scale, bleed space. */
  dest: Rect;
  /** Clip to the element frame (fill and crop overflow the destination). */
  clip: Rect;
  cornerRadius: Upt;
  /** Source crop in basis points of the source image. */
  crop: { x: number; y: number; w: number; h: number };
  /** Effective resolution at the placed size, when the source dimensions are known. */
  effectiveDpi: number | null;
  isBackground: boolean;
  missing: boolean;
};

export type BarcodeOp = DrawOpBase & {
  op: "barcode";
  /** Where the symbol's quiet-zone box sits, bleed space. */
  origin: { x: Upt; y: Upt };
  render: BarcodeRender | null;
  error: string | null;
  barColor: PrintColor;
  quietZoneFill: PrintColor;
  /** Quiet-zone box in bleed space, for the preflight clearance check. */
  quietBox: Rect;
  /** Bars-only box, for the physical-size check. */
  symbolBox: Rect;
  humanReadableFontFamily: string;
  humanReadableFontWeight: number;
};

export type DrawOp = PathOp | EllipseOp | LineOp | TextOp | ImageOp | BarcodeOp;

export type ElementDiagnostics = {
  elementId: string;
  elementName: string;
  kind: DesignElement["kind"];
  side: SideKey;
  frame: Rect;
  visible: boolean;
  hiddenReason: string;
  bindingIssues: BindingIssue[];
  /** Set by text and BOM ops when the copy does not fit. */
  overflow: boolean;
  overflowAmount: Upt;
  fontsMissing: string[];
  unmappedGlyphs: boolean;
  /** Set by BOM blocks whose maxItems dropped rows. */
  truncatedCount: number;
  bomEmpty: boolean;
  /** Set by image ops. */
  effectiveDpi: number | null;
  assetMissing: boolean;
  /** Set by barcode ops. */
  barcodeError: string | null;
  barcodeNotes: string[];
  quietBox: Rect | null;
  symbolBox: Rect | null;
  moduleWidth: Upt | null;
};

export type SidePlan = {
  side: SideKey;
  /** The page: the full-bleed canvas, origin at its top-left. */
  canvas: Rect;
  trim: Rect;
  safe: Rect;
  cavity: Rect;
  cornerRadius: Upt;
  background: PrintColor;
  ops: DrawOp[];
  diagnostics: ElementDiagnostics[];
  /** Every distinct face the side needs, so the PDF writer embeds exactly those. */
  facesUsed: string[];
  /** Asset ids referenced, so the caller can pre-load bytes. */
  assetsUsed: string[];
};

export function isTextOp(op: DrawOp): op is TextOp {
  return op.op === "text";
}
export function isImageOp(op: DrawOp): op is ImageOp {
  return op.op === "image";
}
export function isBarcodeOp(op: DrawOp): op is BarcodeOp {
  return op.op === "barcode";
}
