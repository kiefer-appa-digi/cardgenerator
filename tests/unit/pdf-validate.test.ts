import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
  rgb,
} from "pdf-lib";
import { inToUpt, uptToPt } from "@/lib/units";
import { CARD_PRESETS, fullBleedHeight, fullBleedWidth } from "@/lib/geometry/presets";
import { cmykPct, grayPct, NONE, TEXT_BLACK } from "@/lib/color/types";
import {
  DesignElementSchema,
  emptyDesign,
  type DesignDoc,
  type DesignElement,
  type SideKey,
} from "@/lib/design/schema";
import { planDocument, type AssetInfo } from "@/lib/design/plan";
import type { SidePlan } from "@/lib/design/render";
import { emptyProductContext } from "@/lib/data/context";
import { renderProductionPdf } from "@/lib/pdf/production";
import type { AssetPayload } from "@/lib/pdf/draw";
import { inspectPdf } from "@/lib/pdf/inspect";
import {
  BOX_TOLERANCE_PT,
  EDITOR_OVERLAY_WORDS,
  SPEC_FULL_BLEED_IN,
  VALIDATION_CHECK_IDS,
  basePostScriptName,
  expectationForPlans,
  expectationForPreset,
  expectedPostScriptName,
  formatValidationReport,
  presetForPageSize,
  validateProductionPdf,
  type PdfExpectation,
  type ValidationCheckId,
  type PdfValidationReport,
} from "@/lib/pdf/validate";

/**
 * EXPORT VALIDATION TESTS — spec §22.
 *
 * Every fixture is produced by the real production writer. Nothing here stubs
 * the PDF: a validator proved against a hand-built file proves nothing about
 * the exporter.
 *
 * Each check is exercised twice — once on a good file, once on a file whose
 * corresponding property has been deliberately broken — because a check that
 * has never been seen to fail is not known to be a check at all.
 */

const IN = inToUpt;
const UPC = "036000291452";

type PresetCode = keyof typeof CARD_PRESETS;

/* ------------------------------------------------------------- fixtures */

function el(input: Record<string, unknown>): DesignElement {
  return DesignElementSchema.parse(input);
}

type FixtureOptions = {
  withBarcode?: boolean;
  imageAssetId?: string;
  /** Placed size of the image, inches. */
  imageSizeIn?: number;
  /** Placed size of the image, inches, when it is not square. */
  imageFrameIn?: { w: number; h: number };
  imageFit?: "fill" | "fit" | "crop" | "stretch";
  overlayText?: string;
};

function fixtureDoc(presetCode: PresetCode, opts: FixtureOptions = {}): DesignDoc {
  const preset = CARD_PRESETS[presetCode];
  const w = fullBleedWidth(preset);
  const h = fullBleedHeight(preset);
  const doc = emptyDesign(presetCode);

  const front: DesignElement[] = [
    el({
      kind: "shape",
      id: "bg",
      name: "Background",
      shape: "rect",
      frame: { x: 0, y: 0, w, h },
      fill: cmykPct(78, 20, 0, 0),
      stroke: NONE,
    }),
    el({
      kind: "text",
      id: "title",
      name: "Title",
      frame: { x: IN(0.4), y: IN(0.5), w: w - IN(0.8), h: IN(0.6) },
      paragraphs: [{ runs: [{ text: opts.overlayText ?? "HUB ASSEMBLY" }] }],
      fontFamily: "Archivo",
      fontWeight: 800,
      fontSize: 18_000_000,
      color: TEXT_BLACK,
    }),
  ];

  if (opts.withBarcode !== false) {
    front.push(
      el({
        kind: "barcode",
        id: "upc",
        name: "UPC",
        frame: { x: IN(0.4), y: h - IN(1.6), w: IN(1.6), h: IN(1.2) },
        symbology: "upca",
        value: UPC,
        quietZoneFill: cmykPct(0, 0, 0, 0),
      }),
    );
  }

  if (opts.imageAssetId) {
    const size = IN(opts.imageSizeIn ?? 1);
    const frame = opts.imageFrameIn
      ? { w: IN(opts.imageFrameIn.w), h: IN(opts.imageFrameIn.h) }
      : { w: size, h: size };
    front.push(
      el({
        kind: "image",
        id: "photo",
        name: "Photo",
        frame: { x: IN(0.4), y: IN(2), w: frame.w, h: frame.h },
        assetId: opts.imageAssetId,
        fit: opts.imageFit ?? "stretch",
      }),
    );
  }

  doc.front.elements = front;
  doc.back.elements = [
    el({
      kind: "text",
      id: "legal",
      name: "Legal",
      frame: { x: IN(0.4), y: IN(0.5), w: w - IN(0.8), h: IN(1.2) },
      paragraphs: [{ runs: [{ text: "Made in USA. Freedom Trailer Parts." }] }],
      fontFamily: "Inter",
      fontWeight: 400,
      fontSize: 8_000_000,
      color: grayPct(100),
    }),
  ];
  return doc;
}

type Exported = {
  bytes: Uint8Array;
  plans: Record<SideKey, SidePlan>;
  presetCode: PresetCode;
};

/** Grayscale JPEGs, so an image fixture does not also trip the RGB check. */
const jpegCache = new Map<string, Uint8Array>();

async function grayJpeg(pixels: number, tall = pixels): Promise<Uint8Array> {
  const key = `${pixels}x${tall}`;
  const hit = jpegCache.get(key);
  if (hit) return hit;
  const buf = await sharp({
    create: {
      width: pixels,
      height: tall,
      channels: 3,
      background: { r: 120, g: 120, b: 120 },
    },
  })
    .greyscale()
    // greyscale() alone still writes three identical channels; forcing the
    // output colourspace is what makes it a one-component JPEG, which pdf-lib
    // embeds as DeviceGray rather than DeviceRGB.
    .toColourspace("b-w")
    .jpeg({ quality: 70 })
    .toBuffer();
  const bytes = new Uint8Array(buf);
  jpegCache.set(key, bytes);
  return bytes;
}

async function exportFixture(
  presetCode: PresetCode,
  opts: FixtureOptions & { imagePixels?: number; imagePixelsTall?: number } = {},
): Promise<Exported> {
  const doc = fixtureDoc(presetCode, opts);
  const assets = new Map<string, AssetInfo>();
  let assetBytes: ((id: string) => Promise<AssetPayload | null>) | undefined;

  if (opts.imageAssetId) {
    const px = opts.imagePixels ?? 900;
    const py = opts.imagePixelsTall ?? px;
    const jpeg = await grayJpeg(px, py);
    assets.set(opts.imageAssetId, {
      id: opts.imageAssetId,
      pixelWidth: px,
      pixelHeight: py,
      colorSpace: "gray",
      contentType: "image/jpeg",
    });
    assetBytes = async () => ({ bytes: jpeg, contentType: "image/jpeg" });
  }

  const plans = planDocument({ doc, product: emptyProductContext(), assets });
  const out = await renderProductionPdf({ plans, assetBytes });
  return { bytes: out.bytes, plans, presetCode };
}

function expectationFor(
  exported: Exported,
  overrides: Partial<PdfExpectation> = {},
): PdfExpectation {
  return {
    ...expectationForPlans({ presetCode: exported.presetCode, plans: exported.plans }),
    ...overrides,
  };
}

async function validateFixture(
  exported: Exported,
  overrides: Partial<PdfExpectation> = {},
  bytes: Uint8Array = exported.bytes,
): Promise<PdfValidationReport> {
  return validateProductionPdf(bytes, expectationFor(exported, overrides));
}

function check(report: PdfValidationReport, id: ValidationCheckId) {
  const c = report.checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id} in report`);
  return c;
}

/* ----------------------------------------------------------- corruptions */

/** Load, mutate, re-save. Every corruption goes through pdf-lib, not byte surgery. */
async function mutate(
  bytes: Uint8Array,
  fn: (doc: PDFDocument) => void | Promise<void>,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  await fn(doc);
  return doc.save({ useObjectStreams: false });
}

/** Strip the embedded font program from every FontDescriptor in the file. */
function stripFontPrograms(doc: PDFDocument): number {
  let stripped = 0;
  for (const page of doc.getPages()) {
    const fonts = page.node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
    if (!fonts) continue;
    for (const key of fonts.keys()) {
      const font = fonts.lookupMaybe(key, PDFDict);
      if (!font) continue;
      const descendants = font.lookupMaybe(PDFName.of("DescendantFonts"), PDFArray);
      const holder = descendants?.lookupMaybe(0, PDFDict) ?? font;
      const fd = holder.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict);
      if (!fd) continue;
      for (const k of ["FontFile", "FontFile2", "FontFile3"] as const) {
        if (fd.has(PDFName.of(k))) {
          fd.delete(PDFName.of(k));
          stripped += 1;
        }
      }
    }
  }
  return stripped;
}

/* ------------------------------------------------------------- the tests */

describe("inspectPdf on a real production export", () => {
  let exported: Exported;
  beforeAll(async () => {
    exported = await exportFixture("409TF");
  });

  it("reads all four page boxes from every page", async () => {
    const insp = await inspectPdf(exported.bytes);
    expect(insp.pageCount).toBe(2);
    for (const page of insp.pages) {
      expect(page.boxes.present).toEqual({
        mediaBox: true,
        cropBox: true,
        bleedBox: true,
        trimBox: true,
        artBox: false,
      });
      expect(page.boxes.mediaBox?.width).toBeCloseTo(332.46, 6);
      expect(page.boxes.mediaBox?.height).toBeCloseTo(530.046, 6);
      // 0.125 in bleed = 9 pt on every side.
      expect(page.boxes.trimBox?.x).toBeCloseTo(9, 6);
      expect(page.boxes.trimBox?.y).toBeCloseTo(9, 6);
    }
  });

  it("reports every embedded font as a tagged subset", async () => {
    const insp = await inspectPdf(exported.bytes);
    expect(insp.fonts.length).toBeGreaterThan(0);
    for (const f of insp.fonts) {
      expect(f.embedded).toBe(true);
      expect(f.fontFileKey).toBe("FontFile2");
      expect(f.subset).toBe(true);
      expect(f.subsetTag).toMatch(/^[A-Z]{6}$/);
      expect(f.hasToUnicode).toBe(true);
    }
  });

  it("recovers the barcode digits in reading order, not paint order", async () => {
    const insp = await inspectPdf(exported.bytes);
    const front = insp.pages[0];
    // UPC-A paints the centre digit groups before the number-system and check
    // digits, so raw stream order spells 360002914502 rather than 036000291452.
    const paintOrder = front.textRuns.map((r) => r.text).join("").replace(/[^0-9]/g, "");
    expect(paintOrder).not.toContain(UPC);
    expect(front.textContent.replace(/[^0-9]/g, "")).toContain(UPC);
  });

  it("counts the barcode's bars as filled vector rectangles", async () => {
    const insp = await inspectPdf(exported.bytes);
    // UPC-A is 30 bars; they arrive as `m l l l h` subpaths, not `re`.
    expect(insp.pages[0].barLikeRectCount).toBe(30);
    expect(insp.pages[1].barLikeRectCount).toBe(0);
  });

  it("finds only DeviceCMYK and no output intent for an unconfigured deployment", async () => {
    const insp = await inspectPdf(exported.bytes);
    expect(insp.pages[0].colorSpaces.spaces).toEqual(["DeviceCMYK"]);
    expect(insp.hasOutputIntent).toBe(false);
    expect(insp.warnings).toEqual([]);
  });
});

describe("validateProductionPdf on a good export", () => {
  let report: PdfValidationReport;
  beforeAll(async () => {
    report = await validateFixture(await exportFixture("409TF"));
  });

  it("passes overall", () => {
    const failed = report.checks.filter((c) => c.status === "fail");
    expect(failed.map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.counts.fail).toBe(0);
  });

  it("emits exactly the checks spec §22 names, each with a measurement", () => {
    expect(report.checks.map((c) => c.id)).toEqual([...VALIDATION_CHECK_IDS]);
    for (const c of report.checks) {
      expect(c.measured.length, `${c.id} measured`).toBeGreaterThan(0);
      expect(c.expected.length, `${c.id} expected`).toBeGreaterThan(0);
      expect(c.tolerance.length, `${c.id} tolerance`).toBeGreaterThan(0);
      expect(c.detail.length, `${c.id} detail`).toBeGreaterThan(0);
      // Never a bare boolean.
      expect(c.measured).not.toBe("true");
      expect(c.measured).not.toBe("false");
    }
  });

  it("states the page count it measured", () => {
    const c = check(report, "PAGE_COUNT");
    expect(c.status).toBe("pass");
    expect(c.measured).toBe("2 pages");
    expect(c.tolerance).toBe("exact");
  });

  it("states the box deviation and the tolerance it used", () => {
    const c = check(report, "PAGE_BOXES");
    expect(c.status).toBe("pass");
    expect(c.tolerance).toContain(String(BOX_TOLERANCE_PT));
    expect(c.measurements.worstDeviationPt).toBeLessThanOrEqual(BOX_TOLERANCE_PT);
    expect(c.pageResults).toHaveLength(2);
    // A perfect file still has to state a number, not "nothing was measured".
    expect(c.measured).toBe("worst deviation 0 pt of 8 boxes (page 1 MediaBox)");
  });

  it("reports physical dimensions to five decimal places of an inch", () => {
    const c = check(report, "PHYSICAL_DIMENSIONS");
    expect(c.status).toBe("pass");
    expect(c.measured).toBe("4.61750 × 7.36175 in");
    expect(c.expected).toContain("4.61750 × 7.36175 in");
    for (const p of c.pageResults) expect(p.measured).toMatch(/\d\.\d{5} × \d\.\d{5} in/);
  });

  it("names the subsets it found", () => {
    const c = check(report, "FONT_EMBEDDING");
    expect(c.status).toBe("pass");
    expect(c.measurements.embeddedCount).toBe(c.measurements.fontCount);
    expect(c.measurements.subsetCount).toBe(c.measurements.fontCount);
    expect(String(c.measurements.subsetFonts)).toMatch(/[A-Z]{6}\+/);
    expect(c.measurements.notEmbedded).toBe("none");
  });

  it("reports DeviceCMYK and says the output intent is missing", () => {
    const c = check(report, "COLOR_SPACES");
    expect(c.status).toBe("pass");
    expect(c.measured).toBe("DeviceCMYK");
    expect(c.detail).toContain("No OutputIntent");
    expect(report.outputIntent.present).toBe(false);
  });

  it("marks image resolution not applicable for an all-vector card", () => {
    const c = check(report, "IMAGE_RESOLUTION");
    expect(c.status).toBe("not_applicable");
    expect(c.measured).toBe("0 placed rasters");
    expect(c.measurements.imageCount).toBe(0);
  });

  it("verifies the barcode by digits and by bar count", () => {
    const c = check(report, "BARCODE_PRESENCE");
    expect(c.status).toBe("pass");
    expect(c.measurements.verifiedBarcodes).toBe(1);
    expect(c.measurements.barShapedRectangles).toBe(30);
    expect(c.expected).toContain(UPC);
  });

  it("finds no overlay vocabulary", () => {
    const c = check(report, "NO_EDITOR_OVERLAYS");
    expect(c.status).toBe("pass");
    expect(c.measurements.hits).toBe(0);
    expect(c.expected).toContain("BLEED");
  });

  it("finds nothing painted outside the MediaBox", () => {
    const c = check(report, "NO_CLIPPING");
    expect(c.status).toBe("pass");
    expect(c.measurements.worstOverhangPt).toBe(0);
    expect(Number(c.measurements.paintedMarks)).toBeGreaterThan(0);
    expect(c.measured).toMatch(/^\d+ painted mark\(s\); furthest overhang 0 pt \(page \d\)$/);
  });

  it("never claims PDF/X conformance", () => {
    expect(report.complianceNote).toContain("NOT a PDF/X conformance test");
    expect(report.complianceNote).toContain("veraPDF");
  });
});

describe("geometry for all three presets (spec §22 table)", () => {
  const codes: PresetCode[] = ["409TF", "277TF", "206TF"];
  for (const code of codes) {
    it(`${code} exports at the tabulated full-bleed size and validates clean`, async () => {
      const exported = await exportFixture(code);
      const report = await validateFixture(exported);
      expect(report.checks.filter((c) => c.status === "fail")).toEqual([]);

      const spec = SPEC_FULL_BLEED_IN[code];
      const dims = check(report, "PHYSICAL_DIMENSIONS");
      expect(dims.measured).toBe(
        `${spec.widthIn.toFixed(5)} × ${spec.heightIn.toFixed(5)} in`,
      );

      // The measured page must also agree with the preset module, which is a
      // separate source of truth from the spec table transcribed in validate.ts.
      const preset = CARD_PRESETS[code];
      const media = report.inspection.pages[0].boxes.mediaBox;
      expect(media?.width).toBeCloseTo(uptToPt(fullBleedWidth(preset)), 6);
      expect(media?.height).toBeCloseTo(uptToPt(fullBleedHeight(preset)), 6);
    });
  }

  it("identifies a preset from a measured page size", () => {
    expect(presetForPageSize(332.46, 530.046)).toBe("409TF");
    expect(presetForPageSize(330.696, 434.7)).toBe("277TF");
    expect(presetForPageSize(242.46, 484.38)).toBe("206TF");
    expect(presetForPageSize(612, 792)).toBeNull();
  });
});

describe("each check fails when its property is broken", () => {
  let good: Exported;
  beforeAll(async () => {
    good = await exportFixture("409TF");
  });

  it("PAGE_COUNT fails when a page is removed", async () => {
    const broken = await mutate(good.bytes, (doc) => doc.removePage(1));
    const report = await validateFixture(good, {}, broken);
    const c = check(report, "PAGE_COUNT");
    expect(c.status).toBe("fail");
    expect(c.measured).toBe("1 page");
    expect(c.expected).toBe("2 pages");
    expect(report.passed).toBe(false);
  });

  it("PAGE_BOXES fails when the TrimBox moves by a point", async () => {
    const broken = await mutate(good.bytes, (doc) => {
      const p = doc.getPages()[0];
      const t = p.getTrimBox();
      p.setTrimBox(t.x + 1, t.y, t.width, t.height);
    });
    const report = await validateFixture(good, {}, broken);
    const c = check(report, "PAGE_BOXES");
    expect(c.status).toBe("fail");
    expect(Number(c.measurements.worstDeviationPt)).toBeCloseTo(1, 6);
    expect(c.detail).toContain("TrimBox");
    expect(c.pageResults[0].status).toBe("fail");
    expect(c.pageResults[1].status).toBe("pass");
  });

  it("PAGE_BOXES fails when the BleedBox is dropped", async () => {
    const broken = await mutate(good.bytes, (doc) => {
      doc.getPages()[1].node.delete(PDFName.of("BleedBox"));
    });
    const report = await validateFixture(good, {}, broken);
    const c = check(report, "PAGE_BOXES");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("BleedBox is missing");
  });

  it("PAGE_BOXES fails when an ArtBox is added alongside the TrimBox", async () => {
    const broken = await mutate(good.bytes, (doc) => {
      doc.getPages()[0].setArtBox(9, 9, 100, 100);
    });
    const report = await validateFixture(good, {}, broken);
    const c = check(report, "PAGE_BOXES");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("ArtBox is present");
  });

  it("PHYSICAL_DIMENSIONS fails when the page is the wrong size", async () => {
    const broken = await mutate(good.bytes, (doc) => {
      doc.getPages()[0].setMediaBox(0, 0, 612, 792);
    });
    const report = await validateFixture(good, {}, broken);
    const c = check(report, "PHYSICAL_DIMENSIONS");
    expect(c.status).toBe("fail");
    expect(c.pageResults[0].measured).toContain("8.50000 × 11.00000 in");
    expect(c.pageResults[0].detail).toContain("4.61750 × 7.36175 in");
    expect(c.pageResults[1].status).toBe("pass");
  });

  it("FONT_EMBEDDING fails when the font program is stripped", async () => {
    let stripped = 0;
    const broken = await mutate(good.bytes, (doc) => {
      stripped = stripFontPrograms(doc);
    });
    expect(stripped).toBeGreaterThan(0);
    const report = await validateFixture(good, {}, broken);
    const c = check(report, "FONT_EMBEDDING");
    expect(c.status).toBe("fail");
    expect(c.measurements.embeddedCount).toBe(0);
    expect(c.detail).toContain("Not embedded");
    expect(String(c.measurements.notEmbedded)).toContain("+Inter");
  });

  it("FONT_EMBEDDING fails when a required family is absent", async () => {
    const report = await validateFixture(good, {
      requiredFaces: ["Barlow Condensed:700"],
    });
    const c = check(report, "FONT_EMBEDDING");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("no font of that family is embedded");
  });

  it("FONT_EMBEDDING fails when the right family is embedded at the wrong weight", async () => {
    const report = await validateFixture(good, { requiredFaces: ["Inter:700"] });
    const c = check(report, "FONT_EMBEDDING");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("Wrong weight embedded");
    expect(c.detail).toContain("Inter-Bold");
  });

  it("derives the PostScript name every shipped face is embedded under", () => {
    expect(expectedPostScriptName("Inter:400")).toBe("Inter-Regular");
    expect(expectedPostScriptName("Inter:500")).toBe("Inter-Medium");
    expect(expectedPostScriptName("Inter:400i")).toBe("Inter-Italic");
    expect(expectedPostScriptName("Archivo:800")).toBe("Archivo-ExtraBold");
    expect(expectedPostScriptName("Barlow Condensed:600")).toBe("BarlowCondensed-SemiBold");
    expect(expectedPostScriptName("nonsense")).toBeNull();
    expect(basePostScriptName("Inter-Medium-7888")).toBe("Inter-Medium");
  });

  it("COLOR_SPACES fails when RGB reaches a CMYK production file", async () => {
    const broken = await mutate(good.bytes, (doc) => {
      doc.getPages()[0].drawRectangle({
        x: 20,
        y: 20,
        width: 40,
        height: 40,
        color: rgb(1, 0, 0),
      });
    });
    const report = await validateFixture(good, {}, broken);
    const c = check(report, "COLOR_SPACES");
    expect(c.status).toBe("fail");
    expect(c.measured).toContain("DeviceRGB");
    expect(c.measurements.rgbSpaces).toBe("DeviceRGB");
    expect(c.pageResults[0].status).toBe("fail");
    expect(c.pageResults[1].status).toBe("pass");
  });

  it("COLOR_SPACES passes the same file when RGB is allowed", async () => {
    const broken = await mutate(good.bytes, (doc) => {
      doc.getPages()[0].drawRectangle({
        x: 20,
        y: 20,
        width: 40,
        height: 40,
        color: rgb(1, 0, 0),
      });
    });
    const report = await validateFixture(good, { requireCmykOnly: false }, broken);
    expect(check(report, "COLOR_SPACES").status).toBe("pass");
  });

  it("IMAGE_RESOLUTION passes a high-resolution placement and fails a low one", async () => {
    const sharpExport = await exportFixture("409TF", {
      imageAssetId: "asset-hi",
      imagePixels: 900,
      imageSizeIn: 1,
    });
    const sharpReport = await validateFixture(sharpExport);
    const hi = check(sharpReport, "IMAGE_RESOLUTION");
    expect(hi.status).toBe("pass");
    expect(Number(hi.measurements.lowestDpi)).toBeGreaterThanOrEqual(300);
    expect(hi.measured).toContain("1 image XObject");
    // A grayscale JPEG must not drag the CMYK workflow check down with it.
    expect(check(sharpReport, "COLOR_SPACES").status).toBe("pass");

    const softExport = await exportFixture("409TF", {
      imageAssetId: "asset-lo",
      imagePixels: 64,
      imageSizeIn: 2,
    });
    const softReport = await validateFixture(softExport);
    const lo = check(softReport, "IMAGE_RESOLUTION");
    expect(lo.status).toBe("fail");
    expect(Number(lo.measurements.lowestDpi)).toBeCloseTo(32, 0);
    expect(lo.detail).toContain("under the 300 ppi floor");
  });

  it("BARCODE_PRESENCE fails when the expected digits are not in the file", async () => {
    const report = await validateFixture(good, {
      barcodes: [{ value: "012345678905", humanReadable: true, page: 1 }],
    });
    const c = check(report, "BARCODE_PRESENCE");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("012345678905");
    expect(c.measurements.verifiedBarcodes).toBe(0);
  });

  it("BARCODE_PRESENCE fails when the design has no barcode at all", async () => {
    const noBarcode = await exportFixture("409TF", { withBarcode: false });
    const report = await validateProductionPdf(
      noBarcode.bytes,
      expectationForPreset("409TF", {
        barcodes: [{ value: UPC, humanReadable: true, page: 1 }],
      }),
    );
    const c = check(report, "BARCODE_PRESENCE");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("No bar-shaped rectangles");
    expect(c.measurements.barShapedRectangles).toBe(0);
  });

  it("BARCODE_PRESENCE is not applicable when no barcode was planned", async () => {
    const noBarcode = await exportFixture("409TF", { withBarcode: false });
    const report = await validateFixture(noBarcode);
    const c = check(report, "BARCODE_PRESENCE");
    expect(c.status).toBe("not_applicable");
    expect(report.passed).toBe(true);
  });

  it("NO_EDITOR_OVERLAYS fails for every overlay word", async () => {
    for (const word of EDITOR_OVERLAY_WORDS) {
      const broken = await mutate(good.bytes, async (doc) => {
        const helv = await doc.embedFont(StandardFonts.Helvetica);
        doc.getPages()[0].drawText(word, { x: 20, y: 20, size: 9, font: helv });
      });
      const report = await validateFixture(good, {}, broken);
      const c = check(report, "NO_EDITOR_OVERLAYS");
      expect(c.status, `word "${word}"`).toBe("fail");
      expect(c.measured).toContain(word);
      expect(c.measurements.hits).toBe(1);
    }
  });

  it("NO_EDITOR_OVERLAYS does not fire on ordinary copy containing a longer word", async () => {
    const doc = fixtureDoc("409TF", { overlayText: "TRIMMER SAFETY CAVITIES" });
    const plans = planDocument({ doc, product: emptyProductContext(), assets: new Map() });
    const out = await renderProductionPdf({ plans });
    const report = await validateProductionPdf(
      out.bytes,
      expectationForPlans({ presetCode: "409TF", plans }),
    );
    const c = check(report, "NO_EDITOR_OVERLAYS");
    expect(report.inspection.pages[0].textContent).toContain("TRIMMER");
    expect(c.status).toBe("pass");
  });

  it("NO_CLIPPING fails when content falls outside a shrunken MediaBox", async () => {
    const broken = await mutate(good.bytes, (doc) => {
      doc.getPages()[0].setMediaBox(0, 0, 200, 300);
    });
    const report = await validateFixture(good, {}, broken);
    const c = check(report, "NO_CLIPPING");
    expect(c.status).toBe("fail");
    // The background runs the full 332.46 pt width, so it overhangs by 132.46.
    expect(Number(c.measurements.worstOverhangPt)).toBeCloseTo(230.046, 3);
    expect(c.pageResults[0].detail).toContain("outside");
    expect(c.pageResults[1].status).toBe("pass");
  });
});

describe("cases the validator has to survive in the field", () => {
  it("fails NO_CLIPPING when an element is left hanging off the artboard", async () => {
    const preset = CARD_PRESETS["409TF"];
    const w = fullBleedWidth(preset);
    const doc = fixtureDoc("409TF");
    doc.front.elements.push(
      el({
        kind: "shape",
        id: "runoff",
        name: "Dragged off the artboard",
        shape: "rect",
        frame: { x: w - IN(0.5), y: IN(2), w: IN(2), h: IN(1) },
        fill: cmykPct(0, 90, 88, 0),
        stroke: NONE,
      }),
    );
    const plans = planDocument({ doc, product: emptyProductContext(), assets: new Map() });
    const out = await renderProductionPdf({ plans });
    const report = await validateProductionPdf(
      out.bytes,
      expectationForPlans({ presetCode: "409TF", plans }),
    );
    const c = check(report, "NO_CLIPPING");
    // The writer clips to the bleed box, so the ink is contained — but the
    // operator coordinates still run 1.5 in past the page, which is precisely
    // the accidental clipping §22 asks about.
    expect(c.status).toBe("fail");
    expect(Number(c.measurements.worstOverhangPt)).toBeCloseTo(uptToPt(IN(1.5)), 3);
    expect(c.pageResults[0].detail).toContain("clipped away by the page");
  });

  it("reads a file saved with object streams", async () => {
    const good = await exportFixture("409TF");
    const compact = await mutate(good.bytes, () => {});
    const packed = await PDFDocument.load(compact, { updateMetadata: false }).then((d) =>
      d.save({ useObjectStreams: true }),
    );
    const report = await validateFixture(good, {}, packed);
    expect(report.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(report.inspection.fonts.every((f) => f.embedded)).toBe(true);
  });

  it("reports an embedded output intent when the deployment configures one", async () => {
    // A header-only ICC stub: 132 bytes, correct declared size, "CMYK" data
    // colour space and the "acsp" signature the writer verifies. It exercises
    // the OutputIntents plumbing, and is NOT a colour profile — no test here
    // makes any claim about colour accuracy.
    const icc = new Uint8Array(132);
    new DataView(icc.buffer).setUint32(0, icc.byteLength);
    icc.set([0x43, 0x4d, 0x59, 0x4b], 16); // "CMYK"
    icc.set([0x61, 0x63, 0x73, 0x70], 36); // "acsp"

    const doc = fixtureDoc("409TF");
    const plans = planDocument({ doc, product: emptyProductContext(), assets: new Map() });
    const out = await renderProductionPdf({
      plans,
      outputIntent: {
        identifier: "Coated FOGRA39 (ISO 12647-2:2004)",
        conditionName: "Coated FOGRA39",
        registryName: "http://www.color.org",
        info: "stub",
        iccBase64: Buffer.from(icc).toString("base64"),
      },
    });
    const report = await validateProductionPdf(
      out.bytes,
      expectationForPlans({ presetCode: "409TF", plans }),
    );
    expect(report.outputIntent).toEqual({
      present: true,
      subtype: "GTS_PDFX",
      conditionIdentifier: "Coated FOGRA39 (ISO 12647-2:2004)",
      iccBytes: icc.byteLength,
    });
    expect(check(report, "COLOR_SPACES").detail).toContain("An OutputIntent is embedded");
    // Carrying an output intent still does not make the file PDF/X.
    expect(report.complianceNote).toContain("never asserts PDF/X conformance");
    expect(report.passed).toBe(true);
  });
});

describe("report rendering", () => {
  it("prints every check with its measurement and never claims PDF/X", async () => {
    const report = await validateFixture(await exportFixture("206TF"));
    const text = formatValidationReport(report);
    for (const id of VALIDATION_CHECK_IDS) expect(text).toContain(id);
    expect(text).toContain("[PASS]");
    expect(text).toContain("MediaBox");
    expect(text).toContain("TrimBox");
    expect(text).toContain("3.36750 in");
    expect(text).toContain("NOT a PDF/X conformance test");
  });

  it("prints FAIL and the failing measurement for a broken file", async () => {
    const good = await exportFixture("409TF");
    const broken = await mutate(good.bytes, (doc) => doc.removePage(1));
    const report = await validateFixture(good, {}, broken);
    const text = formatValidationReport(report);
    expect(text).toContain("[FAIL] Page count");
    expect(text).toContain("result          FAIL");
  });
});
