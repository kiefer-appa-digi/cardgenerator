import { inToUpt, uptToIn, uptToPt } from "../src/lib/units";
import { DesignDocSchema } from "../src/lib/design/schema";
import { planDocument } from "../src/lib/design/plan";
import { emptyProductContext } from "../src/lib/data/context";
import { renderProofPdf } from "../src/lib/pdf/proof";
import { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
const IN = inToUpt;
(async () => {
  for (const ov of [
    { top: IN(0.1875), right: IN(0.1875), bottom: IN(0.1875), left: IN(0.1875) },
    { top: IN(0.1), right: IN(0.1), bottom: IN(0.1), left: IN(0.4) },
  ]) {
    const doc = DesignDocSchema.parse({ version: 1, presetCode: "409TF", safeAreaOverride: ov,
      front: { side: "front", elements: [] }, back: { side: "back", elements: [] } });
    const plans = planDocument({ doc, product: emptyProductContext(), assets: new Map() });
    const r = await renderProofPdf({ plans, info: { cardName: "C", sku: "S", gtin: "G",
      presetCode: "409TF", revision: "r", approvalStatus: "Draft" } });
    const d = await PDFDocument.load(r.bytes, { updateMetadata: false });
    const c = d.context.lookup(d.getPage(0).node.get(PDFName.of("Contents")));
    const streams = c instanceof PDFArray ? c.asArray().map((x) => d.context.lookup(x)) : [c];
    let txt = "";
    for (const s of streams) if (s instanceof PDFRawStream) txt += Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
    // safe area is the dashed [4 2] stroke in 1 0 1 0 K
    const m = /1 0 1 0 K\n0\.5 w\n\[4 2\] 0 d\n([-\d.]+) ([-\d.]+) m/.exec(txt);
    const bleedX = uptToPt(plans.front.canvas.x);
    const safeXpt = uptToPt(plans.front.safe.x) + (r.pageBoxes[0].bleedBox.x - bleedX);
    const drawnRadiusPt = m ? Number(m[1]) - safeXpt : NaN;
    console.log("safe insets L/T/R/B in:", [ov.left, ov.top, ov.right, ov.bottom].map(uptToIn).join("/"),
      "| plan.safeCornerRadius pt:", uptToPt(plans.front.safeCornerRadius).toFixed(4),
      "| drawn radius pt:", drawnRadiusPt.toFixed(4),
      Math.abs(drawnRadiusPt - uptToPt(plans.front.safeCornerRadius)) < 1e-6 ? "AGREE" : "*** DISAGREE ***");
  }
})();
