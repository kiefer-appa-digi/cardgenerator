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
import { CARD_PRESETS, safeRect, trimRect, bleedRect, type CardPresetDef } from "@/lib/geometry/presets";
import { NONE, TEXT_BLACK, cmykPct, grayPct } from "@/lib/color/types";
import { inToUpt } from "@/lib/units";
import { renderBarcode } from "@/lib/barcode";
import type { Rect } from "@/lib/geometry/types";

/**
 * MASTER TEMPLATES — the 11-500 benchmark (spec §23).
 *
 * These reproduce the *structure* of the supplied 11-500 sample, not its
 * artwork: a full-colour front carrying brand, part number, title, spec line,
 * multilingual copy, alternate numbers, a background band and a fitment footer;
 * and a black-and-white back carrying identity, a "This Pack Includes" list from
 * the BOM, alternate numbers, fitment, a genuine-parts statement, country of
 * origin, a vector UPC-A and a warning footer.
 *
 * Everything variable is bound to the product, so one template drives hundreds
 * of SKUs. Everything brand-critical is `templateLocked` so a designer working
 * on a generated card cannot move it.
 *
 * Geometry is expressed as fractions of the preset's safe area, which is why the
 * same builder produces a sensible 3.1175 in card and a sensible 4.3675 in card
 * without a separate hand-built layout per preset.
 */

const IN = inToUpt;

type Ctx = {
  preset: CardPresetDef;
  bleed: Rect;
  trim: Rect;
  safe: Rect;
  id: (s: string) => string;
};

function bind(
  path: string,
  extra: Partial<{
    fallback: string;
    prefix: string;
    suffix: string;
    transform: "none" | "uppercase" | "lowercase" | "titlecase";
    joiner: string;
    hideWhenEmpty: boolean;
  }> = {},
) {
  return {
    path,
    fallback: extra.fallback ?? "",
    prefix: extra.prefix ?? "",
    suffix: extra.suffix ?? "",
    transform: extra.transform ?? ("none" as const),
    joiner: extra.joiner ?? ", ",
    hideWhenEmpty: extra.hideWhenEmpty ?? false,
  };
}

function text(
  id: string,
  frame: Rect,
  runs: Array<{ text?: string; binding?: ReturnType<typeof bind>; bold?: boolean }>,
  opts: Partial<Parameters<typeof TextElementSchema.parse>[0]> = {},
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

/* -------------------------------------------------------------------- front */

function buildFront(c: Ctx) {
  const { safe, bleed, trim } = c;
  const els: DesignElement[] = [];
  const W = safe.w;

  // Full-bleed brand field. Extends through bleed on all four sides so trimming
  // can never expose paper (spec §16).
  els.push(
    ShapeElementSchema.parse({
      id: c.id("front-bg"),
      kind: "shape",
      shape: "rect",
      name: "Background field",
      frame: bleed,
      fill: cmykPct(78, 20, 0, 0),
      stroke: NONE,
      templateLocked: true,
    }),
  );

  // White card body, leaving a brand border that reads as a frame on shelf.
  const bodyInset = IN(0.1875);
  els.push(
    ShapeElementSchema.parse({
      id: c.id("front-body"),
      kind: "shape",
      shape: "rect",
      name: "Card body",
      frame: {
        x: trim.x + bodyInset,
        y: trim.y + bodyInset,
        w: trim.w - bodyInset * 2,
        h: trim.h - bodyInset * 2,
      },
      fill: cmykPct(0, 0, 0, 0),
      cornerRadius: IN(0.125),
      stroke: NONE,
      templateLocked: true,
    }),
  );

  let y = safe.y + IN(0.1);
  const logoH = Math.round(c.trim.h * 0.075);

  els.push(
    ImageElementSchema.parse({
      id: c.id("front-logo"),
      kind: "image",
      name: "Brand logo",
      frame: { x: safe.x + IN(0.06), y, w: Math.round(W * 0.62), h: logoH },
      fit: "fit",
      focalX: 0,
      templateLocked: true,
      required: true,
    }),
  );
  y += logoH + IN(0.08);

  // Part number: the single largest element on the front. On shelf this is what
  // a counter person reads from three feet away.
  const partH = Math.round(c.trim.h * 0.062);
  els.push(
    text(
      c.id("front-part"),
      { x: safe.x + IN(0.06), y, w: W - IN(0.12), h: partH },
      [{ binding: bind("partNumber", { transform: "uppercase" }) }],
      {
        name: "Part number",
        // Oswald: condensed enough that a long part number stays large, with
        // proper lining numerals. This is the element read from three feet away.
        fontFamily: "Oswald",
        fontWeight: 700,
        fontSize: Math.round(partH * 0.78),
        lineHeight: 10_500,
        color: cmykPct(0, 0, 0, 100),
        align: "left",
        verticalAlign: "middle",
        required: true,
        autoFit: { mode: "shrink", minFontSize: IN(0.12) },
      },
    ),
  );
  y += partH + IN(0.04);

  const titleH = Math.round(c.trim.h * 0.09);
  els.push(
    text(
      c.id("front-title"),
      { x: safe.x + IN(0.06), y, w: W - IN(0.12), h: titleH },
      [{ binding: bind("productName", { fallback: "", transform: "uppercase" }) }],
      {
        name: "Product title",
        // Bebas Neue has no lowercase — every glyph is a cap — so this block is
        // uppercase by construction, which is what the title wants anyway.
        fontFamily: "Bebas Neue",
        fontWeight: 400,
        fontSize: Math.round(titleH * 0.40),
        lineHeight: 11_000,
        color: cmykPct(78, 20, 0, 0),
        required: true,
        autoFit: { mode: "shrink", minFontSize: IN(0.09) },
      },
    ),
  );
  y += titleH + IN(0.02);

  const subH = Math.round(c.trim.h * 0.045);
  els.push(
    text(
      c.id("front-subtitle"),
      { x: safe.x + IN(0.06), y, w: W - IN(0.12), h: subH },
      [{ binding: bind("subtitle", { hideWhenEmpty: true }) }],
      {
        name: "Specification line",
        fontFamily: "Barlow Condensed",
        fontWeight: 600,
        fontSize: Math.round(subH * 0.44),
        color: grayPct(70),
        transform: "uppercase",
        tracking: Math.round(subH * 0.02),
        autoFit: { mode: "shrink", minFontSize: IN(0.075) },
      },
    ),
  );
  y += subH + IN(0.05);

  // The blocks below the artwork are laid out from the BOTTOM of the card
  // upwards, and the product image then takes whatever height is left. That is
  // what lets one builder produce a sensible layout on a 6.48 in card and a
  // 7.11 in card without a hand-tuned variant for each.
  const footH = Math.round(c.trim.h * 0.062);
  const footY = trim.y + trim.h - bodyInset - footH;

  const altH = IN(0.16);
  const altY = footY - IN(0.12) - altH;

  const mlH = Math.round(c.trim.h * 0.055);
  const mlY = altY - IN(0.05) - mlH;

  const photoTop = y;
  const photoH = Math.max(IN(0.5), mlY - IN(0.06) - photoTop);

  els.push(
    ImageElementSchema.parse({
      id: c.id("front-photo"),
      kind: "image",
      name: "Product image",
      frame: { x: safe.x + IN(0.06), y: photoTop, w: W - IN(0.12), h: photoH },
      fit: "fit",
      editableRegion: true,
    }),
  );

  // Multilingual copy — the sample carries English, Spanish and French.
  els.push(
    TextElementSchema.parse({
      id: c.id("front-multilingual"),
      kind: "text",
      name: "Multilingual title",
      frame: { x: safe.x + IN(0.06), y: mlY, w: W - IN(0.12), h: mlH },
      fontFamily: "Barlow Condensed",
      fontWeight: 500,
      fontSize: Math.round(mlH * 0.3),
      lineHeight: 11_500,
      color: grayPct(65),
      autoFit: { mode: "shrink", minFontSize: IN(0.06) },
      paragraphs: [
        {
          runs: [
            { text: "ES  ", bold: true, italic: false },
            { text: "", bold: false, italic: false, binding: bind("translations.es.productName", { hideWhenEmpty: true }) },
          ],
          spaceBefore: 0,
          spaceAfter: 0,
        },
        {
          runs: [
            { text: "FR  ", bold: true, italic: false },
            { text: "", bold: false, italic: false, binding: bind("translations.fr.productName", { hideWhenEmpty: true }) },
          ],
          spaceBefore: 0,
          spaceAfter: 0,
        },
      ],
    }),
  );

  els.push(
    text(
      c.id("front-alternates"),
      { x: safe.x + IN(0.06), y: altY, w: W - IN(0.12), h: altH },
      [
        { text: "ALSO SOLD AS  ", bold: true },
        { binding: bind("alternatePartNumbers", { joiner: " · ", hideWhenEmpty: true }) },
      ],
      {
        name: "Alternate part numbers",
        fontFamily: "Barlow Condensed",
        fontWeight: 500,
        fontSize: IN(0.085),
        color: grayPct(60),
        verticalAlign: "middle",
        visibleWhen: "alternatePartNumbers",
        autoFit: { mode: "shrink", minFontSize: IN(0.06) },
      },
    ),
  );

  // Fitment footer, reversed out of the brand band at the foot of the card.
  els.push(
    ShapeElementSchema.parse({
      id: c.id("front-foot-band"),
      kind: "shape",
      shape: "rect",
      name: "Fitment band",
      frame: { x: trim.x + bodyInset, y: footY, w: trim.w - bodyInset * 2, h: footH },
      fill: cmykPct(78, 20, 0, 0),
      stroke: NONE,
      cornerRadius: IN(0.06),
      templateLocked: true,
    }),
  );
  els.push(
    text(
      c.id("front-fitment"),
      { x: trim.x + bodyInset + IN(0.08), y: footY, w: trim.w - bodyInset * 2 - IN(0.16), h: footH },
      [{ binding: bind("fitments", { joiner: "  ·  ", hideWhenEmpty: true }) }],
      {
        name: "Fits / replaces",
        fontFamily: "Barlow Condensed",
        fontWeight: 600,
        fontSize: Math.round(footH * 0.26),
        lineHeight: 11_000,
        color: cmykPct(0, 0, 0, 0),
        verticalAlign: "middle",
        transform: "uppercase",
        autoFit: { mode: "shrink", minFontSize: IN(0.055) },
      },
    ),
  );

  return els;
}

/* --------------------------------------------------------------------- back */

function buildBack(c: Ctx) {
  const { safe, trim } = c;
  const els: DesignElement[] = [];
  const W = safe.w;
  const K = grayPct(100);

  let y = safe.y + IN(0.05);
  const logoH = Math.round(trim.h * 0.05);
  els.push(
    ImageElementSchema.parse({
      id: c.id("back-logo"),
      kind: "image",
      name: "Brand logo (mono)",
      frame: { x: safe.x, y, w: Math.round(W * 0.45), h: logoH },
      fit: "fit",
      focalX: 0,
      templateLocked: true,
    }),
  );
  els.push(
    text(
      c.id("back-part"),
      { x: safe.x + Math.round(W * 0.5), y, w: Math.round(W * 0.5), h: logoH },
      [{ binding: bind("partNumber", { transform: "uppercase" }) }],
      {
        name: "Part number",
        // Oswald: condensed enough that a long part number stays large, with
        // proper lining numerals. This is the element read from three feet away.
        fontFamily: "Oswald",
        fontWeight: 700,
        fontSize: Math.round(logoH * 0.62),
        color: K,
        align: "right",
        verticalAlign: "middle",
        required: true,
        autoFit: { mode: "shrink", minFontSize: IN(0.09) },
      },
    ),
  );
  y += logoH + IN(0.05);

  els.push(
    ShapeElementSchema.parse({
      id: c.id("back-rule-1"),
      kind: "shape",
      shape: "line",
      name: "Rule",
      frame: { x: safe.x, y, w: W, h: IN(0.012) },
      fill: K,
      stroke: K,
      strokeWidth: IN(0.012),
      templateLocked: true,
    }),
  );
  y += IN(0.1);

  const titleH = Math.round(trim.h * 0.055);
  els.push(
    text(
      c.id("back-title"),
      { x: safe.x, y, w: W, h: titleH },
      [{ binding: bind("description") }],
      {
        name: "Description",
        fontFamily: "Inter",
        fontWeight: 700,
        fontSize: Math.round(titleH * 0.3),
        lineHeight: 12_000,
        color: K,
        required: true,
        autoFit: { mode: "shrink", minFontSize: IN(0.07) },
      },
    ),
  );
  y += titleH + IN(0.03);

  // Multilingual identity line.
  els.push(
    TextElementSchema.parse({
      id: c.id("back-multilingual"),
      kind: "text",
      name: "Multilingual identity",
      frame: { x: safe.x, y, w: W, h: IN(0.28) },
      fontFamily: "Inter",
      fontWeight: 400,
      fontSize: IN(0.075),
      lineHeight: 12_500,
      color: grayPct(75),
      autoFit: { mode: "shrink", minFontSize: IN(0.055) },
      paragraphs: [
        {
          runs: [
            { text: "ES ", bold: true, italic: false },
            { text: "", bold: false, italic: false, binding: bind("translations.es.productName", { hideWhenEmpty: true }) },
          ],
          spaceBefore: 0,
          spaceAfter: 0,
        },
        {
          runs: [
            { text: "FR ", bold: true, italic: false },
            { text: "", bold: false, italic: false, binding: bind("translations.fr.productName", { hideWhenEmpty: true }) },
          ],
          spaceBefore: 0,
          spaceAfter: 0,
        },
      ],
    }),
  );
  y += IN(0.32);

  // Everything from the alternate-numbers block down is laid out from the
  // BOTTOM of the card upwards, and the pack-contents list then takes whatever
  // height is left. The BOM is the block that actually varies between SKUs — a
  // two-line kit and a fourteen-line kit both have to fit — so it is the one
  // that should absorb the slack.
  // The barcode frame is sized from the engine's own output rather than from a
  // remembered nominal, so the frame can never be a little too small and clip
  // the guard descenders or the human-readable digits.
  const BARCODE_BAR_HEIGHT = IN(1.02);
  const BARCODE_HR_SIZE = IN(0.1);
  const probe = renderBarcode({
    symbology: "upca",
    value: "000000000000",
    magnificationBps: 10_000,
    barHeight: BARCODE_BAR_HEIGHT,
    showHumanReadable: true,
    humanReadableFontSize: BARCODE_HR_SIZE,
    showLightMarginIndicator: true,
  });
  const bcW = probe.ok ? probe.render.width : IN(1.469);
  const bcH = probe.ok ? probe.render.height : IN(1.2);
  // Inset from the safe edge rather than flush with it: the quiet-zone box is a
  // rectangle, and a rectangle sitting exactly in the corner of the safe area
  // pokes past the safe area's own arc. A barcode is the one element where that
  // matters — a trimmed quiet zone is the commonest cause of a symbol that will
  // not scan — so it is moved clear rather than argued with.
  const bcX = safe.x + IN(0.06);
  const bcY = trim.y + trim.h - IN(0.28) - bcH;

  const genuineH = IN(0.34);
  const fitH = IN(0.3);

  const altH = IN(0.2);

  // The pack-contents block gets a generous fixed share of the card and the
  // three text blocks flow directly under it, so the unavoidable whitespace on a
  // short-BOM card collects above the barcode rather than opening a hole in the
  // middle of the copy. The block is still clamped to what is actually
  // available, and an overflowing BOM raises a blocking preflight error rather
  // than clipping.
  const bomTop = y;
  const flowHeight = altH + IN(0.06) + fitH + IN(0.06) + genuineH;
  const available = Math.max(IN(0.6), bcY - IN(0.16) - bomTop);
  const bomH = Math.max(
    IN(0.6),
    Math.min(Math.round(trim.h * 0.24), available - flowHeight - IN(0.08)),
  );

  const altY = bomTop + bomH + IN(0.08);
  const fitY2 = altY + altH + IN(0.06);
  const genuineY2 = fitY2 + fitH + IN(0.06);

  els.push(
    BomListElementSchema.parse({
      id: c.id("back-bom"),
      kind: "bomList",
      name: "This pack includes",
      frame: { x: safe.x, y: bomTop, w: W, h: bomH },
      heading: "THIS PACK INCLUDES:",
      showHeading: true,
      headingFontSize: IN(0.1),
      headingFontWeight: 600,
      fontFamily: "Barlow Condensed",
      fontWeight: 500,
      fontSize: IN(0.085),
      lineHeight: 12_500,
      color: K,
      columns: c.preset.code === "206TF" ? 1 : 2,
      itemTemplate: "{quantity}) {name} ({partNumber})",
      emptyText: "",
      autoFit: { mode: "shrink", minFontSize: IN(0.06) },
      required: true,
    }),
  );

  els.push(
    text(
      c.id("back-alternates"),
      { x: safe.x, y: altY, w: W, h: altH },
      [
        { text: "ALTERNATE PART NUMBERS: ", bold: true },
        { binding: bind("alternatePartNumbers", { joiner: " · ", hideWhenEmpty: true }) },
      ],
      {
        name: "Alternate part numbers",
        fontFamily: "Barlow Condensed",
        fontWeight: 500,
        fontSize: IN(0.08),
        lineHeight: 12_000,
        color: K,
        visibleWhen: "alternatePartNumbers",
        autoFit: { mode: "shrink", minFontSize: IN(0.055) },
      },
    ),
  );

  els.push(
    text(
      c.id("back-fitment"),
      { x: safe.x, y: fitY2, w: W, h: fitH },
      [
        { text: "FITS OR REPLACES: ", bold: true },
        { binding: bind("fitments", { joiner: " · ", hideWhenEmpty: true }) },
      ],
      {
        name: "Fits or replaces",
        fontFamily: "Barlow Condensed",
        fontWeight: 500,
        fontSize: IN(0.08),
        lineHeight: 12_000,
        color: K,
        visibleWhen: "fitments",
        autoFit: { mode: "shrink", minFontSize: IN(0.055) },
      },
    ),
  );

  els.push(
    text(
      c.id("back-genuine"),
      { x: safe.x, y: genuineY2, w: W, h: genuineH },
      [{ binding: bind("brand.statement", { hideWhenEmpty: true }) }],
      {
        name: "Genuine parts statement",
        fontFamily: "Inter",
        fontWeight: 400,
        fontSize: IN(0.07),
        lineHeight: 13_000,
        color: grayPct(80),
        autoFit: { mode: "shrink", minFontSize: IN(0.05) },
      },
    ),
  );

  // The UPC-A block sits bottom-left; country of origin, GTIN and the warning
  // fill the space beside it. At 100 % magnification a UPC-A is 1.469 in wide
  // including both quiet zones.
  els.push(
    BarcodeElementSchema.parse({
      id: c.id("back-barcode"),
      kind: "barcode",
      name: "UPC-A",
      frame: { x: bcX, y: bcY, w: bcW, h: bcH },
      symbology: "upca",
      binding: bind("identifiers.upc12"),
      magnification: 10_000,
      barHeight: BARCODE_BAR_HEIGHT,
      showHumanReadable: true,
      humanReadableFontSize: BARCODE_HR_SIZE,
      showLightMarginIndicator: true,
      barColor: TEXT_BLACK,
      // A white quiet zone rather than "none": the bar/space contrast a scanner
      // needs must be guaranteed by the artwork, not by whatever sits behind it.
      quietZoneFill: cmykPct(0, 0, 0, 0),
      required: true,
      templateLocked: true,
    }),
  );

  const rightX = bcX + bcW + IN(0.1);
  const rightW = Math.max(IN(0.5), safe.x + safe.w - rightX);

  els.push(
    text(
      c.id("back-origin"),
      { x: rightX, y: bcY, w: rightW, h: IN(0.2) },
      [{ binding: bind("countryOfOrigin", { transform: "uppercase" }) }],
      {
        name: "Country of origin",
        fontFamily: "Inter",
        fontWeight: 700,
        fontSize: IN(0.08),
        color: K,
        align: "right",
        required: true,
        autoFit: { mode: "shrink", minFontSize: IN(0.055) },
      },
    ),
  );

  els.push(
    text(
      c.id("back-gtin"),
      { x: rightX, y: bcY + IN(0.22), w: rightW, h: IN(0.16) },
      [{ text: "GTIN " }, { binding: bind("identifiers.gtin14") }],
      {
        name: "GTIN",
        fontFamily: "Inter",
        fontWeight: 400,
        fontSize: IN(0.065),
        color: grayPct(70),
        align: "right",
        autoFit: { mode: "shrink", minFontSize: IN(0.05) },
      },
    ),
  );

  els.push(
    text(
      c.id("back-warning"),
      { x: rightX, y: bcY + IN(0.42), w: rightW, h: bcH - IN(0.42) },
      [{ binding: bind("warnings", { joiner: "  ", hideWhenEmpty: true }) }],
      {
        name: "Warnings",
        fontFamily: "Inter",
        fontWeight: 400,
        fontSize: IN(0.055),
        lineHeight: 12_000,
        color: K,
        align: "right",
        verticalAlign: "bottom",
        visibleWhen: "warnings",
        autoFit: { mode: "shrink", minFontSize: IN(0.042) },
      },
    ),
  );

  // Above the barcode, not along the foot of the card: a full-width footer at
  // the bottom edge runs straight through the symbol's left quiet zone, which
  // is the one part of a barcode that must stay clear of everything.
  els.push(
    text(
      c.id("back-brandfoot"),
      { x: safe.x, y: genuineY2 + genuineH + IN(0.04), w: W, h: IN(0.14) },
      [{ binding: bind("brand.legalName", { fallback: "" }) }],
      {
        name: "Legal footer",
        fontFamily: "Inter",
        fontWeight: 400,
        fontSize: IN(0.055),
        color: grayPct(60),
        templateLocked: true,
        autoFit: { mode: "shrink", minFontSize: IN(0.045) },
      },
    ),
  );

  return els;
}

/**
 * Build the 11-500-structure master template for a preset.
 * `prefix` keeps element ids unique when several templates coexist in one org.
 */
export function buildMasterTemplate(
  presetCode: CardPresetDef["code"],
  prefix = "m",
): DesignDoc {
  const preset = CARD_PRESETS[presetCode];
  const c: Ctx = {
    preset,
    bleed: bleedRect(preset),
    trim: trimRect(preset),
    safe: safeRect(preset),
    id: (s: string) => `${prefix}-${presetCode}-${s}`,
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

/** A blank card that still carries the preset's paper and colour intents. */
export function buildBlankTemplate(presetCode: CardPresetDef["code"]): DesignDoc {
  return DesignDocSchema.parse({
    version: 1,
    presetCode,
    front: CardSideSchema.parse({ side: "front", colorIntent: "process" }),
    back: CardSideSchema.parse({ side: "back", colorIntent: "grayscale" }),
  });
}

export const MASTER_TEMPLATE_DESCRIPTION =
  "Reproduces the structure of the supplied 11-500 sample: full-colour front with brand, part number, title, specification line, multilingual copy, alternate numbers, product image and a fitment footer; black-and-white back with identity, a BOM-driven pack-contents list, alternate numbers, fitment, a genuine-parts statement, country of origin, a vector UPC-A and a warning footer.";
