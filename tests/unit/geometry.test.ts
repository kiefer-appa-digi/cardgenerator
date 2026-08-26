import { describe, expect, it } from "vitest";
import { inToUpt, uptToIn } from "@/lib/units";
import {
  CARD_PRESETS,
  PRESET_CODES,
  bleedRect,
  cavityRect,
  fullBleedHeight,
  fullBleedWidth,
  presetDiscrepancies,
  safeRect,
  trimRect,
} from "@/lib/geometry/presets";
import {
  clampRadius,
  roundedRectContains,
  roundedRectPath,
  rotatedBounds,
  rectContains,
} from "@/lib/geometry/types";

/** Spec §22 — the expected full-bleed dimensions, verbatim. */
const EXPECTED_FULL_BLEED: Record<string, [number, number]> = {
  "409TF": [4.6175, 7.36175],
  "277TF": [4.593, 6.0375],
  "206TF": [3.3675, 6.7275],
};

describe("card presets", () => {
  it("produces the exact full-bleed canvas the spec requires", () => {
    for (const code of PRESET_CODES) {
      const p = CARD_PRESETS[code];
      const [w, h] = EXPECTED_FULL_BLEED[code];
      // Exact integer equality — there is no tolerance to spend at this stage.
      expect(fullBleedWidth(p)).toBe(inToUpt(w));
      expect(fullBleedHeight(p)).toBe(inToUpt(h));
    }
  });

  it("keeps trim, safe and cavity nested inside the bleed canvas", () => {
    for (const code of PRESET_CODES) {
      const p = CARD_PRESETS[code];
      expect(rectContains(bleedRect(p), trimRect(p))).toBe(true);
      expect(rectContains(trimRect(p), safeRect(p))).toBe(true);
      expect(rectContains(trimRect(p), cavityRect(p))).toBe(true);
    }
  });

  it("uses a 0.25 in trim corner on every preset", () => {
    for (const code of PRESET_CODES) {
      expect(uptToIn(CARD_PRESETS[code].cornerRadius)).toBe(0.25);
    }
  });

  it("uses 0.125 in bleed on all four sides of every preset", () => {
    for (const code of PRESET_CODES) {
      const b = CARD_PRESETS[code].bleed;
      for (const v of [b.top, b.right, b.bottom, b.left]) expect(uptToIn(v)).toBe(0.125);
    }
  });

  it("surfaces CAD disagreements instead of reconciling them", () => {
    const d = presetDiscrepancies();
    // The 409TF card is wider than the clamshell's stated MAX CARD WIDTH; that is
    // a real conflict in the supplied source and must be reported, not smoothed.
    const w409 = d.find(
      (x) => x.preset === "409TF" && x.field === "trim width vs clamshell MAX CARD WIDTH",
    );
    expect(w409).toBeDefined();
    expect(w409!.deltaIn).toBeCloseTo(0.0245, 6);
    // 206TF is longer than its clamshell's MAX CARD LENGTH.
    const h206 = d.find(
      (x) => x.preset === "206TF" && x.field === "trim length vs clamshell MAX CARD LENGTH",
    );
    expect(h206).toBeDefined();
    expect(h206!.deltaIn).toBeCloseTo(0.0405, 6);
    // 206TF's authoritative trim matches its own dieline exactly, so no dieline row.
    expect(
      d.filter((x) => x.preset === "206TF" && x.field.includes("dieline")).length,
    ).toBe(0);
  });
});

describe("rounded rectangle geometry", () => {
  const r = { x: 0, y: 0, w: inToUpt(4), h: inToUpt(6) };

  it("clamps a radius to half the shorter side", () => {
    expect(clampRadius(r, inToUpt(10))).toBe(inToUpt(2));
    expect(clampRadius(r, inToUpt(0.25))).toBe(inToUpt(0.25));
  });

  it("emits a closed path with four arcs", () => {
    const segs = roundedRectPath(r, inToUpt(0.25));
    expect(segs.filter((s) => s.t === "C")).toHaveLength(4);
    expect(segs[segs.length - 1].t).toBe("Z");
  });

  it("knows a box tucked into a rounded corner is outside the card", () => {
    const rad = inToUpt(0.25);
    // Fully inside, away from the corners.
    expect(
      roundedRectContains(r, rad, { x: inToUpt(1), y: inToUpt(1), w: inToUpt(1), h: inToUpt(1) }),
    ).toBe(true);
    // Sitting in the top-left corner square: inside the bounding box but outside the arc.
    expect(
      roundedRectContains(r, rad, { x: 0, y: 0, w: inToUpt(0.1), h: inToUpt(0.1) }),
    ).toBe(false);
    // Same corner, but pushed in past the arc.
    expect(
      roundedRectContains(r, rad, {
        x: inToUpt(0.08),
        y: inToUpt(0.08),
        w: inToUpt(0.5),
        h: inToUpt(0.5),
      }),
    ).toBe(true);
  });

  it("expands the bounding box of a rotated element", () => {
    const b = rotatedBounds({ x: 0, y: 0, w: inToUpt(2), h: inToUpt(1) }, 90_000);
    expect(b.w).toBe(inToUpt(1));
    expect(b.h).toBe(inToUpt(2));
    const b45 = rotatedBounds({ x: 0, y: 0, w: inToUpt(2), h: inToUpt(2) }, 45_000);
    expect(uptToIn(b45.w)).toBeCloseTo(2 * Math.SQRT2, 3);
  });
});
