import { z } from "zod";
import { RectSchema } from "@/lib/geometry/types";
import { SIDE_KEYS } from "@/lib/design/schema";

/**
 * PREFLIGHT RESULT CONTRACT — spec §21.
 *
 * Four severities. `blocking` stops a production export unless an Admin records
 * an explicit override with an audit note; `error` is a real defect that the
 * deployment may configure as blocking; `warning` and `info` never stop a run.
 */
export const SEVERITIES = ["info", "warning", "error", "blocking"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  blocking: 3,
};

/** Stable machine codes — referenced by tests, docs and the override audit log. */
export const CHECK_CODES = [
  "DOC_DIMENSIONS",
  "DOC_EMPTY_SIDE",
  "BLEED_COVERAGE",
  "BLEED_LOW_DPI",
  "TRIM_CROSSING",
  "SAFE_AREA_TEXT",
  "SAFE_AREA_BARCODE",
  "SAFE_AREA_ELEMENT",
  "ASSET_MISSING",
  "ASSET_LOW_DPI",
  "ASSET_RGB_IN_CMYK",
  "ASSET_UNSUPPORTED",
  "FONT_MISSING",
  "TEXT_OVERFLOW",
  "TEXT_EMPTY_REQUIRED",
  "BINDING_UNRESOLVED",
  "BINDING_UNKNOWN_PATH",
  "PRODUCT_FIELD_MISSING",
  "GTIN_INVALID",
  "GTIN_MISSING",
  "BARCODE_QUIET_ZONE",
  "BARCODE_SIZE",
  "BARCODE_CONTRAST",
  "BARCODE_CLIPPED",
  "BARCODE_TRUNCATED_HEIGHT",
  "BARCODE_VALUE_INVALID",
  "CAVITY_CONFLICT",
  "GRAYSCALE_VIOLATION",
  "TRANSPARENCY_PRESENT",
  "INK_LIMIT",
  "RICH_BLACK_SMALL_TEXT",
  "HIDDEN_REQUIRED",
  "SPOT_CONVERTED",
  "OUTPUT_INTENT_MISSING",
  "BOM_OVERFLOW",
  "BOM_EMPTY",
  "IMAGE_UPSCALED",
] as const;
export type CheckCode = (typeof CHECK_CODES)[number];

export const PreflightFindingSchema = z.object({
  code: z.enum(CHECK_CODES),
  severity: z.enum(SEVERITIES),
  title: z.string(),
  detail: z.string(),
  /** Which side the finding is on, when it is side-specific. */
  side: z.enum(SIDE_KEYS).optional(),
  elementId: z.string().optional(),
  elementName: z.string().optional(),
  /** Bleed-space rect the UI highlights on the artboard. */
  rect: RectSchema.optional(),
  /** Actionable next step. Never "contact support". */
  remedy: z.string().optional(),
  /** Numbers behind the finding, e.g. { effectiveDpi: 142, threshold: 300 }. */
  measurements: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type PreflightFinding = z.infer<typeof PreflightFindingSchema>;

export const PreflightReportSchema = z.object({
  ranAt: z.string(),
  /** Profile the checks were run under (thresholds vary by press). */
  profileName: z.string(),
  designId: z.string().optional(),
  revisionId: z.string().optional(),
  productId: z.string().optional(),
  findings: z.array(PreflightFindingSchema),
  counts: z.object({
    info: z.number().int(),
    warning: z.number().int(),
    error: z.number().int(),
    blocking: z.number().int(),
  }),
  /** True when nothing blocks a production export. */
  exportable: z.boolean(),
});
export type PreflightReport = z.infer<typeof PreflightReportSchema>;

export function summarise(
  findings: PreflightFinding[],
  opts: { profileName: string; treatErrorAsBlocking: boolean } & Record<string, unknown>,
): PreflightReport {
  const counts = { info: 0, warning: 0, error: 0, blocking: 0 };
  for (const f of findings) counts[f.severity] += 1;
  const exportable =
    counts.blocking === 0 && (!opts.treatErrorAsBlocking || counts.error === 0);
  return PreflightReportSchema.parse({
    ranAt: new Date().toISOString(),
    profileName: opts.profileName,
    designId: opts.designId as string | undefined,
    revisionId: opts.revisionId as string | undefined,
    productId: opts.productId as string | undefined,
    findings: [...findings].sort(
      (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
    ),
    counts,
    exportable,
  });
}

/**
 * Preflight thresholds. Every number a press might argue about lives here rather
 * than being scattered through the checks (spec §16/§21).
 */
export const PreflightProfileSchema = z.object({
  name: z.string().default("Default sheetfed CMYK"),
  /** Minimum effective resolution for placed raster art, at final placed size. */
  minImageDpi: z.number().int().default(300),
  /** Below this is an error rather than a warning. */
  criticalImageDpi: z.number().int().default(200),
  /** Bleed art must cover at least this fraction of the bleed box (bps). */
  bleedCoverageBps: z.number().int().default(10_000),
  /** Total ink limit, tenths of a percent. */
  inkLimit: z.number().int().default(3_000),
  /** UPC-A/EAN-13 magnification bounds per GS1 General Specifications (bps). */
  barcodeMinMagnificationBps: z.number().int().default(8_000),
  barcodeMaxMagnificationBps: z.number().int().default(20_000),
  /** Minimum print contrast between bars and background, as ΔK tenths of a %. */
  barcodeMinContrast: z.number().int().default(700),
  /** Rich black is flagged under this text size (µpt). */
  richBlackMinTextSize: z.number().int().default(14_000_000),
  /** Errors block a production export in addition to blocking findings. */
  treatErrorAsBlocking: z.boolean().default(false),
});
export type PreflightProfile = z.infer<typeof PreflightProfileSchema>;
export const DEFAULT_PREFLIGHT_PROFILE: PreflightProfile = PreflightProfileSchema.parse({});
