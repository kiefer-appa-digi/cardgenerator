/* TEMPORARY: proof drawn with a preset code that does not match the plans */
import fs from "node:fs";
import { inToUpt } from "../src/lib/units";
import { cmykPct } from "../src/lib/color/types";
import { DesignDocSchema } from "../src/lib/design/schema";
import { planDocument } from "../src/lib/design/plan";
import { emptyProductContext } from "../src/lib/data/context";
import { renderProofPdf } from "../src/lib/pdf/proof";
const IN = inToUpt;
const doc = DesignDocSchema.parse({ version: 1, presetCode: "409TF",
  front: { side: "front", elements: [{ id: "b", kind: "shape", frame: { x: 0, y: 0, w: IN(4.6), h: IN(1) },
    shape: "rect", fill: cmykPct(78,20,0,0), cornerRadius: 0 }] },
  back: { side: "back", elements: [] } });
const plans = planDocument({ doc, product: emptyProductContext(), assets: new Map() });
(async () => {
  const r = await renderProofPdf({ plans, info: { cardName: "MISMATCH", sku: "S", gtin: "G",
    presetCode: "206TF", revision: "r", approvalStatus: "Draft" } });
  fs.writeFileSync("/tmp/mismatch-proof.pdf", r.bytes);
  console.log("rendered mismatch proof, bytes", r.bytes.byteLength, "boxes", JSON.stringify(r.pageBoxes[0].trimBox));
})();
