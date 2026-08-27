import {
  BarcodeElementSchema,
  BomListElementSchema,
  CardSideSchema,
  DesignDocSchema,
  ImageElementSchema,
  ShapeElementSchema,
  TextElementSchema,
  type DesignDoc,
  type DesignElement,
} from "@/lib/design/schema";
import {
  CARD_PRESETS,
  bleedRect,
  safeRect,
  trimRect,
  type CardPresetDef,
} from "@/lib/geometry/presets";
import { NONE, cmykPct, grayPct } from "@/lib/color/types";
import { inToUpt } from "@/lib/units";
import { renderBarcode } from "@/lib/barcode";
import type { Rect } from "@/lib/geometry/types";

/**
 * AXLETEK PRODUCTION LAYOUT
 *
 * Built to match the supplied 409TF reference artwork rather than invented:
 *
 *   Front — full-bleed black; reversed brand mark top-left; a white SKU tab
 *   hanging off the top-right corner with the part number set in brand blue;
 *   centred product title with the French and Spanish titles inside a rounded
 *   keyline box; a periwinkle field carrying an oversized brand graphic; and a
 *   black footer band with the bilingual "FITS OR REPLACES / POUR OU REMPLACE"
 *   brand list.
 *
 *   Back — white; brand mark top-left in black with an inverted black SKU tab;
 *   centred titles; a ruled "This Pack Includes:" box closed by an ALTERNATE
 *   PART NUMBERS band; the bilingual fitment list at lower left beside a UPC-A;
 *   and a GENUINE PARTS / trilingual country-of-origin line opposite the
 *   Proposition 65 warning.
 *
 * Geometry is expressed as fractions of the card so the same builder produces a
 * coherent 206TF and 277TF, but the proportions were tuned against 409TF, which
 * is the preset the reference was drawn for.
 *
 * Two elements are deliberately empty slots: the AxleTek brand mark and the
 * oversized brand graphic. Neither was supplied with the source materials, so
 * they are editable regions a designer fills rather than something approximated
 * here and passed off as the brand's own artwork.
 */

const IN = inToUpt;

/** The periwinkle field from the reference, as a press recipe. */
const FIELD_BLUE = cmykPct(52, 36, 0, 0);
/** The blue the SKU is set in on the white tab. */
const SKU_BLUE = cmykPct(78, 52, 0, 0);
const BLACK = cmykPct(0, 0, 0, 100);
const PAPER = cmykPct(0, 0, 0, 0);

type Binding = {
  path: string;
  fallback: string;
  prefix: string;
  suffix: string;
  transform: "none" | "uppercase" | "lowercase" | "titlecase";
  joiner: string;
  hideWhenEmpty: boolean;
};

function bind(path: string, extra: Partial<Binding> = {}): Binding {
  return {
    path,
    fallback: extra.fallback ?? "",
    prefix: extra.prefix ?? "",
    suffix: extra.suffix ?? "",
    transform: extra.transform ?? "none",
    joiner: extra.joiner ?? ", ",
    hideWhenEmpty: extra.hideWhenEmpty ?? false,
  };
}

function text(
  id: string,
  frame: Rect,
  runs: Array<{ text?: string; binding?: Binding; bold?: boolean }>,
  opts: Record<string, unknown> = {},
): DesignElement {
  return TextElementSchema.parse({
    id,
    kind: "text",
    frame,
    paragraphs: [
      {
        runs: runs.map((r) => ({
          text: r.text ?? "",
          binding: r.binding,
          bold: r.bold ?? false,
          italic: false,
        })),
        spaceBefore: 0,
        spaceAfter: 0,
      },
    ],
    ...opts,
  });
}

function rect(
  id: string,
  name: string,
  frame: Rect,
  opts: Record<string, unknown> = {},
): DesignElement {
  return ShapeElementSchema.parse({
    id,
    kind: "shape",
    shape: "rect",
    name,
    frame,
    stroke: NONE,
    ...opts,
  });
}

type Ctx = {
  preset: CardPresetDef;
  bleed: Rect;
  trim: Rect;
  safe: Rect;
  id: (s: string) => string;
};

/* -------------------------------------------------------------------- front */

function buildFront(c: Ctx): DesignElement[] {
  const { bleed, trim, safe } = c;
  const els: DesignElement[] = [];
  const H = trim.h;

  // Full-bleed black. Everything else sits on this, so trimming anywhere in the
  // bleed still leaves a black edge.
  els.push(
    rect(c.id("bg"), "Background (black)", bleed, { fill: BLACK, templateLocked: true }),
  );

  const headerH = Math.round(H * 0.235);
  const footerH = Math.round(H * 0.075);

  // The periwinkle field between the header and footer bands, run to bleed left
  // and right so the two black bands read as bands rather than as boxes.
  const fieldTop = trim.y + headerH;
  const fieldBottom = trim.y + trim.h - footerH;
  els.push(
    rect(
      c.id("field"),
      "Colour field",
      { x: bleed.x, y: fieldTop, w: bleed.w, h: fieldBottom - fieldTop },
      { fill: FIELD_BLUE, templateLocked: true },
    ),
  );

  // Oversized brand graphic, deliberately allowed to run off the right edge.
  els.push(
    ImageElementSchema.parse({
      id: c.id("graphic"),
      kind: "image",
      name: "Brand graphic",
      frame: {
        x: safe.x,
        y: fieldTop + Math.round((fieldBottom - fieldTop) * 0.06),
        w: Math.round(trim.w * 1.02),
        h: Math.round((fieldBottom - fieldTop) * 0.88),
      },
      fit: "fit",
      focalX: 0,
      editableRegion: true,
    }),
  );

  /* ------------------------------------------------------------ SKU tab */

  // The tab hangs off the top-right, running out through the bleed on two sides
  // so the trim cuts through it cleanly and it reads as a tab rather than a box.
  const tabW = Math.round(trim.w * 0.35);
  const tabH = Math.round(H * 0.055);
  const tabX = trim.x + trim.w - tabW;
  els.push(
    rect(
      c.id("sku-tab"),
      "SKU tab",
      { x: tabX, y: bleed.y, w: tabW + c.preset.bleed.right, h: tabH + (trim.y - bleed.y) },
      { fill: PAPER, cornerRadius: c.preset.bleed.top, templateLocked: true },
    ),
  );
  els.push(
    text(
      c.id("sku"),
      { x: tabX, y: trim.y, w: tabW - IN(0.1), h: tabH },
      [{ binding: bind("partNumber", { transform: "uppercase" }) }],
      {
        name: "SKU",
        fontFamily: "Oswald",
        fontWeight: 700,
        fontSize: Math.round(tabH * 0.62),
        color: SKU_BLUE,
        align: "center",
        verticalAlign: "middle",
        required: true,
        autoFit: { mode: "shrink", minFontSize: IN(0.1) },
      },
    ),
  );

  /* ------------------------------------------------------------- header */

  const logoH = Math.round(H * 0.055);
  els.push(
    ImageElementSchema.parse({
      id: c.id("logo"),
      kind: "image",
      name: "Brand mark (reversed)",
      frame: { x: safe.x, y: trim.y + IN(0.09), w: Math.round(trim.w * 0.46), h: logoH },
      fit: "fit",
      focalX: 0,
      templateLocked: true,
      required: true,
    }),
  );

  const titleY = trim.y + IN(0.09) + logoH + Math.round(H * 0.022);
  const titleH = Math.round(H * 0.035);
  els.push(
    text(
      c.id("title"),
      { x: safe.x, y: titleY, w: safe.w, h: titleH },
      [{ binding: bind("productName", { transform: "uppercase" }) }],
      {
        name: "Product title",
        fontFamily: "Oswald",
        fontWeight: 700,
        fontSize: Math.round(titleH * 0.72),
        color: PAPER,
        align: "center",
        verticalAlign: "middle",
        required: true,
        autoFit: { mode: "shrink", minFontSize: IN(0.09) },
      },
    ),
  );

  // The keyline box around the translated titles, exactly as in the reference.
  const boxY = titleY + titleH + Math.round(H * 0.008);
  const boxH = Math.round(H * 0.062);
  const boxInset = Math.round(trim.w * 0.055);
  els.push(
    ShapeElementSchema.parse({
      id: c.id("title-box"),
      kind: "shape",
      shape: "rect",
      name: "Translated title keyline",
      frame: { x: trim.x + boxInset, y: boxY, w: trim.w - boxInset * 2, h: boxH },
      fill: NONE,
      stroke: PAPER,
      strokeWidth: IN(0.008),
      cornerRadius: IN(0.09),
      templateLocked: true,
    }),
  );
  els.push(
    TextElementSchema.parse({
      id: c.id("title-translated"),
      kind: "text",
      name: "French and Spanish titles",
      frame: { x: trim.x + boxInset, y: boxY, w: trim.w - boxInset * 2, h: boxH },
      fontFamily: "Oswald",
      fontWeight: 400,
      fontSize: Math.round(boxH * 0.3),
      lineHeight: 12_000,
      color: PAPER,
      align: "center",
      verticalAlign: "middle",
      transform: "uppercase",
      autoFit: { mode: "shrink", minFontSize: IN(0.06) },
      paragraphs: [
        {
          runs: [
            {
              text: "",
              bold: false,
              italic: false,
              binding: bind("translations.fr.productName", {
                fallback: "FRENCH TITLE",
                hideWhenEmpty: false,
              }),
            },
          ],
          spaceBefore: 0,
          spaceAfter: 0,
        },
        {
          runs: [
            {
              text: "",
              bold: false,
              italic: false,
              binding: bind("translations.es.productName", {
                fallback: "SPANISH TITLE",
                hideWhenEmpty: false,
              }),
            },
          ],
          spaceBefore: 0,
          spaceAfter: 0,
        },
      ],
    }),
  );

  /* ------------------------------------------------------------- footer */

  const footY = trim.y + trim.h - footerH;
  els.push(
    text(
      c.id("fits-label"),
      { x: safe.x, y: footY + IN(0.05), w: safe.w, h: IN(0.13) },
      [{ text: "FITS OR REPLACES / POUR OU REMPLACE:" }],
      {
        name: "Fitment label",
        fontFamily: "Oswald",
        fontWeight: 600,
        fontSize: IN(0.075),
        color: PAPER,
        templateLocked: true,
      },
    ),
  );
  els.push(
    text(
      c.id("fits-list"),
      { x: safe.x, y: footY + IN(0.19), w: safe.w, h: footerH - IN(0.24) },
      [{ binding: bind("fitments", { joiner: ", ", hideWhenEmpty: true, transform: "uppercase" }) }],
      {
        name: "Fits or replaces",
        fontFamily: "Oswald",
        fontWeight: 400,
        fontSize: IN(0.085),
        lineHeight: 11_500,
        color: PAPER,
        autoFit: { mode: "shrink", minFontSize: IN(0.06) },
      },
    ),
  );

  return els;
}

/* --------------------------------------------------------------------- back */

function buildBack(c: Ctx): DesignElement[] {
  const { bleed, trim, safe } = c;
  const els: DesignElement[] = [];
  const H = trim.h;
  const K = grayPct(100);
  const WHITE = grayPct(0);

  els.push(rect(c.id("bg"), "Background (white)", bleed, { fill: WHITE, templateLocked: true }));

  /* ---------------------------------------------------------- header */

  const tabW = Math.round(trim.w * 0.3);
  const tabH = Math.round(H * 0.05);
  const tabX = trim.x + trim.w - tabW;
  els.push(
    rect(
      c.id("sku-tab"),
      "SKU tab",
      { x: tabX, y: bleed.y, w: tabW + c.preset.bleed.right, h: tabH + (trim.y - bleed.y) },
      { fill: K, cornerRadius: c.preset.bleed.top, templateLocked: true },
    ),
  );
  els.push(
    text(
      c.id("sku"),
      { x: tabX, y: trim.y, w: tabW - IN(0.08), h: tabH },
      [{ binding: bind("partNumber", { transform: "uppercase" }) }],
      {
        name: "SKU",
        fontFamily: "Oswald",
        fontWeight: 700,
        fontSize: Math.round(tabH * 0.6),
        color: WHITE,
        align: "center",
        verticalAlign: "middle",
        required: true,
        autoFit: { mode: "shrink", minFontSize: IN(0.09) },
      },
    ),
  );

  const logoH = Math.round(H * 0.048);
  els.push(
    ImageElementSchema.parse({
      id: c.id("logo"),
      kind: "image",
      name: "Brand mark (black)",
      frame: { x: safe.x, y: trim.y + IN(0.07), w: Math.round(trim.w * 0.4), h: logoH },
      fit: "fit",
      focalX: 0,
      templateLocked: true,
      required: true,
    }),
  );

  let y = trim.y + IN(0.07) + logoH + IN(0.06);
  els.push(
    ShapeElementSchema.parse({
      id: c.id("rule"),
      kind: "shape",
      shape: "line",
      name: "Header rule",
      frame: { x: safe.x, y, w: safe.w, h: IN(0.012) },
      fill: K,
      stroke: K,
      strokeWidth: IN(0.012),
      templateLocked: true,
    }),
  );

  /* ----------------------------------------------------------- titles */

  y += Math.round(H * 0.055);
  const titleH = Math.round(H * 0.03);
  els.push(
    text(
      c.id("title"),
      { x: safe.x, y, w: safe.w, h: titleH },
      [{ binding: bind("productName", { transform: "uppercase" }) }],
      {
        name: "Product title",
        fontFamily: "Oswald",
        fontWeight: 700,
        fontSize: Math.round(titleH * 0.72),
        color: K,
        align: "center",
        verticalAlign: "middle",
        required: true,
        autoFit: { mode: "shrink", minFontSize: IN(0.08) },
      },
    ),
  );
  y += titleH + IN(0.02);
  els.push(
    TextElementSchema.parse({
      id: c.id("title-translated"),
      kind: "text",
      name: "French and Spanish titles",
      frame: { x: safe.x, y, w: safe.w, h: Math.round(H * 0.045) },
      fontFamily: "Oswald",
      fontWeight: 400,
      fontSize: IN(0.095),
      lineHeight: 12_000,
      color: K,
      align: "center",
      transform: "uppercase",
      autoFit: { mode: "shrink", minFontSize: IN(0.06) },
      paragraphs: [
        {
          runs: [{ text: "", bold: false, italic: false, binding: bind("translations.fr.productName", { fallback: "FRENCH TITLE" }) }],
          spaceBefore: 0,
          spaceAfter: 0,
        },
        {
          runs: [{ text: "", bold: false, italic: false, binding: bind("translations.es.productName", { fallback: "SPANISH TITLE" }) }],
          spaceBefore: 0,
          spaceAfter: 0,
        },
      ],
    }),
  );

  /* --------------------------------------------------- pack-contents box */

  // Laid out from the bottom of the card upwards. GENUINE PARTS and the warning
  // sit on the trim edge, the fitment/barcode row goes directly above them, and
  // the pack-contents box takes whatever height is left — it is the block that
  // actually varies between SKUs, so it is the one that should absorb the slack.
  const footTop = trim.y + trim.h - IN(0.52);
  const headerRowH = IN(0.19);
  const altRowH = IN(0.2);

  /* --------------------------------------------------- fitment + barcode */

  const barcodeProbe = renderBarcode({
    symbology: "upca",
    value: "000000000000",
    magnificationBps: 8_500,
    barHeight: IN(0.72),
    showHumanReadable: true,
    humanReadableFontSize: IN(0.085),
    showLightMarginIndicator: false,
  });
  const bcW = barcodeProbe.ok ? barcodeProbe.render.width : IN(1.25);
  const bcH = barcodeProbe.ok ? barcodeProbe.render.height : IN(0.9);

  const lowerTop = footTop - IN(0.14) - bcH;
  const bcX = trim.x + trim.w - IN(0.22) - bcW;
  const boxTop = y + Math.round(H * 0.055);
  // Capped as well as floored: letting the box take the whole middle turns a
  // five-line kit into a mostly-empty rectangle. It grows to the space available
  // only up to the proportion the reference uses, and an overflowing list raises
  // a blocking preflight error rather than being clipped.
  const boxH = Math.max(
    IN(1.2),
    Math.min(Math.round(H * 0.34), lowerTop - IN(0.14) - boxTop),
  );

  els.push(
    text(
      c.id("fits-label"),
      { x: safe.x, y: lowerTop, w: bcX - safe.x - IN(0.1), h: IN(0.14) },
      [{ text: "FITS OR REPLACES / POUR OU REMPLACE:" }],
      {
        name: "Fitment label",
        fontFamily: "Oswald",
        fontWeight: 600,
        fontSize: IN(0.072),
        color: K,
        templateLocked: true,
      },
    ),
  );
  els.push(
    TextElementSchema.parse({
      id: c.id("fits-list"),
      kind: "text",
      name: "Fits or replaces",
      frame: {
        x: safe.x,
        y: lowerTop + IN(0.16),
        w: bcX - safe.x - IN(0.1),
        h: bcH - IN(0.16),
      },
      fontFamily: "Oswald",
      fontWeight: 400,
      fontSize: IN(0.085),
      lineHeight: 12_500,
      color: K,
      transform: "uppercase",
      autoFit: { mode: "shrink", minFontSize: IN(0.055) },
      // One brand per line, as the reference sets it.
      paragraphs: [
        {
          runs: [
            {
              text: "",
              bold: false,
              italic: false,
              binding: bind("fitments", { joiner: "\n", hideWhenEmpty: true }),
            },
          ],
          spaceBefore: 0,
          spaceAfter: 0,
        },
      ],
    }),
  );

  els.push(
    BarcodeElementSchema.parse({
      id: c.id("barcode"),
      kind: "barcode",
      name: "UPC-A",
      frame: { x: bcX, y: lowerTop, w: bcW, h: bcH },
      symbology: "upca",
      binding: bind("identifiers.upc12"),
      magnification: 8_500,
      barHeight: IN(0.72),
      showHumanReadable: true,
      humanReadableFontSize: IN(0.085),
      showLightMarginIndicator: false,
      barColor: BLACK,
      quietZoneFill: PAPER,
      required: true,
      templateLocked: true,
    }),
  );

  els.push(
    ShapeElementSchema.parse({
      id: c.id("pack-box"),
      kind: "shape",
      shape: "rect",
      name: "Pack contents keyline",
      frame: { x: safe.x, y: boxTop, w: safe.w, h: boxH },
      fill: NONE,
      stroke: K,
      strokeWidth: IN(0.012),
      cornerRadius: 0,
      templateLocked: true,
    }),
  );
  els.push(
    ShapeElementSchema.parse({
      id: c.id("pack-rule-top"),
      kind: "shape",
      shape: "line",
      name: "Pack contents header rule",
      frame: { x: safe.x, y: boxTop + headerRowH, w: safe.w, h: IN(0.012) },
      fill: K,
      stroke: K,
      strokeWidth: IN(0.012),
      templateLocked: true,
    }),
  );
  els.push(
    ShapeElementSchema.parse({
      id: c.id("pack-rule-bottom"),
      kind: "shape",
      shape: "line",
      name: "Alternate numbers rule",
      frame: { x: safe.x, y: boxTop + boxH - altRowH, w: safe.w, h: IN(0.012) },
      fill: K,
      stroke: K,
      strokeWidth: IN(0.012),
      templateLocked: true,
    }),
  );
  els.push(
    text(
      c.id("pack-heading"),
      { x: safe.x + IN(0.06), y: boxTop, w: safe.w - IN(0.12), h: headerRowH },
      [{ text: "This Pack Includes:" }],
      {
        name: "Pack contents heading",
        fontFamily: "Oswald",
        fontWeight: 500,
        fontSize: IN(0.105),
        color: K,
        verticalAlign: "middle",
        templateLocked: true,
      },
    ),
  );
  els.push(
    BomListElementSchema.parse({
      id: c.id("pack-list"),
      kind: "bomList",
      name: "This pack includes",
      frame: {
        x: safe.x + IN(0.06),
        y: boxTop + headerRowH + IN(0.05),
        w: safe.w - IN(0.12),
        h: boxH - headerRowH - altRowH - IN(0.1),
      },
      showHeading: false,
      heading: "",
      fontFamily: "Oswald",
      fontWeight: 400,
      fontSize: IN(0.09),
      lineHeight: 13_000,
      color: K,
      columns: 1,
      itemTemplate: "{quantity}) {name} ({partNumber})",
      emptyText: "",
      autoFit: { mode: "shrink", minFontSize: IN(0.06) },
      required: true,
    }),
  );
  els.push(
    text(
      c.id("alternates"),
      { x: safe.x + IN(0.06), y: boxTop + boxH - altRowH, w: safe.w - IN(0.12), h: altRowH },
      [
        { text: "ALTERNATE PART NUMBERS", bold: true },
        { binding: bind("alternatePartNumbers", { joiner: " · ", prefix: "  ", hideWhenEmpty: true, transform: "uppercase" }) },
      ],
      {
        name: "Alternate part numbers",
        fontFamily: "Oswald",
        fontWeight: 500,
        fontSize: IN(0.095),
        color: K,
        align: "center",
        verticalAlign: "middle",
        autoFit: { mode: "shrink", minFontSize: IN(0.06) },
      },
    ),
  );

  /* ------------------------------------------------------------ footer */

  els.push(
    text(
      c.id("genuine"),
      { x: safe.x, y: footTop, w: Math.round(safe.w * 0.55), h: IN(0.2) },
      [{ text: "GENUINE PARTS" }],
      {
        name: "Genuine parts",
        fontFamily: "Oswald",
        fontWeight: 700,
        fontSize: IN(0.15),
        color: K,
        templateLocked: true,
      },
    ),
  );
  els.push(
    text(
      c.id("origin"),
      { x: safe.x, y: footTop + IN(0.21), w: Math.round(safe.w * 0.55), h: IN(0.14) },
      [
        {
          binding: bind("countryOfOrigin", {
            transform: "uppercase",
            suffix: " / HECHO EN CHINA / FABRIQUÉ EN CHINE",
            hideWhenEmpty: true,
          }),
        },
      ],
      {
        name: "Country of origin",
        fontFamily: "Oswald",
        fontWeight: 600,
        fontSize: IN(0.062),
        color: K,
        required: true,
        autoFit: { mode: "shrink", minFontSize: IN(0.045) },
      },
    ),
  );

  const warnX = safe.x + Math.round(safe.w * 0.58);
  els.push(
    text(
      c.id("warning"),
      { x: warnX, y: footTop + IN(0.02), w: safe.x + safe.w - warnX, h: IN(0.34) },
      [
        {
          binding: bind("warnings", {
            joiner: "  ",
            hideWhenEmpty: true,
            fallback: "",
          }),
        },
      ],
      {
        name: "Warnings",
        fontFamily: "Inter",
        fontWeight: 400,
        fontSize: IN(0.052),
        lineHeight: 12_000,
        color: K,
        align: "right",
        verticalAlign: "middle",
        visibleWhen: "warnings",
        autoFit: { mode: "shrink", minFontSize: IN(0.04) },
      },
    ),
  );

  return els;
}

export function buildAxleTekTemplate(
  presetCode: CardPresetDef["code"],
  prefix = "ax",
): DesignDoc {
  const preset = CARD_PRESETS[presetCode];
  const c: Ctx = {
    preset,
    bleed: bleedRect(preset),
    trim: trimRect(preset),
    safe: safeRect(preset),
    id: (s) => `${prefix}-${presetCode}-${s}`,
  };
  return DesignDocSchema.parse({
    version: 1,
    presetCode,
    front: CardSideSchema.parse({
      side: "front",
      colorIntent: "process",
      elements: buildFront(c),
    }),
    back: CardSideSchema.parse({
      side: "back",
      colorIntent: "grayscale",
      elements: buildBack(c),
    }),
  });
}

export const AXLETEK_TEMPLATE_DESCRIPTION =
  "Matches the supplied AxleTek 409TF reference: full-bleed black front with a white SKU tab on the top-right corner, centred product title over a French/Spanish keyline box, a periwinkle field carrying an oversized brand graphic, and a bilingual fitment footer band. Black-and-white back with an inverted SKU tab, a ruled This Pack Includes box closed by an ALTERNATE PART NUMBERS band, the bilingual fitment list beside a UPC-A, and GENUINE PARTS with the trilingual country-of-origin line opposite the Proposition 65 warning. The brand mark and the oversized brand graphic are left as empty editable slots — neither was supplied.";
