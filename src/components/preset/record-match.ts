import { formatLength } from "@/lib/units";
import type { CardPresetDef } from "@/lib/geometry/presets";

/**
 * DOES THE STORED ROW CARRY THE AUTHORITATIVE GEOMETRY?
 *
 * The list screen and the detail screen both badge this, so the comparison
 * lives in one place: two screens applying two different definitions of
 * "matches" is how a card_presets row ends up green on /presets and red on
 * /presets/409TF. Every geometric column the application relies on is compared,
 * not just the trim size.
 */

/** The card_presets columns that must equal the preset definition. */
export type StoredPresetGeometry = {
  trimWidth: number;
  trimHeight: number;
  cornerRadius: number;
  bleedTop: number;
  bleedRight: number;
  bleedBottom: number;
  bleedLeft: number;
  safeTop: number;
  safeRight: number;
  safeBottom: number;
  safeLeft: number;
};

export type GeometryMismatch = {
  field: string;
  /** Both in inches, formatted exactly as the dimension tables format them. */
  expected: string;
  stored: string;
};

function pairs(p: CardPresetDef): Array<[string, keyof StoredPresetGeometry, number]> {
  return [
    ["Trim width", "trimWidth", p.trimWidth],
    ["Trim height", "trimHeight", p.trimHeight],
    ["Corner radius", "cornerRadius", p.cornerRadius],
    ["Bleed top", "bleedTop", p.bleed.top],
    ["Bleed right", "bleedRight", p.bleed.right],
    ["Bleed bottom", "bleedBottom", p.bleed.bottom],
    ["Bleed left", "bleedLeft", p.bleed.left],
    ["Safe inset top", "safeTop", p.safeArea.top],
    ["Safe inset right", "safeRight", p.safeArea.right],
    ["Safe inset bottom", "safeBottom", p.safeArea.bottom],
    ["Safe inset left", "safeLeft", p.safeArea.left],
  ];
}

/** Every stored value that disagrees with the preset definition. */
export function geometryMismatches(
  row: StoredPresetGeometry | null | undefined,
  p: CardPresetDef,
): GeometryMismatch[] {
  if (!row) return [];
  const out: GeometryMismatch[] = [];
  for (const [field, key, expected] of pairs(p)) {
    const stored = row[key];
    if (stored !== expected) {
      out.push({
        field,
        expected: `${formatLength(expected, "in")} in`,
        stored: `${formatLength(stored, "in")} in`,
      });
    }
  }
  return out;
}

/** A missing row is not a match — there is nothing to agree with. */
export function presetRecordMatches(
  row: StoredPresetGeometry | null | undefined,
  p: CardPresetDef,
): boolean {
  return !!row && geometryMismatches(row, p).length === 0;
}
