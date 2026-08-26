/* TEMPORARY: does the PDF advance a TRACKED span exactly as the plan measured it? */
import fs from "node:fs";
import { inToUpt, uptToPt } from "../src/lib/units";
import { cmykPct } from "../src/lib/color/types";
import { DesignDocSchema } from "../src/lib/design/schema";
import { planDocument } from "../src/lib/design/plan";
import { emptyProductContext } from "../src/lib/data/context";
import { renderProductionPdf } from "../src/lib/pdf/production";

const IN = inToUpt;
const TEXT = "AVWA Wa To 12345 ff -> $9 fi";
const doc = DesignDocSchema.parse({
  version: 1, presetCode: "409TF",
  front: { side: "front", elements: [
    { id: "t0", kind: "text", frame: { x: IN(0.25), y: IN(0.4), w: IN(4.0), h: IN(0.5) },
      paragraphs: [{ runs: [{ text: TEXT }] }], fontFamily: "Archivo", fontWeight: 400,
      fontSize: 12_000_000, tracking: 600_000, color: cmykPct(0,0,0,100) },
    { id: "t1", kind: "text", frame: { x: IN(0.25), y: IN(1.0), w: IN(4.0), h: IN(0.5) },
      paragraphs: [{ runs: [{ text: TEXT }] }], fontFamily: "Inter", fontWeight: 400,
      fontSize: 12_000_000, tracking: 0, color: cmykPct(0,0,0,100) },
    { id: "t2", kind: "text", frame: { x: IN(0.25), y: IN(1.6), w: IN(4.0), h: IN(0.5) },
      paragraphs: [{ runs: [{ text: TEXT }] }], fontFamily: "Barlow Condensed", fontWeight: 400,
      fontSize: 12_000_000, tracking: -300_000, color: cmykPct(0,0,0,100) },
  ] },
  back: { side: "back", elements: [] },
});
const plans = planDocument({ doc, product: emptyProductContext(), assets: new Map() });
const out: Record<string, unknown>[] = [];
for (const op of plans.front.ops) {
  if (op.op !== "text") continue;
  for (const s of op.spans) {
    out.push({ id: op.elementId, text: s.text, xPt: uptToPt(s.x), yPt: uptToPt(s.y),
      widthPt: uptToPt(s.width), sizePt: uptToPt(s.fontSize), trackingPt: uptToPt(s.tracking),
      endPt: uptToPt(s.x + s.width) });
  }
}
(async () => {
  const r = await renderProductionPdf({ plans });
  fs.writeFileSync("/tmp/track.pdf", r.bytes);
  fs.writeFileSync("/tmp/track.json", JSON.stringify({ pageHeightPt: uptToPt(plans.front.canvas.h), spans: out }, null, 2));
  console.log(JSON.stringify(out, null, 1));
})();
