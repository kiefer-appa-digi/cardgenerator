import { formatLength, uptToIn, type Upt } from "@/lib/units";
import {
  rectBottom,
  rectCenter,
  rectIntersection,
  rectRight,
  rectUnion,
  rotatePoint,
  type Point,
  type Rect,
} from "@/lib/geometry/types";
import {
  TINT_MAX,
  toCmyk,
  type BlackRules,
  type OutputIntent,
  type PrintColor,
} from "@/lib/color/types";
import {
  defaultElementName,
  type CardSide,
  type DesignDoc,
  type DesignElement,
  type SideKey,
} from "@/lib/design/schema";
import type { DrawOp, ElementDiagnostics, SidePlan } from "@/lib/design/render";
import type { AssetInfo } from "@/lib/design/plan";
import type { ProductContext } from "@/lib/data/context";
import type {
  CheckCode,
  PreflightFinding,
  PreflightProfile,
  Severity,
} from "../types";

/**
 * SHARED CHECK CONTEXT — spec §21.
 *
 * The preflight engine never re-lays-out anything and never re-decides what a
 * card says. It reads the SidePlan the renderer and the PDF writer both consume,
 * pairs each op with the element it came from, and measures. That is the only
 * way a finding can be trusted: it is measured on the same geometry that will be
 * imaged, not on a second interpretation of the design.
 *
 * Everything in this file is measurement and vocabulary. The judgements live in
 * the per-area check modules next to it.
 */

export type PreflightContext = {
  doc: DesignDoc;
  side: SideKey;
  plan: SidePlan;
  cardSide: CardSide;
  product: ProductContext;
  profile: PreflightProfile;
  blackRules: BlackRules;
  outputIntent: OutputIntent;
  assets: Map<string, AssetInfo>;
  /** Source elements by id: severity often depends on `required`/`templateLocked`. */
  elements: Map<string, DesignElement>;
  /** Plan diagnostics by element id. */
  diagnostics: Map<string, ElementDiagnostics>;
  /** Every op an element produced, in paint order. */
  opsByElement: Map<string, DrawOp[]>;
  /** Display names, resolved once so every finding says the same thing. */
  labels: Map<string, string>;
};

export function buildContext(args: {
  doc: DesignDoc;
  side: SideKey;
  plan: SidePlan;
  product: ProductContext;
  profile: PreflightProfile;
  blackRules: BlackRules;
  outputIntent: OutputIntent;
  assets: Map<string, AssetInfo>;
}): PreflightContext {
  const cardSide = args.doc[args.side];
  const elements = new Map<string, DesignElement>();
  const labels = new Map<string, string>();
  for (const el of cardSide.elements) {
    elements.set(el.id, el);
    labels.set(el.id, defaultElementName(el));
  }
  const diagnostics = new Map<string, ElementDiagnostics>();
  for (const d of args.plan.diagnostics) {
    diagnostics.set(d.elementId, d);
    if (!labels.has(d.elementId)) labels.set(d.elementId, d.elementName);
  }
  const opsByElement = new Map<string, DrawOp[]>();
  for (const op of args.plan.ops) {
    const list = opsByElement.get(op.elementId);
    if (list) list.push(op);
    else opsByElement.set(op.elementId, [op]);
  }
  return { ...args, cardSide, elements, diagnostics, opsByElement, labels };
}

/* ---------------------------------------------------------------- findings */

export type FindingInit = {
  code: CheckCode;
  severity: Severity;
  title: string;
  /** Must contain the measured numbers. A finding without them is not actionable. */
  detail: string;
  /** Must say what to DO. Never "contact support". */
  remedy: string;
  side?: SideKey;
  elementId?: string;
  elementName?: string;
  rect?: Rect;
  measurements?: Record<string, string | number>;
};

/**
 * The report schema makes `remedy` and `measurements` optional because it is
 * also the shape of a report read back from the database. Nothing produced here
 * is allowed to omit the remedy, so this builder demands it.
 */
export function finding(init: FindingInit): PreflightFinding {
  return init;
}

/** Side, element identity and the highlight rect, in one spread. */
export function at(
  ctx: PreflightContext,
  elementId: string,
  rect?: Rect,
): Pick<FindingInit, "side" | "elementId" | "elementName" | "rect"> {
  return {
    side: ctx.side,
    elementId,
    elementName: ctx.labels.get(elementId) ?? elementId,
    rect,
  };
}

/* -------------------------------------------------------------- vocabulary */

/** Inches to four decimals with the unit, e.g. "0.1875 in". */
export function inches(u: Upt): string {
  return `${formatLength(u, "in")} in`;
}

/** Inches as a number, for `measurements`. */
export function inNum(u: Upt): number {
  return Number(uptToIn(u).toFixed(4));
}

/** Points as a number, for type sizes in `measurements`. */
export function ptNum(u: Upt): number {
  return Number((u / 1_000_000).toFixed(2));
}

/** A tint (tenths of a percent) as a percentage string. */
export function pct(tenths: number): string {
  return `${(tenths / 10).toFixed(1)} %`;
}

/** Basis points as a percentage string, e.g. 8_000 -> "80.0 %". */
export function bpsPct(bps: number): string {
  return `${(bps / 100).toFixed(1)} %`;
}

/** "front" / "back" for a sentence. */
export function sideWord(side: SideKey): string {
  return side === "front" ? "front" : "back";
}

/* ---------------------------------------------------------------- geometry */

/**
 * `rect` in card space after the op's rotation about its frame centre.
 *
 * Rotation pivots on the element frame, not on the rect being tested, so a
 * rotated text block's ink bounds land where they are actually imaged. An
 * unrotated op returns its rect untouched, which keeps every containment test
 * exact integer arithmetic in the common case.
 */
export function rotatedTo(rect: Rect, op: DrawOp): Rect {
  const norm = ((op.rotation % 360_000) + 360_000) % 360_000;
  if (norm === 0) return rect;
  const pivot: Point = rectCenter(op.frame);
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rectRight(rect), y: rect.y },
    { x: rectRight(rect), y: rectBottom(rect) },
    { x: rect.x, y: rectBottom(rect) },
  ].map((p) => rotatePoint(p, pivot, op.rotation));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Half a stroke sits outside the path, so a stroked shape paints wider than its frame. */
function outsetByStroke(r: Rect, strokeWidth: Upt): Rect {
  if (strokeWidth <= 0) return r;
  const half = Math.round(strokeWidth / 2);
  return { x: r.x - half, y: r.y - half, w: r.w + strokeWidth, h: r.h + strokeWidth };
}

/**
 * Everything the op puts ink on, in card space, rotation applied.
 * A text box counts its background fill; a barcode counts its quiet zones,
 * because a quiet zone is part of the symbol as far as the page is concerned.
 */
export function opPaintBounds(op: DrawOp): Rect {
  switch (op.op) {
    case "path":
      return rotatedTo(outsetByStroke(op.frame, op.stroke.space === "none" ? 0 : op.strokeWidth), op);
    case "ellipse":
      return rotatedTo(outsetByStroke(op.rect, op.stroke.space === "none" ? 0 : op.strokeWidth), op);
    case "line": {
      const x = Math.min(op.x1, op.x2);
      const y = Math.min(op.y1, op.y2);
      const r: Rect = { x, y, w: Math.abs(op.x2 - op.x1), h: Math.abs(op.y2 - op.y1) };
      return rotatedTo(outsetByStroke(r, op.strokeWidth), op);
    }
    case "text": {
      const ink = textInkRect(op);
      return rotatedTo(op.fill.space === "none" ? ink : rectUnion(op.frame, ink), op);
    }
    case "image": {
      const painted = rectIntersection(op.dest, op.clip);
      return rotatedTo(painted ?? op.clip, op);
    }
    case "barcode":
      return rotatedTo(op.quietBox, op);
  }
}

/** The glyph ink of a text op, unrotated. Empty text collapses onto its origin. */
export function textInkRect(op: DrawOp): Rect {
  if (op.op !== "text") return op.frame;
  return op.spans.length === 0 ? { x: op.frame.x, y: op.frame.y, w: 0, h: 0 } : op.inkBounds;
}

/** True when the op puts something on the plate. */
export function opPaintsInk(op: DrawOp): boolean {
  if (op.opacity <= 0) return false;
  switch (op.op) {
    case "path":
    case "ellipse":
      return op.fill.space !== "none" || (op.stroke.space !== "none" && op.strokeWidth > 0);
    case "line":
      return op.stroke.space !== "none" && op.strokeWidth > 0;
    case "text":
      // Spans carry their own colour, so counting spans alone said "this side
      // has content" about a block set in `none` — which images as a blank
      // plate. A run has to have somewhere to put ink before it counts.
      return op.spans.some((s) => s.color.space !== "none") || op.fill.space !== "none";
    case "image":
      return op.assetId !== null && !op.missing;
    case "barcode":
      return op.render !== null;
  }
}

/* ------------------------------------------------------------------ colour */

export type ColorUse = {
  color: PrintColor;
  /** Where the colour is used, named for the finding's detail sentence. */
  role: string;
  /** Type size, for the small-rich-black rule. Null for non-text ink. */
  fontSize: Upt | null;
};

/**
 * Every printing colour an op carries. Raster ink is deliberately absent: the
 * ink values inside a placed image are not knowable from its metadata, and
 * guessing them would be exactly the kind of invented number §32 forbids. The
 * asset colour-space check speaks for images instead.
 */
export function opColors(op: DrawOp): ColorUse[] {
  switch (op.op) {
    case "path":
    case "ellipse":
      return [
        { color: op.fill, role: "fill", fontSize: null },
        { color: op.stroke, role: "stroke", fontSize: null },
      ].filter((u) => u.color.space !== "none");
    case "line":
      return op.stroke.space === "none" ? [] : [{ color: op.stroke, role: "stroke", fontSize: null }];
    case "text": {
      const out: ColorUse[] = [];
      if (op.fill.space !== "none") out.push({ color: op.fill, role: "text box fill", fontSize: null });
      for (const s of op.spans) {
        out.push({ color: s.color, role: "text", fontSize: s.fontSize });
      }
      return out;
    }
    case "image":
      return [];
    case "barcode": {
      const out: ColorUse[] = [{ color: op.barColor, role: "bars", fontSize: null }];
      if (op.quietZoneFill.space !== "none") {
        out.push({ color: op.quietZoneFill, role: "quiet-zone fill", fontSize: null });
      }
      return out;
    }
  }
}

/**
 * Reflectance in the red band, in tenths of a percent, from the ink recipe.
 *
 * Cyan and black absorb at the ~660 nm a laser scanner reads; magenta and yellow
 * are close to transparent there, which is why a yellow bar on white does not
 * scan and a cyan one does. This is an INK-VALUE PROXY, not a measurement: a
 * real print contrast signal comes from a verifier reading printed stock, and
 * every finding computed from it says so.
 */
export function redBandReflectance(color: PrintColor): number {
  const k = toCmyk(color);
  if (!k) return TINT_MAX; // `none` leaves the substrate showing.
  return Math.round(((TINT_MAX - k.c) * (TINT_MAX - k.k)) / TINT_MAX);
}

/** The darkest printing colour an op carries, or null when it cannot be measured. */
export function opDarkestColor(op: DrawOp): PrintColor | null {
  const uses = opColors(op);
  if (uses.length === 0) return null;
  let best = uses[0].color;
  let bestReflectance = redBandReflectance(best);
  for (const u of uses.slice(1)) {
    const r = redBandReflectance(u.color);
    if (r < bestReflectance) {
      best = u.color;
      bestReflectance = r;
    }
  }
  return best;
}

export function describeColor(color: PrintColor): string {
  const k = toCmyk(color);
  if (!k) return "no fill";
  if (color.space === "spot") return `${color.name} (alternate C${k.c / 10} M${k.m / 10} Y${k.y / 10} K${k.k / 10})`;
  if (color.space === "gray") return `${pct(color.k)} gray`;
  return `C ${pct(k.c)} M ${pct(k.m)} Y ${pct(k.y)} K ${pct(k.k)}`;
}
