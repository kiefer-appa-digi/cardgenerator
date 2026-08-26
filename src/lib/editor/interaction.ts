import type { Rect } from "@/lib/geometry/types";
import { rectBottom, rectRight } from "@/lib/geometry/types";
import type { Upt } from "@/lib/units";
import type { DesignElement } from "@/lib/design/schema";

/**
 * Transform and snapping maths for the artboard. Pure functions so they can be
 * unit-tested without a DOM — dragging behaviour is exactly the kind of thing
 * that silently regresses.
 */

export type Handle =
  | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w"
  | "rotate";

export const RESIZE_HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export function unionFrames(els: DesignElement[]): Rect | null {
  if (els.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of els) {
    x0 = Math.min(x0, e.frame.x);
    y0 = Math.min(y0, e.frame.y);
    x1 = Math.max(x1, rectRight(e.frame));
    y1 = Math.max(y1, rectBottom(e.frame));
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Resize a rect by dragging `handle` by (dx, dy).
 * `constrain` keeps the original aspect ratio (Shift), `fromCenter` resizes
 * about the centre (Alt) — the two modifiers every design tool uses.
 */
export function resizeRect(
  start: Rect,
  handle: Handle,
  dx: Upt,
  dy: Upt,
  opts: { constrain?: boolean; fromCenter?: boolean; minSize?: Upt } = {},
): Rect {
  const min = opts.minSize ?? 72_000; // 0.001 in — small enough for a hairline rule
  let { x, y, w, h } = start;

  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.startsWith("n");
  const south = handle.startsWith("s");

  let ddx = dx;
  let ddy = dy;

  if (opts.constrain && start.w > 0 && start.h > 0 && handle.length === 2) {
    // Corner drags follow the dominant axis and derive the other from the
    // original aspect ratio, so the ratio is exact rather than accumulated.
    const aspect = start.w / start.h;
    const signX = east ? 1 : -1;
    const signY = south ? 1 : -1;
    if (Math.abs(ddx) * (1 / aspect) > Math.abs(ddy)) {
      ddy = Math.round((ddx * signX * signY) / aspect);
    } else {
      ddx = Math.round(ddy * aspect * signX * signY);
    }
  }

  if (opts.fromCenter) {
    if (east) { w = start.w + 2 * ddx; x = start.x - ddx; }
    if (west) { w = start.w - 2 * ddx; x = start.x + ddx; }
    if (south) { h = start.h + 2 * ddy; y = start.y - ddy; }
    if (north) { h = start.h - 2 * ddy; y = start.y + ddy; }
  } else {
    if (east) w = start.w + ddx;
    if (west) { w = start.w - ddx; x = start.x + ddx; }
    if (south) h = start.h + ddy;
    if (north) { h = start.h - ddy; y = start.y + ddy; }
  }

  // Flipping through zero is confusing in a print tool; clamp instead.
  if (w < min) {
    if (west) x = rectRight(start) - min;
    w = min;
  }
  if (h < min) {
    if (north) y = rectBottom(start) - min;
    h = min;
  }
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

export type SnapLine = {
  axis: "x" | "y";
  pos: Upt;
  /** What produced the line, shown in the alignment indicator. */
  kind: "trim" | "safe" | "bleed" | "center" | "cavity" | "element" | "guide";
};

export type SnapResult = {
  dx: Upt;
  dy: Upt;
  lines: SnapLine[];
};

/**
 * Snap a moving rect against a set of candidate lines.
 * Returns the *additional* delta to apply, plus the lines that matched so the
 * artboard can draw the contextual alignment indicators the spec asks for.
 */
export function snapRect(
  moving: Rect,
  candidatesX: SnapLine[],
  candidatesY: SnapLine[],
  tolerance: Upt,
): SnapResult {
  const edgesX = [
    { pos: moving.x, off: 0 },
    { pos: moving.x + moving.w / 2, off: -moving.w / 2 },
    { pos: rectRight(moving), off: -moving.w },
  ];
  const edgesY = [
    { pos: moving.y, off: 0 },
    { pos: moving.y + moving.h / 2, off: -moving.h / 2 },
    { pos: rectBottom(moving), off: -moving.h },
  ];

  let bestX: { d: number; line: SnapLine } | null = null;
  for (const e of edgesX) {
    for (const c of candidatesX) {
      const d = c.pos - e.pos;
      if (Math.abs(d) <= tolerance && (!bestX || Math.abs(d) < Math.abs(bestX.d))) {
        bestX = { d, line: c };
      }
    }
  }
  let bestY: { d: number; line: SnapLine } | null = null;
  for (const e of edgesY) {
    for (const c of candidatesY) {
      const d = c.pos - e.pos;
      if (Math.abs(d) <= tolerance && (!bestY || Math.abs(d) < Math.abs(bestY.d))) {
        bestY = { d, line: c };
      }
    }
  }

  const lines: SnapLine[] = [];
  if (bestX) lines.push(bestX.line);
  if (bestY) lines.push(bestY.line);
  return { dx: bestX ? Math.round(bestX.d) : 0, dy: bestY ? Math.round(bestY.d) : 0, lines };
}

export function buildSnapCandidates(opts: {
  bleed: Rect;
  trim: Rect;
  safe: Rect;
  cavity: Rect;
  guides: Array<{ axis: "x" | "y"; pos: Upt }>;
  others: Rect[];
  includeCavity: boolean;
}): { x: SnapLine[]; y: SnapLine[] } {
  const x: SnapLine[] = [];
  const y: SnapLine[] = [];
  const push = (r: Rect, kind: SnapLine["kind"]) => {
    x.push({ axis: "x", pos: r.x, kind }, { axis: "x", pos: rectRight(r), kind }, { axis: "x", pos: r.x + r.w / 2, kind });
    y.push({ axis: "y", pos: r.y, kind }, { axis: "y", pos: rectBottom(r), kind }, { axis: "y", pos: r.y + r.h / 2, kind });
  };
  push(opts.trim, "trim");
  push(opts.safe, "safe");
  push(opts.bleed, "bleed");
  if (opts.includeCavity) push(opts.cavity, "cavity");
  for (const o of opts.others) push(o, "element");
  for (const g of opts.guides) {
    if (g.axis === "x") x.push({ axis: "x", pos: g.pos, kind: "guide" });
    else y.push({ axis: "y", pos: g.pos, kind: "guide" });
  }
  return { x, y };
}

/** Alignment operations for a multi-selection. */
export type AlignMode =
  | "left" | "hcenter" | "right"
  | "top" | "vcenter" | "bottom";

export function alignFrames(frames: Rect[], bounds: Rect, mode: AlignMode): Rect[] {
  return frames.map((f) => {
    switch (mode) {
      case "left":
        return { ...f, x: bounds.x };
      case "right":
        return { ...f, x: rectRight(bounds) - f.w };
      case "hcenter":
        return { ...f, x: Math.round(bounds.x + (bounds.w - f.w) / 2) };
      case "top":
        return { ...f, y: bounds.y };
      case "bottom":
        return { ...f, y: rectBottom(bounds) - f.h };
      case "vcenter":
        return { ...f, y: Math.round(bounds.y + (bounds.h - f.h) / 2) };
    }
  });
}

/** Even spacing between the outer two elements. */
export function distributeFrames(frames: Rect[], axis: "x" | "y"): Rect[] {
  if (frames.length < 3) return frames;
  const idx = frames.map((f, i) => ({ f, i }));
  idx.sort((a, b) => (axis === "x" ? a.f.x - b.f.x : a.f.y - b.f.y));
  const first = idx[0].f;
  const last = idx[idx.length - 1].f;
  const total =
    axis === "x" ? rectRight(last) - first.x : rectBottom(last) - first.y;
  const used = idx.reduce((s, { f }) => s + (axis === "x" ? f.w : f.h), 0);
  const gap = (total - used) / (idx.length - 1);
  const out = frames.slice();
  let cursor = axis === "x" ? first.x : first.y;
  for (const { f, i } of idx) {
    out[i] = axis === "x" ? { ...f, x: Math.round(cursor) } : { ...f, y: Math.round(cursor) };
    cursor += (axis === "x" ? f.w : f.h) + gap;
  }
  return out;
}

/** Nudge distances: arrow = 0.01 in, shift+arrow = 0.1 in. */
export const NUDGE_UPT = 720_000;
export const NUDGE_SHIFT_UPT = 7_200_000;
