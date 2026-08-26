import { readFile } from "node:fs/promises";
import { inspectPdf } from "@/lib/pdf/inspect";
async function main() {
  for (const f of ["409TF-production", "409TF-proof"]) {
    const i = await inspectPdf(new Uint8Array(await readFile(`artifacts/pdf/${f}.pdf`)));
    for (const p of i.pages) {
      const clipped = p.paintedExtents.filter((e) => e.clip).length;
      const mirrored = p.paintedExtents.filter((e) => e.mirrored).length;
      console.log(`${f} page ${p.index + 1}: extents=${p.paintedExtents.length} withClip=${clipped} mirrored=${mirrored} readable=${p.contentReadable} annots=${p.annotations.length} bars=${p.barLikeRectCount}`);
      console.log("   clips:", JSON.stringify([...new Set(p.paintedExtents.map(e => e.clip ? `${e.clip.x0},${e.clip.y0},${e.clip.x1},${e.clip.y1}` : "none"))]));
      console.log("   lines:", JSON.stringify(p.textLines).slice(0, 400));
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
