import { uptToIn } from "@/lib/units";
import {
  rectBottom,
  rectContains,
  rectEquals,
  rectIntersection,
  rectIntersects,
  rectRight,
  roundedRectContains,
  type Rect,
} from "@/lib/geometry/types";
import { CARD_PRESETS, bleedRect } from "@/lib/geometry/presets";
import { defaultElementName } from "@/lib/design/schema";
import type { DrawOp } from "@/lib/design/render";
import type { PreflightFinding } from "../types";
import {
  at,
  finding,
  inNum,
  inches,
  opPaintBounds,
  opPaintsInk,
  sideWord,
  textInkRect,
  rotatedTo,
  type PreflightContext,
} from "./context";

/**
 * GEOMETRY CHECKS — spec §16, §17, §21.
 *
 * The page, the bleed, the trim line, the safe area and the clamshell cavity.
 * Every test here is run against the SidePlan's own geometry, so it measures the
 * artwork that will be imaged rather than the design's intent.
 */

/* --------------------------------------------------------- doc dimensions */

/**
 * The plan's page must be the preset's full-bleed canvas exactly. There is no
 * tolerance to spend: µpt geometry is integer, so a mismatch here means the
 * plan was built against a different preset or a stale document, and the press
 * would receive a plate of the wrong size.
 */
export function checkDocDimensions(ctx: PreflightContext): PreflightFinding[] {
  const preset = CARD_PRESETS[ctx.doc.presetCode];
  const expected = bleedRect(preset);
  const actual = ctx.plan.canvas;
  if (rectEquals(expected, actual)) return [];
  return [
    finding({
      code: "DOC_DIMENSIONS",
      severity: "blocking",
      title: `The ${sideWord(ctx.side)} page is not the ${preset.code} full-bleed size`,
      detail:
        `The plan's canvas is ${inches(actual.w)} × ${inches(actual.h)} with its origin at ` +
        `(${inches(actual.x)}, ${inches(actual.y)}), but ${preset.code} is ${inches(expected.w)} × ` +
        `${inches(expected.h)} with its origin at (0 in, 0 in) — trim ${inches(preset.trimWidth)} × ` +
        `${inches(preset.trimHeight)} plus ${inches(preset.bleed.left)} of bleed on every side.`,
      remedy:
        `Re-plan this side against the ${preset.code} preset. If the document was authored at a ` +
        `different size, change the preset on the design rather than resizing the page, so trim, ` +
        `safe area and cavity move with it.`,
      side: ctx.side,
      rect: actual,
      measurements: {
        actualWidthIn: inNum(actual.w),
        actualHeightIn: inNum(actual.h),
        expectedWidthIn: inNum(expected.w),
        expectedHeightIn: inNum(expected.h),
        preset: preset.code,
      },
    }),
  ];
}

/* ------------------------------------------------------------- empty side */

/**
 * A side with nothing on it prints as a blank plate. A blank front is always a
 * defect; a blank back is a legitimate one-sided card, so it is reported at a
 * lower grade rather than being hidden.
 */
export function checkEmptySide(ctx: PreflightContext): PreflightFinding[] {
  const inked = ctx.plan.ops.filter(opPaintsInk);
  if (inked.length > 0) return [];
  const hidden = ctx.plan.diagnostics.filter((d) => !d.visible).length;
  return [
    finding({
      code: "DOC_EMPTY_SIDE",
      severity: ctx.side === "front" ? "error" : "warning",
      title: `The ${sideWord(ctx.side)} has no printing content`,
      detail:
        `${ctx.plan.ops.length} draw operation(s) resolved on the ${sideWord(ctx.side)} and none of ` +
        `them puts ink on the page; ${hidden} element(s) resolved as hidden for this product. The ` +
        `${sideWord(ctx.side)} would image as a blank ${inches(ctx.plan.canvas.w)} × ` +
        `${inches(ctx.plan.canvas.h)} plate.`,
      remedy:
        ctx.side === "front"
          ? "Add the front artwork, or select a different design revision. If this side is meant to be blank, remove it from the run rather than exporting an empty plate."
          : "Confirm the card is intended to print one-sided. If it is, tell the press so the second plate is not made; if it is not, add the back artwork.",
      side: ctx.side,
      rect: ctx.plan.canvas,
      measurements: { ops: ctx.plan.ops.length, hiddenElements: hidden },
    }),
  ];
}

/* --------------------------------------------------------- bleed coverage */

function coverageBps(covered: Rect | null, canvas: Rect): number {
  if (!covered) return 0;
  const area = uptToIn(covered.w) * uptToIn(covered.h);
  const total = uptToIn(canvas.w) * uptToIn(canvas.h);
  return total <= 0 ? 10_000 : Math.round((area / total) * 10_000);
}

function shortfall(covered: Rect | null, canvas: Rect) {
  if (!covered) {
    return { left: canvas.w, top: canvas.h, right: canvas.w, bottom: canvas.h };
  }
  return {
    left: Math.max(0, covered.x - canvas.x),
    top: Math.max(0, covered.y - canvas.y),
    right: Math.max(0, rectRight(canvas) - rectRight(covered)),
    bottom: Math.max(0, rectBottom(canvas) - rectBottom(covered)),
  };
}

function describeShortfall(s: ReturnType<typeof shortfall>): string {
  const parts: string[] = [];
  if (s.left > 0) parts.push(`${inches(s.left)} at the left`);
  if (s.top > 0) parts.push(`${inches(s.top)} at the top`);
  if (s.right > 0) parts.push(`${inches(s.right)} at the right`);
  if (s.bottom > 0) parts.push(`${inches(s.bottom)} at the bottom`);
  return parts.join(", ");
}

/**
 * Background art has to run past the trim line to the edge of the bleed box.
 *
 * The failure this catches is the expensive one: a background drawn exactly to
 * trim looks perfect on screen and produces a white sliver on every card as soon
 * as the guillotine wanders by a few thousandths of an inch. It is an error, not
 * a warning, because the press cannot fix it and the cards cannot be sold.
 *
 * Two things are treated as background: an image element flagged `isBackground`,
 * and any filled shape that covers the whole trim box — a colour block sized to
 * trim is a background whether or not anybody ticked the box.
 */
export function checkBleedCoverage(ctx: PreflightContext): PreflightFinding[] {
  const out: PreflightFinding[] = [];
  const canvas = ctx.plan.canvas;
  const trim = ctx.plan.trim;

  for (const op of ctx.plan.ops) {
    if (!opPaintsInk(op)) continue;

    let isBackground = false;
    if (op.op === "image") isBackground = op.isBackground;
    else if (op.op === "path" || op.op === "ellipse") {
      isBackground = op.fill.space !== "none" && rectContains(opPaintBounds(op), trim);
    }
    if (!isBackground) continue;

    const painted = opPaintBounds(op);
    if (rectContains(painted, canvas)) continue;

    const covered = rectIntersection(painted, canvas);
    const bps = coverageBps(covered, canvas);
    if (bps >= ctx.profile.bleedCoverageBps) continue;

    const gaps = shortfall(covered, canvas);
    const stopsAtTrim = covered !== null && rectEquals(covered, trim);
    out.push(
      finding({
        code: "BLEED_COVERAGE",
        severity: "error",
        title: stopsAtTrim
          ? "Background stops exactly at the trim line"
          : "Background does not reach the edge of the bleed",
        detail:
          `The background covers ${(bps / 100).toFixed(1)} % of the ${inches(canvas.w)} × ` +
          `${inches(canvas.h)} bleed box and falls short by ${describeShortfall(gaps)}. ` +
          (stopsAtTrim
            ? "It ends on the trim line, so any movement of the knife leaves an unprinted white edge on the finished card."
            : "The uncovered strip trims as bare stock.") +
          ` The profile requires ${(ctx.profile.bleedCoverageBps / 100).toFixed(1)} % coverage.`,
        remedy:
          `Extend this element to ${inches(canvas.w)} × ${inches(canvas.h)} at (0 in, 0 in) — that is ` +
          `${inches(ctx.plan.trim.x)} past trim on every side. Scale the artwork rather than stretching ` +
          `it, so nothing near the trim line changes proportion.`,
        ...at(ctx, op.elementId, painted),
        measurements: {
          coverageBps: bps,
          requiredBps: ctx.profile.bleedCoverageBps,
          shortLeftIn: inNum(gaps.left),
          shortTopIn: inNum(gaps.top),
          shortRightIn: inNum(gaps.right),
          shortBottomIn: inNum(gaps.bottom),
        },
      }),
    );
  }
  return out;
}

/* --------------------------------------------------------- trim crossing */

/** Art that deliberately runs off the card: a background, or anything covering trim. */
function isIntentionalBleed(op: DrawOp, trim: Rect, canvas: Rect): boolean {
  if (op.op === "image" && op.isBackground) return true;
  const painted = opPaintBounds(op);
  return rectContains(painted, trim) || rectContains(painted, canvas);
}

/**
 * An element that straddles the trim line is cut in half by the guillotine.
 * That is fine when it is meant to bleed off the card and a mistake otherwise,
 * and nothing in the document distinguishes the two, so this is a warning that
 * names the overhang and asks for a decision.
 */
export function checkTrimCrossing(ctx: PreflightContext): PreflightFinding[] {
  const out: PreflightFinding[] = [];
  const { trim, canvas } = ctx.plan;

  for (const op of ctx.plan.ops) {
    if (!opPaintsInk(op)) continue;
    if (isIntentionalBleed(op, trim, canvas)) continue;
    const painted = opPaintBounds(op);
    if (rectContains(trim, painted)) continue;
    if (!rectIntersects(painted, trim)) continue; // Entirely in the bleed margin: the safe-area check owns it.

    const gaps = {
      left: Math.max(0, trim.x - painted.x),
      top: Math.max(0, trim.y - painted.y),
      right: Math.max(0, rectRight(painted) - rectRight(trim)),
      bottom: Math.max(0, rectBottom(painted) - rectBottom(trim)),
    };
    const worst = Math.max(gaps.left, gaps.top, gaps.right, gaps.bottom);
    out.push(
      finding({
        code: "TRIM_CROSSING",
        severity: "warning",
        title: "Element crosses the trim line without bleeding off the card",
        detail:
          `This element extends past trim by ${describeShortfall(gaps)} (worst edge ${inches(worst)}) ` +
          `but stops short of the bleed edge, so the knife cuts through it and the cut edge is where ` +
          `the artwork happens to end rather than where it was drawn to end.`,
        remedy:
          `Either pull the element back inside the trim box (${inches(trim.w)} × ${inches(trim.h)} at ` +
          `${inches(trim.x)}, ${inches(trim.y)}), or push it out to the full bleed edge so the cut lands ` +
          `in artwork that was meant to be cut.`,
        ...at(ctx, op.elementId, painted),
        measurements: {
          overLeftIn: inNum(gaps.left),
          overTopIn: inNum(gaps.top),
          overRightIn: inNum(gaps.right),
          overBottomIn: inNum(gaps.bottom),
        },
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------- safe area */

function safeOverhang(bounds: Rect, safe: Rect) {
  return {
    left: Math.max(0, safe.x - bounds.x),
    top: Math.max(0, safe.y - bounds.y),
    right: Math.max(0, rectRight(bounds) - rectRight(safe)),
    bottom: Math.max(0, rectBottom(bounds) - rectBottom(safe)),
  };
}

/**
 * Is this box inside the live area of the card?
 *
 * The safe area is the trim shape inset on all four sides, so its own corner
 * radius is the trim radius less that inset — see safeCornerRadius() in
 * lib/geometry/presets.ts. Testing with the trim radius instead would reject a
 * box that is comfortably on the card.
 */
function insideSafe(ctx: PreflightContext, bounds: Rect): boolean {
  return roundedRectContains(ctx.plan.safe, ctx.plan.safeCornerRadius, bounds);
}

function cornerCase(ctx: PreflightContext, bounds: Rect): boolean {
  // Inside every straight edge, but a corner of the box pokes past the safe
  // area's own arc.
  return rectContains(ctx.plan.safe, bounds) && !insideSafe(ctx, bounds);
}

/**
 * How far past the trim line does the box actually go?
 *
 * A corner-only overrun is a different animal from crossing an edge. The box is
 * still inside the card — it is only closer to the cut than the safe inset asks
 * for, by a fraction of that inset, and that happens to ANY element laid out to
 * the full safe width because the corners of its bounding box are the extreme
 * points. Grading that as an error would flag every reasonable layout, so it is
 * reported as a warning with the measured shortfall, and only content that
 * genuinely crosses the trim is an error.
 */
function crossesTrim(ctx: PreflightContext, bounds: Rect): boolean {
  return !roundedRectContains(ctx.plan.trim, ctx.plan.cornerRadius, bounds);
}

/** Shortfall at the worst corner, in µpt: how much closer to the cut than asked. */
function cornerShortfall(ctx: PreflightContext, bounds: Rect): number {
  const safe = ctx.plan.safe;
  const r = ctx.plan.safeCornerRadius;
  if (r <= 0) return 0;
  const x1 = safe.x + safe.w;
  const y1 = safe.y + safe.h;
  const bx1 = bounds.x + bounds.w;
  const by1 = bounds.y + bounds.h;
  const corners: Array<[number, number, number, number, -1 | 1, -1 | 1]> = [
    [safe.x + r, safe.y + r, bounds.x, bounds.y, -1, -1],
    [x1 - r, safe.y + r, bx1, bounds.y, 1, -1],
    [x1 - r, y1 - r, bx1, by1, 1, 1],
    [safe.x + r, y1 - r, bounds.x, by1, -1, 1],
  ];
  let worst = 0;
  for (const [cx, cy, px, py, sx, sy] of corners) {
    const dx = px - cx;
    const dy = py - cy;
    if (dx * sx <= 0 || dy * sy <= 0) continue;
    const d = Math.hypot(dx, dy);
    if (d > r) worst = Math.max(worst, Math.round(d - r));
  }
  return worst;
}

export function checkSafeArea(ctx: PreflightContext): PreflightFinding[] {
  const out: PreflightFinding[] = [];
  const safe = ctx.plan.safe;

  for (const op of ctx.plan.ops) {
    if (!opPaintsInk(op)) continue;

    const el = ctx.elements.get(op.elementId);
    const required = el?.required ?? false;
    const templateLocked = el?.templateLocked ?? false;

    if (op.op === "text") {
      const bounds = rotatedTo(textInkRect(op), op);
      if (bounds.w === 0 && bounds.h === 0) continue;
      if (insideSafe(ctx, bounds)) continue;
      const gaps = safeOverhang(bounds, safe);
      out.push(
        finding({
          code: "SAFE_AREA_TEXT",
          severity: cornerCase(ctx, bounds) && !crossesTrim(ctx, bounds) ? "warning" : "error",
          title: cornerCase(ctx, bounds)
            ? crossesTrim(ctx, bounds)
              ? "Text runs off the rounded corner of the card"
              : "Text sits closer to the cut than the safe margin allows"
            : "Text is outside the safe area",
          detail: cornerCase(ctx, bounds)
            ? `The type is inside the safe rectangle on every edge, but a corner of its ink bounds ` +
              `passes the safe area's own ${inches(ctx.plan.safeCornerRadius)} corner radius by ` +
              `${inches(cornerShortfall(ctx, bounds))}` +
              (crossesTrim(ctx, bounds)
                ? ` and reaches past the ${inches(ctx.plan.cornerRadius)} trim corner, so part of the ` +
                  `line falls where the card has no material.`
                : `. It is still on the card — the ${inches(ctx.plan.cornerRadius)} trim corner is ` +
                  `clear — but the margin to the cut is smaller there than the ` +
                  `${inches(safe.x - ctx.plan.trim.x)} this preset asks for.`) +
              ` Ink bounds ${inches(bounds.w)} × ${inches(bounds.h)} at ` +
              `(${inches(bounds.x)}, ${inches(bounds.y)}).`
            : `The type reaches past the safe area by ${describeShortfall(gaps)}. The safe area is ` +
              `${inches(safe.w)} × ${inches(safe.h)}, inset ${inches(safe.x - ctx.plan.trim.x)} from trim.`,
          remedy:
            `Move or re-wrap the text so its ink bounds sit inside ${inches(safe.w)} × ${inches(safe.h)} ` +
            `at (${inches(safe.x)}, ${inches(safe.y)}), clear of the ${inches(ctx.plan.safeCornerRadius)} ` +
            `corners. Shrinking the frame with auto-fit off will re-wrap rather than clip.`,
          ...at(ctx, op.elementId, bounds),
          measurements: {
            overLeftIn: inNum(gaps.left),
            overTopIn: inNum(gaps.top),
            overRightIn: inNum(gaps.right),
            overBottomIn: inNum(gaps.bottom),
            cornerRadiusIn: inNum(ctx.plan.cornerRadius),
            safeCornerRadiusIn: inNum(ctx.plan.safeCornerRadius),
          },
        }),
      );
      continue;
    }

    if (op.op === "barcode") {
      const bounds = rotatedTo(op.quietBox, op);
      if (insideSafe(ctx, bounds)) continue;
      const gaps = safeOverhang(bounds, safe);
      out.push(
        finding({
          code: "SAFE_AREA_BARCODE",
          // A barcode is the one thing that stays an error either way: a symbol
          // that loses part of a quiet zone to the cut stops scanning.
          severity: "error",
          title: "Barcode is outside the safe area",
          detail:
            `The symbol including its quiet zones measures ${inches(bounds.w)} × ${inches(bounds.h)} and ` +
            `reaches past the safe area by ${describeShortfall(gaps)}` +
            (cornerCase(ctx, bounds) ? `, crossing the ${inches(ctx.plan.safeCornerRadius)} safe-area corner radius` : "") +
            `. Trimming into a quiet zone is the most common cause of a symbol that will not scan.`,
          remedy:
            `Move the symbol so the whole quiet-zone box sits inside ${inches(safe.w)} × ${inches(safe.h)} ` +
            `at (${inches(safe.x)}, ${inches(safe.y)}). Reduce magnification only if moving it is not ` +
            `enough — the quiet zone scales with the symbol.`,
          ...at(ctx, op.elementId, bounds),
          measurements: {
            overLeftIn: inNum(gaps.left),
            overTopIn: inNum(gaps.top),
            overRightIn: inNum(gaps.right),
            overBottomIn: inNum(gaps.bottom),
          },
        }),
      );
      continue;
    }

    // Images and shapes. Art that bleeds off the card is meant to leave the safe
    // area, so only content that stops inside the card is judged, and the grade
    // follows how load-bearing the element is: decoration near the edge is a
    // designer's choice, a required or template-locked element near the edge is
    // brand-critical content at risk of being cut.
    const bounds = opPaintBounds(op);
    if (insideSafe(ctx, bounds)) continue;
    if (isIntentionalBleed(op, ctx.plan.trim, ctx.plan.canvas)) continue;
    const gaps = safeOverhang(bounds, safe);
    out.push(
      finding({
        code: "SAFE_AREA_ELEMENT",
        severity: required ? "error" : templateLocked ? "warning" : "info",
        title: required
          ? "Required element is outside the safe area"
          : "Element extends past the safe area",
        detail:
          `The element reaches past the safe area by ${describeShortfall(gaps)}` +
          (cornerCase(ctx, bounds) ? ` and crosses the ${inches(ctx.plan.safeCornerRadius)} safe-area corner radius` : "") +
          `. It stops inside the card rather than bleeding off it, so the trim tolerance of ` +
          `${inches(safe.x - ctx.plan.trim.x)} is what stands between it and the cut edge.`,
        remedy: required
          ? `Move this element inside ${inches(safe.w)} × ${inches(safe.h)} at (${inches(safe.x)}, ${inches(safe.y)}); it is marked required, so it must survive the trim on every card in the run.`
          : `Confirm the overhang is intended. If it is decorative, extend it to the bleed edge so the cut lands in artwork; if it matters, move it inside the safe area.`,
        ...at(ctx, op.elementId, bounds),
        measurements: {
          overLeftIn: inNum(gaps.left),
          overTopIn: inNum(gaps.top),
          overRightIn: inNum(gaps.right),
          overBottomIn: inNum(gaps.bottom),
          required: required ? 1 : 0,
        },
      }),
    );
  }
  return out;
}

/* --------------------------------------------------------------- cavity */

/**
 * Clamshell cavity awareness.
 *
 * What is actually true on a thermoformed clamshell: the card sits between two
 * clear PVC halves and the cavity is a pocket formed into the front half. The
 * plastic is transparent, so the card IS seen through it — on a 409TF the
 * cavity covers 87 % of the card, and treating all of that as hidden would
 * condemn every real design. What the pocket does is (a) hold the part, which
 * physically covers whatever is directly behind it, and (b) put a formed,
 * curved plastic wall between the eye and the card.
 *
 * So the graded defect is narrow and specific: a BARCODE on the front under the
 * cavity cannot be scanned, because a scanner needs a flat, unobstructed window
 * and there is a metal part in the way. Everything else is context: one
 * informational note per side listing the elements the part may sit over, so a
 * designer can judge it, rather than seventeen errors that train people to
 * ignore the panel.
 *
 * The back half of a clamshell is flat, so nothing on the back is reported.
 *
 * The cavity rect is used as a rectangle, not as a rounded shape: the corner
 * radii in the presets are recovered from a raster edge profile and are marked
 * approximate, so widening the test with them would be false precision.
 */
export function checkCavityConflict(ctx: PreflightContext): PreflightFinding[] {
  if (ctx.side !== "front") return [];

  const out: PreflightFinding[] = [];
  const cavity = ctx.plan.cavity;
  const covered: Array<{ name: string; pct: number }> = [];

  for (const op of ctx.plan.ops) {
    if (!opPaintsInk(op)) continue;
    const bounds = op.op === "text" ? rotatedTo(textInkRect(op), op) : opPaintBounds(op);
    if (bounds.w === 0 && bounds.h === 0) continue;
    const overlap = rectIntersection(bounds, cavity);
    if (!overlap) continue;

    const areaPct = Math.round(
      ((uptToIn(overlap.w) * uptToIn(overlap.h)) /
        Math.max(1e-9, uptToIn(bounds.w) * uptToIn(bounds.h))) *
        100,
    );

    if (op.op === "barcode") {
      out.push(
        finding({
          code: "CAVITY_CONFLICT",
          severity: "error",
          title: "Barcode sits under the clamshell cavity",
          detail:
            `${areaPct} % of the symbol falls inside the ${inches(cavity.w)} × ${inches(cavity.h)} ` +
            `cavity footprint at (${inches(cavity.x)}, ${inches(cavity.y)}). A scanner needs a flat, ` +
            `unobstructed window; here it would be reading through a formed plastic pocket with the ` +
            `part inside it. Cavity geometry provenance: ` +
            `${CARD_PRESETS[ctx.doc.presetCode].cavity.provenance}.`,
          remedy:
            `Move the symbol into a flange band — clear of the cavity, above ${inches(cavity.y)} or ` +
            `below ${inches(rectBottom(cavity))} in page coordinates — or put it on the back of the card, ` +
            `which is the usual place for it.`,
          ...at(ctx, op.elementId, overlap),
          measurements: {
            overlapPct: areaPct,
            cavityXIn: inNum(cavity.x),
            cavityYIn: inNum(cavity.y),
            cavityWIn: inNum(cavity.w),
            cavityHIn: inNum(cavity.h),
          },
        }),
      );
      continue;
    }

    // Only worth mentioning when the part could actually sit over most of it.
    if (areaPct >= 60) {
      const el = ctx.elements.get(op.elementId);
      covered.push({ name: el ? defaultElementName(el) : op.elementId, pct: areaPct });
    }
  }

  if (covered.length) {
    const named = covered
      .slice(0, 8)
      .map((c) => `${c.name} (${c.pct} %)`)
      .join(", ");
    out.push(
      finding({
        code: "CAVITY_CONFLICT",
        severity: "info",
        title: `${covered.length} element${covered.length === 1 ? "" : "s"} sit under the cavity footprint`,
        detail:
          `The clamshell pocket is ${inches(cavity.w)} × ${inches(cavity.h)} at ` +
          `(${inches(cavity.x)}, ${inches(cavity.y)}) — most of the card. The PVC is clear, so this ` +
          `artwork is seen through it, but the part itself sits in that pocket and will cover whatever ` +
          `is directly behind it: ${named}${covered.length > 8 ? ", …" : ""}. ` +
          `Cavity geometry provenance: ${CARD_PRESETS[ctx.doc.presetCode].cavity.provenance}.`,
        remedy:
          `Check a physical sample. Anything that must stay readable with the part in the pack — the ` +
          `part number and the barcode above all — belongs in the flange bands above ` +
          `${inches(cavity.y)} or below ${inches(rectBottom(cavity))}.`,
        side: ctx.side,
        rect: cavity,
        measurements: {
          elementsCovered: covered.length,
          cavityWIn: inNum(cavity.w),
          cavityHIn: inNum(cavity.h),
        },
      }),
    );
  }

  return out;
}

export function geometryChecks(ctx: PreflightContext): PreflightFinding[] {
  return [
    ...checkDocDimensions(ctx),
    ...checkEmptySide(ctx),
    ...checkBleedCoverage(ctx),
    ...checkTrimCrossing(ctx),
    ...checkSafeArea(ctx),
    ...checkCavityConflict(ctx),
  ];
}
