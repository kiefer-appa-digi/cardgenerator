import { z } from "zod";

/**
 * COLOR — spec §14.
 *
 * The source of truth for every printed colour in this system is a CMYK tint
 * quadruple (or a grayscale tint, or a named spot). RGB exists in exactly one
 * place: as a *display approximation* produced for the browser, which cannot
 * show CMYK. We never store an RGB value and call it print data, and we never
 * claim the on-screen preview is colour-managed.
 *
 * Tints are stored in tenths of a percent (0..1000) so that "38.5 %" round-trips
 * exactly and no ink value can drift.
 */

export const TINT_MAX = 1000; // 100.0 %

export const TintSchema = z.number().int().min(0).max(TINT_MAX);

export const CmykSchema = z.object({
  space: z.literal("cmyk"),
  c: TintSchema,
  m: TintSchema,
  y: TintSchema,
  k: TintSchema,
});
export type Cmyk = z.infer<typeof CmykSchema>;

export const GraySchema = z.object({
  space: z.literal("gray"),
  /** Ink coverage, i.e. 1000 = solid black. */
  k: TintSchema,
});
export type Gray = z.infer<typeof GraySchema>;

/**
 * Spot colours are architecturally supported now (spec §14 "spot-color-ready")
 * but the production PDF writer converts them to their CMYK alternate and
 * records a preflight INFO, because pdf-lib cannot emit a Separation colour
 * space. That limitation is stated, not hidden.
 */
export const SpotSchema = z.object({
  space: z.literal("spot"),
  name: z.string().min(1).max(64),
  /** Required CMYK alternate used for both preview and current PDF output. */
  alternate: CmykSchema.omit({ space: true }).extend({ space: z.literal("cmyk") }),
  tint: TintSchema.default(TINT_MAX),
});
export type Spot = z.infer<typeof SpotSchema>;

export const NoneColorSchema = z.object({ space: z.literal("none") });
export type NoneColor = z.infer<typeof NoneColorSchema>;

export const PrintColorSchema = z.discriminatedUnion("space", [
  CmykSchema,
  GraySchema,
  SpotSchema,
  NoneColorSchema,
]);
export type PrintColor = z.infer<typeof PrintColorSchema>;

export const cmyk = (c: number, m: number, y: number, k: number): Cmyk => ({
  space: "cmyk",
  c: clampTint(c),
  m: clampTint(m),
  y: clampTint(y),
  k: clampTint(k),
});
/** Convenience for whole-percent authoring: cmykPct(0,0,0,100) */
export const cmykPct = (c: number, m: number, y: number, k: number): Cmyk =>
  cmyk(c * 10, m * 10, y * 10, k * 10);
export const gray = (k: number): Gray => ({ space: "gray", k: clampTint(k) });
export const grayPct = (k: number): Gray => gray(k * 10);
export const NONE: NoneColor = { space: "none" };

export function clampTint(n: number): number {
  return Math.max(0, Math.min(TINT_MAX, Math.round(n)));
}

/** Production standard: text black is 0/0/0/100 (spec §14 "Black rules"). */
export const TEXT_BLACK: Cmyk = cmykPct(0, 0, 0, 100);
/** Default rich black. Configurable per organisation. */
export const DEFAULT_RICH_BLACK: Cmyk = cmykPct(60, 40, 40, 100);
export const PAPER_WHITE: Cmyk = cmykPct(0, 0, 0, 0);

export function isNone(c: PrintColor): c is NoneColor {
  return c.space === "none";
}

/** Effective CMYK, resolving grayscale and spot to their ink values. */
export function toCmyk(c: PrintColor): Cmyk | null {
  switch (c.space) {
    case "cmyk":
      return c;
    case "gray":
      return cmyk(0, 0, 0, c.k);
    case "spot": {
      const t = c.tint / TINT_MAX;
      const a = c.alternate;
      return cmyk(a.c * t, a.m * t, a.y * t, a.k * t);
    }
    case "none":
      return null;
  }
}

/** Total Area Coverage, in tenths of a percent (400.0 % = 4000). */
export function totalAreaCoverage(c: PrintColor): number {
  const k = toCmyk(c);
  if (!k) return 0;
  return k.c + k.m + k.y + k.k;
}

export function isGrayscale(c: PrintColor): boolean {
  if (c.space === "none" || c.space === "gray") return true;
  const k = toCmyk(c);
  if (!k) return true;
  return k.c === 0 && k.m === 0 && k.y === 0;
}

/**
 * CMYK → sRGB *preview* approximation.
 *
 * This is the naive multiplicative model, deliberately: it is fast, stable and
 * — critically — it is honest about what it is. It is NOT an ICC transform and
 * the UI never labels its output as a colour-accurate proof. Deployments that
 * need a managed preview configure an output intent and use a colour-managed
 * proof workflow downstream (see /docs/print-pipeline.md).
 */
export function cmykToPreviewRgb(color: PrintColor): { r: number; g: number; b: number } {
  const k = toCmyk(color);
  if (!k) return { r: 255, g: 255, b: 255 };
  const c = k.c / TINT_MAX;
  const m = k.m / TINT_MAX;
  const y = k.y / TINT_MAX;
  const kk = k.k / TINT_MAX;
  const r = 255 * (1 - Math.min(1, c * (1 - kk) + kk));
  const g = 255 * (1 - Math.min(1, m * (1 - kk) + kk));
  const b = 255 * (1 - Math.min(1, y * (1 - kk) + kk));
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
}

export function previewCss(color: PrintColor, opacityBps = 10_000): string {
  if (color.space === "none") return "transparent";
  const { r, g, b } = cmykToPreviewRgb(color);
  const a = opacityBps / 10_000;
  return a >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${a})`;
}

export function previewHex(color: PrintColor): string {
  if (color.space === "none") return "#ffffff";
  const { r, g, b } = cmykToPreviewRgb(color);
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * sRGB → CMYK for *imported* values (a hex swatch a user pastes, a colour picked
 * from an uploaded RGB asset). Uses simple GCR with a configurable black
 * generation point. Every call site must raise a preflight warning: an RGB value
 * converted this way is an estimate, not a specified ink recipe (spec §14).
 */
export function rgbToCmykEstimate(r: number, g: number, b: number): Cmyk {
  const rn = Math.max(0, Math.min(255, r)) / 255;
  const gn = Math.max(0, Math.min(255, g)) / 255;
  const bn = Math.max(0, Math.min(255, b)) / 255;
  const k = 1 - Math.max(rn, gn, bn);
  if (k >= 1) return cmyk(0, 0, 0, TINT_MAX);
  const c = (1 - rn - k) / (1 - k);
  const m = (1 - gn - k) / (1 - k);
  const y = (1 - bn - k) / (1 - k);
  return cmyk(c * TINT_MAX, m * TINT_MAX, y * TINT_MAX, k * TINT_MAX);
}

export function hexToCmykEstimate(hex: string): Cmyk | null {
  const m = hex.trim().replace(/^#/, "");
  const full = m.length === 3 ? m.split("").map((ch) => ch + ch).join("") : m;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return rgbToCmykEstimate(
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  );
}

export function formatColor(c: PrintColor): string {
  const pct = (t: number) => (t / 10).toFixed(t % 10 === 0 ? 0 : 1);
  switch (c.space) {
    case "none":
      return "None";
    case "gray":
      return `Gray ${pct(c.k)}%`;
    case "cmyk":
      return `C${pct(c.c)} M${pct(c.m)} Y${pct(c.y)} K${pct(c.k)}`;
    case "spot":
      return `${c.name} @ ${pct(c.tint)}%`;
  }
}

export function colorsEqual(a: PrintColor, b: PrintColor): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Named brand swatches (spec §14). Freedom Trailer Parts' brand blue and red are
 * specified in the identity package as sRGB (#1D9ED9 / #E82627); the CMYK values
 * below are the derived press recipes, flagged as derived so a brand manager can
 * replace them with vendor-supplied ink values.
 */
export type Swatch = {
  key: string;
  name: string;
  color: PrintColor;
  /** True when the CMYK was derived from an RGB brand value rather than specified. */
  derivedFromRgb: boolean;
  sourceRgbHex?: string;
};

export const BRAND_SWATCHES: Swatch[] = [
  {
    key: "freedom-blue",
    name: "Freedom Blue",
    color: cmykPct(78, 20, 0, 0),
    derivedFromRgb: true,
    sourceRgbHex: "#1D9ED9",
  },
  {
    key: "freedom-red",
    name: "Freedom Red",
    color: cmykPct(0, 90, 88, 0),
    derivedFromRgb: true,
    sourceRgbHex: "#E82627",
  },
  { key: "text-black", name: "Text Black (100K)", color: TEXT_BLACK, derivedFromRgb: false },
  { key: "rich-black", name: "Rich Black", color: DEFAULT_RICH_BLACK, derivedFromRgb: false },
  { key: "paper", name: "Paper / White", color: PAPER_WHITE, derivedFromRgb: false },
  { key: "gray-50", name: "50% Gray", color: grayPct(50), derivedFromRgb: false },
  { key: "gray-15", name: "15% Gray", color: grayPct(15), derivedFromRgb: false },
];

/** Black-handling rules, configurable per organisation (spec §14). */
export const BlackRulesSchema = z.object({
  textBlack: CmykSchema.default(TEXT_BLACK),
  richBlack: CmykSchema.default(DEFAULT_RICH_BLACK),
  /** Total ink limit in tenths of a percent. 3000 = 300 %, a common sheetfed limit. */
  totalAreaCoverageLimit: z.number().int().min(1000).max(4000).default(3000),
  /** Rich black under this size is flagged as a registration risk (µpt). */
  richBlackMinTextSize: z.number().int().default(14_000_000), // 14 pt
});
export type BlackRules = z.infer<typeof BlackRulesSchema>;
export const DEFAULT_BLACK_RULES: BlackRules = BlackRulesSchema.parse({});

/**
 * Output intent. Deliberately configurable per deployment/printer — we do not
 * invent a profile (spec §14). When `icc` is absent the exported PDF carries no
 * OutputIntent and the preflight says so.
 */
export const OutputIntentSchema = z.object({
  identifier: z.string().default("none"),
  conditionName: z.string().default("Not specified"),
  registryName: z.string().default(""),
  info: z.string().default(""),
  /** Base64 ICC profile, supplied by the deployment. */
  iccBase64: z.string().optional(),
});
export type OutputIntent = z.infer<typeof OutputIntentSchema>;
