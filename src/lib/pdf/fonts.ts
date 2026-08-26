import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import {
  PDFArray,
  PDFDict,
  PDFName,
  type EmbedFontOptions,
  type PDFDocument,
  type PDFFont,
} from "pdf-lib";
import { FONT_FAMILIES, faceKeyOf } from "@/lib/text/fonts";

/**
 * FONT EMBEDDING FOR THE PDF WRITER — spec §9, §15.
 *
 * The SidePlan reports the faces it needs as `faceKey` strings ("Inter:600",
 * "Barlow Condensed:400", "Inter:400i"). This module turns those into embedded,
 * subset font programs inside a pdf-lib document, reading the very same TTF
 * bytes that `scripts/gen-font-metrics.ts` measured for the layout engine.
 *
 * Two things here are load-bearing and easy to get silently wrong.
 *
 * 1. SHAPING MUST BE TURNED OFF.
 *
 *    pdf-lib encodes a string by calling fontkit's `layout()`, which applies the
 *    font's default OpenType features. The layout engine in lib/text/layout.ts
 *    measures per code point via `glyphForCodePoint().advanceWidth` — no
 *    ligatures, no contextual alternates. Left at fontkit's defaults the two
 *    disagree: Archivo's `liga` turns "ff" into one narrower glyph, Inter's
 *    `calt` turns "->" into an arrow, and Archivo's `rvrn` swaps `$` for a
 *    variable-font bracket-layer variant. The PDF would then set text at
 *    different widths than the editor measured, and a line that fitted on screen
 *    could overrun the safe area on press.
 *
 *    `PDF_SHAPING_FEATURES` disables every substitution feature, which was
 *    verified to reproduce the layout engine's glyph selection exactly for every
 *    ordered pair of characters in the generated metrics charset, across all
 *    thirteen shipped faces. The one exception is U+00AD SOFT HYPHEN, which
 *    fontkit's cmap handling maps differently from `glyphForCodePoint`; it is
 *    absent from the metrics for most faces and already raises the layout
 *    engine's `unmappedGlyphs` flag, so preflight reports it rather than the
 *    exporter hiding it.
 *
 * 2. SUBSET FONTS NEED A SUBSET TAG.
 *
 *    pdf-lib writes /BaseFont as e.g. `/Inter-SemiBold-9742` for a subset. ISO
 *    32000 (and every PDF/X part) requires a subset font's name to carry a
 *    six-uppercase-letter tag and a `+`. `finaliseFontSubsets()` rewrites the
 *    name to `ABCDEF+Inter-SemiBold` after the document is flushed. The tag is
 *    derived deterministically from the face key, so the same design exports to
 *    the same bytes every time.
 */

/** Where the TTFs live, relative to `process.cwd()`, in preference order. */
export const FONT_DIR_CANDIDATES = [
  // The canonical copy. Next.js serverless bundles need this traced in.
  "src/assets/fonts",
  // The same bytes, shipped for the editor's @font-face rules. A usable
  // fallback when only `public/` survives the deployment bundler.
  "public/fonts",
] as const;

/**
 * Every OpenType substitution feature fontkit might apply, switched off.
 * `mark`/`mkmk`/`kern`/`curs` are positioning features whose output pdf-lib
 * discards anyway; they are listed so the intent — "no shaping at all" — is
 * explicit rather than implied.
 */
export const PDF_SHAPING_FEATURES: NonNullable<EmbedFontOptions["features"]> = {
  calt: false,
  ccmp: false,
  clig: false,
  curs: false,
  dlig: false,
  dnom: false,
  frac: false,
  hlig: false,
  kern: false,
  liga: false,
  locl: false,
  mark: false,
  mkmk: false,
  numr: false,
  rclt: false,
  rlig: false,
  rvrn: false,
};

export class UnknownFaceError extends Error {
  readonly code = "UNKNOWN_FACE" as const;
  constructor(readonly faceKey: string) {
    super(
      `No shipped font face matches "${faceKey}". Only faces listed in ` +
        `lib/text/fonts.ts can be embedded, because only those are licensed and ` +
        `measured for the layout engine.`,
    );
    this.name = "UnknownFaceError";
  }
}

export class FontFileMissingError extends Error {
  readonly code = "FONT_FILE_MISSING" as const;
  constructor(
    readonly faceKey: string,
    readonly file: string,
    readonly searched: string[],
  ) {
    super(
      `Font file "${file}" for face "${faceKey}" was not found. Searched: ` +
        `${searched.join(", ")}. A serverless deployment must trace the font ` +
        `directory into the function bundle.`,
    );
    this.name = "FontFileMissingError";
  }
}

/** faceKey → TTF filename, built once from the shipped registry. */
const FACE_FILES: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const fam of FONT_FAMILIES) {
    for (const face of fam.faces) {
      m.set(faceKeyOf(fam.family, face.weight, face.italic), face.file);
    }
  }
  return m;
})();

export function fontFileForFaceKey(faceKey: string): string | null {
  return FACE_FILES.get(faceKey) ?? null;
}

export function knownFaceKeys(): string[] {
  return [...FACE_FILES.keys()].sort();
}

/** Absolute paths a face's file could live at, in preference order. */
export function faceSearchPaths(file: string, fontDir?: string): string[] {
  if (fontDir) return [path.join(fontDir, file)];
  return FONT_DIR_CANDIDATES.map((dir) => path.join(process.cwd(), dir, file));
}

/* ------------------------------------------------- glyf record alignment */

/**
 * WHY THIS EXISTS — a real, reproducible corruption in the shipped subsetter.
 *
 * `@pdf-lib/fontkit`'s TrueType subsetter concatenates each glyph's raw `glyf`
 * record and records the running offset in `loca`. When it serialises `loca` it
 * picks the SHORT format if the final offset fits in 16 bits, and short-format
 * loca stores every offset divided by two:
 *
 *     this.version = last > 0xffff ? 1 : 0;
 *     if (this.version === 0) for (i) this.offsets[i] >>>= 1;
 *
 * That is only lossless if every offset is even, which is only true if every
 * glyph record has an even length. It never pads. A font whose records are
 * odd-length therefore gets a subset whose glyph boundaries are silently wrong:
 * the affected glyphs render blank or as garbage, while the surrounding text
 * looks fine.
 *
 * Fonts with a SHORT loca in the source cannot have odd records — the format
 * forbids it — so Archivo and Barlow Condensed are unaffected. Inter uses the
 * long format and has around 500 odd-length records per face; drawing "12345"
 * in a subset Inter produced a page showing only "5". Both CoreGraphics and
 * Poppler rendered it that way, so this was the file, not the viewer.
 *
 * The fix is at the input boundary, where this module owns the bytes: pad each
 * odd-length record to an even length and rewrite `loca` in the long format.
 * Padding at the end of a glyph record is exactly what a short-loca font already
 * has, no outline, metric or component offset is touched, and the subsetter then
 * accumulates even offsets and halves them losslessly.
 *
 * Remove this when @pdf-lib/fontkit pads in `TTFSubset._addGlyph`, and prove it
 * by re-running the "every subset glyph decodes" test in tests/unit/pdf.test.ts.
 */
export function alignGlyfRecords(src: Uint8Array): Uint8Array {
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  if (src.byteLength < 12) return src;

  const sfnt = view.getUint32(0);
  // 0x00010000 = TrueType outlines, 'true' = the legacy Apple variant. 'OTTO'
  // is CFF and has no glyf table to align.
  if (sfnt !== 0x00010000 && sfnt !== 0x74727565) return src;

  const numTables = view.getUint16(4);
  if (12 + numTables * 16 > src.byteLength) return src;

  type Entry = { tag: string; offset: number; length: number };
  const dir: Entry[] = [];
  for (let i = 0; i < numTables; i += 1) {
    const p = 12 + i * 16;
    dir.push({
      tag: String.fromCharCode(src[p], src[p + 1], src[p + 2], src[p + 3]),
      offset: view.getUint32(p + 8),
      length: view.getUint32(p + 12),
    });
  }
  const byTag = new Map(dir.map((e) => [e.tag, e]));
  const head = byTag.get("head");
  const maxp = byTag.get("maxp");
  const loca = byTag.get("loca");
  const glyf = byTag.get("glyf");
  if (!head || !maxp || !loca || !glyf) return src;

  const locFormat = view.getInt16(head.offset + 50);
  const numGlyphs = view.getUint16(maxp.offset + 4);
  const need = locFormat === 1 ? (numGlyphs + 1) * 4 : (numGlyphs + 1) * 2;
  if (loca.length < need) return src;

  const offsets: number[] = new Array(numGlyphs + 1);
  for (let i = 0; i <= numGlyphs; i += 1) {
    offsets[i] =
      locFormat === 1
        ? view.getUint32(loca.offset + i * 4)
        : view.getUint16(loca.offset + i * 2) * 2;
  }

  let anyOdd = false;
  for (let i = 0; i < numGlyphs; i += 1) {
    if ((offsets[i + 1] - offsets[i]) % 2 !== 0) {
      anyOdd = true;
      break;
    }
  }
  // Nothing to fix, and rewriting a well-formed font for no reason would only
  // add risk.
  if (!anyOdd) return src;

  let total = 0;
  for (let i = 0; i < numGlyphs; i += 1) {
    total += align2(offsets[i + 1] - offsets[i]);
  }
  const newGlyf = new Uint8Array(total);
  const newOffsets = new Uint32Array(numGlyphs + 1);
  let cursor = 0;
  for (let i = 0; i < numGlyphs; i += 1) {
    newOffsets[i] = cursor;
    const from = glyf.offset + offsets[i];
    const len = offsets[i + 1] - offsets[i];
    if (len > 0) newGlyf.set(src.subarray(from, from + len), cursor);
    cursor += align2(len);
  }
  newOffsets[numGlyphs] = cursor;

  const newLoca = new Uint8Array((numGlyphs + 1) * 4);
  const locaView = new DataView(newLoca.buffer);
  for (let i = 0; i <= numGlyphs; i += 1) locaView.setUint32(i * 4, newOffsets[i]);

  const newHead = src.slice(head.offset, head.offset + head.length);
  // The rewritten loca is long-format, and head must say so.
  new DataView(newHead.buffer).setInt16(50, 1);
  // checkSumAdjustment is recomputed over the finished file below.
  new DataView(newHead.buffer).setUint32(8, 0);

  const replacements = new Map<string, Uint8Array>([
    ["glyf", newGlyf],
    ["loca", newLoca],
    ["head", newHead],
  ]);
  return rebuildSfnt(src, sfnt, dir, replacements);
}

function align2(n: number): number {
  return n + (n % 2);
}
function align4(n: number): number {
  return (n + 3) & ~3;
}

/** TrueType table checksum: big-endian uint32 sum over the zero-padded table. */
function tableChecksum(bytes: Uint8Array): number {
  let sum = 0;
  const padded = align4(bytes.byteLength);
  for (let i = 0; i < padded; i += 4) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const b3 = bytes[i + 3] ?? 0;
    sum = (sum + (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)) >>> 0;
  }
  return sum;
}

/**
 * Write a new sfnt from the original tables with some replaced. The directory
 * stays in its original (tag-sorted) order, every table is 4-byte aligned, and
 * checksums — including head's checkSumAdjustment — are recomputed so the result
 * is a well-formed font and not merely one this process happens to accept.
 */
function rebuildSfnt(
  src: Uint8Array,
  sfntVersion: number,
  dir: Array<{ tag: string; offset: number; length: number }>,
  replacements: Map<string, Uint8Array>,
): Uint8Array {
  const tables = dir.map((e) => ({
    tag: e.tag,
    data: replacements.get(e.tag) ?? src.subarray(e.offset, e.offset + e.length),
  }));

  const headerBytes = 12 + tables.length * 16;
  let size = headerBytes;
  for (const t of tables) size += align4(t.data.byteLength);

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, sfntVersion);
  view.setUint16(4, tables.length);
  // searchRange / entrySelector / rangeShift, per the sfnt header definition.
  const entrySelector = Math.floor(Math.log2(tables.length));
  const searchRange = 2 ** entrySelector * 16;
  view.setUint16(6, searchRange);
  view.setUint16(8, entrySelector);
  view.setUint16(10, tables.length * 16 - searchRange);

  let cursor = headerBytes;
  let headDirOffset = -1;
  tables.forEach((t, i) => {
    const p = 12 + i * 16;
    for (let c = 0; c < 4; c += 1) out[p + c] = t.tag.charCodeAt(c);
    view.setUint32(p + 4, tableChecksum(t.data));
    view.setUint32(p + 8, cursor);
    view.setUint32(p + 12, t.data.byteLength);
    out.set(t.data, cursor);
    if (t.tag === "head") headDirOffset = cursor;
    cursor += align4(t.data.byteLength);
  });

  if (headDirOffset >= 0) {
    // checkSumAdjustment = 0xB1B0AFBA − (checksum of the whole file with the
    // field zeroed), which it already is.
    view.setUint32(headDirOffset + 8, (0xb1b0afba - tableChecksum(out)) >>> 0);
  }
  return out;
}

/**
 * TTF bytes are immutable for the life of the process, so they are cached by
 * absolute path. A serverless cold start pays the read once.
 */
const FILE_BYTES = new Map<string, Uint8Array>();

export async function readFaceBytes(
  faceKey: string,
  fontDir?: string,
): Promise<{ bytes: Uint8Array; file: string; absPath: string }> {
  const file = fontFileForFaceKey(faceKey);
  if (!file) throw new UnknownFaceError(faceKey);

  const candidates = faceSearchPaths(file, fontDir);
  const hit = candidates.find((p) => FILE_BYTES.has(p) || existsSync(p));
  if (!hit) throw new FontFileMissingError(faceKey, file, candidates);

  const cached = FILE_BYTES.get(hit);
  if (cached) return { bytes: cached, file, absPath: hit };

  const buf = await readFile(hit);
  const bytes = alignGlyfRecords(
    new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
  );
  FILE_BYTES.set(hit, bytes);
  return { bytes, file, absPath: hit };
}

/** Test/maintenance hook: forget cached TTF bytes. */
export function clearFontByteCache(): void {
  FILE_BYTES.clear();
}

export type EmbeddedFace = {
  faceKey: string;
  font: PDFFont;
  file: string;
  /** Size of the source TTF. The embedded subset must be far smaller. */
  sourceByteLength: number;
  /** The six-letter tag written into /BaseFont by `finaliseFontSubsets`. */
  subsetTag: string;
};

export type EmbeddedFaces = {
  readonly faceKeys: string[];
  get(faceKey: string): PDFFont | null;
  entry(faceKey: string): EmbeddedFace | null;
  all(): EmbeddedFace[];
};

/**
 * Per-document cache. Two sides of the same card share a face, and pdf-lib
 * would otherwise embed the font program twice.
 */
const DOC_FACES = new WeakMap<PDFDocument, Map<string, EmbeddedFace>>();
const FONTKIT_REGISTERED = new WeakSet<PDFDocument>();

function docFaces(doc: PDFDocument): Map<string, EmbeddedFace> {
  let m = DOC_FACES.get(doc);
  if (!m) {
    m = new Map();
    DOC_FACES.set(doc, m);
  }
  return m;
}

/**
 * Six uppercase letters, derived from the face key by FNV-1a. Deterministic
 * because the exported bytes have to be: the same design must produce the same
 * file, and a random tag would break that.
 */
export function subsetTag(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 6; i += 1) {
    out += String.fromCharCode(65 + (h % 26));
    // Advance the state between letters; the +7 keeps a short seed from
    // collapsing to a repeated letter once h has been divided down to zero.
    h = Math.floor(h / 26) + 7;
  }
  return out;
}

/**
 * Embed (subset) every requested face into `doc`. Faces are embedded in sorted
 * order so the document's object numbering does not depend on the order the
 * plan happened to discover them in.
 */
export async function embedFaces(
  doc: PDFDocument,
  faceKeys: Iterable<string>,
  opts: { fontDir?: string } = {},
): Promise<EmbeddedFaces> {
  if (!FONTKIT_REGISTERED.has(doc)) {
    doc.registerFontkit(fontkit);
    FONTKIT_REGISTERED.add(doc);
  }
  const cache = docFaces(doc);
  const wanted = [...new Set(faceKeys)].sort();

  for (const faceKey of wanted) {
    if (cache.has(faceKey)) continue;
    const { bytes, file } = await readFaceBytes(faceKey, opts.fontDir);
    const font = await doc.embedFont(bytes, {
      subset: true,
      features: PDF_SHAPING_FEATURES,
    });
    cache.set(faceKey, {
      faceKey,
      font,
      file,
      sourceByteLength: bytes.byteLength,
      subsetTag: subsetTag(faceKey),
    });
  }

  return {
    get faceKeys() {
      return [...cache.keys()].sort();
    },
    get: (k) => cache.get(k)?.font ?? null,
    entry: (k) => cache.get(k) ?? null,
    all: () => [...cache.values()].sort((a, b) => a.faceKey.localeCompare(b.faceKey)),
  };
}

/**
 * Rewrite /BaseFont (and the descendant CIDFont's /BaseFont and the
 * FontDescriptor's /FontName) to carry a proper subset tag.
 *
 * Must be called AFTER `doc.flush()`, because pdf-lib only materialises the font
 * dictionaries when the document is flushed. `save()` flushes again, which is a
 * no-op for fonts already embedded, so the rename survives.
 */
export async function finaliseFontSubsets(
  doc: PDFDocument,
  faces: EmbeddedFaces,
): Promise<void> {
  await doc.flush();
  for (const entry of faces.all()) {
    const type0 = doc.context.lookupMaybe(entry.font.ref, PDFDict);
    if (!type0) continue;
    const base = type0.get(PDFName.of("BaseFont"));
    if (!(base instanceof PDFName)) continue;
    const current = base.asString().replace(/^\//, "");
    if (/^[A-Z]{6}\+/.test(current)) continue;
    const tagged = PDFName.of(`${entry.subsetTag}+${current}`);
    type0.set(PDFName.of("BaseFont"), tagged);

    // /DescendantFonts is a one-element array holding the CIDFont dictionary.
    const descendants = type0.lookupMaybe(PDFName.of("DescendantFonts"), PDFArray);
    const cid = descendants?.lookupMaybe(0, PDFDict);
    if (!cid) continue;
    cid.set(PDFName.of("BaseFont"), tagged);
    const fd = cid.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict);
    if (fd) fd.set(PDFName.of("FontName"), tagged);
  }
}
