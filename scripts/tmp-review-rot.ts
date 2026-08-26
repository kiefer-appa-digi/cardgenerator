import { inToUpt } from "../src/lib/units";
import { cmykPct } from "../src/lib/color/types";
import { DesignDocSchema } from "../src/lib/design/schema";
import { planDocument } from "../src/lib/design/plan";
import { emptyProductContext } from "../src/lib/data/context";
import { renderProductionPdf } from "../src/lib/pdf/production";
import { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
const IN = inToUpt;
(async () => {
  for (const rot of [90_000, 45_000, -3_000, 180_000, 359_000, 360_000, 720_000, -90_000]) {
    const doc = DesignDocSchema.parse({ version: 1, presetCode: "409TF",
      front: { side: "front", elements: [
        { id: "r", kind: "text", frame: { x: IN(1), y: IN(1), w: IN(2), h: IN(0.4) },
          paragraphs: [{ runs: [{ text: "NINETY" }] }], fontFamily: "Inter", fontWeight: 400,
          fontSize: 14_000_000, color: cmykPct(0,0,0,100), rotation: rot }] },
      back: { side: "back", elements: [] } });
    const el = doc.front.elements[0] as { rotation?: number };
    const plans = planDocument({ doc, product: emptyProductContext(), assets: new Map() });
    const op = plans.front.ops[0];
    const r = await renderProductionPdf({ plans });
    const d = await PDFDocument.load(r.bytes, { updateMetadata: false });
    const c = d.context.lookup(d.getPage(0).node.get(PDFName.of("Contents")));
    const streams = c instanceof PDFArray ? c.asArray().map((x) => d.context.lookup(x)) : [c];
    let txt = "";
    for (const s2 of streams) if (s2 instanceof PDFRawStream) txt += Buffer.from(decodePDFRawStream(s2).decode()).toString("latin1");
    const cms = txt.match(/[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ cm/g) ?? [];
    console.log(String(rot).padStart(8), "schema.rotation=", el.rotation, "op.rotation=", op?.rotation, "cm:", cms.join(" | ") || "(none)");
  }
})();
