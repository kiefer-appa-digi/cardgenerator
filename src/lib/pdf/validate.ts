import { PT_PER_IN, uptToIn, uptToPt, type Upt } from "@/lib/units";
import {
  CARD_PRESETS,
  fullBleedHeight,
  fullBleedWidth,
  type CardPresetDef,
} from "@/lib/geometry/presets";
import type { SideKey } from "@/lib/design/schema";
import type { SidePlan } from "@/lib/design/render";
import {
  inspectPdf,
  type PdfBox,
  type PdfFontInfo,
  type PdfInspection,
} from "./inspect";

/**
 * POST-EXPORT PDF VALIDATION — spec §22.
 *
 * "After creating every PDF, programmatically verify: MediaBox; CropBox;
 * BleedBox where used; TrimBox; physical dimensions; page count; font
 * embedding; expected color spaces; image resolution metadata where available;
 * barcode presence; no editor overlays; no accidental clipping."
 *
 * Each of those is one named check with a measured value, the value it was
 * required to be, and the tolerance that was applied. There are no bare
 * booleans: "TrimBox correct" is useless in a press-side argument, whereas
 * "TrimBox 9, 9, 323.46, 521.046 pt; expected 9, 9, 323.46, 521.046 pt;
 * tolerance ±0.001 pt" settles it.
 *
 * The expected physical size is taken from the spec §22 table, hard-coded here,
 * not from the preset module. A validator that reads its expectations from the
 * same constants the writer used can only prove the two files are consistent
 * with each other; this one proves the exported page matches the document that
 * specifies the product.
 *
 * WHAT THIS DOES NOT DO. It does not certify PDF/X. It parses structure — it
 * does not run an ICC transform, does not check XMP, and does not implement
 * ISO 15930. `complianceNote` on every report says so. Certified conformance
 * needs a real preflight engine (veraPDF, callas pdfToolbox, Acrobat Preflight)
 * and that step is listed in docs/print-pipeline.md, not faked here (§15, §32).
 */

/* ----------------------------------------------------------- tolerances */

/**
 * Page-box comparison tolerance, in PDF points.
 *
 * 0.001 pt = 1/72000 in = 0.35 µm. µpt → pt is an exact decimal shift and the
 * writer rounds emitted coordinates to 1e-6 pt, so a correct box lands within
 * 5e-7 pt of its target; this tolerance is three orders of magnitude looser
 * than that, and still far finer than any imagesetter can address. Any real
 * error — a box set from the wrong rect, a missing bleed allowance — is at
 * least 0.07 pt (0.001 in) and is caught with a margin of 70×.
 */
export const BOX_TOLERANCE_PT = 0.001;

/**
 * How far a painted mark may reach past the MediaBox before it counts as
 * clipped, in PDF points.
 *
 * 0.25 pt ≈ 0.0035 in. Two measurement artefacts need this headroom: a text
 * run's extent is reconstructed as an em-box from the font's ascent/descent, so
 * it is slightly larger than the ink; and a stroked path is measured on its
 * centreline, so a hairline can genuinely put ink up to half its line width
 * past the recorded extent. Content painted exactly to the page edge — which is
 * what full-bleed artwork is — sits at 0 overhang and passes.
 */
export const CLIP_TOLERANCE_PT = 0.25;

/** Physical dimensions are reported to five decimal places of an inch (§22). */
export const DIMENSION_DECIMALS = 5;

/** Effective resolution below which placed raster art is a defect. */
export const DEFAULT_MIN_IMAGE_DPI = 300;

/**
 * Editor overlay vocabulary. Any of these appearing as a word in a production
 * PDF means a guide, a proof stamp or a dieline annotation escaped into press
 * artwork (§15A "no editor overlays").
 *
 * A design whose own copy legitimately contains one of these words must pass a
 * narrowed list rather than have the check quietly weakened.
 */
export const EDITOR_OVERLAY_WORDS: readonly string[] = [
  "BLEED",
  "TRIM",
  "SAFE",
  "CAVITY",
  "PROOF",
  "DO NOT PRINT",
];

/**
 * Expected full-bleed sizes, transcribed verbatim from the table in spec §22.
 * This is the independent reference the measured page is compared against.
 */
export const SPEC_FULL_BLEED_IN: Record<
  CardPresetDef["code"],
  { widthIn: number; heightIn: number }
> = {
  "409TF": { widthIn: 4.6175, heightIn: 7.36175 },
  "277TF": { widthIn: 4.593, heightIn: 6.0375 },
  "206TF": { widthIn: 3.3675, heightIn: 6.7275 },
};

/* ------------------------------------------------------------- contract */

export const VALIDATION_CHECK_IDS = [
  "PAGE_COUNT",
  "PAGE_BOXES",
  "PHYSICAL_DIMENSIONS",
  "FONT_EMBEDDING",
  "COLOR_SPACES",
  "IMAGE_RESOLUTION",
  "BARCODE_PRESENCE",
  "NO_EDITOR_OVERLAYS",
  "NO_CLIPPING",
] as const;
export type ValidationCheckId = (typeof VALIDATION_CHECK_IDS)[number];

/**
 * `not_applicable` is a real outcome, not a soft pass: a card with no placed
 * raster has nothing to measure, and saying "PASS" would imply a measurement
 * that never happened. It never counts as a failure.
 */
export type ValidationStatus = "pass" | "fail" | "not_applicable";

export type ValidationPageResult = {
  /** One-based, the way a person counts pages. */
  page: number;
  side: SideKey | null;
  status: ValidationStatus;
  measured: string;
  detail: string;
};

export type ValidationCheck = {
  id: ValidationCheckId;
  title: string;
  status: ValidationStatus;
  /** What was found, with units. */
  measured: string;
  /** What it had to be, with units. */
  expected: string;
  /** The tolerance applied, in the measurement's own units, or "exact". */
  tolerance: string;
  detail: string;
  measurements: Record<string, string | number>;
  pageResults: ValidationPageResult[];
};

/** A page box in PDF orientation: lower-left origin, +y up, µpt. */
export type ExpectedBox = { x: Upt; y: Upt; w: Upt; h: Upt };

export type ExpectedPageBoxes = {
  media: ExpectedBox;
  crop: ExpectedBox;
  bleed: ExpectedBox;
  trim: ExpectedBox;
  /** null means the box must be ABSENT. PDF/X permits TrimBox or ArtBox, not both. */
  art: ExpectedBox | null;
};

export type ExpectedBarcode = {
  /** Digits that must be findable in the page text, ignoring separators. */
  value: string;
  /** False when the element was exported without human-readable digits. */
  humanReadable: boolean;
  /** One-based page it must appear on. null accepts any page. */
  page: number | null;
};

export type PdfExpectation = {
  presetCode: CardPresetDef["code"];
  pageCount: number;
  /** Full-bleed page size, µpt. */
  fullBleedWidth: Upt;
  fullBleedHeight: Upt;
  /** Card size after cutting, µpt. */
  trimWidth: Upt;
  trimHeight: Upt;
  /** One entry per expected page. */
  boxes: ExpectedPageBoxes[];
  /** True for a production run: DeviceRGB anywhere is then a defect. */
  requireCmykOnly: boolean;
  /** Face keys the plan said it needed, e.g. "Inter:600", "Inter:400i". */
  requiredFaces: string[];
  barcodes: ExpectedBarcode[];
  minImageDpi: number;
  forbiddenText: readonly string[];
  boxTolerancePt: number;
  clipTolerancePt: number;
};

export type PdfValidationReport = {
  ranAt: string;
  presetCode: CardPresetDef["code"];
  byteLength: number;
  headerVersion: string;
  pageCount: number;
  checks: ValidationCheck[];
  counts: { pass: number; fail: number; notApplicable: number };
  /** True when no check failed. */
  passed: boolean;
  /** Present so a caller can drill into any number without re-parsing. */
  inspection: PdfInspection;
  outputIntent: {
    present: boolean;
    subtype: string | null;
    conditionIdentifier: string | null;
    iccBytes: number;
  };
  /** Honest statement of what this report does and does not certify. */
  complianceNote: string;
  warnings: string[];
};

/* -------------------------------------------------------- expectations */

export type ExpectationOptions = {
  pageCount?: number;
  requireCmykOnly?: boolean;
  requiredFaces?: string[];
  barcodes?: ExpectedBarcode[];
  minImageDpi?: number;
  forbiddenText?: readonly string[];
  boxTolerancePt?: number;
  clipTolerancePt?: number;
};

/**
 * Build the expectation from a card preset alone.
 *
 * The page IS the full-bleed canvas, so MediaBox, CropBox and BleedBox are all
 * the whole sheet at the origin, and TrimBox is the card inset by the bleed. No
 * ArtBox: a file carrying both TrimBox and ArtBox is ambiguous about where the
 * cut goes, and every PDF/X part forbids it.
 */
export function expectationForPreset(
  presetCode: CardPresetDef["code"],
  opts: ExpectationOptions = {},
): PdfExpectation {
  const preset = CARD_PRESETS[presetCode];
  const w = fullBleedWidth(preset);
  const h = fullBleedHeight(preset);
  const pageCount = opts.pageCount ?? 2;

  const perPage: ExpectedPageBoxes = {
    media: { x: 0, y: 0, w, h },
    crop: { x: 0, y: 0, w, h },
    bleed: { x: 0, y: 0, w, h },
    trim: {
      x: preset.bleed.left,
      // PDF is y-up, so the trim box's lower edge is the BOTTOM bleed allowance.
      y: preset.bleed.bottom,
      w: preset.trimWidth,
      h: preset.trimHeight,
    },
    art: null,
  };

  return {
    presetCode,
    pageCount,
    fullBleedWidth: w,
    fullBleedHeight: h,
    trimWidth: preset.trimWidth,
    trimHeight: preset.trimHeight,
    boxes: Array.from({ length: pageCount }, () => perPage),
    requireCmykOnly: opts.requireCmykOnly ?? true,
    requiredFaces: opts.requiredFaces ?? [],
    barcodes: opts.barcodes ?? [],
    minImageDpi: opts.minImageDpi ?? DEFAULT_MIN_IMAGE_DPI,
    forbiddenText: opts.forbiddenText ?? EDITOR_OVERLAY_WORDS,
    boxTolerancePt: opts.boxTolerancePt ?? BOX_TOLERANCE_PT,
    clipTolerancePt: opts.clipTolerancePt ?? CLIP_TOLERANCE_PT,
  };
}

/**
 * Build the expectation from the plans that were exported: the preset geometry
 * plus the faces and barcode values the plan itself said it needed.
 *
 * Geometry still comes from the preset, never from the plan — the point of the
 * check is to catch a plan or a writer that produced the wrong size.
 */
export function expectationForPlans(input: {
  presetCode: CardPresetDef["code"];
  plans: Record<SideKey, SidePlan>;
  sides?: readonly SideKey[];
  options?: ExpectationOptions;
}): PdfExpectation {
  const sides = input.sides ?? (["front", "back"] as const);
  const faces = new Set<string>();
  const barcodes: ExpectedBarcode[] = [];

  sides.forEach((side, pageIndex) => {
    const plan = input.plans[side];
    for (const f of plan.facesUsed) faces.add(f);
    for (const op of plan.ops) {
      if (op.op !== "barcode" || !op.render) continue;
      barcodes.push({
        value: op.render.encodedValue,
        humanReadable: op.render.text.some((t) => t.text.length > 0),
        page: pageIndex + 1,
      });
    }
  });

  return expectationForPreset(input.presetCode, {
    pageCount: sides.length,
    requiredFaces: [...faces].sort(),
    barcodes,
    ...input.options,
  });
}

/* ------------------------------------------------------------- helpers */

function fmtPt(n: number): string {
  return `${Number(n.toFixed(6))} pt`;
}

function fmtIn(pt: number): string {
  return `${(pt / PT_PER_IN).toFixed(DIMENSION_DECIMALS)} in`;
}

function boxToPt(b: ExpectedBox): { x: number; y: number; w: number; h: number } {
  return { x: uptToPt(b.x), y: uptToPt(b.y), w: uptToPt(b.w), h: uptToPt(b.h) };
}

function describeBox(b: PdfBox | null): string {
  if (!b) return "absent";
  const f = (n: number) => Number(n.toFixed(6));
  return `[${f(b.x)}, ${f(b.y)}, ${f(b.x + b.width)}, ${f(b.y + b.height)}] pt`;
}

function describeExpectedBox(b: ExpectedBox | null): string {
  if (!b) return "absent";
  const p = boxToPt(b);
  const f = (n: number) => Number(n.toFixed(6));
  return `[${f(p.x)}, ${f(p.y)}, ${f(p.x + p.w)}, ${f(p.y + p.h)}] pt`;
}

/** Largest per-edge difference between a measured box and its target, in points. */
function boxDeltaPt(actual: PdfBox, expected: ExpectedBox): number {
  const e = boxToPt(expected);
  return Math.max(
    Math.abs(actual.x - e.x),
    Math.abs(actual.y - e.y),
    Math.abs(actual.x + actual.width - (e.x + e.w)),
    Math.abs(actual.y + actual.height - (e.y + e.h)),
  );
}

const CSS_WEIGHT_NAMES: Record<number, string> = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
};

/**
 * PostScript name a face key should be embedded under.
 *
 * The shipped families follow the Google Fonts static-instance convention
 * exactly — `Inter-Medium`, `Archivo-ExtraBold`, `BarlowCondensed-SemiBold`,
 * and `Inter-Italic` for the 400 italic — verified against the name table of
 * every one of the thirteen TTFs in src/assets/fonts. Deriving the name lets
 * the font check assert the right WEIGHT was embedded, not merely the right
 * family. Returns null for a face key it cannot parse, and the check then falls
 * back to matching on family alone rather than inventing a name.
 */
export function expectedPostScriptName(faceKey: string): string | null {
  const m = /^(.+):(\d{3})(i?)$/.exec(faceKey);
  if (!m) return null;
  const family = m[1].replace(/\s+/g, "");
  const weight = Number(m[2]);
  const italic = m[3] === "i";
  const weightName = CSS_WEIGHT_NAMES[weight];
  if (!weightName) return null;
  if (italic) return `${family}-${weight === 400 ? "Italic" : `${weightName}Italic`}`;
  return `${family}-${weightName}`;
}

/**
 * Strip the disambiguating numeric suffix pdf-lib appends to a subset font's
 * name (`Inter-Medium-7888`), leaving the PostScript name the TTF declares.
 */
export function basePostScriptName(name: string): string {
  return name.replace(/-\d+$/, "");
}

function familyToken(name: string): string {
  return basePostScriptName(name).split("-")[0].replace(/\s+/g, "").toLowerCase();
}

function faceKeyFamilyToken(faceKey: string): string {
  const idx = faceKey.lastIndexOf(":");
  const family = idx >= 0 ? faceKey.slice(0, idx) : faceKey;
  return family.replace(/\s+/g, "").toLowerCase();
}

function digitsOnly(s: string): string {
  return s.replace(/[^0-9]/g, "");
}

/** Word-boundary, case-insensitive search that tolerates the run separators. */
function containsWord(haystack: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^A-Za-z])${escaped}([^A-Za-z]|$)`, "i").test(haystack);
}

function statusOf(results: ValidationPageResult[]): ValidationStatus {
  if (results.some((r) => r.status === "fail")) return "fail";
  if (results.length > 0 && results.every((r) => r.status === "not_applicable")) {
    return "not_applicable";
  }
  return "pass";
}

function sideOfPage(index: number): SideKey | null {
  if (index === 0) return "front";
  if (index === 1) return "back";
  return null;
}

/* -------------------------------------------------------------- checks */

function checkPageCount(insp: PdfInspection, exp: PdfExpectation): ValidationCheck {
  const ok = insp.pageCount === exp.pageCount;
  return {
    id: "PAGE_COUNT",
    title: "Page count",
    status: ok ? "pass" : "fail",
    measured: `${insp.pageCount} page${insp.pageCount === 1 ? "" : "s"}`,
    expected: `${exp.pageCount} page${exp.pageCount === 1 ? "" : "s"}`,
    tolerance: "exact",
    detail: ok
      ? `The file has the ${exp.pageCount} pages a ${exp.presetCode} card needs (front, then back).`
      : `The file has ${insp.pageCount} pages, not ${exp.pageCount}. A production card is one page per side, front first.`,
    measurements: { measuredPages: insp.pageCount, expectedPages: exp.pageCount },
    pageResults: [],
  };
}

function checkPageBoxes(insp: PdfInspection, exp: PdfExpectation): ValidationCheck {
  const tol = exp.boxTolerancePt;
  const results: ValidationPageResult[] = [];
  let worstDelta = 0;
  let worstLabel = "";
  let anyBoxMeasured = false;

  const named = [
    ["MediaBox", "media"],
    ["CropBox", "crop"],
    ["BleedBox", "bleed"],
    ["TrimBox", "trim"],
    ["ArtBox", "art"],
  ] as const;

  insp.pages.forEach((page, i) => {
    const want = exp.boxes[i] ?? exp.boxes[exp.boxes.length - 1];
    const problems: string[] = [];
    const parts: string[] = [];

    for (const [label, key] of named) {
      const actual =
        key === "media"
          ? page.boxes.mediaBox
          : key === "crop"
            ? page.boxes.cropBox
            : key === "bleed"
              ? page.boxes.bleedBox
              : key === "trim"
                ? page.boxes.trimBox
                : page.boxes.artBox;
      const target = want ? want[key] : null;

      if (!target) {
        if (actual) {
          problems.push(
            `${label} is present (${describeBox(actual)}) but must be absent — a page carrying both TrimBox and ArtBox does not say where the cut is.`,
          );
        }
        continue;
      }
      if (!actual) {
        problems.push(`${label} is missing; expected ${describeExpectedBox(target)}.`);
        continue;
      }
      const delta = boxDeltaPt(actual, target);
      parts.push(`${label} ${describeBox(actual)}`);
      // Not `delta > worstDelta`: a perfect file has every delta at 0, and the
      // summary line still has to name a measurement.
      if (!anyBoxMeasured || delta > worstDelta) {
        worstDelta = delta;
        worstLabel = `page ${i + 1} ${label}`;
        anyBoxMeasured = true;
      }
      if (delta > tol) {
        problems.push(
          `${label} is ${describeBox(actual)}; expected ${describeExpectedBox(target)} (off by ${fmtPt(delta)}, tolerance ±${fmtPt(tol)}).`,
        );
      }
    }

    results.push({
      page: i + 1,
      side: sideOfPage(i),
      status: problems.length === 0 ? "pass" : "fail",
      measured: parts.join("; ") || "no boxes readable",
      detail:
        problems.length === 0
          ? "All four required boxes present and within tolerance; no ArtBox."
          : problems.join(" "),
    });
  });

  if (insp.pages.length === 0) {
    results.push({
      page: 0,
      side: null,
      status: "fail",
      measured: "no pages",
      detail: "There are no pages to measure boxes on.",
    });
  }

  const status = statusOf(results);
  return {
    id: "PAGE_BOXES",
    title: "MediaBox / CropBox / BleedBox / TrimBox",
    status,
    measured: anyBoxMeasured
      ? `worst deviation ${fmtPt(worstDelta)} of ${insp.pages.length * 4} box edges (${worstLabel})`
      : "no boxes measured",
    expected: `every box within ±${fmtPt(tol)} of the ${exp.presetCode} geometry; no ArtBox`,
    tolerance: `±${fmtPt(tol)} per edge`,
    detail:
      status === "pass"
        ? `The page is the full-bleed canvas — MediaBox, CropBox and BleedBox are the whole sheet — and TrimBox is the card inset by the bleed, so a RIP that honours TrimBox knows where to cut.`
        : results
            .filter((r) => r.status === "fail")
            .map((r) => `Page ${r.page}: ${r.detail}`)
            .join(" "),
    measurements: {
      worstDeviationPt: Number(worstDelta.toFixed(6)),
      tolerancePt: tol,
      pagesChecked: insp.pages.length,
    },
    pageResults: results,
  };
}

function checkPhysicalDimensions(
  insp: PdfInspection,
  exp: PdfExpectation,
): ValidationCheck {
  const spec = SPEC_FULL_BLEED_IN[exp.presetCode];
  // The 5-decimal report is the deliverable, so compare at that resolution:
  // half a unit in the last reported place.
  const tolIn = exp.boxTolerancePt / PT_PER_IN;
  const results: ValidationPageResult[] = [];

  insp.pages.forEach((page, i) => {
    const box = page.boxes.mediaBox;
    if (!box) {
      results.push({
        page: i + 1,
        side: sideOfPage(i),
        status: "fail",
        measured: "no MediaBox",
        detail: "Without a MediaBox the page has no physical size at all.",
      });
      return;
    }
    const wIn = box.width / PT_PER_IN;
    const hIn = box.height / PT_PER_IN;
    const dw = Math.abs(wIn - spec.widthIn);
    const dh = Math.abs(hIn - spec.heightIn);
    const ok = dw <= tolIn && dh <= tolIn;
    results.push({
      page: i + 1,
      side: sideOfPage(i),
      status: ok ? "pass" : "fail",
      measured: `${wIn.toFixed(DIMENSION_DECIMALS)} × ${hIn.toFixed(DIMENSION_DECIMALS)} in (${fmtPt(box.width)} × ${fmtPt(box.height)})`,
      detail: ok
        ? `Matches the spec §22 full-bleed size for ${exp.presetCode}.`
        : `Expected ${spec.widthIn.toFixed(DIMENSION_DECIMALS)} × ${spec.heightIn.toFixed(DIMENSION_DECIMALS)} in; off by ${dw.toFixed(DIMENSION_DECIMALS)} in wide and ${dh.toFixed(DIMENSION_DECIMALS)} in tall.`,
    });
  });

  if (results.length === 0) {
    results.push({
      page: 0,
      side: null,
      status: "fail",
      measured: "no pages",
      detail: "There are no pages to measure.",
    });
  }

  const status = statusOf(results);
  const first = insp.pages[0]?.boxes.mediaBox ?? null;
  return {
    id: "PHYSICAL_DIMENSIONS",
    title: "Physical dimensions",
    status,
    measured: first
      ? `${(first.width / PT_PER_IN).toFixed(DIMENSION_DECIMALS)} × ${(first.height / PT_PER_IN).toFixed(DIMENSION_DECIMALS)} in`
      : "no MediaBox",
    expected: `${spec.widthIn.toFixed(DIMENSION_DECIMALS)} × ${spec.heightIn.toFixed(DIMENSION_DECIMALS)} in (spec §22 table, ${exp.presetCode})`,
    tolerance: `±${tolIn.toFixed(8)} in (±${fmtPt(exp.boxTolerancePt)})`,
    detail:
      status === "pass"
        ? `Every page measures the full-bleed size the specification tabulates for ${exp.presetCode}. Trim after cutting is ${uptToIn(exp.trimWidth).toFixed(DIMENSION_DECIMALS)} × ${uptToIn(exp.trimHeight).toFixed(DIMENSION_DECIMALS)} in.`
        : results
            .filter((r) => r.status === "fail")
            .map((r) => `Page ${r.page}: ${r.detail}`)
            .join(" "),
    measurements: {
      expectedWidthIn: spec.widthIn,
      expectedHeightIn: spec.heightIn,
      measuredWidthIn: first ? Number((first.width / PT_PER_IN).toFixed(DIMENSION_DECIMALS)) : "n/a",
      measuredHeightIn: first ? Number((first.height / PT_PER_IN).toFixed(DIMENSION_DECIMALS)) : "n/a",
      toleranceIn: Number(tolIn.toFixed(8)),
    },
    pageResults: results,
  };
}

function checkFontEmbedding(insp: PdfInspection, exp: PdfExpectation): ValidationCheck {
  const fonts = insp.fonts;
  const notEmbedded = fonts.filter((f) => !f.embedded);
  const subsets = fonts.filter((f) => f.subset);
  const notSubset = fonts.filter((f) => f.embedded && !f.subset);

  const missingFaces: string[] = [];
  const matchedByFamilyOnly: string[] = [];
  for (const faceKey of exp.requiredFaces) {
    const wanted = expectedPostScriptName(faceKey);
    const exact = wanted
      ? fonts.find((f) => basePostScriptName(f.postScriptName) === wanted)
      : undefined;
    if (exact) continue;
    const byFamily = fonts.find(
      (f) => familyToken(f.postScriptName) === faceKeyFamilyToken(faceKey),
    );
    if (byFamily) {
      matchedByFamilyOnly.push(
        `${faceKey} (expected "${wanted ?? "?"}", found "${basePostScriptName(byFamily.postScriptName)}")`,
      );
    } else {
      missingFaces.push(faceKey);
    }
  }

  const failed = notEmbedded.length > 0 || missingFaces.length > 0 || matchedByFamilyOnly.length > 0;

  const detailParts: string[] = [];
  if (notEmbedded.length > 0) {
    detailParts.push(
      `Not embedded: ${notEmbedded.map((f) => f.baseFont).join(", ")}. A font that is only referenced will be substituted by the RIP and the copy will reflow on press.`,
    );
  }
  if (missingFaces.length > 0) {
    detailParts.push(
      `The plan required ${missingFaces.join(", ")}, and no font of that family is embedded at all.`,
    );
  }
  if (matchedByFamilyOnly.length > 0) {
    detailParts.push(
      `Wrong weight embedded for ${matchedByFamilyOnly.join("; ")}. The family is right but the face is not the one the layout was measured with.`,
    );
  }
  if (!failed) {
    detailParts.push(
      `All ${fonts.length} referenced font${fonts.length === 1 ? " is" : "s are"} embedded as ${subsets.length === fonts.length ? "subsets" : `${subsets.length} subset(s) and ${notSubset.length} full face(s)`}.`,
    );
    if (notSubset.length > 0) {
      detailParts.push(
        `Full (non-subset) faces: ${notSubset.map((f) => f.baseFont).join(", ")}. Legal to print, but the file carries more of the font than the job uses.`,
      );
    }
    if (exp.requiredFaces.length > 0) {
      detailParts.push(`Every face the plan asked for is present: ${exp.requiredFaces.join(", ")}.`);
    }
  }

  return {
    id: "FONT_EMBEDDING",
    title: "Font embedding and subsetting",
    status: fonts.length === 0 && exp.requiredFaces.length === 0 ? "not_applicable" : failed ? "fail" : "pass",
    measured: `${fonts.length} font${fonts.length === 1 ? "" : "s"}, ${fonts.length - notEmbedded.length} embedded, ${subsets.length} subset`,
    expected:
      exp.requiredFaces.length > 0
        ? `every font embedded; the ${exp.requiredFaces.length} plan face(s) present: ${exp.requiredFaces.join(", ")}`
        : "every referenced font embedded",
    tolerance: "exact",
    detail: detailParts.join(" "),
    measurements: {
      fontCount: fonts.length,
      embeddedCount: fonts.length - notEmbedded.length,
      subsetCount: subsets.length,
      requiredFaceCount: exp.requiredFaces.length,
      notEmbedded: notEmbedded.map((f) => f.baseFont).join(", ") || "none",
      subsetFonts: describeSubsets(subsets),
    },
    pageResults: [],
  };
}

function describeSubsets(fonts: readonly PdfFontInfo[]): string {
  if (fonts.length === 0) return "none";
  return fonts
    .map((f) => `${f.subsetTag ?? "??????"}+${basePostScriptName(f.postScriptName)} (${f.fontFileKey})`)
    .join(", ");
}

function checkColorSpaces(insp: PdfInspection, exp: PdfExpectation): ValidationCheck {
  const all = new Set<string>();
  const images = new Set<string>();
  for (const p of insp.pages) {
    for (const s of p.colorSpaces.spaces) all.add(s);
    for (const s of p.colorSpaces.imageSpaces) {
      all.add(s);
      images.add(s);
    }
  }
  const isRgb = (s: string) => s === "DeviceRGB" || s === "ICCBased-RGB" || s === "CalRGB";
  const rgb = [...all].filter(isRgb);

  const results: ValidationPageResult[] = insp.pages.map((p, i) => {
    const spaces = [...new Set([...p.colorSpaces.spaces, ...p.colorSpaces.imageSpaces])].sort();
    const pageRgb = spaces.filter(isRgb);
    const bad = exp.requireCmykOnly && pageRgb.length > 0;
    return {
      page: i + 1,
      side: sideOfPage(i),
      status: bad ? "fail" : "pass",
      measured: spaces.join(", ") || "none",
      detail: bad
        ? `${pageRgb.join(", ")} is present in a CMYK production workflow. The RIP will separate it with its own default profile, which is not the colour management this job's output intent describes.`
        : `Content uses ${spaces.join(", ") || "no colour operators"}.`,
    };
  });

  const status = exp.requireCmykOnly && rgb.length > 0 ? "fail" : statusOf(results);
  return {
    id: "COLOR_SPACES",
    title: "Colour spaces",
    status,
    measured: [...all].sort().join(", ") || "none",
    expected: exp.requireCmykOnly
      ? "DeviceCMYK and DeviceGray only; no RGB in a CMYK production workflow"
      : "any",
    tolerance: "exact",
    detail:
      status === "fail"
        ? `RGB colour is present as ${rgb.join(", ")}. Spec §14 requires print colour to be stored and emitted as CMYK; nothing in this file converts RGB through an ICC transform, so the separation would be the RIP's guess.`
        : `${[...all].sort().join(", ") || "No colour operators at all"}. ${
            insp.hasOutputIntent
              ? "An OutputIntent is embedded, so these CMYK numbers are tied to a named printing condition."
              : "No OutputIntent is embedded, so these CMYK numbers are device values with no printing condition attached — the deployment must configure the press ICC profile before this is a colour-managed file."
          }${images.size > 0 ? ` Placed rasters are ${[...images].sort().join(", ")}.` : ""}`,
    measurements: {
      spaces: [...all].sort().join(", ") || "none",
      imageSpaces: [...images].sort().join(", ") || "none",
      rgbSpaces: rgb.join(", ") || "none",
      outputIntentPresent: insp.hasOutputIntent ? "yes" : "no",
    },
    pageResults: results,
  };
}

function checkImageResolution(insp: PdfInspection, exp: PdfExpectation): ValidationCheck {
  const results: ValidationPageResult[] = [];
  let lowest = Number.POSITIVE_INFINITY;
  let imageCount = 0;
  let placementCount = 0;

  insp.pages.forEach((page, i) => {
    if (page.images.length === 0) {
      results.push({
        page: i + 1,
        side: sideOfPage(i),
        status: "not_applicable",
        measured: "no placed raster",
        detail: "This page is entirely vector, so there is no image resolution to measure.",
      });
      return;
    }
    imageCount += page.images.length;
    const lines: string[] = [];
    const problems: string[] = [];
    for (const img of page.images) {
      if (img.placements.length === 0) {
        lines.push(
          `${img.resourceName} ${img.pixelWidth}×${img.pixelHeight} px (${img.colorSpace}), never drawn`,
        );
        continue;
      }
      for (const p of img.placements) {
        placementCount += 1;
        const dpi =
          p.effectiveDpiX !== null && p.effectiveDpiY !== null
            ? Math.min(p.effectiveDpiX, p.effectiveDpiY)
            : null;
        if (dpi !== null) lowest = Math.min(lowest, dpi);
        lines.push(
          `${img.resourceName} ${img.pixelWidth}×${img.pixelHeight} px (${img.colorSpace}) placed at ${p.widthPt.toFixed(3)}×${p.heightPt.toFixed(3)} pt = ${dpi === null ? "unmeasurable" : `${dpi.toFixed(1)} ppi`}`,
        );
        if (dpi !== null && dpi < exp.minImageDpi) {
          problems.push(
            `${img.resourceName} lands at ${dpi.toFixed(1)} ppi, under the ${exp.minImageDpi} ppi floor.`,
          );
        }
      }
    }
    results.push({
      page: i + 1,
      side: sideOfPage(i),
      status: problems.length > 0 ? "fail" : "pass",
      measured: lines.join("; "),
      detail:
        problems.length > 0
          ? problems.join(" ")
          : "Every placed raster meets the resolution floor at its final placed size.",
    });
  });

  const status = statusOf(results);
  return {
    id: "IMAGE_RESOLUTION",
    title: "Placed image resolution",
    status,
    measured:
      imageCount === 0
        ? "0 placed rasters"
        : `${imageCount} image XObject(s), ${placementCount} placement(s), lowest ${Number.isFinite(lowest) ? `${lowest.toFixed(1)} ppi` : "unmeasurable"}`,
    expected: `every placement at or above ${exp.minImageDpi} ppi at final size`,
    tolerance: `${exp.minImageDpi} ppi floor, no slack`,
    detail:
      imageCount === 0
        ? "The card is entirely vector — text, shapes and barcode bars — so there is no raster resolution to report. A PDF carries no resolution field of its own; effective ppi is pixel count divided by placed size, and with no pixels there is nothing to divide."
        : status === "fail"
          ? results.filter((r) => r.status === "fail").map((r) => `Page ${r.page}: ${r.detail}`).join(" ")
          : `Effective resolution is computed as pixel dimensions over the placed size taken from the CTM at each Do operator; that is the only resolution metadata a PDF actually carries.`,
    measurements: {
      imageCount,
      placementCount,
      lowestDpi: Number.isFinite(lowest) ? Number(lowest.toFixed(1)) : "n/a",
      minimumDpi: exp.minImageDpi,
    },
    pageResults: results,
  };
}

function checkBarcodePresence(insp: PdfInspection, exp: PdfExpectation): ValidationCheck {
  if (exp.barcodes.length === 0) {
    return {
      id: "BARCODE_PRESENCE",
      title: "Barcode presence",
      status: "not_applicable",
      measured: `${insp.pages.reduce((n, p) => n + p.barLikeRectCount, 0)} bar-shaped rectangles`,
      expected: "no barcode was planned",
      tolerance: "n/a",
      detail: "The exported plans contain no barcode element, so there is nothing to look for.",
      measurements: { expectedBarcodes: 0 },
      pageResults: [],
    };
  }

  const results: ValidationPageResult[] = [];
  let found = 0;

  for (const bc of exp.barcodes) {
    const needle = digitsOnly(bc.value);
    const pageIdxs =
      bc.page !== null ? [bc.page - 1] : insp.pages.map((_, i) => i);
    const hits = pageIdxs.filter((i) => {
      const page = insp.pages[i];
      if (!page) return false;
      return digitsOnly(page.textContent).includes(needle);
    });
    const barPages = pageIdxs.filter((i) => (insp.pages[i]?.barLikeRectCount ?? 0) > 0);

    const digitsOk = !bc.humanReadable || hits.length > 0;
    const barsOk = barPages.length > 0;
    const ok = digitsOk && barsOk;
    if (ok) found += 1;

    const where = bc.page !== null ? `page ${bc.page}` : "any page";
    const bars = pageIdxs.reduce((n, i) => n + (insp.pages[i]?.barLikeRectCount ?? 0), 0);
    results.push({
      page: bc.page ?? 0,
      side: bc.page !== null ? sideOfPage(bc.page - 1) : null,
      status: ok ? "pass" : "fail",
      measured: `${bars} bar-shaped rectangle(s); human-readable digits ${hits.length > 0 ? "found" : "not found"} on ${where}`,
      detail: ok
        ? `"${bc.value}" is present as vector bars${bc.humanReadable ? " and as readable digits under them" : " (no human-readable line was planned)"}.`
        : [
            !barsOk
              ? `No bar-shaped rectangles were painted on ${where}, so there is no vector symbol at all.`
              : "",
            !digitsOk
              ? `The digits "${bc.value}" were not found in the text of ${where}. Extracted text there reads: "${(insp.pages[pageIdxs[0]]?.textContent ?? "").replace(/\n/g, " / ").slice(0, 160)}".`
              : "",
          ]
            .filter(Boolean)
            .join(" "),
    });
  }

  const status = statusOf(results);
  const totalBars = insp.pages.reduce((n, p) => n + p.barLikeRectCount, 0);
  return {
    id: "BARCODE_PRESENCE",
    title: "Barcode presence",
    status,
    measured: `${found} of ${exp.barcodes.length} expected barcode(s) verified; ${totalBars} bar-shaped rectangles in the file`,
    expected: `${exp.barcodes.map((b) => b.value).join(", ")} — digits findable in the text and at least one bar rectangle`,
    tolerance: "bar count > 0; digits matched after stripping non-digit characters",
    detail:
      status === "pass"
        ? `Bars are vector rectangles, never a raster (§12, §32), and the human-readable line is live text in an embedded font, which is why the digits can be read back out of the file at all. Digits are matched in reading order — a UPC-A paints its centre groups before the number-system and check digits, so raw stream order would not spell the number.`
        : results.filter((r) => r.status === "fail").map((r) => r.detail).join(" "),
    measurements: {
      expectedBarcodes: exp.barcodes.length,
      verifiedBarcodes: found,
      barShapedRectangles: totalBars,
    },
    pageResults: results,
  };
}

function checkNoEditorOverlays(insp: PdfInspection, exp: PdfExpectation): ValidationCheck {
  const results: ValidationPageResult[] = [];
  const allHits: string[] = [];

  insp.pages.forEach((page, i) => {
    const hits = exp.forbiddenText.filter((w) => containsWord(page.textContent, w));
    for (const h of hits) allHits.push(`"${h}" on page ${i + 1}`);
    results.push({
      page: i + 1,
      side: sideOfPage(i),
      status: hits.length === 0 ? "pass" : "fail",
      measured:
        hits.length === 0
          ? `none of ${exp.forbiddenText.length} overlay words present`
          : `found ${hits.map((h) => `"${h}"`).join(", ")}`,
      detail:
        hits.length === 0
          ? `${page.textRuns.length} text run(s) scanned, none matching the overlay vocabulary.`
          : `Overlay text reached press artwork. The extracted text is: "${page.textContent.replace(/\n/g, " / ").slice(0, 240)}".`,
    });
  });

  const status = statusOf(results);
  return {
    id: "NO_EDITOR_OVERLAYS",
    title: "No editor overlays",
    status,
    measured: allHits.length === 0 ? "no overlay words found" : allHits.join(", "),
    expected: `none of: ${exp.forbiddenText.join(", ")}`,
    tolerance: "whole-word, case-insensitive",
    detail:
      status === "pass"
        ? `Bleed, trim, safe-area, cavity and proof furniture are editor and proof-PDF concerns; a production file that names them is showing guides to the press. Matching is whole-word and case-insensitive, so ordinary copy containing "trimmer" or "safety" does not trip it.`
        : `Editor overlay text is present: ${allHits.join(", ")}. A production PDF must contain artwork only.`,
    measurements: {
      forbiddenWords: exp.forbiddenText.join(", "),
      hits: allHits.length,
    },
    pageResults: results,
  };
}

function checkNoClipping(insp: PdfInspection, exp: PdfExpectation): ValidationCheck {
  const tol = exp.clipTolerancePt;
  const results: ValidationPageResult[] = [];
  let worst = Number.NEGATIVE_INFINITY;
  let worstWhere = "";

  insp.pages.forEach((page, i) => {
    const box = page.boxes.mediaBox;
    if (!box) {
      results.push({
        page: i + 1,
        side: sideOfPage(i),
        status: "fail",
        measured: "no MediaBox",
        detail: "Without a MediaBox there is nothing to be inside of.",
      });
      return;
    }
    const x1 = box.x + box.width;
    const y1 = box.y + box.height;
    // Overhang is signed: content strictly inside the page gives a negative
    // value, which is the margin. Only a positive overhang is a defect.
    let pageWorst = Number.NEGATIVE_INFINITY;
    const offenders: string[] = [];
    for (const e of page.paintedExtents) {
      const over = Math.max(box.x - e.x0, box.y - e.y0, e.x1 - x1, e.y1 - y1);
      if (over > pageWorst) pageWorst = over;
      if (over > tol) {
        offenders.push(
          `a ${e.kind} painted by "${e.operator}" reaches [${e.x0.toFixed(3)}, ${e.y0.toFixed(3)}, ${e.x1.toFixed(3)}, ${e.y1.toFixed(3)}] pt, ${fmtPt(over)} outside`,
        );
      }
    }
    if (!Number.isFinite(pageWorst)) pageWorst = 0;
    if (pageWorst > worst) {
      worst = pageWorst;
      worstWhere = `page ${i + 1}`;
    }
    const bad = pageWorst > tol;
    results.push({
      page: i + 1,
      side: sideOfPage(i),
      status: bad ? "fail" : "pass",
      measured: `${page.paintedExtents.length} painted mark(s); furthest overhang ${fmtPt(Math.max(0, pageWorst))}`,
      detail: bad
        ? `Content is being clipped away by the page: ${offenders.slice(-3).join("; ")}. MediaBox is ${describeBox(box)}.`
        : `Everything painted lies inside the MediaBox ${describeBox(box)}; content bounds are ${
            page.paintedBounds
              ? `[${page.paintedBounds.x0.toFixed(3)}, ${page.paintedBounds.y0.toFixed(3)}, ${page.paintedBounds.x1.toFixed(3)}, ${page.paintedBounds.y1.toFixed(3)}] pt`
              : "empty"
          }.`,
    });
  });

  if (results.length === 0) {
    results.push({
      page: 0,
      side: null,
      status: "fail",
      measured: "no pages",
      detail: "There are no pages to check.",
    });
  }

  const status = statusOf(results);
  return {
    id: "NO_CLIPPING",
    title: "Nothing clipped by the page",
    status,
    measured: worstWhere
      ? `${insp.pages.reduce((n, p) => n + p.paintedExtents.length, 0)} painted mark(s); furthest overhang ${fmtPt(Math.max(0, worst))} (${worstWhere})`
      : "nothing painted",
    expected: "every drawing operator's coordinates inside the MediaBox",
    tolerance: `±${fmtPt(tol)} overhang`,
    detail:
      status === "pass"
        ? `Path points, image placements and text em-boxes were transformed through the CTM and compared with the MediaBox. Full-bleed artwork sits exactly on the page edge at 0 overhang; the ${fmtPt(tol)} allowance exists because a text extent is reconstructed as an em-box from the font's ascent and descent and a stroke is measured on its centreline.`
        : results.filter((r) => r.status === "fail").map((r) => `Page ${r.page}: ${r.detail}`).join(" "),
    measurements: {
      worstOverhangPt: Number(Math.max(0, Number.isFinite(worst) ? worst : 0).toFixed(6)),
      tolerancePt: tol,
      paintedMarks: insp.pages.reduce((n, p) => n + p.paintedExtents.length, 0),
    },
    pageResults: results,
  };
}

/* ---------------------------------------------------------------- entry */

const COMPLIANCE_NOTE =
  "This report verifies PDF structure: page count, page boxes, physical size, " +
  "font embedding, colour-space operators, image resolution metadata, barcode " +
  "presence, absence of editor overlays and absence of clipping. It is NOT a " +
  "PDF/X conformance test — it does not evaluate ICC transforms, XMP metadata or " +
  "ISO 15930 rules, and it never asserts PDF/X conformance. Certified output " +
  "requires a preflight engine such as veraPDF, callas pdfToolbox or Acrobat " +
  "Preflight; the remaining steps are listed in docs/print-pipeline.md.";

/**
 * Validate an exported production PDF against what the export was supposed to
 * be. Returns a report; it does not throw on a failed check, because a caller
 * that wants the numbers needs them whether or not the file is good.
 */
export async function validateProductionPdf(
  bytes: Uint8Array,
  expectation: PdfExpectation,
): Promise<PdfValidationReport> {
  const inspection = await inspectPdf(bytes);

  const checks: ValidationCheck[] = [
    checkPageCount(inspection, expectation),
    checkPageBoxes(inspection, expectation),
    checkPhysicalDimensions(inspection, expectation),
    checkFontEmbedding(inspection, expectation),
    checkColorSpaces(inspection, expectation),
    checkImageResolution(inspection, expectation),
    checkBarcodePresence(inspection, expectation),
    checkNoEditorOverlays(inspection, expectation),
    checkNoClipping(inspection, expectation),
  ];

  const counts = { pass: 0, fail: 0, notApplicable: 0 };
  for (const c of checks) {
    if (c.status === "pass") counts.pass += 1;
    else if (c.status === "fail") counts.fail += 1;
    else counts.notApplicable += 1;
  }

  const oi = inspection.outputIntents[0] ?? null;

  return {
    ranAt: new Date().toISOString(),
    presetCode: expectation.presetCode,
    byteLength: inspection.byteLength,
    headerVersion: inspection.headerVersion,
    pageCount: inspection.pageCount,
    checks,
    counts,
    passed: counts.fail === 0,
    inspection,
    outputIntent: {
      present: inspection.hasOutputIntent,
      subtype: oi?.subtype ?? null,
      conditionIdentifier: oi?.outputConditionIdentifier ?? null,
      iccBytes: oi?.destOutputProfileBytes ?? 0,
    },
    complianceNote: COMPLIANCE_NOTE,
    warnings: inspection.warnings,
  };
}

/** Look up which preset a measured page size corresponds to, or null. */
export function presetForPageSize(
  widthPt: number,
  heightPt: number,
  tolerancePt = BOX_TOLERANCE_PT,
): CardPresetDef["code"] | null {
  for (const code of Object.keys(SPEC_FULL_BLEED_IN) as Array<CardPresetDef["code"]>) {
    const spec = SPEC_FULL_BLEED_IN[code];
    if (
      Math.abs(widthPt - spec.widthIn * PT_PER_IN) <= tolerancePt &&
      Math.abs(heightPt - spec.heightIn * PT_PER_IN) <= tolerancePt
    ) {
      return code;
    }
  }
  return null;
}

/** Plain-text rendering of a report, shared by the CLI and any log sink. */
export function formatValidationReport(report: PdfValidationReport): string {
  const out: string[] = [];
  const rule = "-".repeat(78);
  out.push(rule);
  out.push(`PDF EXPORT VALIDATION — spec §22`);
  out.push(rule);
  out.push(`preset          ${report.presetCode}`);
  out.push(`pages           ${report.pageCount}`);
  out.push(`file size       ${report.byteLength.toLocaleString("en-US")} bytes`);
  out.push(`PDF version     ${report.headerVersion}`);
  out.push(
    `output intent   ${
      report.outputIntent.present
        ? `${report.outputIntent.subtype} / ${report.outputIntent.conditionIdentifier} (${report.outputIntent.iccBytes} byte ICC)`
        : "none embedded"
    }`,
  );
  out.push(`result          ${report.passed ? "PASS" : "FAIL"} — ${report.counts.pass} passed, ${report.counts.fail} failed, ${report.counts.notApplicable} not applicable`);
  out.push("");

  for (const c of report.checks) {
    const badge = c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : "N/A ";
    out.push(`[${badge}] ${c.title}  (${c.id})`);
    out.push(`        measured  : ${c.measured}`);
    out.push(`        expected  : ${c.expected}`);
    out.push(`        tolerance : ${c.tolerance}`);
    out.push(`        ${c.detail}`);
    for (const p of c.pageResults) {
      if (p.status === "pass" && report.passed) continue;
      const pb = p.status === "pass" ? "pass" : p.status === "fail" ? "FAIL" : "n/a";
      out.push(`          page ${p.page}${p.side ? ` (${p.side})` : ""} [${pb}]: ${p.measured}`);
      if (p.status !== "pass") out.push(`            ${p.detail}`);
    }
    out.push("");
  }

  out.push(rule);
  out.push("PAGE GEOMETRY");
  for (const p of report.inspection.pages) {
    out.push(`  page ${p.index + 1}`);
    for (const [label, box] of [
      ["MediaBox", p.boxes.mediaBox],
      ["CropBox", p.boxes.cropBox],
      ["BleedBox", p.boxes.bleedBox],
      ["TrimBox", p.boxes.trimBox],
      ["ArtBox", p.boxes.artBox],
    ] as const) {
      if (!box) {
        out.push(`    ${label.padEnd(9)} absent`);
        continue;
      }
      out.push(
        `    ${label.padEnd(9)} ${describeBox(box)}  =  ${fmtIn(box.width)} × ${fmtIn(box.height)}`,
      );
    }
  }
  out.push("");
  out.push("FONTS");
  if (report.inspection.fonts.length === 0) out.push("  none");
  for (const f of report.inspection.fonts) {
    out.push(
      `  ${f.baseFont}  ${f.subtype}${f.descendantSubtype ? `/${f.descendantSubtype}` : ""}  ` +
        `${f.embedded ? `embedded (${f.fontFileKey}, ${f.fontFileBytes} bytes, ${f.fontFileStoredBytes} stored)` : "NOT EMBEDDED"}  ` +
        `${f.subset ? `subset "${f.subsetTag}"` : "full face"}`,
    );
  }
  out.push("");
  out.push("COLOUR SPACES");
  for (const p of report.inspection.pages) {
    const spaces = [...new Set([...p.colorSpaces.spaces, ...p.colorSpaces.imageSpaces])].sort();
    out.push(`  page ${p.index + 1}: ${spaces.join(", ") || "none"}`);
  }
  out.push("");
  out.push("IMAGES");
  const anyImages = report.inspection.pages.some((p) => p.images.length > 0);
  if (!anyImages) out.push("  none placed (the card is entirely vector)");
  for (const p of report.inspection.pages) {
    for (const img of p.images) {
      const dpis = img.placements
        .map((pl) =>
          pl.effectiveDpiX === null ? "?" : `${Math.min(pl.effectiveDpiX, pl.effectiveDpiY ?? pl.effectiveDpiX).toFixed(1)} ppi`,
        )
        .join(", ");
      out.push(
        `  page ${p.index + 1} ${img.resourceName}: ${img.pixelWidth}×${img.pixelHeight} px, ${img.colorSpace}, ${img.filters.join("+") || "no filter"}, placed at ${dpis || "never drawn"}`,
      );
    }
  }
  out.push("");
  out.push("TEXT CONTENT (reading order)");
  for (const p of report.inspection.pages) {
    out.push(`  page ${p.index + 1}:`);
    for (const line of p.textLines) out.push(`    ${line}`);
    if (p.textLines.length === 0) out.push("    (no text)");
  }
  if (report.warnings.length > 0) {
    out.push("");
    out.push("PARSER WARNINGS");
    for (const w of report.warnings) out.push(`  ${w}`);
  }
  out.push("");
  out.push(rule);
  out.push(COMPLIANCE_NOTE);
  out.push(rule);
  return out.join("\n");
}
