/**
 * FONT REGISTRY — spec §9.
 *
 * Only fonts that ship with the application can be used on a card, because only
 * those can be guaranteed embeddable in the exported PDF. All three families are
 * SIL Open Font Licence 1.1, which permits embedding and redistribution
 * (see src/assets/fonts/OFL.txt).
 *
 * The metrics JSON generated from these exact files is what the editor uses to
 * lay out text, and the same TTF bytes are what pdf-lib subsets and embeds. The
 * browser is never asked to make a layout decision the PDF cannot reproduce.
 */

export type FontFaceDef = {
  weight: number;
  italic: boolean;
  file: string;
  /** Public URL for the @font-face rule used by the editor preview. */
  webPath: string;
};

export type FontFamilyDef = {
  family: string;
  label: string;
  /** What this face is for, shown in the font picker. */
  role: string;
  license: "OFL-1.1";
  faces: FontFaceDef[];
  fallbackCss: string;
};

export const FONT_FAMILIES: FontFamilyDef[] = [
  {
    family: "Inter",
    label: "Inter",
    role: "Body copy, legal and compliance text. Highly legible at small sizes.",
    license: "OFL-1.1",
    fallbackCss: "system-ui, sans-serif",
    faces: [
      { weight: 400, italic: false, file: "Inter-400.ttf", webPath: "/fonts/Inter-400.ttf" },
      { weight: 400, italic: true, file: "Inter-400Italic.ttf", webPath: "/fonts/Inter-400Italic.ttf" },
      { weight: 500, italic: false, file: "Inter-500.ttf", webPath: "/fonts/Inter-500.ttf" },
      { weight: 600, italic: false, file: "Inter-600.ttf", webPath: "/fonts/Inter-600.ttf" },
      { weight: 700, italic: false, file: "Inter-700.ttf", webPath: "/fonts/Inter-700.ttf" },
    ],
  },
  {
    family: "Archivo",
    label: "Archivo",
    role: "Headlines, part numbers and brand bars. Grotesque with a strong 800.",
    license: "OFL-1.1",
    fallbackCss: "Helvetica, Arial, sans-serif",
    faces: [
      { weight: 400, italic: false, file: "Archivo-400.ttf", webPath: "/fonts/Archivo-400.ttf" },
      { weight: 600, italic: false, file: "Archivo-600.ttf", webPath: "/fonts/Archivo-600.ttf" },
      { weight: 700, italic: false, file: "Archivo-700.ttf", webPath: "/fonts/Archivo-700.ttf" },
      { weight: 800, italic: false, file: "Archivo-800.ttf", webPath: "/fonts/Archivo-800.ttf" },
    ],
  },
  {
    family: "Barlow Condensed",
    label: "Barlow Condensed",
    role: "Dense pack-contents lists and long fitment copy on narrow cards.",
    license: "OFL-1.1",
    fallbackCss: "'Arial Narrow', sans-serif",
    faces: [
      { weight: 400, italic: false, file: "BarlowCondensed-400.ttf", webPath: "/fonts/BarlowCondensed-400.ttf" },
      { weight: 500, italic: false, file: "BarlowCondensed-500.ttf", webPath: "/fonts/BarlowCondensed-500.ttf" },
      { weight: 600, italic: false, file: "BarlowCondensed-600.ttf", webPath: "/fonts/BarlowCondensed-600.ttf" },
      { weight: 700, italic: false, file: "BarlowCondensed-700.ttf", webPath: "/fonts/BarlowCondensed-700.ttf" },
    ],
  },
  {
    family: "Oswald",
    label: "Oswald",
    role: "Condensed headline and part-number face. Narrow enough for a long part number at a large size.",
    license: "OFL-1.1",
    fallbackCss: "'Arial Narrow', Impact, sans-serif",
    faces: [
      { weight: 300, italic: false, file: "Oswald-300.ttf", webPath: "/fonts/Oswald-300.ttf" },
      { weight: 400, italic: false, file: "Oswald-400.ttf", webPath: "/fonts/Oswald-400.ttf" },
      { weight: 500, italic: false, file: "Oswald-500.ttf", webPath: "/fonts/Oswald-500.ttf" },
      { weight: 600, italic: false, file: "Oswald-600.ttf", webPath: "/fonts/Oswald-600.ttf" },
      { weight: 700, italic: false, file: "Oswald-700.ttf", webPath: "/fonts/Oswald-700.ttf" },
    ],
  },
  {
    family: "Bebas Neue",
    label: "Bebas Neue",
    role:
      "Display face for shelf-legible headlines. Caps only — it has no lowercase, so a text block using it is effectively uppercase whatever the case transform says.",
    license: "OFL-1.1",
    fallbackCss: "Impact, 'Arial Narrow Bold', sans-serif",
    faces: [
      { weight: 400, italic: false, file: "BebasNeue-400.ttf", webPath: "/fonts/BebasNeue-400.ttf" },
    ],
  },
];

export const FONT_FAMILY_NAMES = FONT_FAMILIES.map((f) => f.family);

export function familyDef(family: string): FontFamilyDef | undefined {
  return FONT_FAMILIES.find((f) => f.family === family);
}

/**
 * Pick the closest available face. CSS-style weight matching: prefer an exact
 * hit, otherwise the nearest heavier face when asking for >= 400, nearest
 * lighter when asking below. Returns null when the family is unknown, which the
 * preflight engine reports as FONT_MISSING rather than silently substituting.
 */
export function resolveFace(
  family: string,
  weight: number,
  italic: boolean,
): { def: FontFamilyDef; face: FontFaceDef } | null {
  const def = familyDef(family);
  if (!def) return null;
  const pool = def.faces.filter((f) => f.italic === italic);
  const candidates = pool.length ? pool : def.faces;
  let best = candidates[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const f of candidates) {
    const diff = f.weight - weight;
    // Ties broken toward the heavier face, matching CSS font matching for >=400.
    const score = Math.abs(diff) * 2 + (diff < 0 ? 1 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return { def, face: best };
}

export function faceKey(family: string, weight: number, italic: boolean): string {
  const r = resolveFace(family, weight, italic);
  if (!r) return `missing:${family}`;
  return `${r.def.family}:${r.face.weight}${r.face.italic ? "i" : ""}`;
}

export function faceKeyOf(family: string, weight: number, italic: boolean): string {
  return `${family}:${weight}${italic ? "i" : ""}`;
}
