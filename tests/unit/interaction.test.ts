import { describe, expect, it } from "vitest";
import { inToUpt } from "@/lib/units";
import {
  alignFrames,
  distributeFrames,
  resizeRect,
  snapRect,
  buildSnapCandidates,
} from "@/lib/editor/interaction";

const R = (x: number, y: number, w: number, h: number) => ({
  x: inToUpt(x),
  y: inToUpt(y),
  w: inToUpt(w),
  h: inToUpt(h),
});

describe("resizeRect", () => {
  it("moves the dragged edge and leaves the opposite edge alone", () => {
    const out = resizeRect(R(1, 1, 2, 1), "e", inToUpt(0.5), 0);
    expect(out).toEqual(R(1, 1, 2.5, 1));
    const w = resizeRect(R(1, 1, 2, 1), "w", inToUpt(0.5), 0);
    expect(w).toEqual(R(1.5, 1, 1.5, 1));
  });

  it("keeps the aspect ratio exactly when constrained", () => {
    const out = resizeRect(R(0, 0, 2, 1), "se", inToUpt(1), inToUpt(0.1), { constrain: true });
    expect(out.w / out.h).toBeCloseTo(2, 6);
  });

  it("resizes about the centre when asked", () => {
    const out = resizeRect(R(1, 1, 2, 2), "e", inToUpt(0.5), 0, { fromCenter: true });
    expect(out).toEqual(R(0.5, 1, 3, 2));
  });

  it("clamps instead of flipping through zero", () => {
    const out = resizeRect(R(1, 1, 1, 1), "w", inToUpt(5), 0);
    expect(out.w).toBeGreaterThan(0);
    expect(out.x).toBeLessThanOrEqual(inToUpt(2));
  });
});

describe("snapping", () => {
  const preset = {
    bleed: R(0, 0, 3.3675, 6.7275),
    trim: R(0.125, 0.125, 3.1175, 6.4775),
    safe: R(0.3125, 0.3125, 2.7425, 6.1025),
    cavity: R(0.2897, 1.2245, 2.7818, 5.1088),
    guides: [],
    others: [],
    includeCavity: true,
  };

  it("pulls an element onto the safe-area edge from within tolerance", () => {
    const c = buildSnapCandidates(preset);
    const moving = R(0.315, 1, 1, 0.5);
    const s = snapRect(moving, c.x, c.y, inToUpt(0.01));
    expect(s.dx).toBe(inToUpt(0.3125) - inToUpt(0.315));
    expect(s.lines.some((l) => l.kind === "safe")).toBe(true);
  });

  it("leaves an element alone when nothing is within tolerance", () => {
    const c = buildSnapCandidates(preset);
    const s = snapRect(R(1.5, 3, 0.4, 0.4), c.x, c.y, inToUpt(0.003));
    expect(s.dx).toBe(0);
    expect(s.dy).toBe(0);
  });

  it("centres on the trim centre line", () => {
    const c = buildSnapCandidates(preset);
    // Trim centre x is 0.125 + 3.1175/2 = 1.68375
    const moving = R(1.683 - 0.5, 3, 1, 0.4);
    const s = snapRect(moving, c.x, c.y, inToUpt(0.01));
    expect(inToUpt(1.683 - 0.5) + s.dx + inToUpt(0.5)).toBe(inToUpt(1.68375));
  });
});

describe("align and distribute", () => {
  it("aligns left edges to the selection bounds", () => {
    const frames = [R(1, 1, 1, 1), R(2, 2, 1, 1)];
    const out = alignFrames(frames, R(1, 1, 2, 2), "left");
    expect(out.every((f) => f.x === inToUpt(1))).toBe(true);
  });

  it("distributes three boxes to equal gaps", () => {
    const out = distributeFrames([R(0, 0, 1, 1), R(1.5, 0, 1, 1), R(5, 0, 1, 1)], "x");
    const g1 = out[1].x - (out[0].x + out[0].w);
    const g2 = out[2].x - (out[1].x + out[1].w);
    expect(Math.abs(g1 - g2)).toBeLessThanOrEqual(1);
  });
});
