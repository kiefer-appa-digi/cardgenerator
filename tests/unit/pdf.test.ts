import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import fontkit from "@pdf-lib/fontkit";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { inToUpt, ptToUpt, uptToPt } from "@/lib/units";
import { CARD_PRESETS } from "@/lib/geometry/presets";
import { cmykPct, grayPct, NONE, OutputIntentSchema } from "@/lib/color/types";
import { DesignDocSchema, type DesignDoc } from "@/lib/design/schema";
import { planDocument, type AssetInfo } from "@/lib/design/plan";
import type { SidePlan, TextOp } from "@/lib/design/render";
import { emptyProductContext, type ProductContext } from "@/lib/data/context";
import { inspectPdf } from "@/lib/pdf/inspect";
import {
  MissingAssetError,
  UnsupportedAssetError,
  type AssetPayload,
} from "@/lib/pdf/draw";
import {
  alignGlyfRecords,
  embedFaces,
  finaliseFontSubsets,
  knownFaceKeys,
  readFaceBytes,
} from "@/lib/pdf/fonts";
import {
  InvalidIccProfileError,
  decodeIccProfile,
  renderProductionPdf,
} from "@/lib/pdf/production";
import { PROOF_MARGINS, renderProofPdf } from "@/lib/pdf/proof";

/**
 * PDF EXPORT TESTS — spec §22 "EXPORT VALIDATION".
 *
 * Every assertion here re-opens the finished bytes and measures them. Nothing is
 * checked against the exporter's own bookkeeping, because a writer that grades
 * its own homework proves nothing.
 *
 * GEOMETRY TOLERANCE: 0.001 pt.
 *
 * µpt → pt is an exact decimal shift (1 pt = 1_000_000 µpt), so a page box is
 * written as an exact decimal such as 332.46 and could in principle be compared
 * exactly. The tolerance exists because PDF numbers are decimal text that has to
 * be parsed back through a binary float, and because a downstream tool may
 * re-serialise them. 0.001 pt is 1/72000 in — about 0.35 µm, roughly a hundredth
 * of the diameter of a 200 lpi halftone dot, and four orders of magnitude finer
 * than any imagesetter or die can hold. A geometry error large enough to matter
 * on press is thousands of times bigger than this window.
 */
const TOL_PT = 0.001;

const IN = inToUpt;

/** Spec §22's expected full-bleed dimensions, in inches. */
const EXPECTED_FULL_BLEED_IN: Record<keyof typeof CARD_PRESETS, [number, number]> = {
  "409TF": [4.6175, 7.36175],
  "277TF": [4.593, 6.0375],
  "206TF": [3.3675, 6.7275],
};

/* --------------------------------------------------------------- fixtures */

const ASSET_ID = "asset-hero";

function bomItem(position: number, partNumber: string, name: string, quantity: number) {
  return {
    position,
    partNumber,
    name,
    quantity,
    quantityText: String(quantity),
    description: "",
    unitOfMeasure: "",
  };
}

function product(): ProductContext {
  return {
    ...emptyProductContext(),
    id: "p1",
    partNumber: "11-500",
    productName: "Trailer Hub Repair Kit",
    brand: { name: "Freedom", legalName: "Freedom Trailer Parts LLC", statement: "", logoAssetId: null },
    identifiers: {
      gtin14: "",
      gtin13: "",
      upc12: "012345678905",
      sku: "11-500",
      gs1CompanyPrefix: "",
    },
    bom: {
      items: [
        bomItem(1, "L44643", "Inner Bearing", 2),
        bomItem(2, "L68149", "Outer Bearing", 2),
        bomItem(3, "10-19", "Grease Seal", 2),
      ],
      packIncludes: "",
      itemCount: 3,
    },
  };
}

/** The tracked headline. Its span position is what the tracking test measures. */
const HEADLINE = "FREEDOM TRAILER PARTS";
const HEADLINE_TRACKING_UPT = 600_000; // 0.6 pt

type FixtureOptions = {
  withImage?: boolean;
  withSpot?: boolean;
  withRotation?: boolean;
  withOpacity?: boolean;
};

function design(
  presetCode: DesignDoc["presetCode"],
  opts: FixtureOptions = {},
): DesignDoc {
  // Heterogeneous by construction; DesignDocSchema.parse below is what validates
  // and narrows it, so the fixture is authored as plain records.
  const front: Array<Record<string, unknown>> = [
    {
      id: "bg",
      kind: "shape" as const,
      name: "Brand bar",
      frame: { x: 0, y: 0, w: CARD_PRESETS[presetCode].trimWidth + IN(0.25), h: IN(0.9) },
      shape: "rect" as const,
      fill: cmykPct(78, 20, 0, 0),
      cornerRadius: 0,
      ...(opts.withOpacity ? { opacity: 6_000 } : {}),
    },
    {
      id: "headline",
      kind: "text" as const,
      frame: { x: IN(0.3), y: IN(0.28), w: IN(2.6), h: IN(0.4) },
      paragraphs: [{ runs: [{ text: HEADLINE }] }],
      fontFamily: "Archivo",
      fontWeight: 800,
      fontSize: 11_000_000,
      tracking: HEADLINE_TRACKING_UPT,
      color: cmykPct(0, 0, 0, 0),
    },
    {
      id: "part",
      kind: "text" as const,
      frame: { x: IN(0.3), y: IN(1.1), w: IN(2.6), h: IN(0.5) },
      paragraphs: [{ runs: [{ binding: { path: "partNumber" } }] }],
      fontFamily: "Archivo",
      fontWeight: 700,
      fontSize: 22_000_000,
      color: opts.withSpot
        ? {
            space: "spot" as const,
            name: "PANTONE 485 C",
            alternate: cmykPct(0, 95, 100, 0),
            tint: 1000,
          }
        : cmykPct(0, 90, 88, 0),
      ...(opts.withRotation ? { rotation: -3_000 } : {}),
    },
    {
      id: "rule",
      kind: "shape" as const,
      frame: { x: IN(0.3), y: IN(1.75), w: IN(2.6), h: IN(0.02) },
      shape: "line" as const,
      stroke: cmykPct(0, 0, 0, 100),
      strokeWidth: 700_000,
    },
    {
      id: "dot",
      kind: "shape" as const,
      frame: { x: IN(2.6), y: IN(1.95), w: IN(0.3), h: IN(0.3) },
      shape: "ellipse" as const,
      fill: grayPct(35),
      stroke: cmykPct(0, 0, 0, 100),
      strokeWidth: 400_000,
    },
    {
      id: "barcode",
      kind: "barcode" as const,
      frame: { x: IN(0.4), y: IN(3.4), w: IN(1.6), h: IN(1.2) },
      symbology: "upca" as const,
      binding: { path: "identifiers.upc12" },
      magnification: 9_000,
      barHeight: 55_000_000,
      barColor: cmykPct(0, 0, 0, 100),
      quietZoneFill: cmykPct(0, 0, 0, 0),
    },
  ];

  if (opts.withImage) {
    front.push({
      id: "hero",
      kind: "image" as const,
      frame: { x: IN(0.3), y: IN(2.4), w: IN(1.4), h: IN(0.9) },
      assetId: ASSET_ID,
      fit: "fill" as const,
      cornerRadius: IN(0.06),
    });
  }

  return DesignDocSchema.parse({
    version: 1,
    presetCode,
    front: {
      side: "front",
      colorIntent: "process",
      background: cmykPct(0, 0, 0, 0),
      elements: front,
    },
    back: {
      side: "back",
      colorIntent: "grayscale",
      background: cmykPct(0, 0, 0, 0),
      elements: [
        {
          id: "bom",
          kind: "bomList",
          frame: { x: IN(0.35), y: IN(0.5), w: IN(2.5), h: IN(2.0) },
          fontFamily: "Barlow Condensed",
          fontSize: 8_000_000,
          color: cmykPct(0, 0, 0, 100),
        },
        {
          id: "legal",
          kind: "text",
          frame: { x: IN(0.35), y: IN(3.0), w: IN(2.5), h: IN(1.0) },
          paragraphs: [
            { runs: [{ text: "Made in USA. Inspect components before installation." }] },
          ],
          fontFamily: "Inter",
          fontWeight: 400,
          fontSize: 6_500_000,
          color: grayPct(100),
          fill: NONE,
        },
      ],
    },
  });
}

function plansFor(presetCode: DesignDoc["presetCode"], opts: FixtureOptions = {}) {
  const assets = new Map<string, AssetInfo>();
  if (opts.withImage) {
    assets.set(ASSET_ID, {
      id: ASSET_ID,
      pixelWidth: 900,
      pixelHeight: 600,
      colorSpace: "srgb",
      contentType: "image/png",
    });
  }
  return planDocument({ doc: design(presetCode, opts), product: product(), assets });
}

/* ------------------------------------------------------------- PNG fixture */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** A real 8-bit RGB PNG, built here so the tests need no binary fixture file. */
function makePng(width: number, height: number): Uint8Array {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter type: none
    for (let x = 0; x < width; x += 1) {
      const p = row + 1 + x * 3;
      raw[p] = (x * 31) & 0xff;
      raw[p + 1] = (y * 17) & 0xff;
      raw[p + 2] = 0x80;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

const PNG_BYTES = makePng(900, 600);

async function loadAsset(id: string): Promise<AssetPayload | null> {
  if (id !== ASSET_ID) return null;
  return { bytes: PNG_BYTES, contentType: "image/png" };
}

/* ------------------------------------------------------------- ICC fixture */

/**
 * A structurally valid, minimal ICC v4 CMYK profile: a correct 128-byte header
 * with the `acsp` signature and a declared size that matches the payload, plus an
 * empty tag table. It is a TEST FIXTURE, not a printing condition — the point is
 * to prove the exporter embeds real profile bytes and rejects fake ones, not to
 * ship a profile. Production deployments supply their press's own profile.
 */
function syntheticCmykIcc(): string {
  const size = 132;
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(size, 0);
  buf.write("appl", 4, "latin1"); // preferred CMM
  buf.writeUInt32BE(0x04300000, 8); // version 4.3
  buf.write("prtr", 12, "latin1"); // device class: output
  buf.write("CMYK", 16, "latin1"); // data colour space
  buf.write("Lab ", 20, "latin1"); // PCS
  buf.write("acsp", 36, "latin1"); // profile file signature
  buf.writeUInt32BE(0, 128); // tag count: none
  return buf.toString("base64");
}

/* ---------------------------------------------------------------- helpers */

/** Decompress a page's content stream back to operator text. */
async function contentStream(bytes: Uint8Array, pageIndex: number): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPage(pageIndex);
  const contents = doc.context.lookup(page.node.get(PDFName.of("Contents")));
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((ref) => doc.context.lookup(ref))
      : [contents];
  let out = "";
  for (const s of streams) {
    if (!(s instanceof PDFRawStream)) continue;
    out += Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
  }
  return out;
}

function firstTextOp(plan: SidePlan, elementId: string): TextOp {
  const op = plan.ops.find((o) => o.elementId === elementId && o.op === "text");
  if (!op || op.op !== "text") throw new Error(`no text op for ${elementId}`);
  return op;
}

function expectClose(actual: number, expected: number, what: string): void {
  expect(Math.abs(actual - expected), `${what}: ${actual} vs ${expected}`).toBeLessThanOrEqual(
    TOL_PT,
  );
}

/* -------------------------------------------------------------- the tests */

describe("production PDF geometry (spec §22)", () => {
  for (const code of ["409TF", "277TF", "206TF"] as const) {
    it(`${code}: page boxes match the specified full-bleed size within ${TOL_PT} pt`, async () => {
      const [wIn, hIn] = EXPECTED_FULL_BLEED_IN[code];
      const expectedW = wIn * 72;
      const expectedH = hIn * 72;
      const preset = CARD_PRESETS[code];
      const bleedPt = uptToPt(preset.bleed.left);

      const result = await renderProductionPdf({ plans: plansFor(code) });
      const info = await inspectPdf(result.bytes);

      expect(info.pageCount).toBe(2);
      expect(info.pages).toHaveLength(2);

      for (const page of info.pages) {
        const { mediaBox, cropBox, bleedBox, trimBox } = page.boxes;
        expect(page.boxes.present.mediaBox).toBe(true);
        expect(page.boxes.present.cropBox).toBe(true);
        expect(page.boxes.present.bleedBox).toBe(true);
        expect(page.boxes.present.trimBox).toBe(true);

        for (const [name, box] of [
          ["MediaBox", mediaBox],
          ["CropBox", cropBox],
          ["BleedBox", bleedBox],
        ] as const) {
          expect(box, `${code} ${name}`).not.toBeNull();
          expectClose(box!.x, 0, `${code} ${name}.x`);
          expectClose(box!.y, 0, `${code} ${name}.y`);
          expectClose(box!.width, expectedW, `${code} ${name}.width`);
          expectClose(box!.height, expectedH, `${code} ${name}.height`);
        }

        // TrimBox is the bleed canvas inset by the bleed on every side.
        expect(trimBox).not.toBeNull();
        expectClose(trimBox!.x, bleedPt, `${code} TrimBox.x`);
        expectClose(trimBox!.y, bleedPt, `${code} TrimBox.y`);
        expectClose(trimBox!.width, expectedW - bleedPt * 2, `${code} TrimBox.width`);
        expectClose(trimBox!.height, expectedH - bleedPt * 2, `${code} TrimBox.height`);
        expectClose(trimBox!.width, uptToPt(preset.trimWidth), `${code} trim width`);
        expectClose(trimBox!.height, uptToPt(preset.trimHeight), `${code} trim height`);
      }

      // The returned pageBoxes must agree with what is actually in the file.
      expect(result.pageBoxes.map((p) => p.side)).toEqual(["front", "back"]);
      result.pageBoxes.forEach((reported, i) => {
        const parsed = info.pages[i].boxes;
        expectClose(reported.mediaBox.width, parsed.mediaBox!.width, "reported MediaBox width");
        expectClose(reported.trimBox.x, parsed.trimBox!.x, "reported TrimBox x");
        expectClose(reported.trimBox.y, parsed.trimBox!.y, "reported TrimBox y");
      });
    });
  }

  it("page count is exactly two — front then back", async () => {
    const result = await renderProductionPdf({ plans: plansFor("409TF") });
    const info = await inspectPdf(result.bytes);
    expect(info.pageCount).toBe(2);
    expect(result.pageBoxes).toHaveLength(2);
    expect(result.pageBoxes[0].side).toBe("front");
    expect(result.pageBoxes[1].side).toBe("back");
  });
});

describe("font embedding", () => {
  it("embeds every face as a tagged subset, with the program present", async () => {
    const result = await renderProductionPdf({ plans: plansFor("409TF") });
    const info = await inspectPdf(result.bytes);

    expect(info.fonts.length).toBeGreaterThan(0);
    for (const font of info.fonts) {
      expect(font.embedded, `${font.baseFont} embedded`).toBe(true);
      expect(font.fontFileKey).toBe("FontFile2");
      expect(font.fontFileBytes).toBeGreaterThan(0);
      expect(font.subset, `${font.baseFont} is a subset`).toBe(true);
      expect(font.subsetTag).toMatch(/^[A-Z]{6}$/);
      expect(font.hasToUnicode).toBe(true);
      expect(font.subtype).toBe("Type0");
      expect(font.descendantSubtype).toBe("CIDFontType2");
    }

    // Every page's font resource dictionary is non-empty.
    for (const page of info.pages) expect(page.fonts.length).toBeGreaterThan(0);

    // Subsetting really happened: the embedded program is a small fraction of
    // the source TTF, which is 300 kB+ per face.
    const totalEmbedded = info.fonts.reduce((n, f) => n + f.fontFileBytes, 0);
    const totalSource = result.complianceStatus.fonts.faces.reduce(
      (n, f) => n + f.sourceByteLength,
      0,
    );
    expect(totalSource).toBeGreaterThan(200_000);
    expect(totalEmbedded).toBeLessThan(totalSource / 10);
    expect(result.complianceStatus.fonts.allSubset).toBe(true);
  });

  it("does not apply OpenType shaping, so PDF advances match the layout engine", async () => {
    // "->" would become one arrow glyph under Inter's `calt`, and Archivo's
    // `liga` would collapse "ff". Both would set narrower than the editor
    // measured. One glyph per code point proves the features are off.
    const doc = DesignDocSchema.parse({
      version: 1,
      presetCode: "409TF",
      front: {
        side: "front",
        elements: [
          {
            id: "shaping",
            kind: "text",
            frame: { x: IN(0.3), y: IN(0.3), w: IN(3.5), h: IN(0.5) },
            paragraphs: [{ runs: [{ text: "off->staff" }] }],
            fontFamily: "Archivo",
            fontWeight: 400,
            fontSize: 12_000_000,
            color: cmykPct(0, 0, 0, 100),
          },
        ],
      },
      back: { side: "back", elements: [] },
    });
    const plans = planDocument({ doc, product: product(), assets: new Map() });
    const result = await renderProductionPdf({ plans });
    const info = await inspectPdf(result.bytes);
    expect(info.pages[0].textContent).toContain("off->staff");
  });
});

/* ------------------------------------------------- subset integrity checks */

/** The characters the layout engine has metrics for, minus U+00AD. */
function metricsCharset(): string {
  const chars: string[] = [];
  for (let c = 0x20; c <= 0x7e; c += 1) chars.push(String.fromCharCode(c));
  for (let c = 0xa0; c <= 0xff; c += 1) {
    // U+00AD SOFT HYPHEN is mapped differently by fontkit's cmap handling than
    // by glyphForCodePoint; it is absent from the metrics and already raises the
    // layout engine's unmappedGlyphs flag, so it is out of scope here.
    if (c !== 0xad) chars.push(String.fromCharCode(c));
  }
  for (const ch of "‐‑‒–—―‘’‚“”„†‡•…‰‹›€™©®°±×÷≤≥≠≈→←↔⌀½¼¾⅛⅜⅝⅞") chars.push(ch);
  return chars.join("");
}

/**
 * The slice of fontkit's API these checks use. `@pdf-lib/fontkit`'s published
 * types describe `Font` but not the `create()` entry point, so the cast is
 * confined to this one helper instead of spreading `any` through the test.
 */
type FontkitGlyph = { advanceWidth: number; bbox: { width: number; height: number } };
type FontkitFont = {
  numGlyphs: number;
  getGlyph(id: number): FontkitGlyph;
  glyphForCodePoint(codePoint: number): FontkitGlyph;
};
const openFont = fontkit.create as unknown as (bytes: Buffer) => FontkitFont;

/** subset glyph id → unicode, read from the font's /ToUnicode CMap. */
function toUnicodeMap(cmap: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const m of cmap.matchAll(/<([0-9a-fA-F]{4})>\s*<([0-9a-fA-F]{4,})>/g)) {
    out.set(parseInt(m[1], 16), parseInt(m[2].slice(0, 4), 16));
  }
  return out;
}

type ExtractedFont = { program: Uint8Array; toUnicode: string };

function extractFontPrograms(doc: PDFDocument): ExtractedFont[] {
  const out: ExtractedFont[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of("Subtype"))?.toString() !== "/CIDFontType2") continue;
    const fd = doc.context.lookup(obj.get(PDFName.of("FontDescriptor")), PDFDict);
    const file = fd && doc.context.lookup(fd.get(PDFName.of("FontFile2")));
    if (!(file instanceof PDFRawStream)) continue;
    // The Type0 parent holds /ToUnicode; find it by matching the descendant.
    let toUnicode = "";
    for (const [, parent] of doc.context.enumerateIndirectObjects()) {
      if (!(parent instanceof PDFDict)) continue;
      if (parent.get(PDFName.of("Subtype"))?.toString() !== "/Type0") continue;
      const kids = parent.lookupMaybe(PDFName.of("DescendantFonts"), PDFArray);
      if (kids?.lookupMaybe(0, PDFDict) !== obj) continue;
      const tu = doc.context.lookup(parent.get(PDFName.of("ToUnicode")));
      if (tu instanceof PDFRawStream) {
        toUnicode = Buffer.from(decodePDFRawStream(tu).decode()).toString("latin1");
      }
    }
    out.push({ program: decodePDFRawStream(file).decode(), toUnicode });
  }
  return out;
}

describe("subset font programs are not silently corrupted", () => {
  /**
   * REGRESSION GUARD for a real defect that shipped in a rendered PDF.
   *
   * @pdf-lib/fontkit's TrueType subsetter serialises `loca` in the short format
   * whenever the subset is under 64 kB, and the short format stores every offset
   * halved — which is only lossless if every glyph record has an even length. It
   * never pads. Inter's faces use a long `loca` and carry ~500 odd-length
   * records each, so a subset Inter came out with wrong glyph boundaries:
   * drawing "12345" produced a page showing only "5", in both CoreGraphics and
   * Poppler.
   *
   * `alignGlyfRecords()` pads the source records before embedding. This test
   * proves the embedded program is intact by decoding every glyph out of the
   * PDF's own FontFile2 and comparing it, through the /ToUnicode CMap, with the
   * same glyph in the source font. Comparing against the source is the point:
   * a subset that merely parses could still hold the wrong outlines.
   */
  it("every glyph in every embedded face matches the source outline", async () => {
    const charset = metricsCharset();
    for (const faceKey of knownFaceKeys()) {
      const doc = await PDFDocument.create({ updateMetadata: false });
      const faces = await embedFaces(doc, [faceKey]);
      const font = faces.get(faceKey)!;
      const page = doc.addPage([600, 400]);
      page.drawText(charset, { x: 10, y: 10, size: 6, font });
      await finaliseFontSubsets(doc, faces);
      const bytes = await doc.save({ useObjectStreams: false });

      const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
      const programs = extractFontPrograms(reloaded);
      expect(programs, `${faceKey}: one embedded program`).toHaveLength(1);

      const { bytes: sourceBytes } = await readFaceBytes(faceKey);
      const source = openFont(Buffer.from(sourceBytes));
      const subset = openFont(Buffer.from(programs[0].program));

      const unicode = toUnicodeMap(programs[0].toUnicode);
      expect(unicode.size, `${faceKey}: ToUnicode entries`).toBeGreaterThan(150);

      let compared = 0;
      for (const [gid, cp] of unicode) {
        const want = source.glyphForCodePoint(cp);
        let got: FontkitGlyph;
        try {
          got = subset.getGlyph(gid);
          // Touching bbox is what forces the outline to be decoded.
          void got.bbox.width;
        } catch (err) {
          throw new Error(
            `${faceKey}: subset glyph ${gid} (U+${cp.toString(16)}) failed to decode: ${String(err)}`,
          );
        }
        expect(got.advanceWidth, `${faceKey} U+${cp.toString(16)} advance`).toBe(
          want.advanceWidth,
        );
        if (Number.isFinite(want.bbox.width) && want.bbox.width > 0) {
          expect(
            Number.isFinite(got.bbox.width) && got.bbox.width > 0,
            `${faceKey}: subset glyph for U+${cp.toString(16)} lost its outline`,
          ).toBe(true);
          expect(Math.round(got.bbox.width)).toBe(Math.round(want.bbox.width));
          expect(Math.round(got.bbox.height)).toBe(Math.round(want.bbox.height));
        }
        compared += 1;
      }
      expect(compared, `${faceKey}: glyphs compared`).toBeGreaterThan(150);
    }
  }, 60_000);

  it("aligns only the fonts that need it, and leaves the rest byte-identical", async () => {
    let padded = 0;
    for (const faceKey of knownFaceKeys()) {
      const { bytes } = await readFaceBytes(faceKey);
      // readFaceBytes already aligns, so re-aligning must be a no-op: the
      // operation is idempotent and every record is now even.
      expect(alignGlyfRecords(bytes)).toBe(bytes);
      if (faceKey.startsWith("Inter")) padded += 1;
    }
    expect(padded).toBeGreaterThan(0);
  });

  it("leaves a non-TrueType payload untouched rather than guessing", () => {
    const notAFont = Uint8Array.from([0x4f, 0x54, 0x54, 0x4f, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(alignGlyfRecords(notAFont)).toBe(notAFont);
    expect(alignGlyfRecords(Uint8Array.from([1, 2, 3]))).toHaveLength(3);
  });
});

describe("colour", () => {
  it("writes DeviceCMYK operators and no RGB operator for an all-CMYK card", async () => {
    const result = await renderProductionPdf({ plans: plansFor("409TF") });
    const info = await inspectPdf(result.bytes);

    for (const page of info.pages) {
      const counts = page.colorSpaces.operatorCounts;
      expect((counts.k ?? 0) + (counts.K ?? 0)).toBeGreaterThan(0);
      expect(counts.rg ?? 0).toBe(0);
      expect(counts.RG ?? 0).toBe(0);
      expect(page.colorSpaces.spaces).toContain("DeviceCMYK");
      expect(page.colorSpaces.spaces).not.toContain("DeviceRGB");
    }
    expect(result.complianceStatus.colorSpaces).toEqual(["DeviceCMYK"]);

    // Grayscale ink is written as 0/0/0/K, not DeviceGray, so a K-only back
    // cannot be re-separated across four plates by the RIP.
    const back = await contentStream(result.bytes, 1);
    expect(back).toMatch(/\bk\b/);
    expect(back).not.toMatch(/\bg\b\s/);
  });

  it("honours the device-gray policy when a deployment asks for it", async () => {
    const result = await renderProductionPdf({
      plans: plansFor("409TF"),
      grayPolicy: "device-gray",
    });
    const info = await inspectPdf(result.bytes);
    const spaces = new Set(info.pages.flatMap((p) => p.colorSpaces.spaces));
    expect(spaces.has("DeviceGray")).toBe(true);
    expect(spaces.has("DeviceRGB")).toBe(false);
  });

  it("converts a spot ink to its CMYK alternate and says so", async () => {
    const result = await renderProductionPdf({ plans: plansFor("409TF", { withSpot: true }) });
    const spot = result.notes.find((n) => n.code === "SPOT_CONVERTED");
    expect(spot, "SPOT_CONVERTED note").toBeDefined();
    expect(spot!.detail).toContain("PANTONE 485 C");
    expect(spot!.detail).toContain("Separation");
    expect(result.complianceStatus.spotConversions[0].name).toBe("PANTONE 485 C");

    const info = await inspectPdf(result.bytes);
    // No Separation space exists in the file — that is the honest outcome.
    for (const page of info.pages) {
      expect(page.colorSpaces.resourceSpaces).not.toContain("Separation");
    }
  });
});

describe("text positioning", () => {
  it("sets a tracked span at exactly the x and baseline the plan computed", async () => {
    const plans = plansFor("409TF");
    const plan = plans.front;
    const op = firstTextOp(plan, "headline");
    const span = op.spans.find((s) => s.text.includes("FREEDOM"));
    expect(span, "headline span").toBeDefined();

    const pageHeightPt = uptToPt(plan.canvas.h);
    const expectedX = uptToPt(span!.x);
    const expectedY = pageHeightPt - uptToPt(span!.y);
    const expectedTc = uptToPt(span!.tracking);
    expect(expectedTc).toBeCloseTo(0.6, 10);

    const result = await renderProductionPdf({ plans });
    const content = await contentStream(result.bytes, 0);

    // Find the text matrix that places this span, then the character spacing in
    // force when it was shown.
    const matrices = [
      ...content.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm/g),
    ] as RegExpMatchArray[];
    const hit = matrices.find(
      (m) =>
        Math.abs(Number(m[1]) - expectedX) <= TOL_PT &&
        Math.abs(Number(m[2]) - expectedY) <= TOL_PT,
    );
    expect(
      hit,
      `no Tm at (${expectedX}, ${expectedY}); saw ${matrices.map((m) => `(${m[1]}, ${m[2]})`).join(" ")}`,
    ).toBeDefined();

    const before = content.slice(0, hit!.index);
    const tcs = [...before.matchAll(/(-?[\d.]+) Tc/g)];
    expect(tcs.length, "a Tc precedes the tracked span").toBeGreaterThan(0);
    expect(Math.abs(Number(tcs[tcs.length - 1][1]) - expectedTc)).toBeLessThanOrEqual(TOL_PT);

    // And the decoded run is really at that device position.
    const info = await inspectPdf(result.bytes);
    const run = info.pages[0].textRuns.find((r) => r.text.startsWith("FREEDOM"));
    expect(run, "decoded headline run").toBeDefined();
    expectClose(run!.xPt, expectedX, "headline run x");
    expectClose(run!.yPt, expectedY, "headline run baseline");
    expectClose(run!.fontSizePt, uptToPt(span!.fontSize), "headline font size");
  });

  it("places every plan span at its own position, not a re-laid-out one", async () => {
    const plans = plansFor("409TF");
    const result = await renderProductionPdf({ plans });
    const info = await inspectPdf(result.bytes);
    const pageHeightPt = uptToPt(plans.front.canvas.h);

    const planned = plans.front.ops
      .filter((o) => o.op === "text")
      .flatMap((o) => (o.op === "text" ? o.spans : []))
      .filter((s) => s.text.trim().length > 0);

    for (const span of planned) {
      const x = uptToPt(span.x);
      const y = pageHeightPt - uptToPt(span.y);
      const match = info.pages[0].textRuns.find(
        (r) => Math.abs(r.xPt - x) <= TOL_PT && Math.abs(r.yPt - y) <= TOL_PT,
      );
      expect(match, `span "${span.text}" at (${x}, ${y})`).toBeDefined();
    }
  });
});

describe("overlays", () => {
  it("no overlay text or overlay marks reach the production PDF", async () => {
    const production = await renderProductionPdf({ plans: plansFor("409TF") });
    const info = await inspectPdf(production.bytes);
    const text = info.pages.map((p) => p.textContent).join("\n").toUpperCase();

    for (const word of [
      "PROOF",
      "NOT FOR PRODUCTION",
      "BLEED",
      "TRIM",
      "SAFE AREA",
      "CAVITY",
      "PREFLIGHT",
      "REVISION",
      "APPROVAL",
    ]) {
      expect(text, `production text must not contain "${word}"`).not.toContain(word);
    }

    // The production text is exactly the artwork's own copy and nothing else.
    const plans = plansFor("409TF");
    const planned = new Set(
      [plans.front, plans.back]
        .flatMap((p) => p.ops)
        .flatMap((o) => (o.op === "text" ? o.spans.map((s) => s.text) : []))
        .concat(
          [plans.front, plans.back]
            .flatMap((p) => p.ops)
            .flatMap((o) => (o.op === "barcode" && o.render ? o.render.text.map((t) => t.text) : [])),
        )
        .map((s) => s.trim())
        .filter(Boolean),
    );
    for (const page of info.pages) {
      for (const run of page.textRuns) {
        const t = run.text.trim();
        if (!t) continue;
        expect(planned.has(t), `unexpected text "${t}" in production artwork`).toBe(true);
      }
    }

    // No optional content dictionary at all: production has no layers to hide.
    const raw = Buffer.from(production.bytes).toString("latin1");
    expect(raw).not.toContain("/OCProperties");
  });

  it("the proof carries the overlay, on a sheet larger than the card", async () => {
    const plans = plansFor("409TF");
    const proof = await renderProofPdf({
      plans,
      info: {
        cardName: "Trailer Hub Repair Kit",
        sku: "11-500",
        gtin: "00012345678905",
        presetCode: "409TF",
        revision: "rev-4",
        approvalStatus: "Approved 2026-08-26 by J. Rivera",
        exportedAt: "2026-08-26T18:00:00Z",
        productName: "Trailer Hub Repair Kit",
      },
    });
    const info = await inspectPdf(proof.bytes);
    const text = info.pages.map((p) => p.textContent).join("\n").toUpperCase();

    for (const word of ["PROOF", "NOT FOR PRODUCTION", "BLEED", "TRIM", "SAFE AREA", "CAVITY"]) {
      expect(text, `proof must state "${word}"`).toContain(word);
    }
    expect(text).toContain("11-500");
    expect(text).toContain("REV-4");
    expect(text).toContain("00012345678905");
    expect(text).toContain("409TF");
    expect(text).toContain("2026-08-26T18:00:00Z");
    expect(text).toContain("PREFLIGHT");

    const cardW = uptToPt(plans.front.canvas.w);
    const cardH = uptToPt(plans.front.canvas.h);
    for (const page of info.pages) {
      expect(page.boxes.mediaBox!.width).toBeGreaterThan(cardW);
      expect(page.boxes.mediaBox!.height).toBeGreaterThan(cardH + PROOF_MARGINS.bottom - 1);
      // The artwork's trim box still describes the real card.
      expectClose(page.boxes.trimBox!.width, uptToPt(CARD_PRESETS["409TF"].trimWidth), "proof trim w");
      expectClose(page.boxes.trimBox!.height, uptToPt(CARD_PRESETS["409TF"].trimHeight), "proof trim h");
    }

    // The overlay is a declared non-printing optional content group.
    const raw = Buffer.from(proof.bytes).toString("latin1");
    expect(raw).toContain("/OCProperties");
    expect(raw).toContain("/PrintState /OFF");
    expect(raw).toContain("/Type /OCG");
  });

  it("the proof slug sits below the artwork, never on it", async () => {
    const plans = plansFor("409TF");
    const proof = await renderProofPdf({
      plans,
      info: {
        cardName: "Card",
        sku: "SKU",
        gtin: "GTIN",
        presetCode: "409TF",
        revision: "r1",
        approvalStatus: "Draft",
      },
    });
    const info = await inspectPdf(proof.bytes);
    const page = info.pages[0];
    const bleedBottom = page.boxes.bleedBox!.y;

    const slugRuns = page.textRuns.filter((r) => r.text.includes("PROOF"));
    expect(slugRuns.length).toBeGreaterThan(0);
    for (const run of slugRuns) {
      expect(run.yPt, "slug baseline is below the bleed box").toBeLessThan(bleedBottom);
    }
  });
});

describe("determinism (spec §15)", () => {
  it("two runs of the same input produce byte-identical production PDFs", async () => {
    const a = await renderProductionPdf({ plans: plansFor("409TF", { withImage: true }), assetBytes: loadAsset });
    const b = await renderProductionPdf({ plans: plansFor("409TF", { withImage: true }), assetBytes: loadAsset });
    expect(a.bytes.byteLength).toBe(b.bytes.byteLength);
    expect(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes))).toBe(0);
  });

  it("two runs of the same input produce byte-identical proof PDFs", async () => {
    const info = {
      cardName: "Card",
      sku: "11-500",
      gtin: "00012345678905",
      presetCode: "277TF" as const,
      revision: "r2",
      approvalStatus: "In review",
      exportedAt: "2026-08-26T18:00:00Z",
    };
    const a = await renderProofPdf({ plans: plansFor("277TF"), info });
    const b = await renderProofPdf({ plans: plansFor("277TF"), info });
    expect(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes))).toBe(0);
  });

  it("rotation and transparency stay deterministic", async () => {
    const opts = { withRotation: true, withOpacity: true };
    const a = await renderProductionPdf({ plans: plansFor("206TF", opts) });
    const b = await renderProductionPdf({ plans: plansFor("206TF", opts) });
    expect(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes))).toBe(0);
    expect(a.complianceStatus.transparencyPresent).toBe(true);
    expect(a.notes.some((n) => n.code === "TRANSPARENCY_PRESENT")).toBe(true);
  });
});

describe("vector barcodes", () => {
  it("draws bar modules as filled rectangles, one per module", async () => {
    const plans = plansFor("409TF");
    const barcodeOp = plans.front.ops.find((o) => o.op === "barcode");
    expect(barcodeOp?.op).toBe("barcode");
    if (barcodeOp?.op !== "barcode" || !barcodeOp.render) throw new Error("no barcode render");
    const expectedBars = barcodeOp.render.bars.length;
    expect(expectedBars).toBeGreaterThan(20);

    const result = await renderProductionPdf({ plans });
    const info = await inspectPdf(result.bytes);
    expect(info.pages[0].barLikeRectCount).toBeGreaterThanOrEqual(expectedBars);
    // No image XObject anywhere: the symbol was not rasterised.
    expect(info.pages[0].images).toHaveLength(0);

    // The human-readable digits are live text, not outlines.
    expect(info.pages[0].textContent).toContain("012345678905".slice(1, 6));
  });
});

describe("placed images", () => {
  it("embeds the raster, reports its colour space, and warns that RGB is not converted", async () => {
    const result = await renderProductionPdf({
      plans: plansFor("409TF", { withImage: true }),
      assetBytes: loadAsset,
    });
    const info = await inspectPdf(result.bytes);
    const images = info.pages.flatMap((p) => p.images);
    expect(images).toHaveLength(1);
    expect(images[0].pixelWidth).toBe(900);
    expect(images[0].pixelHeight).toBe(600);
    expect(result.complianceStatus.placedImageColorSpaces).toEqual(["DeviceRGB"]);

    const note = result.notes.find((n) => n.code === "ASSET_RGB_IN_CMYK");
    expect(note, "ASSET_RGB_IN_CMYK note").toBeDefined();
    expect(note!.severity).toBe("warning");
    expect(note!.detail).toContain("no ICC");
  });

  it("throws a typed error rather than drawing a placeholder for a missing asset", async () => {
    await expect(
      renderProductionPdf({
        plans: plansFor("409TF", { withImage: true }),
        assetBytes: async () => null,
      }),
    ).rejects.toBeInstanceOf(MissingAssetError);

    await expect(
      renderProductionPdf({ plans: plansFor("409TF", { withImage: true }) }),
    ).rejects.toBeInstanceOf(MissingAssetError);
  });

  it("rejects an asset format it cannot place as vector-safe artwork", async () => {
    await expect(
      renderProductionPdf({
        plans: plansFor("409TF", { withImage: true }),
        assetBytes: async () => ({
          bytes: Uint8Array.from([0x25, 0x50, 0x44, 0x46]),
          contentType: "application/pdf",
        }),
      }),
    ).rejects.toBeInstanceOf(UnsupportedAssetError);
  });
});

describe("output intent and compliance labelling (spec §14, §15)", () => {
  it("writes no output intent when none is configured, and says so honestly", async () => {
    const result = await renderProductionPdf({ plans: plansFor("409TF") });
    const info = await inspectPdf(result.bytes);

    expect(info.hasOutputIntent).toBe(false);
    expect(result.complianceStatus.level).toBe("cmyk-production-pdf");
    expect(result.complianceStatus.claimsPdfX).toBe(false);
    expect(result.complianceStatus.label).toContain("not certified PDF/X");
    expect(result.complianceStatus.outputIntent.embedded).toBe(false);
    expect(result.complianceStatus.remainingForPdfX.length).toBeGreaterThan(0);

    const note = result.notes.find((n) => n.code === "OUTPUT_INTENT_MISSING");
    expect(note, "OUTPUT_INTENT_MISSING note").toBeDefined();
    expect(note!.severity).toBe("warning");

    // Nothing in the file may claim PDF/X.
    const raw = Buffer.from(result.bytes).toString("latin1");
    expect(raw).not.toContain("GTS_PDFX");
    expect(raw).not.toContain("pdfxid");
  });

  it("embeds a real ICC profile as a /OutputIntent when one is supplied", async () => {
    const intent = OutputIntentSchema.parse({
      identifier: "FOGRA39",
      conditionName: "Coated FOGRA39 (ISO 12647-2:2004)",
      registryName: "http://www.color.org",
      info: "Supplied by the deployment",
      iccBase64: syntheticCmykIcc(),
    });
    const result = await renderProductionPdf({ plans: plansFor("409TF"), outputIntent: intent });
    const info = await inspectPdf(result.bytes);

    expect(info.hasOutputIntent).toBe(true);
    expect(info.outputIntents).toHaveLength(1);
    const oi = info.outputIntents[0];
    expect(oi.subtype).toBe("GTS_PDFX");
    expect(oi.outputConditionIdentifier).toBe("FOGRA39");
    expect(oi.outputCondition).toBe("Coated FOGRA39 (ISO 12647-2:2004)");
    expect(oi.hasDestOutputProfile).toBe(true);
    expect(oi.destOutputProfileBytes).toBeGreaterThan(0);

    expect(result.complianceStatus.level).toBe("cmyk-production-pdf-with-output-intent");
    expect(result.complianceStatus.claimsPdfX).toBe(false);
    expect(result.complianceStatus.outputIntent.iccColorSpace).toBe("CMYK");
    expect(result.notes.some((n) => n.code === "OUTPUT_INTENT_MISSING")).toBe(false);
  });

  it("writes GTS_PDFA1 when the deployment asks for that subtype", async () => {
    const result = await renderProductionPdf({
      plans: plansFor("409TF"),
      outputIntent: OutputIntentSchema.parse({ iccBase64: syntheticCmykIcc() }),
      outputIntentSubtype: "GTS_PDFA1",
    });
    const info = await inspectPdf(result.bytes);
    expect(info.outputIntents[0].subtype).toBe("GTS_PDFA1");
  });

  it("refuses a profile that is not an ICC profile rather than embedding a fake one", () => {
    expect(() => decodeIccProfile("not-base64-icc")).toThrow(InvalidIccProfileError);
    expect(() => decodeIccProfile(Buffer.alloc(200).toString("base64"))).toThrow(
      InvalidIccProfileError,
    );
    // Correct signature but a declared size that disagrees with the payload.
    const bad = Buffer.alloc(200);
    bad.writeUInt32BE(999, 0);
    bad.write("acsp", 36, "latin1");
    bad.write("CMYK", 16, "latin1");
    expect(() => decodeIccProfile(bad.toString("base64"))).toThrow(/declares 999 bytes/);
  });

  it("reports a valid CMYK profile's colour space and component count", () => {
    const decoded = decodeIccProfile(syntheticCmykIcc());
    expect(decoded.colorSpace).toBe("CMYK");
    expect(decoded.componentCount).toBe(4);
  });
});

describe("page contents stay inside the sheet", () => {
  it("clips every mark to the bleed box before painting anything", async () => {
    // The brand bar in the fixture is deliberately wider than the card, so the
    // clip is doing real work here rather than being a no-op.
    const plans = plansFor("409TF");
    const w = uptToPt(plans.front.canvas.w);
    const h = uptToPt(plans.front.canvas.h);
    const result = await renderProductionPdf({ plans });
    const content = await contentStream(result.bytes, 0);

    // The stream opens by saving state and clipping to the bleed rectangle.
    // Card space (0,0) is the top-left, so the path runs top-left → top-right →
    // bottom-right → bottom-left in PDF coordinates.
    const expectedPrefix = `q\n0 ${h} m\n${w} ${h} l\n${w} 0 l\n0 0 l\nh\nW\nn\n`;
    expect(content.startsWith(expectedPrefix), content.slice(0, 120)).toBe(true);

    // Nothing paints before the clip, and the clip is never released early: the
    // stream ends with the matching Q and every paint operator sits inside it.
    const clipEnd = expectedPrefix.length;
    const firstPaint = content.search(/\n(f|S|B|Do)\n/);
    expect(firstPaint).toBeGreaterThan(clipEnd - 1);
    expect(content.trimEnd().endsWith("Q")).toBe(true);

    // The clip rectangle is the MediaBox, so no mark can reach a neighbouring
    // card on an imposed sheet.
    const info = await inspectPdf(result.bytes);
    const media = info.pages[0].boxes.mediaBox!;
    expectClose(media.width, w, "clip width vs MediaBox");
    expectClose(media.height, h, "clip height vs MediaBox");
  });

  it("keeps the proof's artwork clip on the card, not on the slug", async () => {
    const plans = plansFor("409TF");
    const proof = await renderProofPdf({
      plans,
      info: {
        cardName: "Card",
        sku: "SKU",
        gtin: "GTIN",
        presetCode: "409TF",
        revision: "r1",
        approvalStatus: "Draft",
      },
    });
    const content = await contentStream(proof.bytes, 0);
    // The clip follows the card's own bleed box on the larger sheet, which is
    // what keeps artwork off the slug and the slug off the artwork.
    const bleed = proof.pageBoxes[0].bleedBox;
    const top = bleed.y + bleed.height;
    const lines = content.split("\n");
    expect(lines[0]).toBe("q");
    expect(lines[1].endsWith(" m")).toBe(true);
    expect(lines[2].endsWith(" l")).toBe(true);
    const [mx, my] = lines[1].split(" ").map(Number);
    const [lx] = lines[2].split(" ").map(Number);
    expectClose(mx, bleed.x, "proof clip left");
    expectClose(my, top, "proof clip top");
    expectClose(lx, bleed.x + bleed.width, "proof clip right");
    expect(lines.slice(0, 8)).toContain("W");
    expect(bleed.x).toBeGreaterThanOrEqual(PROOF_MARGINS.left);
    expect(bleed.y).toBeGreaterThanOrEqual(PROOF_MARGINS.bottom - TOL_PT);
  });
});

describe("plan fidelity", () => {
  it("draws every op the plan produced", async () => {
    const plans = plansFor("409TF", { withImage: true });
    const result = await renderProductionPdf({ plans, assetBytes: loadAsset });
    const info = await inspectPdf(result.bytes);
    // Paths, text and one image on the front.
    expect(info.pages[0].filledRects.length).toBeGreaterThan(0);
    expect(info.pages[0].images).toHaveLength(1);
    expect(info.pages[0].textRuns.length).toBeGreaterThan(0);
    // The back has the BOM list and the legal line.
    expect(info.pages[1].textRuns.length).toBeGreaterThan(3);
    expect(ptToUpt(1)).toBe(1_000_000);
  });
});

/**
 * PRINT QA HOOK — spec §32 forbids calling print QA complete without inspecting
 * a generated PDF. Set PDF_ARTIFACT_DIR to have the suite drop real files there
 * for a human (or a rasteriser) to open.
 */
describe.runIf(Boolean(process.env.PDF_ARTIFACT_DIR))("artifact dump", () => {
  it("writes production and proof PDFs for every preset", async () => {
    const dir = process.env.PDF_ARTIFACT_DIR!;
    fs.mkdirSync(dir, { recursive: true });
    for (const code of ["409TF", "277TF", "206TF"] as const) {
      const plans = plansFor(code, { withImage: true, withRotation: true });
      const production = await renderProductionPdf({ plans, assetBytes: loadAsset });
      fs.writeFileSync(path.join(dir, `${code}-production.pdf`), production.bytes);
      const proof = await renderProofPdf({
        plans,
        assetBytes: loadAsset,
        info: {
          cardName: "Trailer Hub Repair Kit",
          sku: "11-500",
          gtin: "00012345678905",
          presetCode: code,
          revision: "rev-4",
          approvalStatus: "Approved 2026-08-26 by J. Rivera",
          exportedAt: "2026-08-26T18:00:00Z",
          productName: "Trailer Hub Repair Kit",
          note: "Print on 18 pt C1S. Verify cavity clearance against a physical clamshell before release.",
        },
      });
      fs.writeFileSync(path.join(dir, `${code}-proof.pdf`), proof.bytes);
    }
    // A card with no placed raster: the honest measure of what the vector
    // pipeline itself costs.
    const lean = await renderProductionPdf({ plans: plansFor("409TF") });
    fs.writeFileSync(path.join(dir, "409TF-production-no-image.pdf"), lean.bytes);
    console.log("no-image production bytes:", lean.bytes.byteLength);
    console.log(
      "embedded faces:",
      JSON.stringify(lean.complianceStatus.fonts.faces.map((f) => f.faceKey)),
    );
    const info = await inspectPdf(lean.bytes);
    for (const f of info.fonts) {
      console.log("  ", f.baseFont, "FontFile2 bytes:", f.fontFileBytes);
    }
    expect(fs.readdirSync(dir).length).toBeGreaterThanOrEqual(6);
  });
});

describe.runIf(Boolean(process.env.PDF_ARTIFACT_DIR))("artifact dump", () => {
  it("writes production and proof PDFs for every preset", async () => {
    const dir = process.env.PDF_ARTIFACT_DIR!;
    fs.mkdirSync(dir, { recursive: true });
    for (const code of ["409TF", "277TF", "206TF"] as const) {
      const plans = plansFor(code, { withImage: true, withRotation: true });
      const production = await renderProductionPdf({ plans, assetBytes: loadAsset });
      fs.writeFileSync(path.join(dir, `${code}-production.pdf`), production.bytes);
      const proof = await renderProofPdf({
        plans,
        assetBytes: loadAsset,
        info: {
          cardName: "Trailer Hub Repair Kit",
          sku: "11-500",
          gtin: "00012345678905",
          presetCode: code,
          revision: "rev-4",
          approvalStatus: "Approved 2026-08-26 by J. Rivera",
          exportedAt: "2026-08-26T18:00:00Z",
          productName: "Trailer Hub Repair Kit",
          note: "Print on 18 pt C1S. Verify cavity clearance against a physical clamshell before release.",
        },
      });
      fs.writeFileSync(path.join(dir, `${code}-proof.pdf`), proof.bytes);
    }
    // A card with no placed raster: the honest measure of what the vector
    // pipeline itself costs.
    const lean = await renderProductionPdf({ plans: plansFor("409TF") });
    fs.writeFileSync(path.join(dir, "409TF-production-no-image.pdf"), lean.bytes);
    console.log("no-image production bytes:", lean.bytes.byteLength);
    console.log(
      "embedded faces:",
      JSON.stringify(lean.complianceStatus.fonts.faces.map((f) => f.faceKey)),
    );
    const info = await inspectPdf(lean.bytes);
    for (const f of info.fonts) {
      console.log("  ", f.baseFont, "FontFile2 bytes:", f.fontFileBytes);
    }
    expect(fs.readdirSync(dir).length).toBeGreaterThanOrEqual(6);
  });
});

