/* TEMPORARY adversarial review harness — delete after review. */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { inToUpt } from "../src/lib/units";
import { CARD_PRESETS } from "../src/lib/geometry/presets";
import { cmykPct, grayPct, NONE } from "../src/lib/color/types";
import { DesignDocSchema, type DesignDoc } from "../src/lib/design/schema";
import { planDocument, type AssetInfo } from "../src/lib/design/plan";
import { emptyProductContext, type ProductContext } from "../src/lib/data/context";
import { renderProductionPdf } from "../src/lib/pdf/production";
import { renderProofPdf } from "../src/lib/pdf/proof";

const IN = inToUpt;
const OUT = process.env.OUT_DIR ?? path.join(process.cwd(), "artifacts/pdf");

const ASSET_ID = "asset-hero";

function bomItem(position: number, partNumber: string, name: string, quantity: number) {
  return { position, partNumber, name, quantity, quantityText: String(quantity), description: "", unitOfMeasure: "" };
}
function product(): ProductContext {
  return {
    ...emptyProductContext(),
    id: "p1",
    partNumber: "11-500",
    productName: "Trailer Hub Repair Kit",
    brand: { name: "Freedom", legalName: "Freedom Trailer Parts LLC", statement: "", logoAssetId: null },
    identifiers: { gtin14: "", gtin13: "", upc12: "012345678905", sku: "11-500", gs1CompanyPrefix: "" },
    bom: {
      items: [bomItem(1, "L44643", "Inner Bearing", 2), bomItem(2, "L68149", "Outer Bearing", 2), bomItem(3, "10-19", "Grease Seal", 2)],
      packIncludes: "",
      itemCount: 3,
    },
  };
}

/* ---- an ORIENTED PNG: a big red block in the TOP-LEFT quadrant only ---- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Buffer) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function orientedPng(w: number, h: number): Uint8Array {
  const raw = Buffer.alloc(h * (1 + w * 3), 0);
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const p = row + 1 + x * 3;
      const topLeft = x < w / 2 && y < h / 2;
      raw[p] = topLeft ? 255 : 20;      // R
      raw[p + 1] = topLeft ? 0 : 20;    // G
      raw[p + 2] = topLeft ? 0 : 220;   // B  (bottom/right = blue)
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Uint8Array.from(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]));
}
const PNG = orientedPng(900, 600);
async function loadAsset(id: string) { return id === ASSET_ID ? { bytes: PNG, contentType: "image/png" } : null; }

function design(presetCode: DesignDoc["presetCode"]): DesignDoc {
  const p = CARD_PRESETS[presetCode];
  const front: Array<Record<string, unknown>> = [
    { id: "bg", kind: "shape", name: "Brand bar", frame: { x: 0, y: 0, w: p.trimWidth + IN(0.25), h: IN(0.9) }, shape: "rect", fill: cmykPct(78, 20, 0, 0), cornerRadius: 0 },
    { id: "topleft", kind: "text", frame: { x: IN(0.2), y: IN(0.16), w: IN(2.2), h: IN(0.3) },
      paragraphs: [{ runs: [{ text: "TOP-LEFT 12345" }] }], fontFamily: "Inter", fontWeight: 600, fontSize: 10_000_000, color: cmykPct(0,0,0,0) },
    { id: "headline", kind: "text", frame: { x: IN(0.3), y: IN(1.1), w: IN(2.4), h: IN(0.5) },
      paragraphs: [{ runs: [{ text: "12345 ff -> $9" }] }], fontFamily: "Inter", fontWeight: 400, fontSize: 18_000_000, color: cmykPct(0,0,0,100) },
    { id: "rot", kind: "text", frame: { x: IN(0.3), y: IN(1.7), w: IN(2.0), h: IN(0.4) },
      paragraphs: [{ runs: [{ text: "ROT-3" }] }], fontFamily: "Archivo", fontWeight: 700, fontSize: 16_000_000, color: cmykPct(0,90,88,0), rotation: -3_000 },
    { id: "hero", kind: "image", frame: { x: IN(0.3), y: IN(2.2), w: IN(1.4), h: IN(0.9) }, assetId: ASSET_ID, fit: "fill", cornerRadius: 0 },
    { id: "barcode", kind: "barcode", frame: { x: IN(0.4), y: IN(3.4), w: IN(1.6), h: IN(1.2) }, symbology: "upca",
      binding: { path: "identifiers.upc12" }, magnification: 9_000, barHeight: 55_000_000, barColor: cmykPct(0,0,0,100), quietZoneFill: cmykPct(0,0,0,0) },
    { id: "botright", kind: "text", frame: { x: IN(0.3), y: p.trimHeight - IN(0.35), w: IN(3.0), h: IN(0.3) },
      paragraphs: [{ runs: [{ text: "BOTTOM-RIGHT MARKER" }] }], fontFamily: "Barlow Condensed", fontWeight: 500, fontSize: 9_000_000, color: cmykPct(0,0,0,100) },
  ];
  return DesignDocSchema.parse({
    version: 1, presetCode,
    front: { side: "front", colorIntent: "process", background: cmykPct(0,0,0,0), elements: front },
    back: { side: "back", colorIntent: "grayscale", background: cmykPct(0,0,0,0), elements: [
      { id: "bom", kind: "bomList", frame: { x: IN(0.35), y: IN(0.5), w: IN(2.4), h: IN(2.0) }, fontFamily: "Barlow Condensed", fontSize: 8_000_000, color: cmykPct(0,0,0,100) },
      { id: "legal", kind: "text", frame: { x: IN(0.35), y: IN(3.0), w: IN(2.4), h: IN(1.0) },
        paragraphs: [{ runs: [{ text: "Made in USA. Inspect components before installation." }] }],
        fontFamily: "Inter", fontWeight: 400, fontSize: 6_500_000, color: grayPct(100), fill: NONE },
    ] },
  });
}

function plansFor(code: DesignDoc["presetCode"]) {
  const assets = new Map<string, AssetInfo>();
  assets.set(ASSET_ID, { id: ASSET_ID, pixelWidth: 900, pixelHeight: 600, colorSpace: "srgb", contentType: "image/png" });
  return planDocument({ doc: design(code), product: product(), assets });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const code of ["409TF", "277TF", "206TF"] as const) {
    const plans = plansFor(code);
    const prod = await renderProductionPdf({ plans, assetBytes: loadAsset });
    fs.writeFileSync(path.join(OUT, `${code}-production.pdf`), prod.bytes);
    const proof = await renderProofPdf({
      plans, assetBytes: loadAsset,
      info: { cardName: "Trailer Hub Repair Kit", sku: "11-500", gtin: "00012345678905", presetCode: code,
        revision: "rev-4", approvalStatus: "Approved 2026-08-26 by J. Rivera", exportedAt: "2026-08-26T18:00:00Z",
        productName: "Trailer Hub Repair Kit", note: "Print on 18 pt C1S." },
    });
    fs.writeFileSync(path.join(OUT, `${code}-proof.pdf`), proof.bytes);
    console.log(code, "prod", prod.bytes.byteLength, "proof", proof.bytes.byteLength,
      JSON.stringify({ level: prod.complianceStatus.level, spaces: prod.complianceStatus.colorSpaces,
        imgSpaces: prod.complianceStatus.placedImageColorSpaces,
        faces: prod.complianceStatus.fonts.faces.map(f => `${f.subsetTag}+${f.faceKey}`) }));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
