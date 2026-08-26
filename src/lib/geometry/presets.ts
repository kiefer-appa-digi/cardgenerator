import { inToUpt, type Upt } from "@/lib/units";
import {
  insetRect,
  outsetRect,
  uniformInsets,
  type Insets,
  type Rect,
} from "./types";

/**
 * CARD PRESETS
 *
 * `trim` values below are the AUTHORITATIVE production dimensions taken from
 * §2 of the master specification. Where the supplied Sinclair & Rush CAD
 * drawings disagree, the CAD numbers are preserved verbatim in `cadReference`
 * and the difference is reported by `presetDiscrepancies()` — they are never
 * silently reconciled (spec §2, §32).
 *
 * Cavity geometry was measured from page 2 ("Cavity Location") of each supplied
 * dieline PDF by rasterising at ~1200 ppi and flood-filling the enclosed white
 * regions; the derived x/y scales agreed to within 0.03 %, and the derivation is
 * documented in /docs/source-audit.md. Cavity corner radii are marked
 * approximate because they were recovered from a raster edge profile.
 */

export type CavitySpec = {
  /** Cavity footprint in TRIM space (origin = top-left of the trim box). */
  rect: Rect;
  cornerRadius: Upt;
  /** How the geometry was obtained, surfaced in the UI next to the overlay. */
  provenance: "measured-from-dieline" | "supplied" | "approximate";
  cornerRadiusIsApproximate: boolean;
  notes: string;
};

export type CadReference = {
  drawingNumber: string;
  revision: string;
  drawnDate: string;
  material: string;
  sheetThicknessIn: number;
  color: string;
  /** Verbatim CAD callouts. `*` in the source means "to theoretical sharp corners". */
  callouts: Record<string, string>;
  maxCardWidthIn: number;
  maxCardLengthIn: number;
  /** Card size as labelled on the dieline sheet (page 2 of the CAD PDF). */
  dielineCardWidthIn: number;
  dielineCardLengthIn: number;
  dielineCornerRadiusIn: number;
  sourceFile: string;
};

export type CardPresetDef = {
  code: "409TF" | "277TF" | "206TF";
  name: string;
  description: string;
  /** Authoritative trim size (spec §2). */
  trimWidth: Upt;
  trimHeight: Upt;
  cornerRadius: Upt;
  bleed: Insets;
  /** Default safe-area inset measured in from TRIM (spec §16 — a preset property). */
  safeArea: Insets;
  cavity: CavitySpec;
  cadReference: CadReference;
};

const IN = inToUpt;

/** 0.125 in on every side, for all three initial presets (spec §16). */
const BLEED_125 = uniformInsets(IN(0.125));

/**
 * Default safe area = 0.1875 in in from trim. Chosen so that the inset clears
 * the 0.125 in bleed plus a 0.0625 in cutting tolerance, which is the ordinary
 * allowance for guillotine-trimmed rotary die work at this card size. It is a
 * preset property and is editable per template.
 */
const SAFE_1875 = uniformInsets(IN(0.1875));

export const CARD_PRESETS: Record<CardPresetDef["code"], CardPresetDef> = {
  "409TF": {
    code: "409TF",
    name: "409TF Clamshell Card",
    description: 'Card insert for the 409TF clamshell — 4.3675 × 7.11175 in, R0.25 in.',
    trimWidth: IN(4.3675),
    trimHeight: IN(7.11175),
    cornerRadius: IN(0.25),
    bleed: BLEED_125,
    safeArea: SAFE_1875,
    cavity: {
      rect: { x: IN(0.3017), y: IN(0.7908), w: IN(3.7655), h: IN(6.194) },
      cornerRadius: IN(0.4329),
      provenance: "measured-from-dieline",
      cornerRadiusIsApproximate: true,
      notes:
        "Measured from 409TF.pdf p2. Left/right margins measured 0.3017/0.3008 in (0.0009 in asymmetry is raster noise); bottom margin 0.1321 in. CAD callouts D *3.188 and C *5.563 describe the cavity floor to theoretical sharp corners, not this flange opening — the thermoform draft angle accounts for the difference.",
    },
    cadReference: {
      drawingNumber: "409TF",
      revision: "0",
      drawnDate: "10-SEP-19",
      material: "PVC",
      sheetThicknessIn: 0.02,
      color: "CLEAR",
      callouts: {
        "A (overall length)": "8.250 in [209.55 mm]",
        "B (overall width)": "4.938 in [125.41 mm]",
        "C (cavity height *)": "5.563 in [141.30 mm]",
        "D (cavity width *)": "3.188 in [80.98 mm]",
        "E (depth)": "1.625 in [41.28 mm]",
        "F (max card length)": "7.125 in [180.98 mm]",
        "H (max card width)": "4.343 in [110.31 mm]",
      },
      maxCardWidthIn: 4.343,
      maxCardLengthIn: 7.125,
      dielineCardWidthIn: 4.3675,
      dielineCardLengthIn: 7.1175,
      dielineCornerRadiusIn: 0.25,
      sourceFile: "docs/source/dielines/409TF.pdf",
    },
  },
  "277TF": {
    code: "277TF",
    name: "277TF Clamshell Card",
    description: 'Card insert for the 277TF clamshell — 4.343 × 5.7875 in, R0.25 in.',
    trimWidth: IN(4.343),
    trimHeight: IN(5.7875),
    cornerRadius: IN(0.25),
    bleed: BLEED_125,
    safeArea: SAFE_1875,
    cavity: {
      // Measured against the 4.3575 in dieline width; re-centred horizontally on
      // the authoritative 4.343 in trim so the overlay stays symmetric.
      rect: { x: IN(0.0939), y: IN(1.1066), w: IN(4.1552), h: IN(4.5527) },
      cornerRadius: IN(0.2242),
      provenance: "measured-from-dieline",
      cornerRadiusIsApproximate: true,
      notes:
        "Measured from 277TF.pdf p2 (dieline drawn at 4.3575 in wide). Measured margins 0.1011 / 0.1018 in; because the authoritative trim width is 4.343 in the cavity was re-centred, giving 0.0939 in each side. Vertical geometry is unchanged: top 1.1066 in, bottom 0.1282 in.",
    },
    cadReference: {
      drawingNumber: "277TF",
      revision: "1",
      drawnDate: "05-SEP-17",
      material: "PVC",
      sheetThicknessIn: 0.02,
      color: "CLEAR",
      callouts: {
        "A (overall length)": "7.000 in [177.80 mm]",
        "B (overall width)": "5.000 in [127.00 mm]",
        "C (cavity height)": "4.250 in [107.95 mm]",
        "D (cavity width)": "3.875 in [98.43 mm]",
        "E (depth)": "2.000 in [50.80 mm]",
        "F (max card length)": "5.750 in [146.05 mm]",
        "H (max card width)": "4.343 in [110.31 mm]",
      },
      maxCardWidthIn: 4.343,
      maxCardLengthIn: 5.75,
      dielineCardWidthIn: 4.3575,
      dielineCardLengthIn: 5.7875,
      dielineCornerRadiusIn: 0.25,
      sourceFile: "docs/source/dielines/277TF.pdf",
    },
  },
  "206TF": {
    code: "206TF",
    name: "206TF Clamshell Card",
    description: 'Card insert for the 206TF clamshell — 3.1175 × 6.4775 in, R0.25 in.',
    trimWidth: IN(3.1175),
    trimHeight: IN(6.4775),
    cornerRadius: IN(0.25),
    bleed: BLEED_125,
    safeArea: SAFE_1875,
    cavity: {
      rect: { x: IN(0.1647), y: IN(1.0995), w: IN(2.7818), h: IN(5.1088) },
      cornerRadius: IN(0.6171),
      provenance: "measured-from-dieline",
      cornerRadiusIsApproximate: true,
      notes:
        "Measured from 206TF.pdf p2. Margins: left 0.1647, right 0.1706, top 1.0995, bottom 0.2701 in. The 0.0059 in left/right asymmetry is within raster measurement noise and was left as measured rather than forced symmetric.",
    },
    cadReference: {
      drawingNumber: "206TF",
      revision: "1",
      drawnDate: "01-SEP-17",
      material: "PVC",
      sheetThicknessIn: 0.02,
      color: "CLEAR",
      callouts: {
        "A (overall length)": "7.437 in [188.90 mm]",
        "B (overall width)": "3.625 in [92.08 mm]",
        "C (cavity height *)": "4.688 in [119.06 mm]",
        "D (cavity width *)": "2.313 in [58.74 mm]",
        "E (depth)": "1.313 in [33.34 mm]",
        "F (max card length)": "6.437 in [163.50 mm]",
        "H (max card width)": "3.140 in [79.76 mm]",
      },
      maxCardWidthIn: 3.14,
      maxCardLengthIn: 6.437,
      dielineCardWidthIn: 3.1175,
      dielineCardLengthIn: 6.4775,
      dielineCornerRadiusIn: 0.25,
      sourceFile: "docs/source/dielines/206TF.pdf",
    },
  },
};

export const PRESET_CODES = Object.keys(CARD_PRESETS) as CardPresetDef["code"][];

/** Trim box expressed in BLEED space (origin = top-left of the full-bleed canvas). */
export function trimRect(p: CardPresetDef): Rect {
  return { x: p.bleed.left, y: p.bleed.top, w: p.trimWidth, h: p.trimHeight };
}
/** The full-bleed canvas: the page the production PDF actually is. */
export function bleedRect(p: CardPresetDef): Rect {
  return outsetRect(trimRect(p), p.bleed);
}
/** Safe area in bleed space. */
export function safeRect(p: CardPresetDef): Rect {
  return insetRect(trimRect(p), p.safeArea);
}

/**
 * The safe area's OWN corner radius.
 *
 * Insetting a rounded rectangle by d shrinks its corner radius by d — the arc
 * centre does not move. Testing safe-area containment with the *trim's* 0.25 in
 * radius would therefore reject artwork that is comfortably on the card, which
 * is exactly the kind of false alarm that teaches an operator to ignore
 * preflight. Where the insets differ per side the smallest one is used, which
 * leaves the largest radius and so the strictest test.
 */
export function safeCornerRadius(p: CardPresetDef, override?: Insets): Upt {
  const i = override ?? p.safeArea;
  const smallest = Math.min(i.top, i.right, i.bottom, i.left);
  return Math.max(0, p.cornerRadius - smallest);
}
/** Cavity overlay in bleed space. */
export function cavityRect(p: CardPresetDef): Rect {
  const t = trimRect(p);
  return {
    x: t.x + p.cavity.rect.x,
    y: t.y + p.cavity.rect.y,
    w: p.cavity.rect.w,
    h: p.cavity.rect.h,
  };
}
export function fullBleedWidth(p: CardPresetDef): Upt {
  return p.trimWidth + p.bleed.left + p.bleed.right;
}
export function fullBleedHeight(p: CardPresetDef): Upt {
  return p.trimHeight + p.bleed.top + p.bleed.bottom;
}

export type PresetDiscrepancy = {
  preset: CardPresetDef["code"];
  field: string;
  authoritativeIn: number;
  cadIn: number;
  deltaIn: number;
  severity: "info" | "warning";
  note: string;
};

/**
 * Every numeric disagreement between the authoritative presets and the supplied
 * CAD drawings, surfaced rather than reconciled (spec §2). Rendered on the
 * preset detail screen and in /docs/source-audit.md.
 */
export function presetDiscrepancies(): PresetDiscrepancy[] {
  const out: PresetDiscrepancy[] = [];
  const round = (n: number) => Number(n.toFixed(6));
  for (const code of PRESET_CODES) {
    const p = CARD_PRESETS[code];
    const cad = p.cadReference;
    const trimWIn = p.trimWidth / 72_000_000;
    const trimHIn = p.trimHeight / 72_000_000;

    const pairs: Array<[string, number, number, "info" | "warning", string]> = [
      [
        "trim width vs dieline sheet",
        trimWIn,
        cad.dielineCardWidthIn,
        "warning",
        "Dieline page 2 of the CAD PDF labels a different card width.",
      ],
      [
        "trim length vs dieline sheet",
        trimHIn,
        cad.dielineCardLengthIn,
        "warning",
        "Dieline page 2 of the CAD PDF labels a different card length.",
      ],
      [
        "trim width vs clamshell MAX CARD WIDTH",
        trimWIn,
        cad.maxCardWidthIn,
        "warning",
        "Clamshell drawing callout H is the maximum card the cavity flange will accept.",
      ],
      [
        "trim length vs clamshell MAX CARD LENGTH",
        trimHIn,
        cad.maxCardLengthIn,
        "warning",
        "Clamshell drawing callout F is the maximum card the cavity flange will accept.",
      ],
    ];
    for (const [field, a, c, severity, note] of pairs) {
      const delta = round(a - c);
      if (Math.abs(delta) < 1e-6) continue;
      out.push({
        preset: code,
        field,
        authoritativeIn: round(a),
        cadIn: round(c),
        deltaIn: delta,
        severity: Math.abs(delta) < 0.01 ? "info" : severity,
        note:
          delta > 0
            ? `${note} The authoritative card is ${round(delta)} in LARGER — confirm with the clamshell vendor before running.`
            : `${note} The authoritative card is ${round(-delta)} in smaller.`,
      });
    }
  }
  return out;
}
