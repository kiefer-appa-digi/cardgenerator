import { z } from "zod";
import { PrintColorSchema, TEXT_BLACK, NONE } from "@/lib/color/types";
import { RectSchema, InsetsSchema } from "@/lib/geometry/types";

/**
 * THE DESIGN DOCUMENT
 *
 * spec §4: "A card design must never be just an opaque canvas JSON blob."
 *
 * Every element is a normalised, validated record with explicit physical
 * geometry in µpt. There is no free-form renderer state, no serialised
 * Fabric/Konva blob, and nothing that only the browser knows how to interpret.
 * The artboard renderer, the preflight engine and the PDF writer all consume
 * exactly this structure, which is why the screen and the press agree.
 */

export const ELEMENT_KINDS = [
  "text",
  "image",
  "shape",
  "barcode",
  "bomList",
  "group",
] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

/* ------------------------------------------------------------------ binding */

export const TextTransformSchema = z.enum([
  "none",
  "uppercase",
  "lowercase",
  "titlecase",
]);
export type TextTransform = z.infer<typeof TextTransformSchema>;

/**
 * A data binding resolves against the selected product at render time.
 * `path` is a dotted path into the ProductContext (see lib/data/context.ts),
 * e.g. `partNumber`, `brand.name`, `identifiers.upc12`.
 */
export const BindingSchema = z.object({
  path: z.string().min(1),
  fallback: z.string().default(""),
  prefix: z.string().default(""),
  suffix: z.string().default(""),
  transform: TextTransformSchema.default("none"),
  /** Join separator when the resolved value is a list. */
  joiner: z.string().default(", "),
  /** Element is hidden entirely when the binding resolves empty. */
  hideWhenEmpty: z.boolean().default(false),
  /** Optional numeric/date format hint, e.g. "0.00" or "MMM d, yyyy". */
  format: z.string().optional(),
});
export type Binding = z.infer<typeof BindingSchema>;

/** Rich text is modelled as runs so it can be exported deterministically. */
export const TextRunSchema = z.object({
  text: z.string().default(""),
  binding: BindingSchema.optional(),
  bold: z.boolean().default(false),
  italic: z.boolean().default(false),
  /** Per-run overrides; undefined inherits from the block. */
  fontFamily: z.string().optional(),
  fontSize: z.number().int().positive().optional(),
  color: PrintColorSchema.optional(),
  tracking: z.number().int().optional(),
});
export type TextRun = z.infer<typeof TextRunSchema>;

export const ParagraphSchema = z.object({
  runs: z.array(TextRunSchema).default([]),
  /** Paragraph style id from the template's style sheet, if any. */
  styleId: z.string().optional(),
  spaceBefore: z.number().int().default(0),
  spaceAfter: z.number().int().default(0),
  listBullet: z.string().optional(),
});
export type Paragraph = z.infer<typeof ParagraphSchema>;

/* ------------------------------------------------------------- base element */

export const BaseElementSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  /** Frame in BLEED space (origin = top-left of the full-bleed canvas). */
  frame: RectSchema,
  /** Rotation about the frame centre, in millidegrees. */
  rotation: z.number().int().default(0),
  opacity: z.number().int().min(0).max(10_000).default(10_000),
  locked: z.boolean().default(false),
  hidden: z.boolean().default(false),
  /** Template-locked: brand-critical, not editable by a Designer (spec §18). */
  templateLocked: z.boolean().default(false),
  /** Marks the element as a controlled editable region of a master template. */
  editableRegion: z.boolean().default(false),
  /** Preflight treats a required element that resolves empty as a blocking error. */
  required: z.boolean().default(false),
  /** Hide when this binding resolves falsy/empty (spec §10 conditional visibility). */
  visibleWhen: z.string().optional(),
  groupId: z.string().optional(),
  notes: z.string().default(""),
});

/* -------------------------------------------------------------------- text */

export const HAlignSchema = z.enum(["left", "center", "right", "justify"]);
export const VAlignSchema = z.enum(["top", "middle", "bottom"]);

export const AutoFitSchema = z.object({
  mode: z.enum(["none", "shrink"]).default("none"),
  /** Never shrink below this size (µpt). Copy is never silently clipped. */
  minFontSize: z.number().int().positive().default(6_000_000),
});

export const TextElementSchema = BaseElementSchema.extend({
  kind: z.literal("text"),
  paragraphs: z.array(ParagraphSchema).default([]),
  fontFamily: z.string().default("Inter"),
  fontWeight: z.number().int().min(100).max(900).default(400),
  italic: z.boolean().default(false),
  /** Font size in µpt: 9 pt = 9_000_000. */
  fontSize: z.number().int().positive().default(9_000_000),
  /** Extra letter spacing in µpt. */
  tracking: z.number().int().default(0),
  /** Line height as a multiple of font size, in basis points (12000 = 1.2×). */
  lineHeight: z.number().int().positive().default(12_000),
  align: HAlignSchema.default("left"),
  verticalAlign: VAlignSchema.default("top"),
  transform: TextTransformSchema.default("none"),
  color: PrintColorSchema.default(TEXT_BLACK),
  padding: InsetsSchema.default({ top: 0, right: 0, bottom: 0, left: 0 }),
  autoFit: AutoFitSchema.default({ mode: "none", minFontSize: 6_000_000 }),
  /** Fill behind the text box. */
  fill: PrintColorSchema.default(NONE),
});
export type TextElement = z.infer<typeof TextElementSchema>;

/* ------------------------------------------------------------------- image */

export const ImageFitSchema = z.enum(["fill", "fit", "stretch", "crop"]);

export const ImageElementSchema = BaseElementSchema.extend({
  kind: z.literal("image"),
  assetId: z.string().nullable().default(null),
  fit: ImageFitSchema.default("fill"),
  /** Focal point for fill/crop, in basis points of the frame (5000 = centre). */
  focalX: z.number().int().min(0).max(10_000).default(5_000),
  focalY: z.number().int().min(0).max(10_000).default(5_000),
  /** Manual crop within the source image, in basis points of source size. */
  crop: z
    .object({
      x: z.number().int().min(0).max(10_000).default(0),
      y: z.number().int().min(0).max(10_000).default(0),
      w: z.number().int().min(1).max(10_000).default(10_000),
      h: z.number().int().min(1).max(10_000).default(10_000),
    })
    .default({ x: 0, y: 0, w: 10_000, h: 10_000 }),
  /** Extra scale applied after fit, in basis points. */
  scale: z.number().int().positive().default(10_000),
  /** Marks this image as the side background: it must cover the bleed box. */
  isBackground: z.boolean().default(false),
  /** Bind the image to a product field (e.g. product image URL). */
  binding: BindingSchema.optional(),
  cornerRadius: z.number().int().nonnegative().default(0),
});
export type ImageElement = z.infer<typeof ImageElementSchema>;

/* ------------------------------------------------------------------- shape */

export const ShapeKindSchema = z.enum(["rect", "ellipse", "line"]);

export const ShapeElementSchema = BaseElementSchema.extend({
  kind: z.literal("shape"),
  shape: ShapeKindSchema.default("rect"),
  fill: PrintColorSchema.default(TEXT_BLACK),
  stroke: PrintColorSchema.default(NONE),
  strokeWidth: z.number().int().nonnegative().default(0),
  cornerRadius: z.number().int().nonnegative().default(0),
});
export type ShapeElement = z.infer<typeof ShapeElementSchema>;

/* ----------------------------------------------------------------- barcode */

export const BarcodeSymbologySchema = z.enum([
  "upca",
  "ean13",
  "gs1-128",
  "qr",
  "gs1-digital-link",
]);
export type BarcodeSymbology = z.infer<typeof BarcodeSymbologySchema>;

export const BarcodeElementSchema = BaseElementSchema.extend({
  kind: z.literal("barcode"),
  symbology: BarcodeSymbologySchema.default("upca"),
  /** Static value; ignored when `binding` is set. */
  value: z.string().default(""),
  binding: BindingSchema.optional(),
  /** GS1 magnification factor in basis points of nominal: 10000 = 100 % (X = 0.0130 in). */
  magnification: z.number().int().min(8_000).max(20_000).default(10_000),
  /** Bar height in µpt. Nominal UPC-A is 1.02 in at 100 %. */
  barHeight: z.number().int().positive().default(73_440_000),
  /** Truncating bar height below nominal is legal but scanner-hostile — flagged. */
  showHumanReadable: z.boolean().default(true),
  humanReadableFontSize: z.number().int().positive().default(7_000_000),
  /** Bars and human-readable text colour. Must be print-safe (dark on light). */
  barColor: PrintColorSchema.default(TEXT_BLACK),
  /** Quiet-zone background; `none` means the underlying artwork shows through. */
  quietZoneFill: PrintColorSchema.default(NONE),
  /** Draw a light-margin indicator "<"/">" as UPC-A requires. */
  showLightMarginIndicator: z.boolean().default(true),
  /** GS1 Digital Link domain for the `gs1-digital-link` symbology. */
  digitalLinkDomain: z.string().default("https://id.gs1.org"),
});
export type BarcodeElement = z.infer<typeof BarcodeElementSchema>;

/* ---------------------------------------------------------------- BOM list */

export const BomListElementSchema = BaseElementSchema.extend({
  kind: z.literal("bomList"),
  /** Binding to the repeating collection. Defaults to the product's BOM items. */
  sourcePath: z.string().default("bom.items"),
  /**
   * Per-row template. Tokens are resolved against the row, e.g.
   * "{quantity}) {name} ({partNumber})" → "2) Inner Bearing (L44643)"
   */
  itemTemplate: z.string().default("{quantity}) {name} ({partNumber})"),
  heading: z.string().default("THIS PACK INCLUDES:"),
  showHeading: z.boolean().default(true),
  headingFontSize: z.number().int().positive().default(9_000_000),
  headingFontWeight: z.number().int().min(100).max(900).default(700),
  fontFamily: z.string().default("Inter"),
  fontSize: z.number().int().positive().default(8_000_000),
  fontWeight: z.number().int().min(100).max(900).default(400),
  lineHeight: z.number().int().positive().default(12_000),
  tracking: z.number().int().default(0),
  align: HAlignSchema.default("left"),
  color: PrintColorSchema.default(TEXT_BLACK),
  columns: z.number().int().min(1).max(3).default(1),
  columnGap: z.number().int().nonnegative().default(864_000), // 0.012 in
  itemSpacing: z.number().int().nonnegative().default(0),
  /** Controlled shrink-to-fit. Never clips — overflow raises a blocking error. */
  autoFit: AutoFitSchema.default({ mode: "shrink", minFontSize: 5_000_000 }),
  maxItems: z.number().int().positive().nullable().default(null),
  emptyText: z.string().default(""),
});
export type BomListElement = z.infer<typeof BomListElementSchema>;

/* ------------------------------------------------------------------- group */

export const GroupElementSchema = BaseElementSchema.extend({
  kind: z.literal("group"),
  childIds: z.array(z.string()).default([]),
});
export type GroupElement = z.infer<typeof GroupElementSchema>;

/* ---------------------------------------------------------------- element */

export const DesignElementSchema = z.discriminatedUnion("kind", [
  TextElementSchema,
  ImageElementSchema,
  ShapeElementSchema,
  BarcodeElementSchema,
  BomListElementSchema,
  GroupElementSchema,
]);
export type DesignElement = z.infer<typeof DesignElementSchema>;

/* --------------------------------------------------------------- guides */

export const GuideSchema = z.object({
  id: z.string(),
  axis: z.enum(["x", "y"]),
  /** Position in bleed space. */
  pos: z.number().int(),
  locked: z.boolean().default(false),
});
export type Guide = z.infer<typeof GuideSchema>;

/* ----------------------------------------------------------------- side */

export const SIDE_KEYS = ["front", "back"] as const;
export type SideKey = (typeof SIDE_KEYS)[number];

export const CardSideSchema = z.object({
  side: z.enum(SIDE_KEYS),
  /**
   * Colour intent. `process` allows full CMYK; `grayscale` is the standard back
   * and makes any non-grayscale content a preflight error unless
   * `allowColorOverride` is set by an authorised template (spec §7).
   */
  colorIntent: z.enum(["process", "grayscale"]).default("process"),
  allowColorOverride: z.boolean().default(false),
  /** Paper colour under everything; not printed, used for preview honesty. */
  background: PrintColorSchema.default({ space: "cmyk", c: 0, m: 0, y: 0, k: 0 }),
  /** Bottom-to-top paint order. */
  elements: z.array(DesignElementSchema).default([]),
  guides: z.array(GuideSchema).default([]),
});
export type CardSide = z.infer<typeof CardSideSchema>;

/* ------------------------------------------------------------- document */

export const DESIGN_DOC_VERSION = 1;

export const DesignDocSchema = z.object({
  version: z.literal(DESIGN_DOC_VERSION),
  presetCode: z.enum(["409TF", "277TF", "206TF"]),
  /** Overrides of the preset's safe area for this design, if the template says so. */
  safeAreaOverride: InsetsSchema.optional(),
  front: CardSideSchema,
  back: CardSideSchema,
  /** Named paragraph styles available to text elements. */
  paragraphStyles: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        fontFamily: z.string(),
        fontWeight: z.number().int(),
        fontSize: z.number().int(),
        lineHeight: z.number().int(),
        tracking: z.number().int(),
        color: PrintColorSchema,
        transform: TextTransformSchema.default("none"),
      }),
    )
    .default([]),
});
export type DesignDoc = z.infer<typeof DesignDocSchema>;

export function emptySide(side: SideKey): CardSide {
  return CardSideSchema.parse({
    side,
    colorIntent: side === "back" ? "grayscale" : "process",
  });
}

export function emptyDesign(presetCode: DesignDoc["presetCode"]): DesignDoc {
  return DesignDocSchema.parse({
    version: DESIGN_DOC_VERSION,
    presetCode,
    front: emptySide("front"),
    back: emptySide("back"),
  });
}

export function findElement(doc: DesignDoc, id: string): { side: SideKey; el: DesignElement } | null {
  for (const side of SIDE_KEYS) {
    const el = doc[side].elements.find((e) => e.id === id);
    if (el) return { side, el };
  }
  return null;
}

/** Plain text of a text element, ignoring bindings (used for search/labels). */
export function textElementPlainText(el: TextElement): string {
  return el.paragraphs
    .map((p) => p.runs.map((r) => r.binding ? `{${r.binding.path}}` : r.text).join(""))
    .join("\n");
}

export function defaultElementName(el: DesignElement): string {
  if (el.name) return el.name;
  switch (el.kind) {
    case "text": {
      const t = textElementPlainText(el).trim().split("\n")[0];
      return t ? t.slice(0, 40) : "Text";
    }
    case "image":
      return el.isBackground ? "Background" : "Image";
    case "shape":
      return el.shape === "rect" ? "Rectangle" : el.shape === "ellipse" ? "Ellipse" : "Line";
    case "barcode":
      return el.symbology.toUpperCase();
    case "bomList":
      return "Pack contents";
    case "group":
      return "Group";
  }
}
