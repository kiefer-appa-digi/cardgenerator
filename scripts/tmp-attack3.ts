#!/usr/bin/env -S npx tsx
import sharp from "sharp";
import { inToUpt } from "@/lib/units";
import { CARD_PRESETS, fullBleedWidth, fullBleedHeight } from "@/lib/geometry/presets";
import { cmykPct, NONE } from "@/lib/color/types";
import { DesignElementSchema, emptyDesign, type DesignElement } from "@/lib/design/schema";
import { planDocument, type AssetInfo } from "@/lib/design/plan";
import { emptyProductContext } from "@/lib/data/context";
import { renderProductionPdf } from "@/lib/pdf/production";
import { validateProductionPdf, expectationForPlans } from "@/lib/pdf/validate";
import type { AssetPayload } from "@/lib/pdf/draw";

const IN = inToUpt;
const el = (o: Record<string, unknown>): DesignElement => DesignElementSchema.parse(o);

async function main() {
  const preset = CARD_PRESETS["409TF"];
  const w = fullBleedWidth(preset), h = fullBleedHeight(preset);
  const jpegBuf = await sharp({ create: { width: 1600, height: 400, channels: 3, background: { r: 90, g: 90, b: 90 } } })
    .greyscale().toColourspace("b-w").jpeg().toBuffer();
  const jpeg = new Uint8Array(jpegBuf);
  const assetBytes = async (): Promise<AssetPayload | null> => ({ bytes: jpeg, contentType: "image/jpeg" });
  const assets = new Map<string, AssetInfo>([
    ["bg", { id: "bg", pixelWidth: 1600, pixelHeight: 400, colorSpace: "gray", contentType: "image/jpeg" }],
  ]);

  for (const fit of ["fill", "crop", "fit", "stretch"] as const) {
    const doc = emptyDesign("409TF");
    doc.front.elements = [
      // A full-bleed background image whose aspect ratio does NOT match the page:
      // 4:1 source into a 0.63:1 frame. "fill" must crop hard.
      el({ kind: "image", id: "bgimg", frame: { x: 0, y: 0, w, h }, assetId: "bg", fit, isBackground: true }),
      el({ kind: "shape", id: "s", shape: "rect", frame: { x: IN(1), y: IN(1), w: IN(1), h: IN(1) },
           fill: cmykPct(0, 0, 0, 100), stroke: NONE }),
    ];
    doc.back.elements = [];
    const plans = planDocument({ doc, product: emptyProductContext(), assets });
    const out = await renderProductionPdf({ plans, assetBytes });
    const r = await validateProductionPdf(out.bytes, expectationForPlans({ presetCode: "409TF", plans }));
    const clip = r.checks.find((c) => c.id === "NO_CLIPPING")!;
    const dpi = r.checks.find((c) => c.id === "IMAGE_RESOLUTION")!;
    console.log(`fit=${fit.padEnd(8)} overall=${r.passed ? "PASS" : "FAIL"} NO_CLIPPING=${clip.status} overhang=${clip.measurements.worstOverhangPt} | IMAGE_RESOLUTION=${dpi.status} ${dpi.measured}`);
    if (clip.status === "fail") console.log("   ", clip.pageResults[0].detail.slice(0, 300));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
