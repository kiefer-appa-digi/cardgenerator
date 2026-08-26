import { uptToIn, type Upt } from "@/lib/units";
import {
  rectContains,
  rectIntersection,
  rectIntersects,
  type Rect,
} from "@/lib/geometry/types";
import { TINT_MAX, toCmyk, totalAreaCoverage, type PrintColor } from "@/lib/color/types";
import {
  NOMINAL_UPCA_BAR_HEIGHT_UPT,
  NOTE_BAR_HEIGHT_TRUNCATED,
  metricsFor,
  normaliseEan13,
  normaliseGtin14,
  normaliseUpcA,
} from "@/lib/barcode";
import { calculateCheckDigit, isDigits, sanitiseDigits } from "@/lib/barcode/gtin";
import { resolveBindingText } from "@/lib/data/binding";
import type { BarcodeElement, BarcodeSymbology } from "@/lib/design/schema";
import type { BarcodeOp, DrawOp } from "@/lib/design/render";
import type { GtinResult } from "@/lib/barcode/gtin";
import type { PreflightFinding } from "../types";
import {
  at,
  bpsPct,
  describeColor,
  finding,
  inNum,
  inches,
  opDarkestColor,
  opPaintBounds,
  opPaintsInk,
  pct,
  redBandReflectance,
  rotatedTo,
  type PreflightContext,
} from "./context";

/**
 * BARCODE CHECKS — spec §12, §21.
 *
 * A card with an unscannable symbol is scrap, and the failure is invisible on
 * screen: the bars look like bars whatever colour they are and whatever is
 * printed next to them. Everything here is measured off the rendered symbol the
 * PDF writer will draw, so quiet zones, magnification and bar height are the
 * real ones rather than the requested ones.
 */

/** Symbologies whose value is a GTIN, and therefore has a check digit to verify. */
const GTIN_SYMBOLOGIES: ReadonlySet<BarcodeSymbology> = new Set([
  "upca",
  "ean13",
  "gs1-digital-link",
]);

/** What a prepress operator calls each symbology, rather than the enum spelling. */
const SYMBOLOGY_LABEL: Record<BarcodeSymbology, string> = {
  upca: "UPC-A",
  ean13: "EAN-13",
  "gs1-128": "GS1-128",
  qr: "QR",
  "gs1-digital-link": "GS1 Digital Link",
};

function barcodeElement(ctx: PreflightContext, elementId: string): BarcodeElement | null {
  const el = ctx.elements.get(elementId);
  return el && el.kind === "barcode" ? el : null;
}

/** The value the plan encoded, resolved the same way planSide() resolved it. */
function resolvedValue(ctx: PreflightContext, el: BarcodeElement): string {
  return el.binding ? resolveBindingText(el.binding, ctx.product) : el.value;
}

function normaliseFor(symbology: BarcodeSymbology, value: string): GtinResult | null {
  switch (symbology) {
    case "upca":
      return normaliseUpcA(value);
    case "ean13":
      return normaliseEan13(value);
    case "gs1-digital-link":
      // A supplied absolute URI is encoded verbatim; only a bare identifier is a GTIN.
      return /^https?:\/\//i.test(value.trim()) ? null : normaliseGtin14(value);
    default:
      return null;
  }
}

/* ----------------------------------------------------------- value / GTIN */

function checkValue(ctx: PreflightContext, op: BarcodeOp, el: BarcodeElement): PreflightFinding[] {
  const raw = resolvedValue(ctx, el);
  const trimmed = raw.trim();
  const bounds = opPaintBounds(op);
  const isGtin = GTIN_SYMBOLOGIES.has(el.symbology);

  if (trimmed === "") {
    return [
      finding({
        code: isGtin ? "GTIN_MISSING" : "BARCODE_VALUE_INVALID",
        severity: "blocking",
        title: isGtin ? "Barcode has no GTIN to encode" : "Barcode has no value to encode",
        detail:
          `The ${SYMBOLOGY_LABEL[el.symbology]} element resolved to an empty value` +
          (el.binding ? ` from "${el.binding.path}" on product "${ctx.product.partNumber || ctx.product.id || "(unidentified)"}"` : " and no static value is set") +
          `, so no symbol was generated and the ${inches(el.frame.w)} × ${inches(el.frame.h)} frame ` +
          `images as empty space.`,
        remedy: el.binding
          ? `Populate "${el.binding.path}" on the product record. Do not type a number into the element as a one-off — the next product through the template will be wrong in the same way.`
          : "Bind the element to the product's identifier field, or enter the value on the element if this card really is a one-off.",
        ...at(ctx, op.elementId, bounds),
        measurements: { symbology: el.symbology, boundPath: el.binding?.path ?? "(static)" },
      }),
    ];
  }

  const norm = normaliseFor(el.symbology, trimmed);
  if (norm && !norm.ok) {
    const digits = sanitiseDigits(trimmed);
    const expected =
      isDigits(digits) && digits.length >= 2 ? calculateCheckDigit(digits.slice(0, -1)) : null;
    return [
      finding({
        code: "GTIN_INVALID",
        severity: "blocking",
        title: `GTIN "${trimmed}" is not valid for ${SYMBOLOGY_LABEL[el.symbology]}`,
        detail:
          `${norm.error.message}. The value was read as "${digits}" (${digits.length} digit(s)) after ` +
          `stripping separators` +
          (expected !== null && norm.error.code === "BAD_CHECK_DIGIT"
            ? `; the correct check digit for body "${digits.slice(0, -1)}" is ${expected}.`
            : ".") +
          ` No symbol was generated. Nothing here corrects the value automatically: a GTIN with a wrong ` +
          `check digit is a data defect upstream, and printing a silently corrected one would hide it on ` +
          `the whole run.`,
        remedy:
          norm.error.code === "BAD_CHECK_DIGIT"
            ? `Correct the identifier at source — in the product record and in whatever exported it — then re-run. Only apply the computed check digit ${expected ?? ""} once someone has confirmed the body digits are the right ones.`
            : `Correct the identifier at source so it is a valid ${SYMBOLOGY_LABEL[el.symbology]} value, then re-run preflight.`,
        ...at(ctx, op.elementId, bounds),
        measurements: {
          value: trimmed,
          digits: digits.length,
          errorCode: norm.error.code,
          expectedCheckDigit: expected ?? "n/a",
        },
      }),
    ];
  }

  if (op.error !== null) {
    return [
      finding({
        code: "BARCODE_VALUE_INVALID",
        severity: "blocking",
        title: `${SYMBOLOGY_LABEL[el.symbology]} value could not be encoded`,
        detail:
          `The encoder rejected "${trimmed}": ${op.error}. No bars were produced, so the frame at ` +
          `(${inches(el.frame.x)}, ${inches(el.frame.y)}) images as empty space.`,
        remedy:
          "Correct the value to something the symbology accepts — check the character set and the length limits for this symbology — or change the element to a symbology that can carry it.",
        ...at(ctx, op.elementId, bounds),
        measurements: { symbology: el.symbology, value: trimmed },
      }),
    ];
  }

  return [];
}

/* ------------------------------------------------------------------ size */

function checkSize(ctx: PreflightContext, op: BarcodeOp, el: BarcodeElement): PreflightFinding[] {
  const render = op.render;
  if (!render) return [];
  const out: PreflightFinding[] = [];
  const metrics = metricsFor(el.symbology);
  const effBps = Math.round((render.moduleWidth * 10_000) / metrics.nominalX);
  const bounds = opPaintBounds(op);

  // The profile's bounds are written for EAN/UPC at retail POS; other
  // symbologies are judged against their own standard's range instead of having
  // a retail rule applied to them by accident.
  const retail = el.symbology === "upca" || el.symbology === "ean13";
  const minBps = retail ? ctx.profile.barcodeMinMagnificationBps : metrics.minBps;
  const maxBps = retail ? ctx.profile.barcodeMaxMagnificationBps : metrics.maxBps;

  const totalModules = render.moduleWidth > 0 ? Math.round(render.width / render.moduleWidth) : 0;
  const minWidth = totalModules * Math.round((metrics.nominalX * minBps) / 10_000);
  const maxWidth = totalModules * Math.round((metrics.nominalX * maxBps) / 10_000);

  if (effBps < minBps || effBps > maxBps) {
    out.push(
      finding({
        code: "BARCODE_SIZE",
        severity: "error",
        title: `Barcode is printed at ${bpsPct(effBps)} of nominal`,
        detail:
          `The symbol's X-dimension is ${inches(render.moduleWidth)} against a nominal ` +
          `${inches(metrics.nominalX)}, which is ${bpsPct(effBps)} magnification — outside the ` +
          `${bpsPct(minBps)}–${bpsPct(maxBps)} range ${retail ? `the "${ctx.profile.name}" profile allows` : "the standard defines for this symbology"}. ` +
          `The symbol measures ${inches(render.width)} wide including quiet zones; the permitted range at ` +
          `this module count is ${inches(minWidth)}–${inches(maxWidth)}.`,
        remedy:
          `Set the element's magnification between ${bpsPct(minBps)} and ${bpsPct(maxBps)}, which puts the ` +
          `printed width between ${inches(minWidth)} and ${inches(maxWidth)}, and re-fit the surrounding ` +
          `layout to it rather than scaling the symbol to fit the layout.`,
        ...at(ctx, op.elementId, bounds),
        measurements: {
          magnificationBps: effBps,
          minBps,
          maxBps,
          widthIn: inNum(render.width),
          minWidthIn: inNum(minWidth),
          maxWidthIn: inNum(maxWidth),
          moduleWidthIn: inNum(render.moduleWidth),
        },
      }),
    );
  } else if (effBps !== el.magnification) {
    out.push(
      finding({
        code: "BARCODE_SIZE",
        severity: "warning",
        title: `Barcode magnification was adjusted to ${bpsPct(effBps)}`,
        detail:
          `The element asks for ${bpsPct(el.magnification)} but the symbol was generated at ` +
          `${bpsPct(effBps)} (X = ${inches(render.moduleWidth)}, total width ${inches(render.width)}). ` +
          `Notes from the encoder: ${render.notes.length ? render.notes.join("; ") : "none"}.`,
        remedy:
          `Set the element's magnification to ${bpsPct(effBps)} so the document says what will actually ` +
          `print, or change the constraint (frame width, fit target) that forced the adjustment.`,
        ...at(ctx, op.elementId, bounds),
        measurements: {
          requestedBps: el.magnification,
          producedBps: effBps,
          widthIn: inNum(render.width),
        },
      }),
    );
  }

  /* ------------------------------------------------------- bar height */

  if (render.notes.includes(NOTE_BAR_HEIGHT_TRUNCATED)) {
    const nominal =
      retail ? Math.round((NOMINAL_UPCA_BAR_HEIGHT_UPT * effBps) / 10_000) : null;
    out.push(
      finding({
        code: "BARCODE_TRUNCATED_HEIGHT",
        severity: "warning",
        title: "Bar height is truncated below nominal",
        detail:
          `Bars are ${inches(el.barHeight)} tall` +
          (nominal !== null
            ? ` against a nominal ${inches(nominal)} at ${bpsPct(effBps)} magnification — ` +
              `${Math.round((el.barHeight / nominal) * 100)} % of full height`
            : "") +
          `. Truncation is permitted by the standard but it removes the vertical redundancy a scanner ` +
          `relies on, so a wrapped or scuffed card takes more attempts at the till.`,
        remedy:
          nominal !== null
            ? `Restore the bar height to ${inches(nominal)} unless the pack physically cannot carry it. If it cannot, get the truncated symbol verified on printed stock before the run.`
            : "Restore full bar height for this symbology, or have the truncated symbol verified on printed stock before the run.",
        ...at(ctx, op.elementId, bounds),
        measurements: {
          barHeightIn: inNum(el.barHeight),
          nominalHeightIn: nominal === null ? "unknown" : inNum(nominal),
        },
      }),
    );
  }

  return out;
}

/* --------------------------------------------------------------- clipping */

function checkClipping(ctx: PreflightContext, op: BarcodeOp, el: BarcodeElement): PreflightFinding[] {
  if (!op.render) return [];
  const out: PreflightFinding[] = [];
  const box = rotatedTo(op.quietBox, op);

  if (!rectContains(ctx.plan.trim, box)) {
    const inside = rectIntersection(box, ctx.plan.trim);
    const lostIn = inside
      ? Number((uptToIn(box.w) * uptToIn(box.h) - uptToIn(inside.w) * uptToIn(inside.h)).toFixed(4))
      : Number((uptToIn(box.w) * uptToIn(box.h)).toFixed(4));
    out.push(
      finding({
        code: "BARCODE_CLIPPED",
        severity: "error",
        title: "Barcode runs off the trimmed card",
        detail:
          `The symbol box is ${inches(box.w)} × ${inches(box.h)} at (${inches(box.x)}, ${inches(box.y)}) ` +
          `and the trim box is ${inches(ctx.plan.trim.w)} × ${inches(ctx.plan.trim.h)} at ` +
          `(${inches(ctx.plan.trim.x)}, ${inches(ctx.plan.trim.y)}); ${lostIn} in² of the symbol is ` +
          `outside it and is cut away at trim.`,
        remedy:
          `Move the symbol fully inside the trim box — ideally inside the safe area at ` +
          `(${inches(ctx.plan.safe.x)}, ${inches(ctx.plan.safe.y)}) — or reduce magnification until the ` +
          `whole quiet-zone box fits.`,
        ...at(ctx, op.elementId, box),
        measurements: { lostAreaSqIn: lostIn, widthIn: inNum(box.w), heightIn: inNum(box.h) },
      }),
    );
  } else if (!rectContains(el.frame, op.quietBox)) {
    out.push(
      finding({
        code: "BARCODE_CLIPPED",
        severity: "warning",
        title: "Symbol is larger than its element frame",
        detail:
          `The generated symbol is ${inches(op.quietBox.w)} × ${inches(op.quietBox.h)} but the element ` +
          `frame is ${inches(el.frame.w)} × ${inches(el.frame.h)}. The symbol is drawn from the frame's ` +
          `top-left corner at its true size, so it overhangs the frame and the frame no longer describes ` +
          `what prints — snapping, alignment and any layout built around the frame are all off by the ` +
          `difference.`,
        remedy:
          `Resize the element frame to ${inches(op.quietBox.w)} × ${inches(op.quietBox.h)} so the ` +
          `document geometry matches the symbol, or lower the magnification until the symbol fits the ` +
          `frame you want.`,
        ...at(ctx, op.elementId, rotatedTo(op.quietBox, op)),
        measurements: {
          symbolWidthIn: inNum(op.quietBox.w),
          symbolHeightIn: inNum(op.quietBox.h),
          frameWidthIn: inNum(el.frame.w),
          frameHeightIn: inNum(el.frame.h),
        },
      }),
    );
  }

  return out;
}

/* ------------------------------------------------------------- quiet zone */

/** Is the quiet-zone box painted opaquely by the barcode's own background fill? */
function quietZoneIsMasked(op: BarcodeOp): boolean {
  return op.quietZoneFill.space !== "none" && op.opacity >= 10_000;
}

/**
 * THE BARS, AND THE REGION THAT HAS TO STAY CLEAR AROUND THEM.
 *
 * `op.symbolBox` is not the bars. `planBarcode()` derives it as the symbol box
 * less the render's quiet zones, and for UPC-A, EAN-13 and GS1-128 the engine
 * reports `quietTop = quietBottom = 0` while `render.height` includes the
 * human-readable band under the bars. So `symbolBox` spans the digits too, and
 * treating it as "the bars" reports a caption grazing the bottom of the HRI row
 * as an element "painted over the bars … changing the widths the scanner
 * measures" — which is not true, and which fired on this application's own
 * master template for all three presets.
 *
 * Both boxes are therefore measured off `render.bars`, whose coordinates are
 * quiet-zone-inclusive with the origin at the symbol box's top-left:
 *
 *   barsBox   the ink a scanner reads.
 *   clearBox  the bars plus the quiet zones the standard actually specifies —
 *             full symbol width, and the bar band grown by quietTop/quietBottom.
 *             For EAN/UPC those are zero, so the HRI band is correctly outside
 *             it: nothing is required to be clear below the bars.
 */
function barGeometry(op: BarcodeOp): { bars: Rect; clear: Rect } {
  const render = op.render;
  if (!render || render.bars.length === 0) {
    return { bars: op.symbolBox, clear: op.quietBox };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const b of render.bars) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  const bars: Rect = {
    x: op.origin.x + minX,
    y: op.origin.y + minY,
    w: maxX - minX,
    h: maxY - minY,
  };
  const top = Math.max(op.quietBox.y, bars.y - render.quietTop);
  const bottom = Math.min(op.quietBox.y + op.quietBox.h, bars.y + bars.h + render.quietBottom);
  return {
    bars,
    clear: {
      x: op.quietBox.x,
      y: top,
      w: op.quietBox.w,
      h: Math.max(0, bottom - top),
    },
  };
}

/**
 * Anything printed in the quiet zone is a mark the scanner has to discount.
 *
 * The judgement is not "does something overlap" — a white panel behind the
 * symbol overlaps it and is exactly right — it is "does something overlap that
 * the scanner will read as a bar". So the test is z-order plus red-band
 * reflectance: ink laid over the bars is fatal whatever colour it is, ink in the
 * quiet ring is fatal when it is dark, and art underneath is irrelevant when the
 * element paints its own opaque quiet zone over it.
 */
function checkQuietZone(ctx: PreflightContext, op: BarcodeOp): PreflightFinding[] {
  if (!op.render) return [];
  const out: PreflightFinding[] = [];
  const geometry = barGeometry(op);
  const quiet = rotatedTo(geometry.clear, op);
  const symbol = rotatedTo(geometry.bars, op);
  const masked = quietZoneIsMasked(op);
  const barReflectance = redBandReflectance(op.barColor);
  const moduleWidth: Upt = op.render.moduleWidth;

  for (const other of ctx.plan.ops) {
    if (other.elementId === op.elementId) continue;
    if (!opPaintsInk(other)) continue;
    const bounds = opPaintBounds(other);
    if (!rectIntersects(bounds, quiet)) continue;

    const above = other.z > op.z;
    if (!above && masked) continue; // The element's own quiet-zone fill covers it.

    const overlap = rectIntersection(bounds, quiet);
    if (!overlap) continue;
    const overBars = rectIntersects(bounds, symbol);
    const color: PrintColor | null = other.op === "image" ? null : opDarkestColor(other);

    if (above && overBars) {
      out.push(
        finding({
          code: "BARCODE_QUIET_ZONE",
          severity: "error",
          title: "Element is painted over the bars",
          detail:
            `"${ctx.labels.get(other.elementId) ?? other.elementId}" paints after the symbol and covers ` +
            `${inches(overlap.w)} × ${inches(overlap.h)} of it, overlapping the bars themselves. Whatever ` +
            `its colour, it changes the widths the scanner measures.`,
          remedy:
            `Move "${ctx.labels.get(other.elementId) ?? other.elementId}" off the symbol, or send it behind ` +
            `the barcode and give the barcode an opaque quiet-zone fill so nothing shows through.`,
          ...at(ctx, op.elementId, overlap),
          measurements: {
            intruder: ctx.labels.get(other.elementId) ?? other.elementId,
            overlapWidthIn: inNum(overlap.w),
            overlapHeightIn: inNum(overlap.h),
          },
        }),
      );
      continue;
    }

    if (color === null) {
      out.push(
        finding({
          code: "BARCODE_QUIET_ZONE",
          severity: "warning",
          title: "A placed image lies in the barcode quiet zone",
          detail:
            `"${ctx.labels.get(other.elementId) ?? other.elementId}" covers ${inches(overlap.w)} × ` +
            `${inches(overlap.h)} of the quiet zone ${above ? "on top of" : "underneath"} the symbol. The ` +
            `ink values inside a raster cannot be read from its metadata, so preflight cannot tell whether ` +
            `that area is light enough — this is not a pass.`,
          remedy:
            `Put an opaque light panel behind the symbol (set the element's quiet-zone fill), or move the ` +
            `symbol onto plain stock. If the image really is light there, have it checked on a printed ` +
            `proof with a verifier before the run.`,
          ...at(ctx, op.elementId, overlap),
          measurements: {
            intruder: ctx.labels.get(other.elementId) ?? other.elementId,
            overlapWidthIn: inNum(overlap.w),
            quietZoneModules: Number((uptToIn(overlap.w) / Math.max(1e-9, uptToIn(moduleWidth))).toFixed(1)),
          },
        }),
      );
      continue;
    }

    const reflectance = redBandReflectance(color);
    const contrast = reflectance - barReflectance;
    // A light panel in the quiet zone is what a quiet zone is for.
    if (contrast >= ctx.profile.barcodeMinContrast) continue;

    out.push(
      finding({
        code: "BARCODE_QUIET_ZONE",
        severity: "error",
        title: `Dark artwork intrudes ${inches(overlap.w)} into the quiet zone`,
        detail:
          `"${ctx.labels.get(other.elementId) ?? other.elementId}" (${describeColor(color)}) covers ` +
          `${inches(overlap.w)} × ${inches(overlap.h)} of the quiet zone — about ` +
          `${(uptToIn(overlap.w) / Math.max(1e-9, uptToIn(moduleWidth))).toFixed(1)} X-dimensions — ` +
          `${above ? "painted over the symbol" : "showing through beneath it"}. Its red-band reflectance is ` +
          `${pct(reflectance)} against ${pct(barReflectance)} for the bars, a difference of ` +
          `${pct(contrast)} where the profile wants at least ${pct(ctx.profile.barcodeMinContrast)}. ` +
          `A scanner reads a mark that close to the guard bars as part of the symbol.`,
        remedy:
          `Clear the quiet zone: move "${ctx.labels.get(other.elementId) ?? other.elementId}" at least ` +
          `${inches(overlap.w)} away from the symbol, or lighten it, or give the barcode an opaque light ` +
          `quiet-zone fill and keep it above that artwork. The quiet zone is ${inches(op.render.quietLeft)} ` +
          `on the left and ${inches(op.render.quietRight)} on the right at this magnification.`,
        ...at(ctx, op.elementId, overlap),
        measurements: {
          intruder: ctx.labels.get(other.elementId) ?? other.elementId,
          overlapWidthIn: inNum(overlap.w),
          overlapHeightIn: inNum(overlap.h),
          quietZoneModules: Number((uptToIn(overlap.w) / Math.max(1e-9, uptToIn(moduleWidth))).toFixed(1)),
          intruderReflectance: reflectance,
          barReflectance,
          contrast,
          requiredContrast: ctx.profile.barcodeMinContrast,
        },
      }),
    );
  }

  return out;
}

/* --------------------------------------------------------------- contrast */

type Background = { color: PrintColor | null; source: string };

/** What the bars are printed against: the element's own fill, or the art beneath it. */
function backgroundUnder(ctx: PreflightContext, op: BarcodeOp): Background {
  if (op.quietZoneFill.space !== "none") {
    return { color: op.quietZoneFill, source: "the element's quiet-zone fill" };
  }
  // Both boxes must be in the same frame of reference. `opPaintBounds` has
  // already applied the intruder's rotation, so the region under the symbol has
  // to carry the symbol's rotation too — otherwise a turned barcode is tested
  // against a box that is not where its bars are.
  const clear = rotatedTo(barGeometry(op).clear, op);
  let best: DrawOp | null = null;
  for (const other of ctx.plan.ops) {
    if (other.elementId === op.elementId) continue;
    if (other.z > op.z) continue;
    if (!opPaintsInk(other)) continue;
    if (!rectContains(opPaintBounds(other), clear)) continue;
    if (!best || other.z > best.z) best = other;
  }
  if (!best) return { color: ctx.plan.background, source: "the bare substrate" };
  if (best.op === "image") {
    return { color: null, source: `the placed image "${ctx.labels.get(best.elementId) ?? best.elementId}"` };
  }
  return {
    color: opDarkestColor(best),
    source: `"${ctx.labels.get(best.elementId) ?? best.elementId}" behind it`,
  };
}

function checkContrast(ctx: PreflightContext, op: BarcodeOp): PreflightFinding[] {
  if (!op.render) return [];
  const out: PreflightFinding[] = [];
  const bounds = rotatedTo(op.quietBox, op);
  const bars = toCmyk(op.barColor);
  const barReflectance = redBandReflectance(op.barColor);
  const background = backgroundUnder(ctx, op);

  // Stated once, in the findings themselves: this is arithmetic on ink values,
  // not a measurement. A real print contrast signal is read off printed stock
  // with a verifier and graded to ISO/IEC 15416; nothing here can substitute.
  const proxy =
    "This is an ink-value proxy: reflectance is computed from the CMYK recipe in the red band a laser " +
    "scanner reads, not measured. Only a verifier reading printed stock can grade the symbol to " +
    "ISO/IEC 15416 (ANSI) — this check catches recipes that cannot pass, it cannot certify one that can.";

  if (background.color === null) {
    out.push(
      finding({
        code: "BARCODE_CONTRAST",
        severity: "warning",
        title: "Barcode contrast cannot be computed",
        detail:
          `The bars are ${describeColor(op.barColor)} (red-band reflectance ${pct(barReflectance)}) but ` +
          `they sit on ${background.source}, whose ink values are not knowable from asset metadata. ` +
          proxy,
        remedy:
          "Set an opaque light quiet-zone fill on the barcode element so the background is a known ink value, or move the symbol onto plain stock.",
        ...at(ctx, op.elementId, bounds),
        measurements: { barReflectance, background: background.source },
      }),
    );
    return out;
  }

  const bgReflectance = redBandReflectance(background.color);
  const contrast = bgReflectance - barReflectance;

  if (contrast < ctx.profile.barcodeMinContrast) {
    out.push(
      finding({
        code: "BARCODE_CONTRAST",
        severity: "error",
        title: `Bar-to-background contrast is ${pct(contrast)}`,
        detail:
          `Bars ${describeColor(op.barColor)} give a red-band reflectance of ${pct(barReflectance)}; ` +
          `${background.source} (${describeColor(background.color)}) gives ${pct(bgReflectance)}. The ` +
          `difference is ${pct(contrast)}, below the ${pct(ctx.profile.barcodeMinContrast)} the ` +
          `"${ctx.profile.name}" profile requires. ${proxy}`,
        remedy:
          "Print the bars in 100 % K on an unprinted or very light background. Never reverse a symbol out of a dark field, and never print bars in yellow, orange or red — those inks are transparent to the scanner's light and the symbol effectively disappears.",
        ...at(ctx, op.elementId, bounds),
        measurements: {
          contrast,
          required: ctx.profile.barcodeMinContrast,
          barReflectance,
          backgroundReflectance: bgReflectance,
          barInkTac: totalAreaCoverage(op.barColor),
        },
      }),
    );
  }

  // Bars built from more than one ink move with registration; a hairline of
  // misregistration on a 0.013 in module is a measurable width error.
  if (bars && bars.c + bars.m + bars.y > 0 && bars.k < TINT_MAX) {
    out.push(
      finding({
        code: "BARCODE_CONTRAST",
        severity: "warning",
        title: "Bars are built from more than one ink",
        detail:
          `The bar colour is ${describeColor(op.barColor)} (total area coverage ` +
          `${pct(totalAreaCoverage(op.barColor))}). A multi-ink bar depends on registration: at ` +
          `${inches(op.render.moduleWidth)} per module, a press moving half a hairline changes the ` +
          `measured bar widths. ${proxy}`,
        remedy: `Set the bar colour to 100 % K only (C 0 M 0 Y 0 K 100). Reserve built colours for artwork that is not being measured by a machine.`,
        ...at(ctx, op.elementId, bounds),
        measurements: {
          c: bars.c,
          m: bars.m,
          y: bars.y,
          k: bars.k,
          moduleWidthIn: inNum(op.render.moduleWidth),
        },
      }),
    );
  }

  return out;
}

/* ------------------------------------------------------------------ entry */

export function barcodeChecks(ctx: PreflightContext): PreflightFinding[] {
  const out: PreflightFinding[] = [];
  for (const op of ctx.plan.ops) {
    if (op.op !== "barcode") continue;
    const el = barcodeElement(ctx, op.elementId);
    if (!el) continue;
    out.push(
      ...checkValue(ctx, op, el),
      ...checkSize(ctx, op, el),
      ...checkClipping(ctx, op, el),
      ...checkQuietZone(ctx, op),
      ...checkContrast(ctx, op),
    );
  }
  return out;
}
