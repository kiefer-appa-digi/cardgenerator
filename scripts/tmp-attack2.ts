#!/usr/bin/env -S npx tsx
import { readFile } from "node:fs/promises";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts } from "pdf-lib";
import { inToUpt } from "@/lib/units";
import { CARD_PRESETS, fullBleedWidth, fullBleedHeight } from "@/lib/geometry/presets";
import { cmykPct, NONE, TEXT_BLACK } from "@/lib/color/types";
import { DesignElementSchema, emptyDesign, type DesignElement } from "@/lib/design/schema";
import { planDocument } from "@/lib/design/plan";
import { emptyProductContext } from "@/lib/data/context";
import { renderProductionPdf } from "@/lib/pdf/production";
import { inspectPdf } from "@/lib/pdf/inspect";
import { validateProductionPdf, expectationForPreset, expectationForPlans } from "@/lib/pdf/validate";

const IN = inToUpt;
const el = (o: Record<string, unknown>): DesignElement => DesignElementSchema.parse(o);

async function mutate(bytes: Uint8Array, fn: (d: PDFDocument) => void | Promise<void>) {
  const d = await PDFDocument.load(bytes, { updateMetadata: false });
  await fn(d);
  return d.save({ useObjectStreams: false });
}
async function report(label: string, bytes: Uint8Array, e = expectationForPreset("409TF")) {
  const r = await validateProductionPdf(bytes, e);
  const failed = r.checks.filter((c) => c.status === "fail").map((c) => c.id);
  console.log(`${r.passed ? "PASS ✗" : "FAIL ✓"}  ${label.padEnd(56)} failed=[${failed.join(",")}] warnings=${r.warnings.length}`);
  return r;
}

async function main() {
  const b = new Uint8Array(await readFile("artifacts/pdf/409TF-production.pdf"));

  // A13 — overlay word painted inside a Form XObject.
  await report("A13 overlay word inside a Form XObject",
    await mutate(b, async (d) => {
      const p = d.getPages()[0];
      const helv = await d.embedFont(StandardFonts.Helvetica);
      const form = d.context.flateStream(`BT /F1 10 Tf 5 5 Td (CAVITY OUTLINE) Tj ET`, {
        Type: "XObject", Subtype: "Form", BBox: [0, 0, 200, 30],
        Resources: { Font: { F1: helv.ref } },
      });
      const ref = d.context.register(form);
      p.node.normalize();
      p.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict).set(PDFName.of("Fx"), ref);
      const cs = d.context.register(d.context.flateStream(`q 1 0 0 1 30 30 cm /Fx Do Q\n`));
      (p.node.Contents() as PDFArray).push(cs);
    }));

  // A18 — a content stream with a filter pdf-lib cannot decode.
  const brokenStream = await mutate(b, (d) => {
    const p = d.getPages()[0];
    const cs = d.context.flateStream("q Q\n");
    cs.dict.set(PDFName.of("Filter"), PDFName.of("JBIG2Decode"));
    const ref = d.context.register(cs);
    p.node.set(PDFName.of("Contents"), d.context.obj([ref]));
  });
  const r18 = await report("A18 content stream in an undecodable filter", brokenStream);
  console.log("     warnings:", r18.warnings);
  console.log("     NO_CLIPPING:", r18.checks.find(c=>c.id==="NO_CLIPPING")!.measured);
  console.log("     NO_EDITOR_OVERLAYS:", r18.checks.find(c=>c.id==="NO_EDITOR_OVERLAYS")!.measured);

  // A19 — a completely blank production page.
  await report("A19 page 1 content stream emptied (blank artwork)",
    await mutate(b, (d) => {
      const p = d.getPages()[0];
      p.node.set(PDFName.of("Contents"), d.context.obj([
        d.context.register(d.context.flateStream("")),
      ]));
    }));

  // A14 — multi-run text: does joining runs with a space invent "TRIM"?
  const preset = CARD_PRESETS["409TF"];
  const w = fullBleedWidth(preset), h = fullBleedHeight(preset);
  const doc = emptyDesign("409TF");
  doc.front.elements = [
    el({ kind: "shape", id: "bg", shape: "rect", frame: { x: 0, y: 0, w, h }, fill: cmykPct(0,0,0,3), stroke: NONE }),
    el({ kind: "text", id: "t1", frame: { x: IN(0.4), y: IN(0.5), w: w - IN(0.8), h: IN(0.6) },
         paragraphs: [{ runs: [{ text: "TRIM" }, { text: "MER", bold: true }] }],
         fontFamily: "Inter", fontWeight: 400, fontSize: 14_000_000, color: TEXT_BLACK }),
  ];
  doc.back.elements = [];
  const plans = planDocument({ doc, product: emptyProductContext(), assets: new Map() });
  const out = await renderProductionPdf({ plans });
  const insp = await inspectPdf(out.bytes);
  console.log("A14 extracted textContent page1:", JSON.stringify(insp.pages[0].textContent));
  await report("A14 'TRIMMER' set as two styled runs",
    out.bytes, expectationForPlans({ presetCode: "409TF", plans }));

  // A20 — barcode replaced by a raster: strip the bar path, add an image.
  //       (simulated by deleting all fill operations is hard; instead check
  //        that a design with a QR/raster-free page reports bars 0.)
  const inspProd = await inspectPdf(b);
  console.log("A20 bar-like rects per page:", inspProd.pages.map((p) => p.barLikeRectCount));
  console.log("A20 filled rect count per page:", inspProd.pages.map((p) => p.filledRects.length));
  console.log("A20 page1 rotation:", inspProd.pages[0].rotation);
  console.log("A20 painted extents page1:", inspProd.pages[0].paintedExtents.length,
              "bounds:", inspProd.pages[0].paintedBounds);
  console.log("A20 operator counts page1:", JSON.stringify(inspProd.pages[0].colorSpaces.operatorCounts));
}
main().catch((e) => { console.error(e); process.exit(1); });
