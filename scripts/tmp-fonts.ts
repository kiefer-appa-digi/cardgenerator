import { readFile } from "node:fs/promises";
import { inspectPdf } from "@/lib/pdf/inspect";
async function main() {
  for (const f of ["409TF-production", "409TF-proof"]) {
    const b = new Uint8Array(await readFile(`artifacts/pdf/${f}.pdf`));
    const i = await inspectPdf(b);
    console.log(`--- ${f}: ${i.fonts.length} distinct fonts, xmp=${i.hasXmpMetadata}, producer=${i.producer}`);
    for (const x of i.fonts)
      console.log(`   ${x.baseFont.padEnd(34)} ${x.subtype}/${x.descendantSubtype} ${x.fontFileKey} decompressed=${x.fontFileBytes} stored=${x.fontFileStoredBytes} toUnicode=${x.hasToUnicode} subset=${x.subset}`);
    console.log("   font resource entries per page:", i.pages.map((p) => p.fonts.length));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
