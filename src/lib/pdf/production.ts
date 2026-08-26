import { PDFDocument, PDFName, PDFString, type PDFPage } from "pdf-lib";
import { uptToPt } from "@/lib/units";
import type { Rect } from "@/lib/geometry/types";
import type { OutputIntent } from "@/lib/color/types";
import { SIDE_KEYS, type SideKey } from "@/lib/design/schema";
import type { SidePlan } from "@/lib/design/render";
import type { PreflightFinding } from "@/lib/preflight/types";
import {
  cardSpace,
  collectRequiredFaces,
  drawSidePlan,
  embedPlanAssets,
  type AssetBytesLoader,
  type CardSpace,
  type PlacedImage,
  type PlacedImageReport,
  type SideDrawReport,
} from "./draw";
import { DEFAULT_GRAY_POLICY, type GrayPolicy, type SpotConversion } from "./color";
import { embedFaces, finaliseFontSubsets, type EmbeddedFaces } from "./fonts";

/**
 * PRODUCTION PDF — spec §15A, §22.
 *
 * Two pages, front then back. Each page IS the full-bleed canvas: MediaBox,
 * CropBox and BleedBox are the whole sheet at the origin, and TrimBox is the
 * card, inset by the bleed. A RIP that honours TrimBox therefore knows exactly
 * where to cut without being told separately.
 *
 * No overlays. This file never imports the proof overlay and `draw.ts` has no
 * function that could paint one (see the header comment there).
 *
 * Deterministic: the same plans, assets and timestamp produce byte-identical
 * output. `DETERMINISTIC_TIMESTAMP` is the default so a caller that does not
 * care gets reproducibility for free; a caller that wants real provenance passes
 * its own and accepts that the bytes then differ per run, by design.
 *
 * WHAT THIS FILE DOES NOT CLAIM. It does not write a PDF/X identification, and
 * `complianceStatus.claimsPdfX` is permanently false. pdf-lib can emit
 * DeviceCMYK operators, embed and subset fonts, set all five page boxes and
 * attach a real ICC OutputIntent — it cannot convert placed RGB rasters through
 * an ICC transform, emit /Separation colour spaces, flatten transparency, or
 * write the XMP that a PDF/X identification requires. See docs/print-pipeline.md
 * for exactly what remains. Renaming a normal PDF to "PDF/X" is forbidden (§15).
 */

/** Fixed epoch used when the caller supplies no timestamp, so output is reproducible. */
export const DETERMINISTIC_TIMESTAMP = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));

export const DEFAULT_PRODUCER = "Freedom Card Designer (pdf-lib 1.17.1)";
export const DEFAULT_CREATOR = "Freedom Card Designer";

/* ------------------------------------------------------------------ types */

/** A PDF page box in points, lower-left origin. */
export type ExportBox = { x: number; y: number; width: number; height: number };

export type ExportPageBoxes = {
  /** Zero-based page index in the exported file. */
  index: number;
  side: SideKey;
  mediaBox: ExportBox;
  cropBox: ExportBox;
  bleedBox: ExportBox;
  trimBox: ExportBox;
  /** Physical trim size in inches, for the job ticket. */
  trimWidthIn: number;
  trimHeightIn: number;
};

export type OutputIntentSubtype = "GTS_PDFX" | "GTS_PDFA1";

export type OutputIntentStatus = {
  embedded: boolean;
  subtype: OutputIntentSubtype | null;
  identifier: string;
  conditionName: string;
  registryName: string;
  /** Colour space declared by the ICC profile header, e.g. "CMYK". */
  iccColorSpace: string | null;
  iccByteLength: number;
  /** Why no intent was written, when none was. */
  reason: string | null;
};

export type ComplianceStatus = {
  /**
   * Honest machine label. Never a PDF/X level: this exporter does not produce
   * conforming PDF/X and says so rather than renaming a file (§15, §32).
   */
  level: "cmyk-production-pdf" | "cmyk-production-pdf-with-output-intent" | "proof-pdf";
  /** One sentence for the export screen and the job ticket. */
  label: string;
  pdfVersion: string;
  /** Permanently false. Nothing in this exporter may set it true. */
  claimsPdfX: false;
  outputIntent: OutputIntentStatus;
  /** Device colour spaces the content streams actually use. */
  colorSpaces: string[];
  fonts: {
    embedded: number;
    /** Every embedded face is subset and carries a six-letter subset tag. */
    allSubset: boolean;
    faces: Array<{ faceKey: string; subsetTag: string; sourceByteLength: number }>;
  };
  /** Families the layout engine had to substitute because the design named an unknown font. */
  fontsMissing: string[];
  transparencyPresent: boolean;
  /** Colour spaces of placed rasters as embedded. RGB here is NOT colour-converted. */
  placedImageColorSpaces: string[];
  spotConversions: SpotConversion[];
  /** Text is always live text in an embedded font; the page is never rasterised. */
  vectorText: true;
  /** The concrete work still required before a certified PDF/X-4 file exists. */
  remainingForPdfX: string[];
};

export type PdfExportResult = {
  bytes: Uint8Array;
  complianceStatus: ComplianceStatus;
  /** Export-time findings, in the same vocabulary the preflight engine uses. */
  notes: PreflightFinding[];
  pageBoxes: ExportPageBoxes[];
};

export type PdfDocumentMetadata = {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
};

export type ProductionPdfOptions = {
  plans: Record<SideKey, SidePlan>;
  /** Deployment/printer output intent (§14). Absent means none is written. */
  outputIntent?: OutputIntent;
  outputIntentSubtype?: OutputIntentSubtype;
  /** Supplies raster bytes. This module performs no I/O of its own. */
  assetBytes?: AssetBytesLoader;
  /** Override the font directory; defaults to FONT_DIR_CANDIDATES under cwd. */
  fontDir?: string;
  grayPolicy?: GrayPolicy;
  metadata?: PdfDocumentMetadata;
  /** Defaults to DETERMINISTIC_TIMESTAMP. */
  timestamp?: Date;
};

/* --------------------------------------------------------- output intents */

export class InvalidIccProfileError extends Error {
  readonly code = "INVALID_ICC_PROFILE" as const;
  constructor(reason: string) {
    super(
      `The supplied output intent ICC profile is not usable: ${reason}. A fake or ` +
        `truncated profile is worse than none, so no OutputIntent was written.`,
    );
    this.name = "InvalidIccProfileError";
  }
}

export type DecodedIcc = {
  bytes: Uint8Array;
  /** ICC data colour space signature, e.g. "CMYK", "RGB", "GRAY". */
  colorSpace: string;
  /** /N for the profile stream: 4, 3 or 1. */
  componentCount: number;
};

/**
 * Validate and decode a base64 ICC profile.
 *
 * The header is checked, not assumed: bytes 36..40 must be the `acsp`
 * signature, the declared profile size must match the payload, and the data
 * colour space must be one PDF can describe. Embedding an unverified blob as
 * /DestOutputProfile would be exactly the kind of fake compliance §32 forbids.
 */
export function decodeIccProfile(base64: string): DecodedIcc {
  // Node's base64 decoder is lenient — it drops invalid characters rather than
  // throwing — so the header checks below are what actually validate the input.
  const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
  if (bytes.byteLength < 132) {
    throw new InvalidIccProfileError(
      `it is ${bytes.byteLength} bytes; an ICC profile header alone is 128 bytes`,
    );
  }
  const sig = String.fromCharCode(bytes[36], bytes[37], bytes[38], bytes[39]);
  if (sig !== "acsp") {
    throw new InvalidIccProfileError(`the header signature is "${sig}", not "acsp"`);
  }
  const declaredSize =
    (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  if (declaredSize !== bytes.byteLength) {
    throw new InvalidIccProfileError(
      `the header declares ${declaredSize} bytes but the payload is ${bytes.byteLength}`,
    );
  }
  const space = String.fromCharCode(bytes[16], bytes[17], bytes[18], bytes[19]).trim();
  const componentCount = space === "CMYK" ? 4 : space === "GRAY" ? 1 : space === "RGB" ? 3 : 0;
  if (componentCount === 0) {
    throw new InvalidIccProfileError(`its data colour space "${space}" is not CMYK, RGB or GRAY`);
  }
  return { bytes, colorSpace: space, componentCount };
}

/**
 * Attach a real /OutputIntent built from a real ICC profile.
 *
 * When no profile is supplied nothing is written. An OutputIntent naming a
 * printing condition it cannot point at is a lie that preflight tools believe,
 * so the honest output is a file with no intent plus an OUTPUT_INTENT_MISSING
 * note saying which one the deployment still has to configure (§14).
 */
export function applyOutputIntent(
  doc: PDFDocument,
  intent: OutputIntent | undefined,
  subtype: OutputIntentSubtype = "GTS_PDFX",
): OutputIntentStatus {
  const identifier = intent?.identifier ?? "none";
  const conditionName = intent?.conditionName ?? "Not specified";
  const registryName = intent?.registryName ?? "";

  if (!intent?.iccBase64) {
    return {
      embedded: false,
      subtype: null,
      identifier,
      conditionName,
      registryName,
      iccColorSpace: null,
      iccByteLength: 0,
      reason:
        "No ICC profile was supplied. The deployment must configure the printing " +
        "condition its press actually runs (spec §14: do not invent a print profile).",
    };
  }

  const icc = decodeIccProfile(intent.iccBase64);
  const profileRef = doc.context.register(
    doc.context.flateStream(icc.bytes, { N: icc.componentCount }),
  );
  const dict = doc.context.obj({
    Type: "OutputIntent",
    S: subtype,
    // Text strings must be PDFString; context.obj() turns a bare string into a
    // PDFName, which would write /Coated_FOGRA39 instead of (Coated FOGRA39).
    OutputConditionIdentifier: PDFString.of(identifier),
    OutputCondition: PDFString.of(conditionName),
    RegistryName: PDFString.of(registryName),
    Info: PDFString.of(intent.info ?? ""),
    DestOutputProfile: profileRef,
  });
  doc.catalog.set(PDFName.of("OutputIntents"), doc.context.obj([dict]));

  return {
    embedded: true,
    subtype,
    identifier,
    conditionName,
    registryName,
    iccColorSpace: icc.colorSpace,
    iccByteLength: icc.bytes.byteLength,
    reason: null,
  };
}

/* ------------------------------------------------------------ page set-up */

/**
 * Add a page and return the card-space transform for it.
 *
 * `originXPt`/`originTopYPt` place the card's top-left bleed corner on the
 * sheet. The production sheet IS the card, so they are (0, pageHeight); the
 * proof sheet is larger and insets the card, reusing this same function.
 */
export function addCardPage(
  doc: PDFDocument,
  opts: {
    pageWidthPt: number;
    pageHeightPt: number;
    originXPt: number;
    originTopYPt: number;
  },
): { page: PDFPage; space: CardSpace } {
  const page = doc.addPage([opts.pageWidthPt, opts.pageHeightPt]);
  page.setMediaBox(0, 0, opts.pageWidthPt, opts.pageHeightPt);
  page.setCropBox(0, 0, opts.pageWidthPt, opts.pageHeightPt);
  return { page, space: cardSpace(opts.originXPt, opts.originTopYPt) };
}

function boxOf(space: CardSpace, r: Rect): ExportBox {
  const b = space.rect(r);
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

/**
 * Write BleedBox and TrimBox from the plan's own rects, then report all four
 * boxes as written. Reporting them from the same numbers that were set is why
 * `pageBoxes` can be trusted without re-parsing the file; the tests re-parse
 * anyway, because a writer that grades its own homework proves nothing.
 */
export function setCardBoxes(
  page: PDFPage,
  plan: SidePlan,
  space: CardSpace,
  index: number,
): ExportPageBoxes {
  const bleed = boxOf(space, plan.canvas);
  const trim = boxOf(space, plan.trim);
  page.setBleedBox(bleed.x, bleed.y, bleed.width, bleed.height);
  page.setTrimBox(trim.x, trim.y, trim.width, trim.height);
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  return {
    index,
    side: plan.side,
    mediaBox: { x: media.x, y: media.y, width: media.width, height: media.height },
    cropBox: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
    bleedBox: bleed,
    trimBox: trim,
    trimWidthIn: uptToPt(plan.trim.w) / 72,
    trimHeightIn: uptToPt(plan.trim.h) / 72,
  };
}

export function applyDocumentMetadata(
  doc: PDFDocument,
  metadata: PdfDocumentMetadata | undefined,
  timestamp: Date,
): void {
  doc.setProducer(metadata?.producer ?? DEFAULT_PRODUCER);
  doc.setCreator(metadata?.creator ?? DEFAULT_CREATOR);
  doc.setCreationDate(timestamp);
  doc.setModificationDate(timestamp);
  if (metadata?.title) doc.setTitle(metadata.title);
  if (metadata?.author) doc.setAuthor(metadata.author);
  if (metadata?.subject) doc.setSubject(metadata.subject);
  if (metadata?.keywords?.length) doc.setKeywords(metadata.keywords);
}

/* --------------------------------------------------------- shared pipeline */

export type PreparedExport = {
  doc: PDFDocument;
  faces: EmbeddedFaces;
  images: Map<string, PlacedImage>;
  plans: SidePlan[];
  timestamp: Date;
  grayPolicy: GrayPolicy;
};

/**
 * Create the document and load everything the pages will need, in a fixed order
 * so object numbering is reproducible.
 */
export async function prepareExport(opts: ProductionPdfOptions): Promise<PreparedExport> {
  const plans = SIDE_KEYS.map((side) => opts.plans[side]);
  const doc = await PDFDocument.create({ updateMetadata: false });
  const timestamp = opts.timestamp ?? DETERMINISTIC_TIMESTAMP;
  applyDocumentMetadata(doc, opts.metadata, timestamp);

  const faces = await embedFaces(doc, collectRequiredFaces(plans), { fontDir: opts.fontDir });
  const images = await embedPlanAssets(doc, plans, opts.assetBytes);

  return {
    doc,
    faces,
    images,
    plans,
    timestamp,
    grayPolicy: opts.grayPolicy ?? DEFAULT_GRAY_POLICY,
  };
}

/** Flush, tag the font subsets, attach the output intent, serialise. */
export async function finaliseExport(
  doc: PDFDocument,
  faces: EmbeddedFaces,
  intent: OutputIntent | undefined,
  subtype: OutputIntentSubtype | undefined,
): Promise<{ bytes: Uint8Array; outputIntent: OutputIntentStatus }> {
  await finaliseFontSubsets(doc, faces);
  const outputIntent = applyOutputIntent(doc, intent, subtype ?? "GTS_PDFX");
  // Object streams would compress the object structure, but they also make the
  // file opaque to the byte-level checks in tests/unit/pdf.test.ts and to a
  // prepress operator opening it in a text editor. A card is a small file; the
  // few kilobytes are worth the auditability.
  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, outputIntent };
}

/* ------------------------------------------------------------------ notes */

const REMAINING_FOR_PDFX: readonly string[] = [
  "Run the exported file through a PDF/X-4 conversion and verification step " +
    "(Ghostscript's pdfwrite with a PDF/X definition, callas pdfToolbox, or an " +
    "Acrobat Preflight profile) — pdf-lib writes no XMP and cannot claim conformance.",
  "Supply the press's ICC output profile so an OutputIntent can be embedded; a " +
    "PDF/X file without one is not conforming.",
  "Convert or replace placed RGB rasters: this exporter embeds them as-is with no " +
    "ICC transform, and PDF/X-4 requires either a calibrated colour space or the " +
    "output intent's space.",
  "Decide the fate of any /Separation (spot) ink: pdf-lib emits only device " +
    "spaces, so spots are currently flattened to their CMYK alternate.",
];

function finding(f: PreflightFinding): PreflightFinding {
  return f;
}

function buildNotes(
  reports: Array<{ side: SideKey; report: SideDrawReport }>,
  outputIntent: OutputIntentStatus,
): PreflightFinding[] {
  const notes: PreflightFinding[] = [];

  if (!outputIntent.embedded) {
    notes.push(
      finding({
        code: "OUTPUT_INTENT_MISSING",
        severity: "warning",
        title: "No output intent embedded",
        detail:
          outputIntent.reason ??
          "The exported PDF carries no OutputIntent, so its CMYK numbers are not tied to a printing condition.",
        remedy:
          "Configure the printer's ICC profile in the deployment's output intent settings and re-export.",
      }),
    );
  }

  for (const { side, report } of reports) {
    for (const spot of report.spotConversions) {
      notes.push(
        finding({
          code: "SPOT_CONVERTED",
          severity: "info",
          title: `Spot ink "${spot.name}" converted to process`,
          detail:
            `"${spot.name}" at ${(spot.tint / 10).toFixed(1)} % was written as ` +
            `C${(spot.alternate.c / 10).toFixed(1)} M${(spot.alternate.m / 10).toFixed(1)} ` +
            `Y${(spot.alternate.y / 10).toFixed(1)} K${(spot.alternate.k / 10).toFixed(1)}. ` +
            `pdf-lib cannot emit a /Separation colour space, so no spot plate exists in this file.`,
          side,
          remedy:
            "If the job runs a real spot plate, hand the printer the ink name and tint separately, " +
            "or route the file through a converter that can create the Separation space.",
          measurements: {
            tint: spot.tint,
            c: spot.alternate.c,
            m: spot.alternate.m,
            y: spot.alternate.y,
            k: spot.alternate.k,
          },
        }),
      );
    }

    if (report.transparencyPresent) {
      notes.push(
        finding({
          code: "TRANSPARENCY_PRESENT",
          severity: "info",
          title: "Live transparency in the artwork",
          detail:
            "One or more elements were painted with an alpha below 100 %. The PDF carries live " +
            "transparency; it is not flattened. Older RIPs and PDF/X-1a workflows require flattening.",
          side,
          remedy:
            "Confirm the press accepts live transparency (PDF/X-4 does), or flatten upstream of the RIP.",
        }),
      );
    }

    for (const family of report.fontsMissing) {
      notes.push(
        finding({
          code: "FONT_MISSING",
          severity: "error",
          title: `Font family "${family}" is not available`,
          detail:
            `The design asks for "${family}", which is not one of the licensed, embeddable ` +
            `families. The layout engine substituted a shipped face and the PDF was set in that ` +
            `substitute — the copy will not look as designed.`,
          side,
          remedy: "Re-point the affected text at one of the shipped families and re-export.",
        }),
      );
    }

    for (const placed of report.placedImages) {
      if (placed.colorSpace !== "DeviceRGB") continue;
      notes.push(
        finding({
          code: "ASSET_RGB_IN_CMYK",
          severity: "warning",
          title: "Placed image is RGB",
          detail:
            `Asset ${placed.assetId} is embedded as DeviceRGB. This exporter performs no ICC ` +
            `conversion, so the RIP will separate it with its own default — which is not the ` +
            `colour management this job's output intent describes.`,
          side,
          remedy:
            "Convert the asset to CMYK against the press profile before upload, or accept the RIP's " +
            "default separation and sign it off on a contract proof.",
          measurements: placed.effectiveDpi === null ? undefined : { effectiveDpi: placed.effectiveDpi },
        }),
      );
    }

    for (const err of report.barcodeErrors) {
      notes.push(
        finding({
          code: "BARCODE_VALUE_INVALID",
          severity: "blocking",
          title: "Barcode did not encode",
          detail: `${err.error}. Nothing was painted for this element — an unencodable value never becomes artwork.`,
          side,
          elementId: err.elementId,
          remedy: "Fix the bound value or the symbology and re-export.",
        }),
      );
    }
  }

  return notes;
}

function mergeStatus(
  reports: Array<{ side: SideKey; report: SideDrawReport }>,
  faces: EmbeddedFaces,
  outputIntent: OutputIntentStatus,
  level: ComplianceStatus["level"],
): ComplianceStatus {
  const colorSpaces = new Set<string>();
  const imageSpaces = new Set<string>();
  const spots = new Map<string, SpotConversion>();
  const missing = new Set<string>();
  let transparency = false;
  const placed: PlacedImageReport[] = [];

  for (const { report } of reports) {
    for (const s of report.colorSpaces) colorSpaces.add(s);
    for (const p of report.placedImages) {
      imageSpaces.add(p.colorSpace);
      placed.push(p);
    }
    for (const s of report.spotConversions) spots.set(`${s.name}@${s.tint}`, s);
    for (const f of report.fontsMissing) missing.add(f);
    transparency ||= report.transparencyPresent;
  }

  const faceList = faces.all();
  const label =
    level === "proof-pdf"
      ? "Proof PDF with non-printing overlay. Not press-ready artwork."
      : outputIntent.embedded
        ? `CMYK production PDF with an embedded ${outputIntent.iccColorSpace ?? ""} output intent (${outputIntent.conditionName}). Not certified PDF/X.`
        : "CMYK production PDF. No output intent embedded, and not certified PDF/X.";

  return {
    level,
    label,
    pdfVersion: "1.7",
    claimsPdfX: false,
    outputIntent,
    colorSpaces: [...colorSpaces].sort(),
    fonts: {
      embedded: faceList.length,
      // Every face is embedded with subset: true and given a six-letter tag;
      // reading the tags back is a check, where `faceList.length > 0` would only
      // have been an assumption.
      allSubset:
        faceList.length > 0 && faceList.every((f) => /^[A-Z]{6}$/.test(f.subsetTag)),
      faces: faceList.map((f) => ({
        faceKey: f.faceKey,
        subsetTag: f.subsetTag,
        sourceByteLength: f.sourceByteLength,
      })),
    },
    fontsMissing: [...missing].sort(),
    transparencyPresent: transparency,
    placedImageColorSpaces: [...imageSpaces].sort(),
    spotConversions: [...spots.values()],
    vectorText: true,
    remainingForPdfX: [...REMAINING_FOR_PDFX],
  };
}

/* ------------------------------------------------------------------ entry */

/**
 * Render the production PDF: two pages, full-bleed canvas, no overlays.
 */
export async function renderProductionPdf(
  opts: ProductionPdfOptions,
): Promise<PdfExportResult> {
  const prepared = await prepareExport(opts);
  const { doc, faces, images, plans, grayPolicy } = prepared;

  const pageBoxes: ExportPageBoxes[] = [];
  const reports: Array<{ side: SideKey; report: SideDrawReport }> = [];

  plans.forEach((plan, index) => {
    const pageWidthPt = uptToPt(plan.canvas.w);
    const pageHeightPt = uptToPt(plan.canvas.h);
    // The card's top-left bleed corner is the page's top-left corner.
    const { page, space } = addCardPage(doc, {
      pageWidthPt,
      pageHeightPt,
      originXPt: -uptToPt(plan.canvas.x),
      originTopYPt: pageHeightPt + uptToPt(plan.canvas.y),
    });
    pageBoxes.push(setCardBoxes(page, plan, space, index));
    reports.push({
      side: plan.side,
      report: drawSidePlan({ doc, page, plan, space, fonts: faces, images, grayPolicy }),
    });
  });

  const { bytes, outputIntent } = await finaliseExport(
    doc,
    faces,
    opts.outputIntent,
    opts.outputIntentSubtype,
  );

  return {
    bytes,
    complianceStatus: mergeStatus(
      reports,
      faces,
      outputIntent,
      outputIntent.embedded
        ? "cmyk-production-pdf-with-output-intent"
        : "cmyk-production-pdf",
    ),
    notes: buildNotes(reports, outputIntent),
    pageBoxes,
  };
}

export { mergeStatus as mergeComplianceStatus, buildNotes as buildExportNotes };
