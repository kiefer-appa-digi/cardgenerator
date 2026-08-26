import {
  PDFName,
  clip,
  closePath,
  concatTransformationMatrix,
  endPath,
  appendBezierCurve,
  fill as fillPath,
  fillAndStroke,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSpacing,
  setFillingColor,
  setGraphicsState,
  setLineWidth,
  setStrokingColor,
  stroke as strokePath,
  type PDFDocument,
  type PDFImage,
  type PDFOperator,
  type PDFPage,
} from "pdf-lib";
import { mdegToRad, uptToPt, type Upt } from "@/lib/units";
import {
  KAPPA,
  clampRadius,
  roundedRectPath,
  type BezierSeg,
  type Rect,
} from "@/lib/geometry/types";
import type { PrintColor } from "@/lib/color/types";
import { faceKey as resolveFaceKey } from "@/lib/text/fonts";
import { getFaceMetrics, measureString } from "@/lib/text/layout";
import type {
  BarcodeOp,
  EllipseOp,
  ImageOp,
  LineOp,
  PathOp,
  SidePlan,
  TextOp,
} from "@/lib/design/render";
import {
  DEFAULT_GRAY_POLICY,
  collectSpotConversions,
  deviceColorSpaces,
  toPdfColor,
  type GrayPolicy,
  type SpotConversion,
} from "./color";
import type { EmbeddedFaces } from "./fonts";

/**
 * DRAW A SIDE PLAN ONTO A PDF PAGE — spec §15.
 *
 * THE SINGLE Y-FLIP LIVES HERE.
 *
 * Card space (lib/geometry/types.ts) has its origin at the top-left of the bleed
 * box with +y DOWN, matching the screen and SVG. PDF user space has its origin
 * at the bottom-left with +y UP. `CardSpace` performs that flip and nothing else
 * in the exporter is allowed to touch y. If a future op type is added, it must
 * go through `space.y()` / `space.rect()` too — a second flip elsewhere is how
 * artwork ends up mirrored on one element and not another.
 *
 * THIS MODULE KNOWS NOTHING ABOUT OVERLAYS.
 *
 * It draws `DrawOp`s and only `DrawOp`s. There is no code path here that can
 * emit a trim outline, a safe-area rule, a cavity footprint or a slug, because
 * `SidePlan.ops` cannot express one. That is the structural guarantee that
 * editor furniture cannot reach a production PDF (§15 "no editor overlays"):
 * the proof exporter draws its overlay with its own functions, in proof.ts.
 *
 * Everything painted is vector: text is real text in an embedded subset font,
 * barcode bars are filled rectangles, shapes are paths. Nothing is rasterised
 * (§32).
 */

/** Emitted coordinates are rounded here. 1e-6 pt is 0.35 nm — see NUMERIC_PRECISION. */
const NUMERIC_PRECISION = 6;

/**
 * Why round at all: µpt → pt is an exact decimal shift, but a rotation matrix
 * goes through Math.cos/Math.sin, whose last bit is not guaranteed identical
 * across V8 builds. Rounding to 1e-6 pt makes the written bytes reproducible
 * while staying five orders of magnitude finer than any imagesetter.
 */
function round(n: number): number {
  const f = 10 ** NUMERIC_PRECISION;
  return Math.round(n * f) / f;
}

/* ------------------------------------------------------------- card space */

export type PdfRectPt = { x: number; y: number; width: number; height: number };

export type CardSpace = {
  /** PDF x of card-space x = 0. */
  readonly originXPt: number;
  /** PDF y of card-space y = 0, i.e. the TOP edge of the card. */
  readonly originTopYPt: number;
  /** Card-space x (µpt) → PDF x (pt). */
  x(u: Upt): number;
  /** Card-space y (µpt) → PDF y (pt). This is the y-flip. */
  y(u: Upt): number;
  /** A length in µpt → pt. Lengths do not flip. */
  len(u: Upt): number;
  /** Card-space rect → PDF rect with a lower-left origin. */
  rect(r: Rect): PdfRectPt;
};

/**
 * @param originXPt      PDF x where the card's left bleed edge sits.
 * @param originTopYPt   PDF y where the card's TOP bleed edge sits.
 *
 * For a production page the card fills the sheet: `cardSpace(0, pageHeightPt)`.
 * The proof page is larger, so the card is inset and the same transform is
 * reused unchanged — which is why the overlay and the artwork cannot drift
 * apart.
 */
export function cardSpace(originXPt: number, originTopYPt: number): CardSpace {
  return {
    originXPt,
    originTopYPt,
    x: (u) => round(originXPt + uptToPt(u)),
    y: (u) => round(originTopYPt - uptToPt(u)),
    len: (u) => round(uptToPt(u)),
    rect: (r) => ({
      x: round(originXPt + uptToPt(r.x)),
      // Lower-left corner: the card-space BOTTOM edge is the PDF y minimum.
      y: round(originTopYPt - uptToPt(r.y + r.h)),
      width: round(uptToPt(r.w)),
      height: round(uptToPt(r.h)),
    }),
  };
}

/* ----------------------------------------------------------------- errors */

export class MissingAssetError extends Error {
  readonly code = "ASSET_MISSING" as const;
  constructor(
    readonly assetId: string,
    readonly reason: "bytes-unavailable" | "metadata-unresolved" = "bytes-unavailable",
  ) {
    super(
      reason === "metadata-unresolved"
        ? `Asset "${assetId}" is referenced by the design but the plan could not ` +
          `resolve its metadata, so its placed size and effective resolution are ` +
          `unknown. Production artwork is never exported with an unmeasurable image.`
        : `Asset "${assetId}" is referenced by the design but its bytes could not ` +
          `be loaded. Production artwork is never exported with a placeholder in ` +
          `place of a missing image.`,
    );
    this.name = "MissingAssetError";
  }
}

export class UnsupportedAssetError extends Error {
  readonly code = "ASSET_UNSUPPORTED" as const;
  constructor(
    readonly assetId: string,
    readonly contentType: string,
  ) {
    super(
      `Asset "${assetId}" has content type "${contentType}", which this exporter ` +
        `cannot embed. Only PNG and JPEG can be placed without rasterising the page.`,
    );
    this.name = "UnsupportedAssetError";
  }
}

export class FaceNotEmbeddedError extends Error {
  readonly code = "FONT_MISSING" as const;
  constructor(readonly faceKey: string) {
    super(
      `Face "${faceKey}" is used by the plan but was not embedded in the document. ` +
        `Collect faces with collectRequiredFaces() before drawing.`,
    );
    this.name = "FaceNotEmbeddedError";
  }
}

/* ------------------------------------------------------------ asset bytes */

export type AssetPayload = { bytes: Uint8Array; contentType: string };
export type AssetBytesLoader = (assetId: string) => Promise<AssetPayload | null>;

export type PlacedImage = {
  assetId: string;
  image: PDFImage;
  /** "DeviceRGB" | "DeviceGray" | "DeviceCMYK" — what actually lands in the PDF. */
  colorSpace: string;
  format: "png" | "jpeg";
  pixelWidth: number;
  pixelHeight: number;
};

function sniffFormat(bytes: Uint8Array): "png" | "jpeg" | null {
  if (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "png";
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  return null;
}

/**
 * Component count from a JPEG's Start-Of-Frame marker: 1 grayscale, 3 YCbCr
 * (written as DeviceRGB), 4 CMYK or YCCK. Read from the bytes rather than
 * trusted from the upload's declared MIME type, because the caller's metadata is
 * not what the RIP will see.
 */
function jpegColorSpace(bytes: Uint8Array): string {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const components = bytes[i + 9];
      if (components === 1) return "DeviceGray";
      if (components === 4) return "DeviceCMYK";
      return "DeviceRGB";
    }
    if (len <= 0) break;
    i += 2 + len;
  }
  return "DeviceRGB";
}

/**
 * Embed every raster the plans place, in sorted asset-id order so the document's
 * object numbering does not depend on element ordering. A referenced asset whose
 * bytes cannot be loaded throws — production artwork never gets a placeholder.
 */
export async function embedPlanAssets(
  doc: PDFDocument,
  plans: readonly SidePlan[],
  loadBytes: AssetBytesLoader | undefined,
): Promise<Map<string, PlacedImage>> {
  const ids = new Set<string>();
  for (const plan of plans) {
    for (const op of plan.ops) {
      if (op.op === "image" && op.assetId) ids.add(op.assetId);
    }
  }
  const out = new Map<string, PlacedImage>();
  if (ids.size === 0) return out;
  if (!loadBytes) throw new MissingAssetError([...ids].sort()[0]);

  for (const assetId of [...ids].sort()) {
    const payload = await loadBytes(assetId);
    if (!payload || payload.bytes.byteLength === 0) throw new MissingAssetError(assetId);

    const format = sniffFormat(payload.bytes);
    if (!format) throw new UnsupportedAssetError(assetId, payload.contentType);

    const image =
      format === "png" ? await doc.embedPng(payload.bytes) : await doc.embedJpg(payload.bytes);
    out.set(assetId, {
      assetId,
      image,
      // pdf-lib's PNG embedder decodes to raw RGB samples, so a PNG is always
      // DeviceRGB in the output regardless of what the source file declared.
      colorSpace: format === "png" ? "DeviceRGB" : jpegColorSpace(payload.bytes),
      format,
      pixelWidth: image.width,
      pixelHeight: image.height,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ faces */

/**
 * Every face the plans actually need. Not simply `plan.facesUsed`: a span whose
 * family could not be resolved still has to be set in *something*, and the
 * layout engine already chose the fallback face for it. Embedding what the spans
 * ask for keeps the writer from throwing on a design preflight has flagged.
 */
export function collectRequiredFaces(plans: readonly SidePlan[]): string[] {
  const faces = new Set<string>();
  for (const plan of plans) {
    for (const f of plan.facesUsed) faces.add(f);
    for (const op of plan.ops) {
      if (op.op === "text") {
        for (const span of op.spans) if (span.text) faces.add(span.faceKey);
      } else if (op.op === "barcode" && op.render && op.render.text.length > 0) {
        faces.add(
          resolveFaceKey(op.humanReadableFontFamily, op.humanReadableFontWeight, false),
        );
      }
    }
  }
  faces.delete("");
  return [...faces].sort();
}

/* --------------------------------------------------------------- painting */

type PaintKind = "fill" | "stroke" | "fillAndStroke" | "none";

function paintKind(fill: PrintColor, stroke: PrintColor, strokeWidth: Upt): PaintKind {
  const hasFill = fill.space !== "none";
  const hasStroke = stroke.space !== "none" && strokeWidth > 0;
  if (hasFill && hasStroke) return "fillAndStroke";
  if (hasFill) return "fill";
  if (hasStroke) return "stroke";
  return "none";
}

function paintOperator(kind: PaintKind): PDFOperator {
  switch (kind) {
    case "fill":
      return fillPath();
    case "stroke":
      return strokePath();
    case "fillAndStroke":
      return fillAndStroke();
    case "none":
      // `n` ends the path without painting it, which is what an element with
      // neither a fill nor a stroke means.
      return endPath();
  }
}

/** Bézier segments in card space → PDF path-construction operators. */
function pathOps(space: CardSpace, segs: readonly BezierSeg[]): PDFOperator[] {
  const out: PDFOperator[] = [];
  for (const s of segs) {
    switch (s.t) {
      case "M":
        out.push(moveTo(space.x(s.x), space.y(s.y)));
        break;
      case "L":
        out.push(lineTo(space.x(s.x), space.y(s.y)));
        break;
      case "C":
        out.push(
          appendBezierCurve(
            space.x(s.x1),
            space.y(s.y1),
            space.x(s.x2),
            space.y(s.y2),
            space.x(s.x),
            space.y(s.y),
          ),
        );
        break;
      case "Z":
        out.push(closePath());
        break;
    }
  }
  return out;
}

/**
 * Ellipse inscribed in `r`, as four cubic quarters using the same KAPPA the
 * editor's rounded corners use, so a circle drawn on the artboard and the same
 * circle in the PDF are the identical curve.
 */
export function ellipseSegs(r: Rect): BezierSeg[] {
  const rx = r.w / 2;
  const ry = r.h / 2;
  const cx = r.x + rx;
  const cy = r.y + ry;
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    { t: "M", x: cx + rx, y: cy },
    { t: "C", x1: cx + rx, y1: cy + ky, x2: cx + kx, y2: cy + ry, x: cx, y: cy + ry },
    { t: "C", x1: cx - kx, y1: cy + ry, x2: cx - rx, y2: cy + ky, x: cx - rx, y: cy },
    { t: "C", x1: cx - rx, y1: cy - ky, x2: cx - kx, y2: cy - ry, x: cx, y: cy - ry },
    { t: "C", x1: cx + kx, y1: cy - ry, x2: cx + rx, y2: cy - ky, x: cx + rx, y: cy },
    { t: "Z" },
  ];
}

/* ----------------------------------------------- rotation and transparency */

/**
 * Rotation about the element frame's centre.
 *
 * Card space has +y down, PDF has +y up, so a card-space rotation of θ is a PDF
 * rotation of −θ about the same (flipped) centre. Deriving it once here is why
 * a rotated element lands in the same place on screen and on press.
 */
function rotationOps(space: CardSpace, frame: Rect, rotationMdeg: number): PDFOperator | null {
  const norm = ((rotationMdeg % 360_000) + 360_000) % 360_000;
  if (norm === 0) return null;
  const phi = -mdegToRad(norm);
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const cx = space.x(frame.x) + space.len(frame.w) / 2;
  const cy = space.y(frame.y) - space.len(frame.h) / 2;
  return concatTransformationMatrix(
    round(cos),
    round(sin),
    round(-sin),
    round(cos),
    round(cx - cx * cos + cy * sin),
    round(cy - cx * sin - cy * cos),
  );
}

/**
 * One ExtGState per distinct alpha, cached per page. pdf-lib's own draw helpers
 * mint a fresh ExtGState on every call; the raw-operator paths here reuse.
 */
type AlphaCache = Map<number, PDFName>;

function alphaState(
  doc: PDFDocument,
  page: PDFPage,
  cache: AlphaCache,
  alpha: number,
): PDFName {
  const key = round(alpha);
  const hit = cache.get(key);
  if (hit) return hit;
  const name = page.node.newExtGState(
    "GS",
    doc.context.obj({ Type: "ExtGState", ca: key, CA: key }),
  );
  cache.set(key, name);
  return name;
}

/* ------------------------------------------------------------------ input */

export type SideDrawInput = {
  doc: PDFDocument;
  page: PDFPage;
  plan: SidePlan;
  space: CardSpace;
  fonts: EmbeddedFaces;
  images: ReadonlyMap<string, PlacedImage>;
  grayPolicy?: GrayPolicy;
};

export type PlacedImageReport = {
  assetId: string;
  colorSpace: string;
  format: "png" | "jpeg";
  /** Resolution at the placed size, as the plan computed it. */
  effectiveDpi: number | null;
  isBackground: boolean;
};

export type SideDrawReport = {
  opsDrawn: number;
  textSpansDrawn: number;
  barModulesDrawn: number;
  imagesDrawn: number;
  /** Image elements with no asset bound: nothing to draw, nothing invented. */
  imagesUnbound: number;
  transparencyPresent: boolean;
  spotConversions: SpotConversion[];
  /** Families the layout engine had to substitute for. */
  fontsMissing: string[];
  colorSpaces: string[];
  placedImages: PlacedImageReport[];
  /** Barcode elements whose value would not encode; nothing was painted. */
  barcodeErrors: Array<{ elementId: string; error: string }>;
};

/* ------------------------------------------------------------------- draw */

/**
 * Paint one side's plan onto one page.
 *
 * All content is clipped to the bleed box. Nothing can paint outside the page,
 * so an element dragged off the artboard cannot smear into a neighbouring card
 * on an imposed sheet.
 */
export function drawSidePlan(input: SideDrawInput): SideDrawReport {
  const { doc, page, plan, space, fonts, images } = input;
  const grayPolicy = input.grayPolicy ?? DEFAULT_GRAY_POLICY;
  const alphaCache: AlphaCache = new Map();

  const colors: PrintColor[] = [];
  const report: SideDrawReport = {
    opsDrawn: 0,
    textSpansDrawn: 0,
    barModulesDrawn: 0,
    imagesDrawn: 0,
    imagesUnbound: 0,
    transparencyPresent: false,
    spotConversions: [],
    fontsMissing: [],
    colorSpaces: [],
    placedImages: [],
    barcodeErrors: [],
  };
  const missingFamilies = new Set<string>();

  // The plan's `background` is the paper colour. It is documented in the schema
  // as "not printed, used for preview honesty", so the exporter does not lay it
  // down: painting white would put an unrequested white plate under the job.

  page.pushOperators(
    pushGraphicsState(),
    ...pathOps(space, roundedRectPath(plan.canvas, 0)),
    clip(),
    endPath(),
  );

  const ordered = [...plan.ops].sort((a, b) => a.z - b.z);

  for (const op of ordered) {
    const alpha = op.opacity / 10_000;
    if (alpha < 1) report.transparencyPresent = true;
    const rotate = rotationOps(space, op.frame, op.rotation);

    if (rotate) page.pushOperators(pushGraphicsState(), rotate);

    switch (op.op) {
      case "path":
        drawPath(doc, page, space, alphaCache, op, alpha, grayPolicy, colors);
        break;
      case "ellipse":
        drawEllipse(doc, page, space, alphaCache, op, alpha, grayPolicy, colors);
        break;
      case "line":
        drawLine(doc, page, space, alphaCache, op, alpha, grayPolicy, colors);
        break;
      case "text":
        report.textSpansDrawn += drawTextOp(
          doc,
          page,
          space,
          alphaCache,
          op,
          alpha,
          grayPolicy,
          fonts,
          colors,
          missingFamilies,
        );
        break;
      case "image": {
        const drawn = drawImage(page, space, op, alpha, images);
        if (drawn) {
          report.imagesDrawn += 1;
          const placed = op.assetId ? images.get(op.assetId) : undefined;
          if (placed) {
            report.placedImages.push({
              assetId: placed.assetId,
              colorSpace: placed.colorSpace,
              format: placed.format,
              effectiveDpi: op.effectiveDpi,
              isBackground: op.isBackground,
            });
          }
        } else {
          report.imagesUnbound += 1;
        }
        break;
      }
      case "barcode": {
        if (op.error) report.barcodeErrors.push({ elementId: op.elementId, error: op.error });
        report.barModulesDrawn += drawBarcode(
          doc,
          page,
          space,
          alphaCache,
          op,
          alpha,
          grayPolicy,
          fonts,
          colors,
        );
        break;
      }
    }

    if (rotate) page.pushOperators(popGraphicsState());
    report.opsDrawn += 1;
  }

  page.pushOperators(popGraphicsState());

  report.spotConversions = collectSpotConversions(colors);
  report.colorSpaces = deviceColorSpaces(colors, grayPolicy);
  report.fontsMissing = [...missingFamilies].sort();
  return report;
}

/* ------------------------------------------------------------- op drawers */

function paintPath(
  doc: PDFDocument,
  page: PDFPage,
  alphaCache: AlphaCache,
  segs: PDFOperator[],
  fill: PrintColor,
  stroke: PrintColor,
  strokeWidth: Upt,
  alpha: number,
  grayPolicy: GrayPolicy,
  space: CardSpace,
  colors: PrintColor[],
): void {
  const kind = paintKind(fill, stroke, strokeWidth);
  if (kind === "none") return;

  const pre: PDFOperator[] = [pushGraphicsState()];
  if (alpha < 1) pre.push(setGraphicsState(alphaState(doc, page, alphaCache, alpha)));

  if (kind === "fill" || kind === "fillAndStroke") {
    const c = toPdfColor(fill, grayPolicy);
    if (c) {
      pre.push(setFillingColor(c));
      colors.push(fill);
    }
  }
  if (kind === "stroke" || kind === "fillAndStroke") {
    const c = toPdfColor(stroke, grayPolicy);
    if (c) {
      pre.push(setStrokingColor(c));
      colors.push(stroke);
    }
    pre.push(setLineWidth(space.len(strokeWidth)));
  }

  page.pushOperators(...pre, ...segs, paintOperator(kind), popGraphicsState());
}

function drawPath(
  doc: PDFDocument,
  page: PDFPage,
  space: CardSpace,
  alphaCache: AlphaCache,
  op: PathOp,
  alpha: number,
  grayPolicy: GrayPolicy,
  colors: PrintColor[],
): void {
  paintPath(
    doc,
    page,
    alphaCache,
    pathOps(space, op.segs),
    op.fill,
    op.stroke,
    op.strokeWidth,
    alpha,
    grayPolicy,
    space,
    colors,
  );
}

function drawEllipse(
  doc: PDFDocument,
  page: PDFPage,
  space: CardSpace,
  alphaCache: AlphaCache,
  op: EllipseOp,
  alpha: number,
  grayPolicy: GrayPolicy,
  colors: PrintColor[],
): void {
  paintPath(
    doc,
    page,
    alphaCache,
    pathOps(space, ellipseSegs(op.rect)),
    op.fill,
    op.stroke,
    op.strokeWidth,
    alpha,
    grayPolicy,
    space,
    colors,
  );
}

function drawLine(
  doc: PDFDocument,
  page: PDFPage,
  space: CardSpace,
  alphaCache: AlphaCache,
  op: LineOp,
  alpha: number,
  grayPolicy: GrayPolicy,
  colors: PrintColor[],
): void {
  const c = toPdfColor(op.stroke, grayPolicy);
  if (!c || op.strokeWidth <= 0) return;
  colors.push(op.stroke);
  const pre: PDFOperator[] = [pushGraphicsState()];
  if (alpha < 1) pre.push(setGraphicsState(alphaState(doc, page, alphaCache, alpha)));
  page.pushOperators(
    ...pre,
    setStrokingColor(c),
    setLineWidth(space.len(op.strokeWidth)),
    moveTo(space.x(op.x1), space.y(op.y1)),
    lineTo(space.x(op.x2), space.y(op.y2)),
    strokePath(),
    popGraphicsState(),
  );
}

/**
 * One `drawText` per span, at the span's own x and BASELINE y.
 *
 * The layout engine has already decided where every span sits; this must not
 * re-measure or re-break anything. Tracking is applied with the text state's
 * `Tc` operator, which adds a fixed advance after every glyph — the identical
 * model `measureString()` uses, which is why a tracked span occupies the same
 * width in the PDF as it did on the artboard. pdf-lib's `drawText` has no
 * tracking option, so `Tc` is set on the enclosing graphics state; `drawText`
 * pushes its own q/Q inside that, inherits the value, and the outer Q restores
 * it.
 */
function drawTextOp(
  doc: PDFDocument,
  page: PDFPage,
  space: CardSpace,
  alphaCache: AlphaCache,
  op: TextOp,
  alpha: number,
  grayPolicy: GrayPolicy,
  fonts: EmbeddedFaces,
  colors: PrintColor[],
  missingFamilies: Set<string>,
): number {
  if (op.fill.space !== "none") {
    paintPath(
      doc,
      page,
      alphaCache,
      pathOps(space, roundedRectPath(op.frame, 0)),
      op.fill,
      { space: "none" },
      0,
      alpha,
      grayPolicy,
      space,
      colors,
    );
  }
  for (const family of op.fontsMissing) missingFamilies.add(family);

  let drawn = 0;
  for (const span of op.spans) {
    if (!span.text) continue;
    const font = fonts.get(span.faceKey);
    if (!font) throw new FaceNotEmbeddedError(span.faceKey);
    const color = toPdfColor(span.color, grayPolicy);
    if (!color) continue;
    colors.push(span.color);

    const tracking = space.len(span.tracking);
    if (tracking !== 0) page.pushOperators(pushGraphicsState(), setCharacterSpacing(tracking));
    page.drawText(span.text, {
      x: space.x(span.x),
      y: space.y(span.y),
      size: space.len(span.fontSize),
      font,
      color,
      ...(alpha < 1 ? { opacity: alpha } : {}),
    });
    if (tracking !== 0) page.pushOperators(popGraphicsState());
    drawn += 1;
  }
  return drawn;
}

/**
 * Place a raster inside its element frame.
 *
 * `dest` is where the CROPPED region of the source must land, so the full image
 * is placed on the enlarged rect that puts the crop window exactly on `dest`,
 * and the frame clips the rest. No pixels are resampled: the RIP does the
 * scaling from the original samples.
 */
function drawImage(
  page: PDFPage,
  space: CardSpace,
  op: ImageOp,
  alpha: number,
  images: ReadonlyMap<string, PlacedImage>,
): boolean {
  if (!op.assetId) return false;
  if (op.missing) throw new MissingAssetError(op.assetId, "metadata-unresolved");
  const placed = images.get(op.assetId);
  if (!placed) throw new MissingAssetError(op.assetId);

  const cropW = op.crop.w > 0 ? op.crop.w / 10_000 : 1;
  const cropH = op.crop.h > 0 ? op.crop.h / 10_000 : 1;
  const fullW = op.dest.w / cropW;
  const fullH = op.dest.h / cropH;
  const full: Rect = {
    x: Math.round(op.dest.x - fullW * (op.crop.x / 10_000)),
    y: Math.round(op.dest.y - fullH * (op.crop.y / 10_000)),
    w: Math.round(fullW),
    h: Math.round(fullH),
  };

  const clipRadius = clampRadius(op.clip, op.cornerRadius);
  const ops: PDFOperator[] = [
    pushGraphicsState(),
    ...pathOps(space, roundedRectPath(op.clip, clipRadius)),
    clip(),
    endPath(),
  ];
  // A second clip intersects the first, holding the crop window to `dest`.
  const cropped = op.crop.x !== 0 || op.crop.y !== 0 || cropW !== 1 || cropH !== 1;
  if (cropped) {
    ops.push(...pathOps(space, roundedRectPath(op.dest, 0)), clip(), endPath());
  }
  page.pushOperators(...ops);

  const box = space.rect(full);
  page.drawImage(placed.image, {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    ...(alpha < 1 ? { opacity: alpha } : {}),
  });
  page.pushOperators(popGraphicsState());
  return true;
}

/**
 * Every bar module as a filled rectangle. Vector, always (§15, §32): a barcode
 * that is rasterised loses the edge definition a verifier grades on.
 */
function drawBarcode(
  doc: PDFDocument,
  page: PDFPage,
  space: CardSpace,
  alphaCache: AlphaCache,
  op: BarcodeOp,
  alpha: number,
  grayPolicy: GrayPolicy,
  fonts: EmbeddedFaces,
  colors: PrintColor[],
): number {
  const render = op.render;
  if (!render) return 0;

  if (op.quietZoneFill.space !== "none") {
    paintPath(
      doc,
      page,
      alphaCache,
      pathOps(space, roundedRectPath(op.quietBox, 0)),
      op.quietZoneFill,
      { space: "none" },
      0,
      alpha,
      grayPolicy,
      space,
      colors,
    );
  }

  const barColor = toPdfColor(op.barColor, grayPolicy);
  if (!barColor) return 0;
  colors.push(op.barColor);

  const pre: PDFOperator[] = [pushGraphicsState()];
  if (alpha < 1) pre.push(setGraphicsState(alphaState(doc, page, alphaCache, alpha)));
  pre.push(setFillingColor(barColor));

  const bars: PDFOperator[] = [];
  for (const bar of render.bars) {
    const r: Rect = { x: op.origin.x + bar.x, y: op.origin.y + bar.y, w: bar.w, h: bar.h };
    bars.push(...pathOps(space, roundedRectPath(r, 0)));
  }
  if (bars.length > 0) {
    page.pushOperators(...pre, ...bars, fillPath(), popGraphicsState());
  }

  if (render.text.length > 0) {
    const hriFaceKey = resolveFaceKey(
      op.humanReadableFontFamily,
      op.humanReadableFontWeight,
      false,
    );
    const font = fonts.get(hriFaceKey);
    if (!font) throw new FaceNotEmbeddedError(hriFaceKey);
    const metrics = getFaceMetrics(
      op.humanReadableFontFamily,
      op.humanReadableFontWeight,
      false,
    );
    for (const run of render.text) {
      if (!run.text) continue;
      // Centring uses the shared layout engine's advance widths, so the digits
      // sit where the artboard puts them rather than where a second, different
      // text measurement would.
      let x = op.origin.x + run.x;
      if (run.align === "center") {
        const measured = Math.round(measureString(run.text, metrics.metrics, run.fontSize, 0));
        x += Math.round((run.width - measured) / 2);
      }
      page.drawText(run.text, {
        x: space.x(x),
        y: space.y(op.origin.y + run.baseline),
        size: space.len(run.fontSize),
        font,
        color: barColor,
        ...(alpha < 1 ? { opacity: alpha } : {}),
      });
    }
  }

  return render.bars.length;
}
