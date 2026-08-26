/**
 * Extracts the glyph advance widths the layout engine needs from the exact TTF
 * files the PDF writer embeds, and writes them to src/lib/text/metrics.json.
 *
 * Run with `npm run fonts:metrics` whenever a font file changes. The generated
 * file is committed so the client bundle never has to parse a TTF.
 */
import fs from "node:fs";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { FONT_FAMILIES } from "../src/lib/text/fonts";

const FONT_DIR = path.join(process.cwd(), "src/assets/fonts");
const OUT = path.join(process.cwd(), "src/lib/text/metrics.json");

// Latin-1 plus the punctuation and symbols that appear in packaging copy.
const CHARSET: string[] = [];
for (let c = 0x20; c <= 0x7e; c++) CHARSET.push(String.fromCharCode(c));
for (let c = 0xa0; c <= 0xff; c++) CHARSET.push(String.fromCharCode(c));
for (const ch of "‐‑‒–—―‘’‚“”„†‡•…‰‹›€™©®°±×÷≤≥≠≈→←↔⌀½¼¾⅛⅜⅝⅞") CHARSET.push(ch);

type FaceMetrics = {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  lineGap: number;
  capHeight: number;
  xHeight: number;
  /** codePoint -> advance width in font units */
  widths: Record<string, number>;
  defaultWidth: number;
};

const out: Record<string, FaceMetrics> = {};

for (const fam of FONT_FAMILIES) {
  for (const face of fam.faces) {
    const buf = fs.readFileSync(path.join(FONT_DIR, face.file));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const font: any = (fontkit as any).create(buf);
    const widths: Record<string, number> = {};
    for (const ch of CHARSET) {
      const cp = ch.codePointAt(0)!;
      try {
        const glyph = font.glyphForCodePoint(cp);
        if (!glyph || glyph.id === 0) continue;
        widths[String(cp)] = Math.round(glyph.advanceWidth);
      } catch {
        /* glyph absent — the layout engine falls back to defaultWidth */
      }
    }
    const key = `${fam.family}:${face.weight}${face.italic ? "i" : ""}`;
    out[key] = {
      unitsPerEm: font.unitsPerEm,
      ascender: Math.round(font.ascent),
      descender: Math.round(font.descent),
      lineGap: Math.round(font.lineGap ?? 0),
      capHeight: Math.round(font.capHeight ?? font.ascent * 0.7),
      xHeight: Math.round(font.xHeight ?? font.ascent * 0.5),
      widths,
      defaultWidth: Math.round(font.glyphForCodePoint(0x20)?.advanceWidth ?? font.unitsPerEm / 2),
    };
    console.log(key, "glyphs:", Object.keys(widths).length, "upem:", font.unitsPerEm);
  }
}

fs.writeFileSync(OUT, JSON.stringify(out));
console.log("wrote", OUT, (fs.statSync(OUT).size / 1024).toFixed(1), "KB");
