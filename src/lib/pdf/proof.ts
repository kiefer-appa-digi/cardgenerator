import {
  PDFDocument,
  PDFName,
  PDFOperator,
  PDFOperatorNames,
  PDFString,
  appendBezierCurve,
  closePath,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  restoreDashPattern,
  setDashPattern,
  setLineWidth,
  setStrokingColor,
  stroke as strokePath,
  type PDFFont,
  type PDFPage,
  type PDFRef,
} from "pdf-lib";
import { ptToUpt, uptToIn, uptToMm, uptToPt, type Upt } from "@/lib/units";
import {
  clampRadius,
  rectBottom,
  rectRight,
  roundedRectPath,
  type BezierSeg,
  type Rect,
} from "@/lib/geometry/types";
import { CARD_PRESETS, type CardPresetDef } from "@/lib/geometry/presets";
import { cmykPct, type PrintColor } from "@/lib/color/types";
import type { SideKey } from "@/lib/design/schema";
import type { SidePlan } from "@/lib/design/render";
import type { PreflightReport } from "@/lib/preflight/types";
import { getFaceMetrics, measureString, type FaceMetrics } from "@/lib/text/layout";
import {
  collectRequiredFaces,
  drawSidePlan,
  ellipseSegs,
  embedPlanAssets,
  type CardSpace,
  type SideDrawReport,
} from "./draw";
import { DEFAULT_GRAY_POLICY, toPdfColor } from "./color";
import { embedFaces } from "./fonts";
import {
  DETERMINISTIC_TIMESTAMP,
  addCardPage,
  applyDocumentMetadata,
  buildExportNotes,
  finaliseExport,
  mergeComplianceStatus,
  setCardBoxes,
  type ExportPageBoxes,
  type PdfExportResult,
  type ProductionPdfOptions,
} from "./production";

/**
 * PROOF PDF — spec §15B, §17.
 *
 * The production artwork, unchanged, plus a labelled overlay: trim with its real
 * 0.25 in rounded corners, the bleed boundary, the safe area, the clamshell
 * cavity footprint, centre lines, corner crop and registration marks, and a slug
 * carrying the identity of the job.
 *
 * TWO THINGS KEEP THIS FROM BEING MISTAKEN FOR ARTWORK.
 *
 * 1. The proof page is LARGER than the card. The slug sits in a margin outside
 *    the bleed box, so it cannot overlap the artwork and cannot be trimmed into
 *    the finished card.
 *
 * 2. The overlay is inside an Optional Content Group whose /Usage sets
 *    /PrintState /OFF and whose name says what it is, so a viewer that honours
 *    optional content will not print it.
 *
 * Both of those are belt and braces. The real guarantee is structural: the
 * production exporter never calls anything in this file, and draw.ts — the only
 * module that paints artwork — has no overlay drawing code at all, because
 * `SidePlan.ops` cannot express a trim line.
 *
 * The overlay reuses the SAME `CardSpace` transform the artwork was drawn with,
 * so the trim line on the proof is the trim line the production TrimBox names.
 * Two separately computed transforms would eventually disagree.
 */

/* ---------------------------------------------------------------- palette */

/** Overlay colours, CMYK so the proof stays in one colour model with the job. */
const OVERLAY = {
  bleed: cmykPct(100, 0, 0, 0),
  trim: cmykPct(0, 100, 0, 0),
  safe: cmykPct(100, 0, 100, 0),
  cavity: cmykPct(0, 45, 100, 0),
  centre: cmykPct(0, 0, 0, 45),
  /** Registration black: all four plates solid, the standard for press marks. */
  registration: cmykPct(100, 100, 100, 100),
  slugText: cmykPct(0, 0, 0, 100),
  slugMuted: cmykPct(0, 0, 0, 60),
  warning: cmykPct(0, 90, 88, 0),
} as const;

/* ------------------------------------------------------------------ sheet */

/**
 * Margins around the card on the proof sheet, in PDF points. The bottom margin
 * carries the slug and is sized so the slug clears the crop marks, which reach
 * 30 pt beyond the trim edge.
 */
export const PROOF_MARGINS = { left: 54, right: 54, top: 54, bottom: 270 } as const;

/** Narrow presets still get a sheet wide enough for the slug to set properly. */
export const PROOF_MIN_SHEET_WIDTH_PT = 486;

/** Crop marks start this far outside the trim edge and run this long, in points. */
const CROP_MARK_OFFSET_PT = 12;
const CROP_MARK_LENGTH_PT = 18;

const SLUG_TOP_INSET_PT = 66;
const LEGEND_SWATCH_PT = 16;
const SLUG_TITLE_SIZE = 11;
const SLUG_LABEL_SIZE = 6.5;
const SLUG_VALUE_SIZE = 8;
const SLUG_LINE = 12.5;
const SLUG_LABEL_GAP = 5;

/* ------------------------------------------------------------------ input */

export type ProofInfo = {
  cardName: string;
  sku: string;
  gtin: string;
  presetCode: CardPresetDef["code"];
  revision: string;
  /** e.g. "Draft", "In review", "Approved 2026-08-26 by J. Rivera". */
  approvalStatus: string;
  /**
   * Rendered timestamp string. Passed in rather than read from the clock so a
   * proof is reproducible and so the string matches the approval record.
   */
  exportedAt?: string;
  productName?: string;
  /** Preflight result to summarise in the slug. */
  preflight?: PreflightReport;
  /** Free-form line, e.g. a press instruction. */
  note?: string;
};

export type ProofPdfOptions = ProductionPdfOptions & {
  info: ProofInfo;
  /** Set false to place the artwork on the larger sheet with no overlay at all. */
  overlay?: boolean;
};

/* -------------------------------------------------- optional content group */

/**
 * One OCG for the document, declared non-printing. Each page still has to name
 * it in /Resources /Properties for `/OC /OC0 BDC` to resolve.
 */
function registerOverlayOcg(doc: PDFDocument): PDFRef {
  const ocg = doc.context.register(
    doc.context.obj({
      Type: "OCG",
      Name: PDFString.of("Proof overlay — non-printing"),
      Usage: {
        Print: { PrintState: "OFF" },
        View: { ViewState: "ON" },
      },
    }),
  );
  doc.catalog.set(
    PDFName.of("OCProperties"),
    doc.context.obj({
      OCGs: [ocg],
      D: {
        Order: [ocg],
        ON: [ocg],
        // The auto-state array is what actually makes a printer drop the layer.
        AS: [{ Event: "Print", Category: ["Print"], OCGs: [ocg] }],
      },
    }),
  );
  return ocg;
}

const OVERLAY_PROPERTY_NAME = PDFName.of("OC0");

function attachOverlayProperties(doc: PDFDocument, page: PDFPage, ocg: PDFRef): void {
  page.node.normalize();
  page.node.Resources()?.set(PDFName.of("Properties"), doc.context.obj({ OC0: ocg }));
}

function beginOverlay(): PDFOperator {
  return PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
    PDFName.of("OC"),
    OVERLAY_PROPERTY_NAME,
  ]);
}

function endOverlay(): PDFOperator {
  return PDFOperator.of(PDFOperatorNames.EndMarkedContent);
}

/* -------------------------------------------------------- drawing helpers */

function segOps(space: CardSpace, segs: readonly BezierSeg[]): PDFOperator[] {
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

function strokeSegs(
  page: PDFPage,
  space: CardSpace,
  segs: readonly BezierSeg[],
  color: PrintColor,
  widthPt: number,
  dash?: [number, number],
): void {
  const pdfColor = toPdfColor(color, DEFAULT_GRAY_POLICY);
  if (!pdfColor) return;
  page.pushOperators(
    pushGraphicsState(),
    setStrokingColor(pdfColor),
    setLineWidth(widthPt),
    ...(dash ? [setDashPattern(dash, 0)] : []),
    ...segOps(space, segs),
    strokePath(),
    ...(dash ? [restoreDashPattern()] : []),
    popGraphicsState(),
  );
}

function lineSegs(x1: Upt, y1: Upt, x2: Upt, y2: Upt): BezierSeg[] {
  return [
    { t: "M", x: x1, y: y1 },
    { t: "L", x: x2, y: y2 },
  ];
}

/** Small overlay caption, set in card space at a baseline. */
function overlayLabel(
  page: PDFPage,
  space: CardSpace,
  font: PDFFont,
  text: string,
  x: Upt,
  baseline: Upt,
  color: PrintColor,
  sizePt = 5.5,
): void {
  const pdfColor = toPdfColor(color, DEFAULT_GRAY_POLICY);
  if (!pdfColor) return;
  page.drawText(text, { x: space.x(x), y: space.y(baseline), size: sizePt, font, color: pdfColor });
}

/* ---------------------------------------------------------------- overlay */

/**
 * Safe-area corner radius. The safe rect is inset from trim, so its corners
 * follow the trim arc reduced by the inset. Computed from the left inset, which
 * is exact for the uniform insets all three presets ship with and conservative
 * (a slightly tighter arc) for a non-uniform override.
 */
function safeCornerRadius(plan: SidePlan): Upt {
  const inset = plan.safe.x - plan.trim.x;
  return clampRadius(plan.safe, Math.max(0, plan.cornerRadius - inset));
}

function drawCropMarks(page: PDFPage, space: CardSpace, trim: Rect): void {
  const offset = ptToUpt(CROP_MARK_OFFSET_PT);
  const length = ptToUpt(CROP_MARK_LENGTH_PT);
  const xs: Array<readonly [Upt, -1 | 1]> = [
    [trim.x, -1],
    [rectRight(trim), 1],
  ];
  const ys: Array<readonly [Upt, -1 | 1]> = [
    [trim.y, -1],
    [rectBottom(trim), 1],
  ];
  for (const [x, xDir] of xs) {
    for (const [y, yDir] of ys) {
      // Horizontal arm on the trim's y, running outward in x.
      strokeSegs(
        page,
        space,
        lineSegs(x + xDir * offset, y, x + xDir * (offset + length), y),
        OVERLAY.registration,
        0.4,
      );
      // Vertical arm on the trim's x, running outward in y.
      strokeSegs(
        page,
        space,
        lineSegs(x, y + yDir * offset, x, y + yDir * (offset + length)),
        OVERLAY.registration,
        0.4,
      );
    }
  }
}

/** A registration bullseye: two concentric rings plus a full crosshair. */
function drawRegistrationTarget(page: PDFPage, space: CardSpace, cx: Upt, cy: Upt): void {
  for (const r of [ptToUpt(5), ptToUpt(2.5)]) {
    strokeSegs(
      page,
      space,
      ellipseSegs({ x: cx - r, y: cy - r, w: r * 2, h: r * 2 }),
      OVERLAY.registration,
      0.4,
    );
  }
  const arm = ptToUpt(8);
  strokeSegs(page, space, lineSegs(cx - arm, cy, cx + arm, cy), OVERLAY.registration, 0.4);
  strokeSegs(page, space, lineSegs(cx, cy - arm, cx, cy + arm), OVERLAY.registration, 0.4);
}

function drawOverlay(
  page: PDFPage,
  space: CardSpace,
  plan: SidePlan,
  preset: CardPresetDef,
  labelFont: PDFFont,
): void {
  const { canvas, trim, safe, cavity } = plan;

  strokeSegs(page, space, roundedRectPath(canvas, 0), OVERLAY.bleed, 0.5);
  // Trim, with the real corner radius — the line the die actually cuts.
  strokeSegs(page, space, roundedRectPath(trim, plan.cornerRadius), OVERLAY.trim, 0.7);
  strokeSegs(page, space, roundedRectPath(safe, safeCornerRadius(plan)), OVERLAY.safe, 0.5, [4, 2]);
  // Cavity footprint, from the measured dieline geometry (§17).
  strokeSegs(
    page,
    space,
    roundedRectPath(cavity, clampRadius(cavity, preset.cavity.cornerRadius)),
    OVERLAY.cavity,
    0.5,
    [2, 2],
  );

  const cx = trim.x + Math.round(trim.w / 2);
  const cy = trim.y + Math.round(trim.h / 2);
  strokeSegs(page, space, lineSegs(trim.x, cy, rectRight(trim), cy), OVERLAY.centre, 0.35, [3, 3]);
  strokeSegs(page, space, lineSegs(cx, trim.y, cx, rectBottom(trim)), OVERLAY.centre, 0.35, [3, 3]);

  drawCropMarks(page, space, trim);
  // Targets go in the top and side margins. The bottom margin belongs to the slug.
  drawRegistrationTarget(page, space, cx, canvas.y - ptToUpt(28));
  drawRegistrationTarget(page, space, canvas.x - ptToUpt(28), cy);
  drawRegistrationTarget(page, space, rectRight(canvas) + ptToUpt(28), cy);

  // The only caption on the sheet itself is the trim dimension, set below the
  // bleed box and clear of the crop marks. Every other mark is named in the
  // legend in the slug: captions floating over the artwork make a proof harder
  // to read, which is the one thing a proof must not be.
  overlayLabel(
    page,
    space,
    labelFont,
    `TRIM ${inches(trim.w)} × ${inches(trim.h)} in · R ${inches(plan.cornerRadius)} in`,
    trim.x + ptToUpt(16),
    rectBottom(canvas) + ptToUpt(11),
    OVERLAY.trim,
  );
}

/* ----------------------------------------------------------------- legend */

type LegendEntry = { color: PrintColor; dash?: [number, number]; label: string };

function legendEntries(preset: CardPresetDef): LegendEntry[] {
  return [
    { color: OVERLAY.bleed, label: "BLEED" },
    { color: OVERLAY.trim, label: "TRIM / die cut" },
    { color: OVERLAY.safe, dash: [4, 2], label: "SAFE AREA" },
    {
      color: OVERLAY.cavity,
      dash: [2, 2],
      label: `CAVITY ${preset.code}${preset.cavity.cornerRadiusIsApproximate ? " (radius approximate — verify)" : ""}`,
    },
    { color: OVERLAY.centre, dash: [3, 3], label: "CENTRE LINES" },
  ];
}

/**
 * The mark key, set in the slug rather than as captions floating over the
 * artwork. A proof has to stay readable as artwork while it explains itself.
 */
function drawLegend(
  page: PDFPage,
  preset: CardPresetDef,
  font: PDFFont,
  left: number,
  right: number,
  firstBaseline: number,
): number {
  const metrics = getFaceMetrics("Inter", 400, false).metrics;
  const size = ptToUpt(SLUG_LABEL_SIZE);
  const ink = toPdfColor(OVERLAY.slugMuted, DEFAULT_GRAY_POLICY);
  if (!ink) return 0;

  let x = left;
  let baseline = firstBaseline;
  let rows = 1;
  for (const entry of legendEntries(preset)) {
    const width =
      LEGEND_SWATCH_PT + 4 + uptToPt(measureString(entry.label, metrics, size, 0)) + 14;
    // Wrap rather than drop an entry: a key that silently omits a mark is worse
    // than a key on two lines.
    if (x > left && x + width > right) {
      x = left;
      baseline -= SLUG_LINE * 0.85;
      rows += 1;
    }
    const swatch = toPdfColor(entry.color, DEFAULT_GRAY_POLICY);
    if (!swatch) continue;
    page.pushOperators(
      pushGraphicsState(),
      setStrokingColor(swatch),
      setLineWidth(1),
      ...(entry.dash ? [setDashPattern(entry.dash, 0)] : []),
      moveTo(x, baseline + 2),
      lineTo(x + LEGEND_SWATCH_PT, baseline + 2),
      strokePath(),
      ...(entry.dash ? [restoreDashPattern()] : []),
      popGraphicsState(),
    );
    page.drawText(entry.label, {
      x: x + LEGEND_SWATCH_PT + 4,
      y: baseline,
      size: SLUG_LABEL_SIZE,
      font,
      color: ink,
    });
    x += width;
  }
  return rows;
}

/* ------------------------------------------------------------------- slug */

type SlugField = { label: string; value: string };

/** Trim a value to a measured width, marking the elision rather than hiding it. */
function fitText(text: string, metrics: FaceMetrics, sizePt: number, maxWidthPt: number): string {
  const size = ptToUpt(sizePt);
  if (uptToPt(measureString(text, metrics, size, 0)) <= maxWidthPt) return text;
  let out = text;
  while (out.length > 1) {
    out = out.slice(0, -1);
    if (uptToPt(measureString(`${out}…`, metrics, size, 0)) <= maxWidthPt) return `${out}…`;
  }
  return "…";
}

function inches(u: Upt): string {
  return uptToIn(u)
    .toFixed(5)
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "");
}

function shortFields(plan: SidePlan, preset: CardPresetDef, info: ProofInfo): SlugField[] {
  return [
    { label: "CARD", value: info.cardName || "—" },
    { label: "PRODUCT", value: info.productName ?? "—" },
    { label: "SKU", value: info.sku || "—" },
    { label: "GTIN", value: info.gtin || "—" },
    { label: "PRESET", value: preset.code },
    { label: "REVISION", value: info.revision || "—" },
    { label: "SIDE", value: plan.side.toUpperCase() },
    { label: "CORNER", value: `R ${inches(plan.cornerRadius)} in` },
    { label: "SAFE INSET", value: `${inches(plan.safe.x - plan.trim.x)} in from trim` },
    { label: "BLEED", value: `${inches(plan.trim.x - plan.canvas.x)} in per side` },
    { label: "APPROVAL", value: info.approvalStatus || "Not recorded" },
    { label: "EXPORTED", value: info.exportedAt ?? "—" },
  ];
}

function dimensionLines(plan: SidePlan): string[] {
  const dim = (r: Rect) =>
    `${inches(r.w)} × ${inches(r.h)} in  (${uptToMm(r.w).toFixed(2)} × ${uptToMm(r.h).toFixed(2)} mm)`;
  return [
    `TRIM   ${dim(plan.trim)}`,
    `BLEED  ${dim(plan.canvas)}`,
    `SAFE   ${dim(plan.safe)}`,
  ];
}

function preflightLine(info: ProofInfo): { text: string; color: PrintColor } {
  const r = info.preflight;
  if (!r) return { text: "PREFLIGHT   not run for this proof", color: OVERLAY.slugMuted };
  const c = r.counts;
  return {
    text:
      `PREFLIGHT   ${r.profileName} — ${c.blocking} blocking, ${c.error} error, ` +
      `${c.warning} warning, ${c.info} info — ` +
      `${r.exportable ? "production export permitted" : "PRODUCTION EXPORT BLOCKED"}`,
    color: r.exportable ? OVERLAY.slugText : OVERLAY.warning,
  };
}

/**
 * The slug sits in the sheet's bottom margin, outside the bleed box, so it
 * cannot overlap artwork and cannot survive trimming.
 */
function drawSlug(
  page: PDFPage,
  plan: SidePlan,
  preset: CardPresetDef,
  info: ProofInfo,
  fonts: { regular: PDFFont; bold: PDFFont },
  sheetWidthPt: number,
): void {
  const left = PROOF_MARGINS.left;
  const right = sheetWidthPt - PROOF_MARGINS.right;
  const top = PROOF_MARGINS.bottom - SLUG_TOP_INSET_PT;

  const muted = toPdfColor(OVERLAY.slugMuted, DEFAULT_GRAY_POLICY);
  const text = toPdfColor(OVERLAY.slugText, DEFAULT_GRAY_POLICY);
  const alarm = toPdfColor(OVERLAY.warning, DEFAULT_GRAY_POLICY);
  if (!muted || !text || !alarm) return;

  page.pushOperators(
    pushGraphicsState(),
    setStrokingColor(muted),
    setLineWidth(0.5),
    moveTo(left, top + 14),
    lineTo(right, top + 14),
    strokePath(),
    popGraphicsState(),
  );

  let y = top - SLUG_TITLE_SIZE;
  page.drawText("PROOF — NOT FOR PRODUCTION", {
    x: left,
    y,
    size: SLUG_TITLE_SIZE,
    font: fonts.bold,
    color: alarm,
  });
  page.drawText(
    "Trim, bleed, safe area, cavity, centre lines and registration marks are a non-printing " +
      "overlay layer and are not part of the artwork.",
    { x: left, y: y - SLUG_LINE, size: SLUG_LABEL_SIZE, font: fonts.regular, color: muted },
  );

  y -= SLUG_LINE * 1.9;
  const legendRows = drawLegend(page, preset, fonts.regular, left, right, y);
  y -= SLUG_LINE * (0.85 * (legendRows - 1) + 1.6);

  const labelMetrics = getFaceMetrics("Inter", 700, false).metrics;
  const valueMetrics = getFaceMetrics("Inter", 400, false).metrics;
  const fields = shortFields(plan, preset, info);
  const labelWidthPt =
    Math.max(
      ...fields.map((f) =>
        uptToPt(measureString(f.label, labelMetrics, ptToUpt(SLUG_LABEL_SIZE), 0)),
      ),
    ) + SLUG_LABEL_GAP;

  const columnWidth = (right - left) / 2;
  const perColumn = Math.ceil(fields.length / 2);
  fields.forEach((field, i) => {
    const col = Math.floor(i / perColumn);
    const row = i % perColumn;
    const fx = left + col * columnWidth;
    const fy = y - row * SLUG_LINE;
    page.drawText(field.label, {
      x: fx,
      y: fy,
      size: SLUG_LABEL_SIZE,
      font: fonts.bold,
      color: muted,
    });
    page.drawText(
      fitText(field.value, valueMetrics, SLUG_VALUE_SIZE, columnWidth - labelWidthPt - 8),
      {
        x: fx + labelWidthPt,
        y: fy,
        size: SLUG_VALUE_SIZE,
        font: fonts.regular,
        color: text,
      },
    );
  });

  // Physical dimensions get full-width lines; squeezed into a column they would
  // have to be elided, and a proof exists to state the dimensions exactly.
  let dy = y - perColumn * SLUG_LINE - 2;
  for (const line of dimensionLines(plan)) {
    page.drawText(line, { x: left, y: dy, size: SLUG_LABEL_SIZE, font: fonts.bold, color: text });
    dy -= SLUG_LINE * 0.85;
  }

  dy -= 3;
  const pf = preflightLine(info);
  const pfColor = toPdfColor(pf.color, DEFAULT_GRAY_POLICY);
  if (pfColor) {
    page.drawText(fitText(pf.text, labelMetrics, SLUG_LABEL_SIZE, right - left), {
      x: left,
      y: dy,
      size: SLUG_LABEL_SIZE,
      font: fonts.bold,
      color: pfColor,
    });
  }
  if (info.note) {
    page.drawText(fitText(info.note, valueMetrics, SLUG_LABEL_SIZE, right - left), {
      x: left,
      y: dy - SLUG_LINE * 0.85,
      size: SLUG_LABEL_SIZE,
      font: fonts.regular,
      color: muted,
    });
  }
}

/* ------------------------------------------------------------------ entry */

/** Faces the proof chrome itself needs, on top of whatever the artwork uses. */
export const PROOF_CHROME_FACES = ["Inter:400", "Inter:700"] as const;

/** Words that must appear on a proof and must never appear in production art. */
export const PROOF_OVERLAY_LABELS = [
  "PROOF",
  "BLEED",
  "TRIM",
  "SAFE AREA",
  "CAVITY",
  "PREFLIGHT",
] as const;

export async function renderProofPdf(opts: ProofPdfOptions): Promise<PdfExportResult> {
  const plans = [opts.plans.front, opts.plans.back];
  const preset = CARD_PRESETS[opts.info.presetCode];
  const withOverlay = opts.overlay !== false;

  const doc = await PDFDocument.create({ updateMetadata: false });
  applyDocumentMetadata(
    doc,
    {
      ...opts.metadata,
      title: opts.metadata?.title ?? `${opts.info.cardName} — proof ${opts.info.revision}`,
      subject:
        opts.metadata?.subject ??
        `Proof for ${opts.info.sku || opts.info.cardName} on ${preset.code}. Not production artwork.`,
    },
    opts.timestamp ?? DETERMINISTIC_TIMESTAMP,
  );

  const faces = await embedFaces(doc, [...collectRequiredFaces(plans), ...PROOF_CHROME_FACES], {
    fontDir: opts.fontDir,
  });
  const images = await embedPlanAssets(doc, plans, opts.assetBytes);
  const grayPolicy = opts.grayPolicy ?? DEFAULT_GRAY_POLICY;

  const regular = faces.get("Inter:400");
  const bold = faces.get("Inter:700");
  if (!regular || !bold) {
    throw new Error("Proof chrome fonts failed to embed; the proof cannot be labelled.");
  }

  const ocg = withOverlay ? registerOverlayOcg(doc) : null;
  const pageBoxes: ExportPageBoxes[] = [];
  const reports: Array<{ side: SideKey; report: SideDrawReport }> = [];

  plans.forEach((plan, index) => {
    const cardWidthPt = uptToPt(plan.canvas.w);
    const cardHeightPt = uptToPt(plan.canvas.h);
    const pageWidthPt = Math.max(
      PROOF_MIN_SHEET_WIDTH_PT,
      cardWidthPt + PROOF_MARGINS.left + PROOF_MARGINS.right,
    );
    const pageHeightPt = cardHeightPt + PROOF_MARGINS.top + PROOF_MARGINS.bottom;
    // Centre a narrow card on a sheet widened for the slug.
    const originXPt = (pageWidthPt - cardWidthPt) / 2 - uptToPt(plan.canvas.x);

    const { page, space } = addCardPage(doc, {
      pageWidthPt,
      pageHeightPt,
      originXPt,
      originTopYPt: pageHeightPt - PROOF_MARGINS.top + uptToPt(plan.canvas.y),
    });

    pageBoxes.push(setCardBoxes(page, plan, space, index));

    // Artwork first, drawn by exactly the same code the production exporter uses.
    reports.push({
      side: plan.side,
      report: drawSidePlan({ doc, page, plan, space, fonts: faces, images, grayPolicy }),
    });

    if (ocg) {
      attachOverlayProperties(doc, page, ocg);
      page.pushOperators(beginOverlay());
      drawOverlay(page, space, plan, preset, regular);
      drawSlug(page, plan, preset, opts.info, { regular, bold }, pageWidthPt);
      page.pushOperators(endOverlay());
    }
  });

  const { bytes, outputIntent } = await finaliseExport(
    doc,
    faces,
    opts.outputIntent,
    opts.outputIntentSubtype,
  );

  return {
    bytes,
    complianceStatus: mergeComplianceStatus(reports, faces, outputIntent, "proof-pdf"),
    notes: buildExportNotes(reports, outputIntent),
    pageBoxes,
  };
}
