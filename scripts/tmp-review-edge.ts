/* TEMPORARY edge-case attacks */
import { inToUpt } from "../src/lib/units";
import { cmykPct } from "../src/lib/color/types";
import { DesignDocSchema } from "../src/lib/design/schema";
import { planDocument } from "../src/lib/design/plan";
import { emptyProductContext } from "../src/lib/data/context";
import { renderProductionPdf } from "../src/lib/pdf/production";
import { renderProofPdf } from "../src/lib/pdf/proof";

const IN = inToUpt;
function mk(elements: Array<Record<string, unknown>>) {
  return planDocument({
    doc: DesignDocSchema.parse({ version: 1, presetCode: "409TF",
      front: { side: "front", elements }, back: { side: "back", elements: [] } }),
    product: emptyProductContext(), assets: new Map() });
}

(async () => {
  // 1. unknown font family
  try {
    const plans = mk([{ id: "t", kind: "text", frame: { x: IN(0.3), y: IN(0.3), w: IN(3), h: IN(0.5) },
      paragraphs: [{ runs: [{ text: "Unknown family" }] }], fontFamily: "Comic Sans MS",
      fontWeight: 400, fontSize: 12_000_000, color: cmykPct(0,0,0,100) }]);
    console.log("  plan facesUsed:", JSON.stringify(plans.front.facesUsed));
    const spans = plans.front.ops.flatMap(o => o.op === "text" ? o.spans : []);
    console.log("  span faceKeys:", JSON.stringify(spans.map(s => s.faceKey)), "fontsMissing:",
      JSON.stringify(plans.front.ops.flatMap(o => o.op === "text" ? o.fontsMissing : [])));
    const r = await renderProductionPdf({ plans });
    console.log("1. unknown family -> OK", r.bytes.byteLength, "notes:", r.notes.map(n=>n.code).join(","));
  } catch (e) { console.log("1. unknown family -> THREW:", (e as Error).name, (e as Error).message.slice(0,140)); }

  // 2. completely empty card
  try {
    const r = await renderProductionPdf({ plans: mk([]) });
    console.log("2. empty card -> OK", r.bytes.byteLength,
      "allSubset:", r.complianceStatus.fonts.allSubset,
      "embedded:", r.complianceStatus.fonts.embedded,
      "colorSpaces:", JSON.stringify(r.complianceStatus.colorSpaces));
  } catch (e) { console.log("2. empty card -> THREW:", (e as Error).message.slice(0,140)); }

  // 3. proof of an empty card (chrome faces still needed)
  try {
    const r = await renderProofPdf({ plans: mk([]), info: { cardName: "C", sku: "S", gtin: "G",
      presetCode: "409TF", revision: "r", approvalStatus: "Draft" } });
    console.log("3. empty proof -> OK", r.bytes.byteLength, "allSubset:", r.complianceStatus.fonts.allSubset);
  } catch (e) { console.log("3. empty proof -> THREW:", (e as Error).message.slice(0,140)); }

  // 4. canvas origin
  const p = mk([]);
  console.log("4. canvas:", JSON.stringify(p.front.canvas), "trim:", JSON.stringify(p.front.trim));

  // 5. 90-degree rotation, exact
  try {
    const plans = mk([{ id: "r90", kind: "text", frame: { x: IN(1), y: IN(1), w: IN(2), h: IN(0.4) },
      paragraphs: [{ runs: [{ text: "NINETY" }] }], fontFamily: "Inter", fontWeight: 400,
      fontSize: 14_000_000, color: cmykPct(0,0,0,100), rotation: 90_000 }]);
    const r = await renderProductionPdf({ plans });
    const { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
    const d = await PDFDocument.load(r.bytes, { updateMetadata: false });
    const c = d.context.lookup(d.getPage(0).node.get(PDFName.of("Contents")));
    const txt = c instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(c).decode()).toString("latin1") : "";
    console.log("5. 90deg cm:", (txt.match(/[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ cm/g) ?? []).join(" | "));
  } catch (e) { console.log("5. THREW", (e as Error).message.slice(0,140)); }
})();
