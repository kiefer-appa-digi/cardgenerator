/* TEMPORARY: does the same face in two DIFFERENT designs get the same full /BaseFont? */
import { inToUpt } from "../src/lib/units";
import { cmykPct } from "../src/lib/color/types";
import { DesignDocSchema } from "../src/lib/design/schema";
import { planDocument } from "../src/lib/design/plan";
import { emptyProductContext } from "../src/lib/data/context";
import { renderProductionPdf } from "../src/lib/pdf/production";
import { PDFDocument, PDFDict, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import crypto from "node:crypto";

const IN = inToUpt;
function mk(text: string) {
  const doc = DesignDocSchema.parse({
    version: 1, presetCode: "409TF",
    front: { side: "front", elements: [
      { id: "t", kind: "text", frame: { x: IN(0.3), y: IN(0.3), w: IN(3.5), h: IN(0.5) },
        paragraphs: [{ runs: [{ text }] }], fontFamily: "Inter", fontWeight: 600,
        fontSize: 12_000_000, color: cmykPct(0,0,0,100) } ] },
    back: { side: "back", elements: [] },
  });
  return planDocument({ doc, product: emptyProductContext(), assets: new Map() });
}
async function names(bytes: Uint8Array) {
  const d = await PDFDocument.load(bytes, { updateMetadata: false });
  const out: string[] = [];
  for (const [, obj] of d.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of("Subtype"))?.toString() !== "/CIDFontType2") continue;
    const fd = d.context.lookup(obj.get(PDFName.of("FontDescriptor")), PDFDict);
    const file = fd && d.context.lookup(fd.get(PDFName.of("FontFile2")));
    const prog = file instanceof PDFRawStream ? decodePDFRawStream(file).decode() : new Uint8Array();
    out.push(`${obj.get(PDFName.of("BaseFont"))?.toString()}  progSha=${crypto.createHash("sha256").update(prog).digest("hex").slice(0,16)} progBytes=${prog.length}`);
  }
  return out.sort();
}
(async () => {
  const a = await renderProductionPdf({ plans: mk("AAAA BBBB") });
  const b = await renderProductionPdf({ plans: mk("wxyz 9876 %%%") });
  console.log("design A:"); for (const n of await names(a.bytes)) console.log("  ", n);
  console.log("design B:"); for (const n of await names(b.bytes)) console.log("  ", n);
})();
