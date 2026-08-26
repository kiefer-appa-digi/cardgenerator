import { inToUpt, uptToIn } from "../src/lib/units";
import { clampRadius } from "../src/lib/geometry/types";
import { DesignDocSchema } from "../src/lib/design/schema";
import { planDocument } from "../src/lib/design/plan";
import { emptyProductContext } from "../src/lib/data/context";
const IN = inToUpt;
for (const ov of [
  { top: IN(0.1875), right: IN(0.1875), bottom: IN(0.1875), left: IN(0.1875) },
  { top: IN(0.5), right: IN(0.1), bottom: IN(0.5), left: IN(0.25) },
  { top: IN(0.1), right: IN(0.1), bottom: IN(0.1), left: IN(0.4) },
]) {
  const doc = DesignDocSchema.parse({ version: 1, presetCode: "409TF", safeAreaOverride: ov,
    front: { side: "front", elements: [] }, back: { side: "back", elements: [] } });
  const plans = planDocument({ doc, product: emptyProductContext(), assets: new Map() });
  const p = plans.front;
  const proofRadius = clampRadius(p.safe, Math.max(0, p.cornerRadius - (p.safe.x - p.trim.x)));
  console.log(
    "override L/T/R/B in:", [ov.left, ov.top, ov.right, ov.bottom].map(uptToIn).join("/"),
    "| plan.safeCornerRadius in:", uptToIn(p.safeCornerRadius).toFixed(5),
    "| proof drew in:", uptToIn(proofRadius).toFixed(5),
    uptToIn(p.safeCornerRadius) === uptToIn(proofRadius) ? "AGREE" : "*** DISAGREE ***");
}
