import { z } from "zod";
import type { MilliDeg, Upt } from "@/lib/units";

/** An integer µpt scalar. */
export const UptSchema = z.number().int();

export const PointSchema = z.object({ x: UptSchema, y: UptSchema });
export type Point = { x: Upt; y: Upt };

/**
 * Rect in *card space*: origin is the TOP-LEFT of the bleed box, +x right,
 * +y DOWN. This is the same orientation as the screen and as SVG, so the editor
 * needs no flip. The PDF writer performs the single y-flip into PDF's
 * bottom-left origin, in exactly one place.
 */
export const RectSchema = z.object({
  x: UptSchema,
  y: UptSchema,
  w: UptSchema.nonnegative(),
  h: UptSchema.nonnegative(),
});
export type Rect = { x: Upt; y: Upt; w: Upt; h: Upt };

export const InsetsSchema = z.object({
  top: UptSchema,
  right: UptSchema,
  bottom: UptSchema,
  left: UptSchema,
});
export type Insets = { top: Upt; right: Upt; bottom: Upt; left: Upt };

export function uniformInsets(v: Upt): Insets {
  return { top: v, right: v, bottom: v, left: v };
}

export function rectRight(r: Rect): Upt {
  return r.x + r.w;
}
export function rectBottom(r: Rect): Upt {
  return r.y + r.h;
}
export function rectCenter(r: Rect): Point {
  return { x: r.x + Math.round(r.w / 2), y: r.y + Math.round(r.h / 2) };
}
export function insetRect(r: Rect, i: Insets): Rect {
  return {
    x: r.x + i.left,
    y: r.y + i.top,
    w: Math.max(0, r.w - i.left - i.right),
    h: Math.max(0, r.h - i.top - i.bottom),
  };
}
export function outsetRect(r: Rect, i: Insets): Rect {
  return {
    x: r.x - i.left,
    y: r.y - i.top,
    w: r.w + i.left + i.right,
    h: r.h + i.top + i.bottom,
  };
}
export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    rectRight(inner) <= rectRight(outer) &&
    rectBottom(inner) <= rectBottom(outer)
  );
}
export function rectIntersects(a: Rect, b: Rect): boolean {
  return !(
    rectRight(a) <= b.x ||
    rectRight(b) <= a.x ||
    rectBottom(a) <= b.y ||
    rectBottom(b) <= a.y
  );
}
export function rectIntersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(rectRight(a), rectRight(b));
  const bo = Math.min(rectBottom(a), rectBottom(b));
  if (r <= x || bo <= y) return null;
  return { x, y, w: r - x, h: bo - y };
}
export function rectUnion(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const r = Math.max(rectRight(a), rectRight(b));
  const bo = Math.max(rectBottom(a), rectBottom(b));
  return { x, y, w: r - x, h: bo - y };
}
export function rectArea(r: Rect): number {
  return r.w * r.h;
}
export function rectEquals(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * Axis-aligned bounding box of a rect rotated by `rotation` about its own
 * centre. Used by selection bounds, snapping and preflight containment tests —
 * a rotated element's *visual* extent is what has to stay inside the safe area.
 */
export function rotatedBounds(r: Rect, rotationMdeg: MilliDeg): Rect {
  const norm = ((rotationMdeg % 360_000) + 360_000) % 360_000;
  if (norm === 0) return r;
  const rad = (norm / 1000) * (Math.PI / 180);
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  const w = Math.round(r.w * c + r.h * s);
  const h = Math.round(r.w * s + r.h * c);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
}

/** Rotate a point about a pivot. Returns µpt-rounded integers. */
export function rotatePoint(p: Point, pivot: Point, rotationMdeg: MilliDeg): Point {
  const rad = (rotationMdeg / 1000) * (Math.PI / 180);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - pivot.x;
  const dy = p.y - pivot.y;
  return {
    x: Math.round(pivot.x + dx * cos - dy * sin),
    y: Math.round(pivot.y + dx * sin + dy * cos),
  };
}

/** The four corners of a rotated rect, in card space. */
export function rectCorners(r: Rect, rotationMdeg: MilliDeg): [Point, Point, Point, Point] {
  const pivot = rectCenter(r);
  const pts: Point[] = [
    { x: r.x, y: r.y },
    { x: rectRight(r), y: r.y },
    { x: rectRight(r), y: rectBottom(r) },
    { x: r.x, y: rectBottom(r) },
  ];
  if (!rotationMdeg) return pts as [Point, Point, Point, Point];
  return pts.map((p) => rotatePoint(p, pivot, rotationMdeg)) as [Point, Point, Point, Point];
}

/**
 * A rounded rectangle expressed as SVG/PDF-friendly path data.
 * `radius` is clamped to half the shorter side, which is what both PDF and SVG
 * renderers do, so the editor and the exporter agree.
 */
export function clampRadius(r: Rect, radius: Upt): Upt {
  return Math.max(0, Math.min(radius, Math.floor(Math.min(r.w, r.h) / 2)));
}

/** Kappa for approximating a quarter circle with a cubic Bézier. */
export const KAPPA = 0.5522847498307936;

export type BezierSeg =
  | { t: "M"; x: number; y: number }
  | { t: "L"; x: number; y: number }
  | { t: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { t: "Z" };

/**
 * Rounded-rect outline as an ordered segment list in card space (y down).
 * Shared by the on-screen artboard, the proof PDF overlay and the production
 * clipping path, so the trim corners are guaranteed identical everywhere.
 */
export function roundedRectPath(r: Rect, radiusUpt: Upt): BezierSeg[] {
  const rad = clampRadius(r, radiusUpt);
  const x0 = r.x;
  const y0 = r.y;
  const x1 = rectRight(r);
  const y1 = rectBottom(r);
  if (rad <= 0) {
    return [
      { t: "M", x: x0, y: y0 },
      { t: "L", x: x1, y: y0 },
      { t: "L", x: x1, y: y1 },
      { t: "L", x: x0, y: y1 },
      { t: "Z" },
    ];
  }
  const k = rad * KAPPA;
  return [
    { t: "M", x: x0 + rad, y: y0 },
    { t: "L", x: x1 - rad, y: y0 },
    { t: "C", x1: x1 - rad + k, y1: y0, x2: x1, y2: y0 + rad - k, x: x1, y: y0 + rad },
    { t: "L", x: x1, y: y1 - rad },
    { t: "C", x1: x1, y1: y1 - rad + k, x2: x1 - rad + k, y2: y1, x: x1 - rad, y: y1 },
    { t: "L", x: x0 + rad, y: y1 },
    { t: "C", x1: x0 + rad - k, y1: y1, x2: x0, y2: y1 - rad + k, x: x0, y: y1 - rad },
    { t: "L", x: x0, y: y0 + rad },
    { t: "C", x1: x0, y1: y0 + rad - k, x2: x0 + rad - k, y2: y0, x: x0 + rad, y: y0 },
    { t: "Z" },
  ];
}

/** Serialise segments to an SVG `d` attribute, scaling µpt → target units. */
export function segsToSvgPath(segs: BezierSeg[], scale = 1, precision = 4): string {
  const f = (n: number) => Number((n * scale).toFixed(precision)).toString();
  return segs
    .map((s) => {
      switch (s.t) {
        case "M":
          return `M${f(s.x)},${f(s.y)}`;
        case "L":
          return `L${f(s.x)},${f(s.y)}`;
        case "C":
          return `C${f(s.x1)},${f(s.y1)} ${f(s.x2)},${f(s.y2)} ${f(s.x)},${f(s.y)}`;
        case "Z":
          return "Z";
      }
    })
    .join(" ");
}

/**
 * Is `inner` fully inside the rounded rectangle `outer`/`radius`?
 * Straight-edge containment plus a per-corner circle test — this is what makes
 * "text is inside the safe area" correct on a card with 0.25 in trim corners.
 */
export function roundedRectContains(outer: Rect, radiusUpt: Upt, inner: Rect): boolean {
  if (!rectContains(outer, inner)) return false;
  const rad = clampRadius(outer, radiusUpt);
  if (rad <= 0) return true;
  const ox1 = rectRight(outer);
  const oy1 = rectBottom(outer);
  const ix1 = rectRight(inner);
  const iy1 = rectBottom(inner);
  // [corner-centre x, corner-centre y, probe x, probe y, xSign, ySign]
  // xSign/ySign point *away* from the rect interior; the arc only governs the
  // quadrant on that side of the corner centre.
  const corners: Array<[number, number, number, number, -1 | 1, -1 | 1]> = [
    [outer.x + rad, outer.y + rad, inner.x, inner.y, -1, -1],
    [ox1 - rad, outer.y + rad, ix1, inner.y, 1, -1],
    [ox1 - rad, oy1 - rad, ix1, iy1, 1, 1],
    [outer.x + rad, oy1 - rad, inner.x, iy1, -1, 1],
  ];
  for (const [cx, cy, px, py, sx, sy] of corners) {
    const dx = px - cx;
    const dy = py - cy;
    const inQuadrant = dx * sx > 0 && dy * sy > 0;
    if (inQuadrant && dx * dx + dy * dy > rad * rad) return false;
  }
  return true;
}
