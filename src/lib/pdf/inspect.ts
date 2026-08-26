import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from "pdf-lib";

/**
 * PDF STRUCTURAL INSPECTION — the evidence gatherer for spec §22.
 *
 * This module opens a finished PDF and reports what is *actually* in it: page
 * boxes, embedded font programs, colour-space operators, image XObjects, the
 * text that a reader would see, and the device-space extent of every painted
 * mark. It makes no judgements — `validate.ts` turns these measurements into
 * PASS/FAIL results.
 *
 * Why re-parse instead of trusting the writer's own bookkeeping: a validator
 * that asks the exporter what it did cannot catch the exporter being wrong.
 * The only honest check reads the bytes that will be sent to the press.
 *
 * Two things here are approximations, and both are labelled as such in the
 * types rather than being quietly presented as exact:
 *
 *  - Glyph boxes. We reconstruct a run's extent from the font's advance widths
 *    plus the FontDescriptor's /Ascent and /Descent. That is the em-box, not the
 *    true outline bbox, so it is conservative (slightly larger than the ink).
 *  - "Bar-like" rectangles. A vector barcode is a run of tall, narrow filled
 *    rectangles; we count rects matching that shape. It is a shape heuristic,
 *    named as one, and the raw filled-rect count is reported alongside it.
 */

/* ------------------------------------------------------------------ boxes */

export type PdfBox = {
  /** The array as written: [llx, lly, urx, ury], in PDF points. */
  raw: [number, number, number, number];
  /** Normalised lower-left origin and size, in PDF points. */
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PdfPageBoxes = {
  /** MediaBox is required by the spec and always inherited if absent on the leaf. */
  mediaBox: PdfBox | null;
  cropBox: PdfBox | null;
  bleedBox: PdfBox | null;
  trimBox: PdfBox | null;
  artBox: PdfBox | null;
  /** Which boxes were written on the page object itself rather than defaulted. */
  present: {
    mediaBox: boolean;
    cropBox: boolean;
    bleedBox: boolean;
    trimBox: boolean;
    artBox: boolean;
  };
};

/* ------------------------------------------------------------------ fonts */

export type PdfFontInfo = {
  /** Key in the page's /Resources /Font dict, e.g. "F1". */
  resourceName: string;
  /** /BaseFont verbatim, e.g. "ABCDEF+Inter-Regular". */
  baseFont: string;
  /** /BaseFont with any subset tag stripped. */
  postScriptName: string;
  /** The six-uppercase-letter subset tag, or null when the font is not subset. */
  subsetTag: string | null;
  subset: boolean;
  subtype: string;
  /** True when a font program is present in the FontDescriptor. */
  embedded: boolean;
  /** Which FontFile entry carried the program. */
  fontFileKey: "FontFile" | "FontFile2" | "FontFile3" | null;
  /** Byte length of the embedded program, as stored (usually Flate-compressed). */
  fontFileBytes: number;
  hasToUnicode: boolean;
  /** For Type0 fonts, the descendant CIDFont subtype. */
  descendantSubtype: string | null;
};

/* ----------------------------------------------------------------- images */

export type PdfImagePlacement = {
  /** Placed size on the page, in PDF points, from the CTM at the `Do`. */
  widthPt: number;
  heightPt: number;
  /** Lower-left of the placed unit square's bounding box, PDF points. */
  xPt: number;
  yPt: number;
  /** Pixels per inch at the placed size. Null when the placement is degenerate. */
  effectiveDpiX: number | null;
  effectiveDpiY: number | null;
};

export type PdfImageInfo = {
  resourceName: string;
  /** Pixel dimensions from /Width and /Height — the only resolution metadata a PDF carries. */
  pixelWidth: number;
  pixelHeight: number;
  bitsPerComponent: number | null;
  /** Colour space family, e.g. "DeviceCMYK", "ICCBased", "Indexed". */
  colorSpace: string;
  filters: string[];
  isMask: boolean;
  hasSMask: boolean;
  placements: PdfImagePlacement[];
};

/* ------------------------------------------------------------ colour use */

export type PdfColorSpaceUsage = {
  /** Distinct colour spaces named or implied by content-stream operators, sorted. */
  spaces: string[];
  /** Raw operator counts, so a report can say *how* a space got used. */
  operatorCounts: Record<string, number>;
  /** Colour spaces declared in /Resources /ColorSpace, whether or not used. */
  resourceSpaces: string[];
  /** Colour spaces of the page's image XObjects. */
  imageSpaces: string[];
};

/* ------------------------------------------------------------------ text */

export type PdfTextRun = {
  /** Unicode text, decoded through the font's /ToUnicode CMap where present. */
  text: string;
  /** Text-run origin in device space, PDF points. */
  xPt: number;
  yPt: number;
  fontSizePt: number;
  fontResourceName: string;
  baseFont: string;
  /**
   * Em-box of the run in device space, PDF points. Approximate: built from
   * advance widths and the FontDescriptor ascent/descent, so it is a superset
   * of the actual ink.
   */
  boxPt: { x0: number; y0: number; x1: number; y1: number };
  /** True when the run was decoded byte-for-byte because no /ToUnicode existed. */
  decodedWithoutToUnicode: boolean;
};

/* -------------------------------------------------------------- geometry */

export type PdfPaintedExtent = {
  kind: "path" | "text" | "image";
  /** Device-space bounding box in PDF points. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The operator that painted it, e.g. "f", "S", "Tj", "Do". */
  operator: string;
};

export type PdfRect = { x: number; y: number; width: number; height: number };

/* --------------------------------------------------------------- results */

export type PdfPageInspection = {
  /** Zero-based. */
  index: number;
  boxes: PdfPageBoxes;
  rotation: number;
  fonts: PdfFontInfo[];
  images: PdfImageInfo[];
  colorSpaces: PdfColorSpaceUsage;
  textRuns: PdfTextRun[];
  /** All run text joined with newlines, for substring searches. */
  textContent: string;
  /** Axis-aligned filled rectangles in device space, PDF points. */
  filledRects: PdfRect[];
  /** Filled rects whose shape matches a barcode bar: taller than wide and narrow. */
  barLikeRectCount: number;
  paintedExtents: PdfPaintedExtent[];
  /** Bounding box of every painted mark on the page, or null when nothing is painted. */
  paintedBounds: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Decompressed content-stream size, bytes. */
  contentBytes: number;
  /** Parse problems that did not stop the inspection. */
  warnings: string[];
};

export type PdfOutputIntentInfo = {
  subtype: string;
  outputConditionIdentifier: string;
  outputCondition: string;
  registryName: string;
  info: string;
  /** True when an actual ICC profile stream is attached, not just a name. */
  hasDestOutputProfile: boolean;
  destOutputProfileBytes: number;
};

export type PdfInspection = {
  byteLength: number;
  /** Version from the "%PDF-x.y" header. */
  headerVersion: string;
  pageCount: number;
  pages: PdfPageInspection[];
  /** Every distinct font across all pages, keyed by /BaseFont. */
  fonts: PdfFontInfo[];
  outputIntents: PdfOutputIntentInfo[];
  hasOutputIntent: boolean;
  title: string | null;
  producer: string | null;
  creator: string | null;
  /** True when the catalog declares /Metadata (XMP). */
  hasXmpMetadata: boolean;
  warnings: string[];
};

/* --------------------------------------------------------------- helpers */

const PT_PER_IN = 72;

/** A PDF box may be written with either corner first; normalise it. */
function toBox(arr: PDFArray | undefined): PdfBox | null {
  if (!arr || arr.size() < 4) return null;
  const nums: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const n = arr.lookup(i, PDFNumber);
    nums.push(n.asNumber());
  }
  const [a, b, c, d] = nums as [number, number, number, number];
  const x0 = Math.min(a, c);
  const y0 = Math.min(b, d);
  const x1 = Math.max(a, c);
  const y1 = Math.max(b, d);
  return { raw: [a, b, c, d], x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function nameValue(obj: unknown): string | null {
  return obj instanceof PDFName ? obj.decodeText() : null;
}

function numberValue(obj: unknown): number | null {
  return obj instanceof PDFNumber ? obj.asNumber() : null;
}

function stringValue(obj: unknown): string | null {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  return null;
}

/** Decompress any stream pdf-lib can decode; returns empty on an unknown filter. */
function streamBytes(stream: PDFStream | undefined, warnings: string[]): Uint8Array {
  if (!stream) return new Uint8Array(0);
  if (!(stream instanceof PDFRawStream)) {
    // A PDFContentStream we built ourselves is already uncompressed.
    return stream.getContents();
  }
  try {
    return decodePDFRawStream(stream).decode();
  } catch (err) {
    warnings.push(`could not decode a stream: ${(err as Error).message}`);
    return new Uint8Array(0);
  }
}

/* ------------------------------------------------------------- tokeniser */

type Tok =
  | { t: "num"; v: number }
  | { t: "name"; v: string }
  | { t: "str"; v: Uint8Array }
  | { t: "arr"; v: Tok[] }
  | { t: "dict"; v: Map<string, Tok> }
  | { t: "op"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "null" };

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isRegular(b: number): boolean {
  return !WHITESPACE.has(b) && !DELIM.has(b);
}

/**
 * Content-stream tokeniser. Deliberately small: content streams are a much
 * simpler grammar than PDF bodies — no indirect references, no streams inside
 * streams — so a purpose-built reader is easier to trust than reusing the
 * document parser.
 */
class ContentLexer {
  private pos = 0;

  constructor(private readonly bytes: Uint8Array) {}

  atEnd(): boolean {
    this.skipSpace();
    return this.pos >= this.bytes.length;
  }

  /** Raw byte position, needed to skip inline-image binary data. */
  position(): number {
    return this.pos;
  }

  seek(p: number): void {
    this.pos = p;
  }

  private skipSpace(): void {
    while (this.pos < this.bytes.length) {
      const b = this.bytes[this.pos];
      if (WHITESPACE.has(b)) {
        this.pos += 1;
      } else if (b === 0x25) {
        // Comment: runs to end of line.
        while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0x0a && this.bytes[this.pos] !== 0x0d) {
          this.pos += 1;
        }
      } else {
        return;
      }
    }
  }

  next(): Tok | null {
    this.skipSpace();
    if (this.pos >= this.bytes.length) return null;
    const b = this.bytes[this.pos];

    if (b === 0x2f) return { t: "name", v: this.readName() };
    if (b === 0x28) return { t: "str", v: this.readLiteralString() };
    if (b === 0x3c) {
      if (this.bytes[this.pos + 1] === 0x3c) return { t: "dict", v: this.readDict() };
      return { t: "str", v: this.readHexString() };
    }
    if (b === 0x5b) return { t: "arr", v: this.readArray() };
    if (b === 0x5d || b === 0x3e || b === 0x29) {
      // Stray closer; consume it so we cannot loop forever.
      this.pos += 1;
      return this.next();
    }
    if ((b >= 0x30 && b <= 0x39) || b === 0x2b || b === 0x2d || b === 0x2e) {
      return { t: "num", v: this.readNumber() };
    }
    const word = this.readKeyword();
    if (word === "true") return { t: "bool", v: true };
    if (word === "false") return { t: "bool", v: false };
    if (word === "null") return { t: "null" };
    if (word === "") {
      this.pos += 1; // Unrecognised byte; advance to guarantee progress.
      return this.next();
    }
    return { t: "op", v: word };
  }

  private readKeyword(): string {
    let s = "";
    while (this.pos < this.bytes.length && isRegular(this.bytes[this.pos])) {
      s += String.fromCharCode(this.bytes[this.pos]);
      this.pos += 1;
    }
    return s;
  }

  private readNumber(): number {
    const s = this.readKeyword();
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  }

  private readName(): string {
    this.pos += 1; // '/'
    let s = "";
    while (this.pos < this.bytes.length && isRegular(this.bytes[this.pos])) {
      const b = this.bytes[this.pos];
      if (b === 0x23 && this.pos + 2 < this.bytes.length) {
        const hex = String.fromCharCode(this.bytes[this.pos + 1], this.bytes[this.pos + 2]);
        const code = Number.parseInt(hex, 16);
        if (Number.isFinite(code)) {
          s += String.fromCharCode(code);
          this.pos += 3;
          continue;
        }
      }
      s += String.fromCharCode(b);
      this.pos += 1;
    }
    return s;
  }

  private readLiteralString(): Uint8Array {
    this.pos += 1; // '('
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.bytes.length) {
      const b = this.bytes[this.pos];
      this.pos += 1;
      if (b === 0x5c) {
        const e = this.bytes[this.pos];
        this.pos += 1;
        switch (e) {
          case 0x6e: out.push(0x0a); break;
          case 0x72: out.push(0x0d); break;
          case 0x74: out.push(0x09); break;
          case 0x62: out.push(0x08); break;
          case 0x66: out.push(0x0c); break;
          case 0x0a: break; // line continuation
          case 0x0d:
            if (this.bytes[this.pos] === 0x0a) this.pos += 1;
            break;
          default:
            if (e >= 0x30 && e <= 0x37) {
              let oct = e - 0x30;
              for (let i = 0; i < 2; i += 1) {
                const d = this.bytes[this.pos];
                if (d >= 0x30 && d <= 0x37) {
                  oct = oct * 8 + (d - 0x30);
                  this.pos += 1;
                } else break;
              }
              out.push(oct & 0xff);
            } else {
              out.push(e);
            }
        }
        continue;
      }
      if (b === 0x28) depth += 1;
      if (b === 0x29) {
        depth -= 1;
        if (depth === 0) break;
      }
      out.push(b);
    }
    return Uint8Array.from(out);
  }

  private readHexString(): Uint8Array {
    this.pos += 1; // '<'
    let hex = "";
    while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0x3e) {
      const c = String.fromCharCode(this.bytes[this.pos]);
      if (/[0-9a-fA-F]/.test(c)) hex += c;
      this.pos += 1;
    }
    this.pos += 1; // '>'
    if (hex.length % 2 === 1) hex += "0";
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  private readArray(): Tok[] {
    this.pos += 1; // '['
    const out: Tok[] = [];
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.bytes.length) break;
      if (this.bytes[this.pos] === 0x5d) {
        this.pos += 1;
        break;
      }
      const tok = this.next();
      if (!tok) break;
      out.push(tok);
    }
    return out;
  }

  private readDict(): Map<string, Tok> {
    this.pos += 2; // '<<'
    const out = new Map<string, Tok>();
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.bytes.length) break;
      if (this.bytes[this.pos] === 0x3e && this.bytes[this.pos + 1] === 0x3e) {
        this.pos += 2;
        break;
      }
      if (this.bytes[this.pos] !== 0x2f) {
        // Not a key — resynchronise rather than spin.
        const skipped = this.next();
        if (!skipped) break;
        continue;
      }
      const key = this.readName();
      const val = this.next();
      if (!val) break;
      out.set(key, val);
    }
    return out;
  }
}

/* -------------------------------------------------------------- matrices */

/** [a, b, c, d, e, f] — the PDF 3x3 affine with the third column fixed. */
type Mat = [number, number, number, number, number, number];

const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** Result applies `m` first, then `n` — the order `cm` and `Tm` both want. */
function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/* ------------------------------------------------------------ font model */

type FontModel = {
  info: PdfFontInfo;
  /** Bytes per character code in a shown string. */
  codeBytes: number;
  /** code → advance width in glyph-space units (1/1000 em). */
  widths: Map<number, number>;
  defaultWidth: number;
  /** code → Unicode, from /ToUnicode. Empty when the font has no CMap. */
  toUnicode: Map<number, string>;
  ascent: number;
  descent: number;
  /** True when the code stream is single-byte and we can fall back to Latin-1. */
  simple: boolean;
};

const SUBSET_TAG = /^([A-Z]{6})\+(.*)$/;

/** Parse the /Widths array of a simple font into a code → width map. */
function simpleWidths(dict: PDFDict): { widths: Map<number, number>; missing: number } {
  const widths = new Map<number, number>();
  const first = numberValue(dict.lookup(PDFName.of("FirstChar"))) ?? 0;
  const arr = dict.lookupMaybe(PDFName.of("Widths"), PDFArray);
  if (arr) {
    for (let i = 0; i < arr.size(); i += 1) {
      const w = numberValue(arr.lookup(i));
      if (w !== null) widths.set(first + i, w);
    }
  }
  const desc = dict.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict);
  const missing = desc ? numberValue(desc.lookup(PDFName.of("MissingWidth"))) ?? 0 : 0;
  return { widths, missing };
}

/**
 * Parse a CIDFont /W array. Format is a mix of
 *   c [w1 w2 ...]      → codes c, c+1, ... take w1, w2, ...
 *   cFirst cLast w     → every code in the range takes w
 */
function cidWidths(descendant: PDFDict): Map<number, number> {
  const widths = new Map<number, number>();
  const w = descendant.lookupMaybe(PDFName.of("W"), PDFArray);
  if (!w) return widths;
  let i = 0;
  while (i < w.size()) {
    const first = numberValue(w.lookup(i));
    if (first === null) break;
    const second = w.lookup(i + 1);
    if (second instanceof PDFArray) {
      for (let j = 0; j < second.size(); j += 1) {
        const v = numberValue(second.lookup(j));
        if (v !== null) widths.set(first + j, v);
      }
      i += 2;
    } else {
      const last = numberValue(second);
      const val = numberValue(w.lookup(i + 2));
      if (last === null || val === null) break;
      // A pathological range would hang the loop; cap it at a sane CID count.
      const end = Math.min(last, first + 65_535);
      for (let c = first; c <= end; c += 1) widths.set(c, val);
      i += 3;
    }
  }
  return widths;
}

/** Decode a /ToUnicode CMap's bfchar and bfrange sections into code → text. */
function parseToUnicode(bytes: Uint8Array): { map: Map<number, string>; codeBytes: number | null } {
  const map = new Map<number, string>();
  let codeBytes: number | null = null;
  const lex = new ContentLexer(bytes);
  const stack: Tok[] = [];
  for (;;) {
    const tok = lex.next();
    if (!tok) break;
    if (tok.t !== "op") {
      stack.push(tok);
      if (stack.length > 4096) stack.splice(0, stack.length - 4096);
      continue;
    }
    if (tok.v === "endcodespacerange") {
      const lo = stack.find((s) => s.t === "str");
      if (lo && lo.t === "str") codeBytes = lo.v.length;
      stack.length = 0;
      continue;
    }
    if (tok.v === "endbfchar") {
      for (let i = 0; i + 1 < stack.length; i += 2) {
        const src = stack[i];
        const dst = stack[i + 1];
        if (src.t !== "str" || dst.t !== "str") continue;
        map.set(bytesToInt(src.v), utf16beToString(dst.v));
      }
      stack.length = 0;
      continue;
    }
    if (tok.v === "endbfrange") {
      for (let i = 0; i + 2 < stack.length; i += 3) {
        const lo = stack[i];
        const hi = stack[i + 1];
        const dst = stack[i + 2];
        if (lo.t !== "str" || hi.t !== "str") continue;
        const loN = bytesToInt(lo.v);
        const hiN = Math.min(bytesToInt(hi.v), loN + 65_535);
        if (dst.t === "arr") {
          for (let c = loN; c <= hiN; c += 1) {
            const d = dst.v[c - loN];
            if (d && d.t === "str") map.set(c, utf16beToString(d.v));
          }
        } else if (dst.t === "str") {
          const base = utf16beToString(dst.v);
          const head = base.slice(0, Math.max(0, base.length - 1));
          const tail = base.length ? base.charCodeAt(base.length - 1) : 0;
          for (let c = loN; c <= hiN; c += 1) {
            map.set(c, head + String.fromCharCode(tail + (c - loN)));
          }
        }
      }
      stack.length = 0;
      continue;
    }
    if (tok.v === "beginbfchar" || tok.v === "beginbfrange" || tok.v === "begincodespacerange") {
      stack.length = 0;
      continue;
    }
    stack.length = 0;
  }
  return { map, codeBytes };
}

function bytesToInt(b: Uint8Array): number {
  let n = 0;
  for (const byte of b) n = n * 256 + byte;
  return n;
}

function utf16beToString(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  if (b.length % 2 === 1) s += String.fromCharCode(b[b.length - 1]);
  return s;
}

function buildFontModel(resourceName: string, dict: PDFDict, warnings: string[]): FontModel {
  const baseFont = nameValue(dict.lookup(PDFName.of("BaseFont"))) ?? "";
  const subtype = nameValue(dict.lookup(PDFName.of("Subtype"))) ?? "";
  const tagMatch = SUBSET_TAG.exec(baseFont);

  const isType0 = subtype === "Type0";
  let descendant: PDFDict | undefined;
  let descendantSubtype: string | null = null;
  if (isType0) {
    const df = dict.lookupMaybe(PDFName.of("DescendantFonts"), PDFArray);
    if (df && df.size() > 0) {
      const d = df.lookup(0);
      if (d instanceof PDFDict) {
        descendant = d;
        descendantSubtype = nameValue(d.lookup(PDFName.of("Subtype")));
      }
    }
  }

  const descriptorHolder = descendant ?? dict;
  const descriptor = descriptorHolder.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict);

  let fontFileKey: PdfFontInfo["fontFileKey"] = null;
  let fontFileBytes = 0;
  if (descriptor) {
    for (const key of ["FontFile", "FontFile2", "FontFile3"] as const) {
      const s = descriptor.lookupMaybe(PDFName.of(key), PDFStream);
      if (s) {
        fontFileKey = key;
        fontFileBytes = s.getContentsSize();
        break;
      }
    }
  }

  const toUnicodeStream = dict.lookupMaybe(PDFName.of("ToUnicode"), PDFStream);
  let toUnicode = new Map<number, string>();
  let cmapCodeBytes: number | null = null;
  if (toUnicodeStream) {
    const parsed = parseToUnicode(streamBytes(toUnicodeStream, warnings));
    toUnicode = parsed.map;
    cmapCodeBytes = parsed.codeBytes;
  }

  let widths: Map<number, number>;
  let defaultWidth: number;
  if (descendant) {
    widths = cidWidths(descendant);
    defaultWidth = numberValue(descendant.lookup(PDFName.of("DW"))) ?? 1000;
  } else {
    const sw = simpleWidths(dict);
    widths = sw.widths;
    defaultWidth = sw.missing;
  }

  // 750/-250 are the conventional fallbacks when a descriptor omits them. Only
  // the run box uses these, and that box is documented as approximate.
  const ascent = descriptor ? numberValue(descriptor.lookup(PDFName.of("Ascent"))) ?? 750 : 750;
  const descent = descriptor ? numberValue(descriptor.lookup(PDFName.of("Descent"))) ?? -250 : -250;

  const info: PdfFontInfo = {
    resourceName,
    baseFont,
    postScriptName: tagMatch ? tagMatch[2] : baseFont,
    subsetTag: tagMatch ? tagMatch[1] : null,
    subset: tagMatch !== null,
    subtype,
    embedded: fontFileKey !== null,
    fontFileKey,
    fontFileBytes,
    hasToUnicode: toUnicodeStream !== undefined,
    descendantSubtype,
  };

  return {
    info,
    codeBytes: isType0 ? cmapCodeBytes ?? 2 : 1,
    widths,
    defaultWidth,
    toUnicode,
    ascent,
    descent,
    simple: !isType0,
  };
}

/* -------------------------------------------------- content interpreter */

type GState = {
  ctm: Mat;
  fillSpace: string;
  strokeSpace: string;
  font: FontModel | null;
  fontResourceName: string;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  renderMode: number;
};

function cloneState(s: GState): GState {
  return { ...s, ctm: [...s.ctm] as Mat };
}

type PageAccum = {
  textRuns: PdfTextRun[];
  filledRects: PdfRect[];
  paintedExtents: PdfPaintedExtent[];
  operatorCounts: Record<string, number>;
  spaces: Set<string>;
  imagePlacements: Map<string, PdfImagePlacement[]>;
  warnings: string[];
  contentBytes: number;
};

const DEVICE_SPACE_OPS: Record<string, string> = {
  g: "DeviceGray",
  G: "DeviceGray",
  rg: "DeviceRGB",
  RG: "DeviceRGB",
  k: "DeviceCMYK",
  K: "DeviceCMYK",
};

/** Resolve a `cs`/`CS` operand to a colour-space family name. */
function resolveColorSpaceName(name: string, resources: PDFDict | undefined): string {
  if (
    name === "DeviceGray" ||
    name === "DeviceRGB" ||
    name === "DeviceCMYK" ||
    name === "Pattern"
  ) {
    return name;
  }
  const csDict = resources?.lookupMaybe(PDFName.of("ColorSpace"), PDFDict);
  const entry = csDict?.lookup(PDFName.of(name));
  if (entry instanceof PDFName) return entry.decodeText();
  if (entry instanceof PDFArray && entry.size() > 0) {
    const family = nameValue(entry.lookup(0));
    if (family) return family;
  }
  return name;
}

const PAINT_OPS = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*"]);
const FILL_OPS = new Set(["f", "F", "f*", "B", "B*", "b", "b*"]);

/** A bar in a vector barcode: taller than wide, and never wider than 3 pt. */
const BAR_MAX_WIDTH_PT = 3;

function interpret(
  content: Uint8Array,
  resources: PDFDict | undefined,
  fontCache: Map<string, FontModel>,
  initial: GState,
  acc: PageAccum,
  doc: PDFDocument,
  depth: number,
): void {
  const lex = new ContentLexer(content);
  let gs = initial;
  const stack: GState[] = [];
  const operands: Tok[] = [];

  // Path state: points of the current subpath, in device space.
  let pathPoints: Array<[number, number]> = [];
  let pathRects: PdfRect[] = [];
  let currentPoint: [number, number] = [0, 0];
  let startPoint: [number, number] = [0, 0];

  // Text state.
  let tm: Mat = [...IDENTITY] as Mat;
  let tlm: Mat = [...IDENTITY] as Mat;

  const num = (i: number): number => {
    const t = operands[operands.length + i];
    return t && t.t === "num" ? t.v : 0;
  };

  const moveTo = (x: number, y: number): void => {
    const p = apply(gs.ctm, x, y);
    pathPoints.push(p);
    currentPoint = p;
    startPoint = p;
  };
  const lineTo = (x: number, y: number): void => {
    const p = apply(gs.ctm, x, y);
    pathPoints.push(p);
    currentPoint = p;
  };
  const curveTo = (pts: Array<[number, number]>): void => {
    // Control points bound the curve, so using them is conservative and exact
    // enough for a "did anything leave the page" test.
    for (const [x, y] of pts) pathPoints.push(apply(gs.ctm, x, y));
    const last = pts[pts.length - 1];
    currentPoint = apply(gs.ctm, last[0], last[1]);
  };

  const paintPath = (op: string): void => {
    if (pathPoints.length > 0) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [x, y] of pathPoints) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
      acc.paintedExtents.push({ kind: "path", x0, y0, x1, y1, operator: op });
    }
    if (FILL_OPS.has(op)) for (const r of pathRects) acc.filledRects.push(r);
    pathPoints = [];
    pathRects = [];
  };

  const showText = (bytes: Uint8Array, adjustments: number[] = []): void => {
    const font = gs.font;
    if (!font) {
      acc.warnings.push("text shown with no font selected");
      return;
    }
    const codes: number[] = [];
    const step = font.codeBytes;
    for (let i = 0; i + step <= bytes.length; i += step) {
      let c = 0;
      for (let j = 0; j < step; j += 1) c = c * 256 + bytes[i + j];
      codes.push(c);
    }

    let text = "";
    let usedToUnicode = font.toUnicode.size > 0;
    for (const c of codes) {
      const mapped = font.toUnicode.get(c);
      if (mapped !== undefined) {
        text += mapped;
      } else if (font.simple) {
        // No CMap entry: a simple font's codes are the WinAnsi/Latin-1 bytes.
        text += String.fromCharCode(c);
        usedToUnicode = false;
      } else {
        // A CID with no ToUnicode entry cannot be read back. Say so with U+FFFD
        // rather than inventing a character.
        text += "�";
        usedToUnicode = false;
      }
    }

    // Total displacement in unscaled text space (PDF 32000-1 §9.4.4).
    let advance = 0;
    for (const c of codes) {
      const w = font.widths.get(c) ?? font.defaultWidth;
      const isSpace = font.codeBytes === 1 && c === 32;
      advance += ((w / 1000) * gs.fontSize + gs.charSpacing + (isSpace ? gs.wordSpacing : 0)) * gs.hScale;
    }
    for (const adj of adjustments) advance -= (adj / 1000) * gs.fontSize * gs.hScale;

    const trm = mul(tm, gs.ctm);
    const yTop = (font.ascent / 1000) * gs.fontSize + gs.rise;
    const yBot = (font.descent / 1000) * gs.fontSize + gs.rise;
    const corners: Array<[number, number]> = [
      apply(trm, 0, yBot),
      apply(trm, advance, yBot),
      apply(trm, advance, yTop),
      apply(trm, 0, yTop),
    ];
    const origin = apply(trm, 0, 0);
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const box = {
      x0: Math.min(...xs),
      y0: Math.min(...ys),
      x1: Math.max(...xs),
      y1: Math.max(...ys),
    };

    if (text.length > 0) {
      acc.textRuns.push({
        text,
        xPt: origin[0],
        yPt: origin[1],
        fontSizePt: gs.fontSize,
        fontResourceName: gs.fontResourceName,
        baseFont: font.info.baseFont,
        boxPt: box,
        decodedWithoutToUnicode: !usedToUnicode,
      });
    }
    // Render mode 3 is invisible and mode 7 is clip-only; neither puts ink down.
    if (gs.renderMode !== 3 && gs.renderMode !== 7 && text.length > 0) {
      acc.paintedExtents.push({ kind: "text", ...box, operator: "Tj" });
    }
    tm = mul([1, 0, 0, 1, advance, 0], tm);
  };

  for (;;) {
    const tok = lex.next();
    if (!tok) break;
    if (tok.t !== "op") {
      operands.push(tok);
      if (operands.length > 64) operands.splice(0, operands.length - 64);
      continue;
    }
    const op = tok.v;
    acc.operatorCounts[op] = (acc.operatorCounts[op] ?? 0) + 1;

    switch (op) {
      case "q":
        stack.push(cloneState(gs));
        break;
      case "Q": {
        const popped = stack.pop();
        if (popped) gs = popped;
        break;
      }
      case "cm":
        gs.ctm = mul(
          [num(-6), num(-5), num(-4), num(-3), num(-2), num(-1)] as Mat,
          gs.ctm,
        );
        break;

      case "m":
        moveTo(num(-2), num(-1));
        break;
      case "l":
        lineTo(num(-2), num(-1));
        break;
      case "c":
        curveTo([
          [num(-6), num(-5)],
          [num(-4), num(-3)],
          [num(-2), num(-1)],
        ]);
        break;
      case "v":
      case "y":
        curveTo([
          [num(-4), num(-3)],
          [num(-2), num(-1)],
        ]);
        break;
      case "h":
        pathPoints.push(startPoint);
        currentPoint = startPoint;
        break;
      case "re": {
        const x = num(-4);
        const y = num(-3);
        const w = num(-2);
        const h = num(-1);
        const c0 = apply(gs.ctm, x, y);
        const c1 = apply(gs.ctm, x + w, y);
        const c2 = apply(gs.ctm, x + w, y + h);
        const c3 = apply(gs.ctm, x, y + h);
        pathPoints.push(c0, c1, c2, c3);
        currentPoint = c0;
        startPoint = c0;
        const rx0 = Math.min(c0[0], c1[0], c2[0], c3[0]);
        const ry0 = Math.min(c0[1], c1[1], c2[1], c3[1]);
        const rx1 = Math.max(c0[0], c1[0], c2[0], c3[0]);
        const ry1 = Math.max(c0[1], c1[1], c2[1], c3[1]);
        pathRects.push({ x: rx0, y: ry0, width: rx1 - rx0, height: ry1 - ry0 });
        break;
      }
      case "S":
      case "s":
      case "f":
      case "F":
      case "f*":
      case "B":
      case "B*":
      case "b":
      case "b*":
        paintPath(op);
        break;
      case "n":
        // No-op painting: this is the `W n` clip idiom. Nothing is inked.
        pathPoints = [];
        pathRects = [];
        break;

      case "g":
      case "G":
      case "rg":
      case "RG":
      case "k":
      case "K": {
        const space = DEVICE_SPACE_OPS[op];
        acc.spaces.add(space);
        if (op === op.toLowerCase()) gs.fillSpace = space;
        else gs.strokeSpace = space;
        break;
      }
      case "cs":
      case "CS": {
        const nameTok = operands[operands.length - 1];
        const csName = nameTok && nameTok.t === "name" ? nameTok.v : "";
        const resolved = resolveColorSpaceName(csName, resources);
        acc.spaces.add(resolved);
        if (op === "cs") gs.fillSpace = resolved;
        else gs.strokeSpace = resolved;
        break;
      }
      case "sc":
      case "scn":
        acc.spaces.add(gs.fillSpace);
        break;
      case "SC":
      case "SCN":
        acc.spaces.add(gs.strokeSpace);
        break;

      case "BT":
        tm = [...IDENTITY] as Mat;
        tlm = [...IDENTITY] as Mat;
        break;
      case "ET":
        break;
      case "Tf": {
        const sizeTok = operands[operands.length - 1];
        const nameTok = operands[operands.length - 2];
        gs.fontSize = sizeTok && sizeTok.t === "num" ? sizeTok.v : 0;
        const fname = nameTok && nameTok.t === "name" ? nameTok.v : "";
        gs.fontResourceName = fname;
        let model = fontCache.get(fname) ?? null;
        if (!model) {
          const fontsDict = resources?.lookupMaybe(PDFName.of("Font"), PDFDict);
          const fdict = fontsDict?.lookupMaybe(PDFName.of(fname), PDFDict);
          if (fdict) {
            model = buildFontModel(fname, fdict, acc.warnings);
            fontCache.set(fname, model);
          }
        }
        gs.font = model;
        break;
      }
      case "Tc":
        gs.charSpacing = num(-1);
        break;
      case "Tw":
        gs.wordSpacing = num(-1);
        break;
      case "Tz":
        gs.hScale = num(-1) / 100;
        break;
      case "TL":
        gs.leading = num(-1);
        break;
      case "Ts":
        gs.rise = num(-1);
        break;
      case "Tr":
        gs.renderMode = num(-1);
        break;
      case "Td":
        tlm = mul([1, 0, 0, 1, num(-2), num(-1)] as Mat, tlm);
        tm = [...tlm] as Mat;
        break;
      case "TD":
        gs.leading = -num(-1);
        tlm = mul([1, 0, 0, 1, num(-2), num(-1)] as Mat, tlm);
        tm = [...tlm] as Mat;
        break;
      case "Tm":
        tlm = [num(-6), num(-5), num(-4), num(-3), num(-2), num(-1)] as Mat;
        tm = [...tlm] as Mat;
        break;
      case "T*":
        tlm = mul([1, 0, 0, 1, 0, -gs.leading] as Mat, tlm);
        tm = [...tlm] as Mat;
        break;
      case "Tj": {
        const t = operands[operands.length - 1];
        if (t && t.t === "str") showText(t.v);
        break;
      }
      case "'": {
        tlm = mul([1, 0, 0, 1, 0, -gs.leading] as Mat, tlm);
        tm = [...tlm] as Mat;
        const t = operands[operands.length - 1];
        if (t && t.t === "str") showText(t.v);
        break;
      }
      case '"': {
        gs.wordSpacing = num(-3);
        gs.charSpacing = num(-2);
        tlm = mul([1, 0, 0, 1, 0, -gs.leading] as Mat, tlm);
        tm = [...tlm] as Mat;
        const t = operands[operands.length - 1];
        if (t && t.t === "str") showText(t.v);
        break;
      }
      case "TJ": {
        const t = operands[operands.length - 1];
        if (t && t.t === "arr") {
          // Each element shifts the pen; run them one at a time so the pen
          // position after the array is right.
          for (const el of t.v) {
            if (el.t === "str") showText(el.v);
            else if (el.t === "num") {
              const shift = -(el.v / 1000) * gs.fontSize * gs.hScale;
              tm = mul([1, 0, 0, 1, shift, 0], tm);
            }
          }
        }
        break;
      }

      case "Do": {
        const nameTok = operands[operands.length - 1];
        const xname = nameTok && nameTok.t === "name" ? nameTok.v : "";
        const xobjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
        const xobj = xobjects?.lookupMaybe(PDFName.of(xname), PDFStream);
        if (!xobj) break;
        const subtype = nameValue(xobj.dict.lookup(PDFName.of("Subtype")));
        if (subtype === "Image") {
          const c0 = apply(gs.ctm, 0, 0);
          const c1 = apply(gs.ctm, 1, 0);
          const c2 = apply(gs.ctm, 1, 1);
          const c3 = apply(gs.ctm, 0, 1);
          const xs = [c0[0], c1[0], c2[0], c3[0]];
          const ys = [c0[1], c1[1], c2[1], c3[1]];
          const x0 = Math.min(...xs);
          const y0 = Math.min(...ys);
          const x1 = Math.max(...xs);
          const y1 = Math.max(...ys);
          acc.paintedExtents.push({ kind: "image", x0, y0, x1, y1, operator: "Do" });
          const pw = numberValue(xobj.dict.lookup(PDFName.of("Width"))) ?? 0;
          const ph = numberValue(xobj.dict.lookup(PDFName.of("Height"))) ?? 0;
          const wPt = x1 - x0;
          const hPt = y1 - y0;
          const list = acc.imagePlacements.get(xname) ?? [];
          list.push({
            widthPt: wPt,
            heightPt: hPt,
            xPt: x0,
            yPt: y0,
            effectiveDpiX: wPt > 0 ? (pw / wPt) * PT_PER_IN : null,
            effectiveDpiY: hPt > 0 ? (ph / hPt) * PT_PER_IN : null,
          });
          acc.imagePlacements.set(xname, list);
        } else if (subtype === "Form" && depth < 8) {
          const formRes = xobj.dict.lookupMaybe(PDFName.of("Resources"), PDFDict) ?? resources;
          const matrixArr = xobj.dict.lookupMaybe(PDFName.of("Matrix"), PDFArray);
          let ctm = gs.ctm;
          if (matrixArr && matrixArr.size() >= 6) {
            const m: number[] = [];
            for (let i = 0; i < 6; i += 1) m.push(numberValue(matrixArr.lookup(i)) ?? 0);
            ctm = mul(m as Mat, gs.ctm);
          }
          const nested: GState = { ...cloneState(gs), ctm, font: null, fontResourceName: "" };
          interpret(
            streamBytes(xobj, acc.warnings),
            formRes,
            new Map<string, FontModel>(),
            nested,
            acc,
            doc,
            depth + 1,
          );
        }
        break;
      }

      case "BI": {
        // Inline image: consume the dictionary, then skip the binary payload to
        // the matching EI so its bytes are never mistaken for operators.
        for (;;) {
          const t = lex.next();
          if (!t) break;
          if (t.t === "op" && t.v === "ID") break;
        }
        let p = lex.position() + 1;
        while (p + 1 < content.length) {
          if (
            content[p] === 0x45 &&
            content[p + 1] === 0x49 &&
            (p === 0 || WHITESPACE.has(content[p - 1])) &&
            (p + 2 >= content.length || WHITESPACE.has(content[p + 2]) || DELIM.has(content[p + 2]))
          ) {
            break;
          }
          p += 1;
        }
        lex.seek(Math.min(p + 2, content.length));
        break;
      }

      default:
        break;
    }
    operands.length = 0;
  }
}

/* ------------------------------------------------------------ page walk */

function inspectPage(
  doc: PDFDocument,
  index: number,
  warnings: string[],
): PdfPageInspection {
  const page = doc.getPages()[index];
  const node = page.node;

  const mediaArr = node.MediaBox();
  const boxes: PdfPageBoxes = {
    mediaBox: toBox(mediaArr),
    cropBox: toBox(node.CropBox()),
    bleedBox: toBox(node.BleedBox()),
    trimBox: toBox(node.TrimBox()),
    artBox: toBox(node.ArtBox()),
    present: {
      mediaBox: node.has(PDFName.of("MediaBox")),
      cropBox: node.has(PDFName.of("CropBox")),
      bleedBox: node.has(PDFName.of("BleedBox")),
      trimBox: node.has(PDFName.of("TrimBox")),
      artBox: node.has(PDFName.of("ArtBox")),
    },
  };

  const resources = node.Resources();
  const pageWarnings: string[] = [];

  // Concatenate every content stream: a page's streams are one stream that
  // happens to be split, and an operator may straddle the join only in badly
  // formed files, which we would rather report than silently mis-parse.
  const contents = node.Contents();
  const chunks: Uint8Array[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) {
      const s = contents.lookupMaybe(i, PDFStream);
      if (s) chunks.push(streamBytes(s, pageWarnings));
    }
  } else if (contents instanceof PDFStream) {
    chunks.push(streamBytes(contents, pageWarnings));
  }
  let total = 0;
  for (const c of chunks) total += c.length + 1;
  const content = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    content.set(c, off);
    off += c.length;
    content[off] = 0x0a;
    off += 1;
  }

  const acc: PageAccum = {
    textRuns: [],
    filledRects: [],
    paintedExtents: [],
    operatorCounts: {},
    spaces: new Set<string>(),
    imagePlacements: new Map<string, PdfImagePlacement[]>(),
    warnings: pageWarnings,
    contentBytes: content.length,
  };

  const fontCache = new Map<string, FontModel>();
  const initial: GState = {
    ctm: [...IDENTITY] as Mat,
    fillSpace: "DeviceGray",
    strokeSpace: "DeviceGray",
    font: null,
    fontResourceName: "",
    fontSize: 0,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
    renderMode: 0,
  };
  interpret(content, resources, fontCache, initial, acc, doc, 0);

  // Fonts: every entry in /Resources /Font, whether or not the content used it.
  const fonts: PdfFontInfo[] = [];
  const fontsDict = resources?.lookupMaybe(PDFName.of("Font"), PDFDict);
  if (fontsDict) {
    for (const key of fontsDict.keys()) {
      const name = key.decodeText();
      const fdict = fontsDict.lookupMaybe(key, PDFDict);
      if (!fdict) continue;
      const cached = fontCache.get(name);
      fonts.push(cached ? cached.info : buildFontModel(name, fdict, pageWarnings).info);
    }
  }

  // Images: every image XObject in /Resources /XObject, with its placements.
  const images: PdfImageInfo[] = [];
  const imageSpaces = new Set<string>();
  const xobjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (xobjects) {
    for (const key of xobjects.keys()) {
      const s = xobjects.lookupMaybe(key, PDFStream);
      if (!s) continue;
      if (nameValue(s.dict.lookup(PDFName.of("Subtype"))) !== "Image") continue;
      const name = key.decodeText();
      const csEntry = s.dict.lookup(PDFName.of("ColorSpace"));
      let cs = "unknown";
      if (csEntry instanceof PDFName) cs = csEntry.decodeText();
      else if (csEntry instanceof PDFArray && csEntry.size() > 0) {
        cs = nameValue(csEntry.lookup(0)) ?? "unknown";
      }
      imageSpaces.add(cs);
      const filterEntry = s.dict.lookup(PDFName.of("Filter"));
      const filters: string[] = [];
      if (filterEntry instanceof PDFName) filters.push(filterEntry.decodeText());
      else if (filterEntry instanceof PDFArray) {
        for (let i = 0; i < filterEntry.size(); i += 1) {
          const f = nameValue(filterEntry.lookup(i));
          if (f) filters.push(f);
        }
      }
      images.push({
        resourceName: name,
        pixelWidth: numberValue(s.dict.lookup(PDFName.of("Width"))) ?? 0,
        pixelHeight: numberValue(s.dict.lookup(PDFName.of("Height"))) ?? 0,
        bitsPerComponent: numberValue(s.dict.lookup(PDFName.of("BitsPerComponent"))),
        colorSpace: cs,
        filters,
        isMask: s.dict.lookup(PDFName.of("ImageMask")) !== undefined,
        hasSMask: s.dict.lookup(PDFName.of("SMask")) !== undefined,
        placements: acc.imagePlacements.get(name) ?? [],
      });
    }
  }

  const resourceSpaces: string[] = [];
  const csDict = resources?.lookupMaybe(PDFName.of("ColorSpace"), PDFDict);
  if (csDict) {
    for (const key of csDict.keys()) {
      resourceSpaces.push(resolveColorSpaceName(key.decodeText(), resources));
    }
  }

  let bounds: PdfPageInspection["paintedBounds"] = null;
  for (const e of acc.paintedExtents) {
    if (!bounds) bounds = { x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1 };
    else {
      bounds.x0 = Math.min(bounds.x0, e.x0);
      bounds.y0 = Math.min(bounds.y0, e.y0);
      bounds.x1 = Math.max(bounds.x1, e.x1);
      bounds.y1 = Math.max(bounds.y1, e.y1);
    }
  }

  const barLike = acc.filledRects.filter(
    (r) => r.width > 0 && r.height > r.width && r.width <= BAR_MAX_WIDTH_PT,
  ).length;

  for (const w of pageWarnings) warnings.push(`page ${index + 1}: ${w}`);

  return {
    index,
    boxes,
    rotation: numberValue(node.Rotate()) ?? 0,
    fonts,
    images,
    colorSpaces: {
      spaces: [...acc.spaces].filter((s) => s.length > 0).sort(),
      operatorCounts: acc.operatorCounts,
      resourceSpaces: resourceSpaces.sort(),
      imageSpaces: [...imageSpaces].sort(),
    },
    textRuns: acc.textRuns,
    textContent: acc.textRuns.map((r) => r.text).join("\n"),
    filledRects: acc.filledRects,
    barLikeRectCount: barLike,
    paintedExtents: acc.paintedExtents,
    paintedBounds: bounds,
    contentBytes: acc.contentBytes,
    warnings: pageWarnings,
  };
}

/* ---------------------------------------------------------------- entry */

function readHeaderVersion(bytes: Uint8Array): string {
  const head = bytes.subarray(0, 32);
  let s = "";
  for (const b of head) s += String.fromCharCode(b);
  const m = /%PDF-(\d+\.\d+)/.exec(s);
  return m ? m[1] : "unknown";
}

/**
 * Parse a finished PDF and report its structure. Never throws for content it
 * cannot understand — unparseable pieces are collected in `warnings` so a
 * validation report can distinguish "this is wrong" from "we could not tell".
 */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  const warnings: string[] = [];
  const doc = await PDFDocument.load(bytes, {
    updateMetadata: false,
    throwOnInvalidObject: false,
  });

  const pages: PdfPageInspection[] = [];
  for (let i = 0; i < doc.getPageCount(); i += 1) {
    pages.push(inspectPage(doc, i, warnings));
  }

  const outputIntents: PdfOutputIntentInfo[] = [];
  const oiArr = doc.catalog.lookupMaybe(PDFName.of("OutputIntents"), PDFArray);
  if (oiArr) {
    for (let i = 0; i < oiArr.size(); i += 1) {
      const oi = oiArr.lookupMaybe(i, PDFDict);
      if (!oi) continue;
      const profile = oi.lookupMaybe(PDFName.of("DestOutputProfile"), PDFStream);
      outputIntents.push({
        subtype: nameValue(oi.lookup(PDFName.of("S"))) ?? "",
        outputConditionIdentifier:
          stringValue(oi.lookup(PDFName.of("OutputConditionIdentifier"))) ?? "",
        outputCondition: stringValue(oi.lookup(PDFName.of("OutputCondition"))) ?? "",
        registryName: stringValue(oi.lookup(PDFName.of("RegistryName"))) ?? "",
        info: stringValue(oi.lookup(PDFName.of("Info"))) ?? "",
        hasDestOutputProfile: profile !== undefined,
        destOutputProfileBytes: profile ? profile.getContentsSize() : 0,
      });
    }
  }

  const byBaseFont = new Map<string, PdfFontInfo>();
  for (const p of pages) {
    for (const f of p.fonts) if (!byBaseFont.has(f.baseFont)) byBaseFont.set(f.baseFont, f);
  }

  return {
    byteLength: bytes.length,
    headerVersion: readHeaderVersion(bytes),
    pageCount: doc.getPageCount(),
    pages,
    fonts: [...byBaseFont.values()].sort((a, b) => a.baseFont.localeCompare(b.baseFont)),
    outputIntents,
    hasOutputIntent: outputIntents.length > 0,
    title: doc.getTitle() ?? null,
    producer: doc.getProducer() ?? null,
    creator: doc.getCreator() ?? null,
    hasXmpMetadata: doc.catalog.has(PDFName.of("Metadata")),
    warnings,
  };
}

/** Points → inches, for reports that must state physical size. */
export function ptToIn(pt: number): number {
  return pt / PT_PER_IN;
}
