import metricsJson from "./metrics.json";
import { resolveFace, faceKeyOf } from "./fonts";
import type { Paragraph, TextRun, TextTransform } from "@/lib/design/schema";
import type { PrintColor } from "@/lib/color/types";
import type { Upt } from "@/lib/units";

/**
 * TEXT LAYOUT — one engine, two consumers.
 *
 * The editor and the PDF writer both call `layoutText` with the same inputs and
 * get the same line breaks, the same advance widths and the same baselines, in
 * µpt. That is the whole reason this engine exists: a browser-measured line
 * break cannot be reproduced by a PDF writer, so we never let the browser
 * measure. The metrics come from the identical TTF bytes that pdf-lib embeds.
 *
 * Deliberate limitations, stated rather than hidden:
 *  - Advance widths only. No kerning pairs and no OpenType shaping, so a pair
 *    like "AV" sets very slightly wider than a shaped renderer would. The same
 *    is true in the editor and in the PDF, so they still agree with each other.
 *  - Latin-1 plus common typographic punctuation. A character outside the
 *    generated metrics falls back to the space advance and raises a preflight
 *    warning at the call site rather than laying out silently wrong.
 */

export type FaceMetrics = {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  lineGap: number;
  capHeight: number;
  xHeight: number;
  widths: Record<string, number>;
  defaultWidth: number;
};

const METRICS = metricsJson as unknown as Record<string, FaceMetrics>;

export function getFaceMetrics(
  family: string,
  weight: number,
  italic: boolean,
): { metrics: FaceMetrics; key: string; missing: boolean } {
  const resolved = resolveFace(family, weight, italic);
  if (resolved) {
    const key = faceKeyOf(resolved.def.family, resolved.face.weight, resolved.face.italic);
    const m = METRICS[key];
    if (m) return { metrics: m, key, missing: false };
  }
  // Unknown family: fall back to Inter 400 so the layout still resolves, and
  // report `missing` so preflight can raise FONT_MISSING.
  return { metrics: METRICS["Inter:400"], key: "Inter:400", missing: true };
}

export function applyTransform(s: string, t: TextTransform): string {
  switch (t) {
    case "uppercase":
      return s.toUpperCase();
    case "lowercase":
      return s.toLowerCase();
    case "titlecase":
      // Capitalise the first CASED character of each word rather than the first
      // \w: a word opening with an accent would otherwise have its SECOND letter
      // capitalised. Comparing a character to its own uppercase avoids needing
      // a Unicode property escape. Mirrors applyTextTransform in lib/data/format.ts.
      return s.replace(/\S+/g, (w) => {
        const lower = w.toLowerCase();
        for (let i = 0; i < lower.length; i++) {
          const up = lower[i].toUpperCase();
          if (up !== lower[i]) return lower.slice(0, i) + up + lower.slice(i + 1);
        }
        return lower;
      });
    default:
      return s;
  }
}

/** Advance of a single code point, in µpt at the given font size. */
export function charAdvance(m: FaceMetrics, cp: number, fontSize: Upt): number {
  const w = m.widths[String(cp)] ?? m.defaultWidth;
  return (w * fontSize) / m.unitsPerEm;
}

export function measureString(
  s: string,
  m: FaceMetrics,
  fontSize: Upt,
  trackingUpt: number,
): number {
  let total = 0;
  let count = 0;
  for (const ch of s) {
    total += charAdvance(m, ch.codePointAt(0)!, fontSize);
    count += 1;
  }
  // Tracking is applied after every glyph including the last, matching how the
  // PDF text state's Tc operator behaves, so the two agree exactly.
  return total + trackingUpt * count;
}

/** Does this string contain a code point we have no metric for? */
export function hasUnmappedGlyphs(s: string, m: FaceMetrics): boolean {
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 10 || cp === 13) continue;
    if (m.widths[String(cp)] === undefined) return true;
  }
  return false;
}

/* --------------------------------------------------------------- shaping */

export type ResolvedRun = {
  text: string;
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  fontSize: Upt;
  tracking: number;
  color: PrintColor;
};

export type LaidGlyphSpan = {
  text: string;
  x: Upt;
  width: Upt;
  run: ResolvedRun;
  faceKey: string;
  fontMissing: boolean;
};

export type LaidLine = {
  spans: LaidGlyphSpan[];
  /** Baseline offset from the top of the text block. */
  baseline: Upt;
  width: Upt;
  height: Upt;
  ascent: Upt;
  descent: Upt;
  /** True when this line had to be broken inside a word (no break opportunity). */
  hardBroken: boolean;
};

export type LayoutResult = {
  lines: LaidLine[];
  /** Total laid height including line spacing. */
  height: Upt;
  /** Widest line. */
  width: Upt;
  /** The font size actually used, after auto-fit shrinking. */
  usedFontSize: Upt;
  overflow: boolean;
  overflowAmount: Upt;
  fontsMissing: string[];
  unmappedGlyphs: boolean;
};

export type LayoutOptions = {
  /** Available width for wrapping. */
  maxWidth: Upt;
  /** Available height. Used to report overflow and to drive auto-fit. */
  maxHeight: Upt;
  align: "left" | "center" | "right" | "justify";
  /** Multiple of the font size, in basis points. 12000 = 1.2×. */
  lineHeightBps: number;
  transform: TextTransform;
  autoFit?: { mode: "none" | "shrink"; minFontSize: Upt };
};

type Token = { text: string; isSpace: boolean; isBreak: boolean; run: ResolvedRun };

function tokenise(runs: ResolvedRun[], transform: TextTransform): Token[] {
  const out: Token[] = [];
  for (const run of runs) {
    const text = applyTransform(run.text, transform);
    if (!text) continue;
    // A newline inside a run is a HARD break, not whitespace to wrap on. A
    // binding joined with "\n" — a fitment list, a pack-contents block, an
    // address — has to break where it says it breaks, or the lines run together
    // and the copy reads as one sentence.
    for (const segment of text.split(/\r\n|\r|\n/)) {
      if (segment) {
        // Split into runs of whitespace and runs of non-whitespace, keeping both.
        for (const p of segment.split(/(\s+)/)) {
          if (!p) continue;
          out.push({ text: p, isSpace: /^\s+$/.test(p), isBreak: false, run });
        }
      }
      out.push({ text: "", isSpace: false, isBreak: true, run });
    }
    // The split above appends a break after the last segment too; drop it, since
    // a run ending without a newline must not force one.
    if (out.length && out[out.length - 1].isBreak) out.pop();
  }
  return out;
}

function layoutOnce(
  paragraphs: Array<{ runs: ResolvedRun[]; spaceBefore: Upt; spaceAfter: Upt }>,
  opts: LayoutOptions,
  scaleBps: number,
): LayoutResult {
  const lines: LaidLine[] = [];
  const missing = new Set<string>();
  let unmapped = false;
  let maxLineWidth = 0;
  let y = 0;

  const scale = (n: number) => Math.round((n * scaleBps) / 10_000);

  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi];
    y += scale(para.spaceBefore);

    const scaledRuns = para.runs.map((r) => ({ ...r, fontSize: scale(r.fontSize), tracking: scale(r.tracking) }));
    const tokens = tokenise(scaledRuns, opts.transform);

    // An empty paragraph still occupies one line.
    if (tokens.length === 0) {
      const probe = scaledRuns[0];
      const fm = probe
        ? getFaceMetrics(probe.fontFamily, probe.fontWeight, probe.italic)
        : getFaceMetrics("Inter", 400, false);
      const size = probe?.fontSize ?? 9_000_000;
      const lh = Math.round((size * opts.lineHeightBps) / 10_000);
      const ascent = Math.round((fm.metrics.ascender * size) / fm.metrics.unitsPerEm);
      const descent = Math.round((-fm.metrics.descender * size) / fm.metrics.unitsPerEm);
      lines.push({
        spans: [],
        baseline: y + Math.round((lh - ascent - descent) / 2) + ascent,
        width: 0,
        height: lh,
        ascent,
        descent,
        hardBroken: false,
      });
      y += lh;
      y += scale(para.spaceAfter);
      continue;
    }

    let current: Token[] = [];
    let currentWidth = 0;
    let hardBroken = false;

    const flush = (broke: boolean) => {
      // Trailing whitespace never contributes to a line's measured width.
      while (current.length && current[current.length - 1].isSpace) current.pop();
      if (current.length === 0 && !broke) return;

      let maxAscent = 0;
      let maxDescent = 0;
      let maxSize = 0;
      for (const t of current) {
        const fm = getFaceMetrics(t.run.fontFamily, t.run.fontWeight, t.run.italic);
        if (fm.missing) missing.add(t.run.fontFamily);
        if (hasUnmappedGlyphs(t.text, fm.metrics)) unmapped = true;
        const a = Math.round((fm.metrics.ascender * t.run.fontSize) / fm.metrics.unitsPerEm);
        const d = Math.round((-fm.metrics.descender * t.run.fontSize) / fm.metrics.unitsPerEm);
        if (a > maxAscent) maxAscent = a;
        if (d > maxDescent) maxDescent = d;
        if (t.run.fontSize > maxSize) maxSize = t.run.fontSize;
      }
      if (maxSize === 0) maxSize = scaledRuns[0]?.fontSize ?? 9_000_000;
      const lineHeight = Math.round((maxSize * opts.lineHeightBps) / 10_000);
      // Centre the ink box inside the line box, the same convention the PDF
      // writer uses when it positions the baseline.
      const leading = lineHeight - maxAscent - maxDescent;
      const baseline = y + Math.round(leading / 2) + maxAscent;

      // Merge adjacent tokens that share a run into single spans.
      const spans: LaidGlyphSpan[] = [];
      let x = 0;
      for (const t of current) {
        const fm = getFaceMetrics(t.run.fontFamily, t.run.fontWeight, t.run.italic);
        const w = Math.round(measureString(t.text, fm.metrics, t.run.fontSize, t.run.tracking));
        const prev = spans[spans.length - 1];
        if (prev && prev.run === t.run) {
          prev.text += t.text;
          prev.width += w;
        } else {
          spans.push({
            text: t.text,
            x,
            width: w,
            run: t.run,
            faceKey: fm.key,
            fontMissing: fm.missing,
          });
        }
        x += w;
      }
      const lineWidth = spans.reduce((s, sp) => s + sp.width, 0);
      if (lineWidth > maxLineWidth) maxLineWidth = lineWidth;

      lines.push({
        spans,
        baseline,
        width: lineWidth,
        height: lineHeight,
        ascent: maxAscent,
        descent: maxDescent,
        hardBroken: broke,
      });
      y += lineHeight;
      current = [];
      currentWidth = 0;
    };

    for (const token of tokens) {
      if (token.isBreak) {
        // Force a line even when the current line is empty, so a blank line in
        // the source is a blank line on the card.
        if (current.length === 0) {
          current.push({ text: "", isSpace: false, isBreak: false, run: token.run });
        }
        flush(true);
        continue;
      }
      const fm = getFaceMetrics(token.run.fontFamily, token.run.fontWeight, token.run.italic);
      const w = Math.round(measureString(token.text, fm.metrics, token.run.fontSize, token.run.tracking));

      if (token.isSpace) {
        if (current.length === 0) continue; // never start a line with a space
        current.push(token);
        currentWidth += w;
        continue;
      }

      if (currentWidth + w <= opts.maxWidth || current.length === 0) {
        // A single token wider than the box must be broken by character —
        // reported via hardBroken so preflight can flag it.
        if (current.length === 0 && w > opts.maxWidth && opts.maxWidth > 0) {
          let buf = "";
          let bufW = 0;
          for (const ch of token.text) {
            const cw = Math.round(measureString(ch, fm.metrics, token.run.fontSize, token.run.tracking));
            if (bufW + cw > opts.maxWidth && buf) {
              current.push({ text: buf, isSpace: false, isBreak: false, run: token.run });
              hardBroken = true;
              flush(true);
              buf = "";
              bufW = 0;
            }
            buf += ch;
            bufW += cw;
          }
          if (buf) {
            current.push({ text: buf, isSpace: false, isBreak: false, run: token.run });
            currentWidth = bufW;
          }
          continue;
        }
        current.push(token);
        currentWidth += w;
      } else {
        flush(false);
        current.push(token);
        currentWidth = w;
      }
    }
    flush(current.length > 0);
    y += scale(para.spaceAfter);
  }

  // Horizontal alignment: shift span x positions.
  for (const line of lines) {
    if (opts.align === "left" || line.spans.length === 0) continue;
    if (opts.align === "justify") continue; // handled below
    const slack = opts.maxWidth - line.width;
    const shift = opts.align === "center" ? Math.round(slack / 2) : slack;
    for (const s of line.spans) s.x += shift;
  }
  if (opts.align === "justify") {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLast = i === lines.length - 1 || lines[i + 1]?.spans.length === 0;
      if (isLast || line.spans.length < 2) continue;
      const slack = opts.maxWidth - line.width;
      if (slack <= 0) continue;
      const gaps = line.spans.length - 1;
      const per = Math.round(slack / gaps);
      for (let s = 1; s < line.spans.length; s++) line.spans[s].x += per * s;
    }
  }

  const height = y;
  return {
    lines,
    height,
    width: maxLineWidth,
    usedFontSize: 0,
    overflow: height > opts.maxHeight,
    overflowAmount: Math.max(0, height - opts.maxHeight),
    fontsMissing: [...missing],
    unmappedGlyphs: unmapped,
  };
}

/**
 * Lay out a block. When `autoFit.mode === "shrink"` the engine binary-searches
 * the largest whole-µpt scale that fits, never going below `minFontSize`. If it
 * still does not fit, it returns the min-size layout WITH `overflow: true` — the
 * caller (preflight) turns that into a blocking error. Copy is never clipped.
 */
export function layoutText(
  paragraphs: Array<{ runs: ResolvedRun[]; spaceBefore?: Upt; spaceAfter?: Upt }>,
  opts: LayoutOptions,
): LayoutResult {
  const paras = paragraphs.map((p) => ({
    runs: p.runs,
    spaceBefore: p.spaceBefore ?? 0,
    spaceAfter: p.spaceAfter ?? 0,
  }));
  const baseSize = paras[0]?.runs[0]?.fontSize ?? 9_000_000;

  const first = layoutOnce(paras, opts, 10_000);
  if (!opts.autoFit || opts.autoFit.mode !== "shrink" || !first.overflow) {
    return { ...first, usedFontSize: baseSize };
  }

  const minScale = Math.max(
    1_000,
    Math.floor((opts.autoFit.minFontSize / Math.max(1, baseSize)) * 10_000),
  );
  if (minScale >= 10_000) return { ...first, usedFontSize: baseSize };

  let lo = minScale;
  let hi = 10_000;
  let best: LayoutResult | null = null;
  // 12 iterations resolves the scale to ~2 basis points — well below one µpt of
  // font size at any realistic card size, and always terminates.
  for (let i = 0; i < 12 && lo <= hi; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const r = layoutOnce(paras, opts, mid);
    if (!r.overflow) {
      best = { ...r, usedFontSize: Math.round((baseSize * mid) / 10_000) };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best) return best;
  const floor = layoutOnce(paras, opts, minScale);
  return { ...floor, usedFontSize: opts.autoFit.minFontSize };
}

/** Turn schema paragraphs + block defaults into ResolvedRuns. */
export function resolveRuns(
  paragraphs: Paragraph[],
  defaults: {
    fontFamily: string;
    fontWeight: number;
    italic: boolean;
    fontSize: Upt;
    tracking: number;
    color: PrintColor;
  },
  resolveBinding: (run: TextRun) => string,
): Array<{ runs: ResolvedRun[]; spaceBefore: Upt; spaceAfter: Upt }> {
  return paragraphs.map((p) => ({
    spaceBefore: p.spaceBefore,
    spaceAfter: p.spaceAfter,
    runs: p.runs.map((r) => ({
      text: resolveBinding(r),
      fontFamily: r.fontFamily ?? defaults.fontFamily,
      fontWeight: r.bold ? Math.max(700, defaults.fontWeight) : defaults.fontWeight,
      italic: r.italic || defaults.italic,
      fontSize: r.fontSize ?? defaults.fontSize,
      tracking: r.tracking ?? defaults.tracking,
      color: r.color ?? defaults.color,
    })),
  }));
}

/** Vertical offset of the laid block inside its frame. */
export function verticalOffset(
  result: LayoutResult,
  boxHeight: Upt,
  align: "top" | "middle" | "bottom",
): Upt {
  if (align === "top") return 0;
  const slack = boxHeight - result.height;
  if (slack <= 0) return 0;
  return align === "middle" ? Math.round(slack / 2) : slack;
}
