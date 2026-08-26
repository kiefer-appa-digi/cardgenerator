import type { Upt } from "@/lib/units";
import type { BarcodeSymbology } from "@/lib/design/schema";
import {
  EAN13_QUIET_LEFT_X,
  EAN13_QUIET_RIGHT_X,
  MAX_MAGNIFICATION_BPS,
  MIN_MAGNIFICATION_BPS,
  NOMINAL_UPCA_BAR_HEIGHT_UPT,
  NOMINAL_X_UPT,
  UPCA_QUIET_LEFT_X,
  UPCA_QUIET_RIGHT_X,
  type BarModule,
  type BarcodeError,
  type BarcodeRequest,
  type BarcodeResult,
  type HumanReadableRun,
} from "./types";
import {
  CODE128_MAX_MAGNIFICATION_BPS,
  CODE128_MIN_MAGNIFICATION_BPS,
  CODE128_QUIET_X,
  NOMINAL_CODE128_BAR_HEIGHT_UPT,
  NOMINAL_X_CODE128_UPT,
  encodeGs1_128,
} from "./code128";
import {
  NOMINAL_X_QR_UPT,
  QR_MAX_MAGNIFICATION_BPS,
  QR_MIN_MAGNIFICATION_BPS,
  QR_QUIET_MODULES,
  encodeDigitalLink,
  encodeQr,
} from "./qr";
import {
  EAN_UPC_MODULES,
  GUARD_EXTENSION_X,
  encodeEan13,
  encodeUpcA,
  normaliseEan13,
  normaliseUpcA,
  type BarClass,
  type EanUpcSymbol,
} from "./upc";

/**
 * BARCODE ENGINE — spec §12, dispatching on symbology.
 *
 * Two rules run through everything below.
 *
 * 1. Width is a pure function of the X-dimension. There is no horizontal scale
 *    input anywhere in this module, because a barcode stretched independently
 *    of its height is a barcode that fails verification. The caller asks for a
 *    magnification (or a target width, which we convert to one) and the module
 *    count settles the rest.
 * 2. Anything the caller asks for that the standard does not allow is clamped
 *    and reported in `notes`, not applied silently. Preflight (§21) turns those
 *    notes into findings; the operator sees what happened.
 *
 * Coordinates are quiet-zone-inclusive with the origin at the top-left of the
 * whole symbol box and y increasing downwards, matching card space.
 */

export const NOTE_BAR_HEIGHT_TRUNCATED = "bar height truncated below nominal";

/** Digits sit at roughly 72 % of the em above the baseline in the faces we set. */
const HRI_ASCENT_BPS = 7_200;
/** Advance reserved per human-readable glyph when we must budget space. */
const HRI_ADVANCE_BPS = 6_000;
/** Clear space between the bottom of the bars and the top of the HRI, in X. */
const HRI_GAP_X = 1;

type Metrics = {
  nominalX: Upt;
  minBps: number;
  maxBps: number;
};

const METRICS: Readonly<Record<BarcodeSymbology, Metrics>> = {
  upca: { nominalX: NOMINAL_X_UPT, minBps: MIN_MAGNIFICATION_BPS, maxBps: MAX_MAGNIFICATION_BPS },
  ean13: { nominalX: NOMINAL_X_UPT, minBps: MIN_MAGNIFICATION_BPS, maxBps: MAX_MAGNIFICATION_BPS },
  "gs1-128": {
    nominalX: NOMINAL_X_CODE128_UPT,
    minBps: CODE128_MIN_MAGNIFICATION_BPS,
    maxBps: CODE128_MAX_MAGNIFICATION_BPS,
  },
  qr: { nominalX: NOMINAL_X_QR_UPT, minBps: QR_MIN_MAGNIFICATION_BPS, maxBps: QR_MAX_MAGNIFICATION_BPS },
  "gs1-digital-link": {
    nominalX: NOMINAL_X_QR_UPT,
    minBps: QR_MIN_MAGNIFICATION_BPS,
    maxBps: QR_MAX_MAGNIFICATION_BPS,
  },
};

export function metricsFor(symbology: BarcodeSymbology): Metrics {
  return METRICS[symbology];
}

/** X-dimension in µpt. The single place magnification turns into geometry. */
export function moduleWidthFor(symbology: BarcodeSymbology, magnificationBps: number): Upt {
  return Math.round((METRICS[symbology].nominalX * magnificationBps) / 10_000);
}

function clampMagnification(
  symbology: BarcodeSymbology,
  requested: number,
  notes: string[],
): number {
  const { minBps, maxBps } = METRICS[symbology];
  if (!Number.isFinite(requested) || requested <= 0) {
    notes.push(`magnification ${requested} is not usable; 10000 bps (100 %) applied`);
    return 10_000;
  }
  const bps = Math.round(requested);
  if (bps < minBps) {
    notes.push(
      `magnification ${bps} bps is below the permitted ${minBps} bps and was clamped; the symbol is not to the requested size`,
    );
    return minBps;
  }
  if (bps > maxBps) {
    notes.push(
      `magnification ${bps} bps is above the permitted ${maxBps} bps and was clamped; the symbol is not to the requested size`,
    );
    return maxBps;
  }
  return bps;
}

/* ------------------------------------------------------------------ shared */

/**
 * Group runs of adjacent bar modules into rectangles, never merging across a
 * height-class boundary so that a guard extension is always its own rect.
 */
function barsFromPattern(
  pattern: string,
  classes: readonly BarClass[],
  quietLeft: Upt,
  x: Upt,
  dataHeight: Upt,
  guardHeight: Upt,
): BarModule[] {
  const bars: BarModule[] = [];
  let run = -1;
  const flush = (endExclusive: number): void => {
    if (run < 0) return;
    const isGuard = classes[run] === "guard";
    bars.push({
      x: quietLeft + run * x,
      y: 0,
      w: (endExclusive - run) * x,
      h: isGuard ? guardHeight : dataHeight,
    });
    run = -1;
  };
  for (let i = 0; i < pattern.length; i += 1) {
    const dark = pattern[i] === "1";
    if (!dark) {
      flush(i);
      continue;
    }
    if (run >= 0 && classes[i] !== classes[run]) flush(i);
    if (run < 0) run = i;
  }
  flush(pattern.length);
  return bars;
}

function hriAscent(fontSize: Upt): Upt {
  return Math.round((fontSize * HRI_ASCENT_BPS) / 10_000);
}

function hriAdvance(fontSize: Upt, glyphs: number): Upt {
  return Math.round((fontSize * HRI_ADVANCE_BPS * glyphs) / 10_000);
}

function fail(code: BarcodeError["code"], message: string, value: string): BarcodeResult {
  return { ok: false, error: { code, message, value } };
}

/* --------------------------------------------------------- UPC-A / EAN-13 */

type EanUpcLayout = {
  quietLeftX: number;
  quietRightX: number;
  /** Human-readable groups beneath the bars, positioned in module offsets. */
  under: Array<{ text: string; startModule: number; widthModules: number }>;
  /** Digit set outside the left guard, in the left light margin. */
  leftMargin: string | null;
  /** Digit set outside the right guard, in the right light margin. */
  rightMargin: string | null;
};

function upcaLayout(digits: string): EanUpcLayout {
  return {
    quietLeftX: UPCA_QUIET_LEFT_X,
    quietRightX: UPCA_QUIET_RIGHT_X,
    // Characters 2-6 occupy modules 10-45, characters 8-12 modules 50-85. The
    // first and last characters have no digit beneath them; theirs sit outside.
    under: [
      { text: digits.slice(1, 6), startModule: 10, widthModules: 35 },
      { text: digits.slice(6, 11), startModule: 50, widthModules: 35 },
    ],
    leftMargin: digits.slice(0, 1),
    rightMargin: digits.slice(11, 12),
  };
}

function ean13Layout(digits: string): EanUpcLayout {
  return {
    quietLeftX: EAN13_QUIET_LEFT_X,
    quietRightX: EAN13_QUIET_RIGHT_X,
    under: [
      { text: digits.slice(1, 7), startModule: 3, widthModules: 42 },
      { text: digits.slice(7, 13), startModule: 50, widthModules: 42 },
    ],
    leftMargin: digits.slice(0, 1),
    rightMargin: null,
  };
}

function renderEanUpc(
  req: BarcodeRequest,
  symbol: EanUpcSymbol,
  layout: EanUpcLayout,
  notes: string[],
): BarcodeResult {
  const totalModules = layout.quietLeftX + EAN_UPC_MODULES + layout.quietRightX;
  const bps = resolveMagnification(req, totalModules, notes);
  const x = moduleWidthFor(req.symbology, bps);

  const quietLeft = layout.quietLeftX * x;
  const quietRight = layout.quietRightX * x;
  const width = totalModules * x;

  // The nominal bar height scales with the symbol: a 200 % UPC-A is 2.04 in of
  // bar, not 1.02 in of bar on twice-as-wide modules.
  const nominalBarHeight = Math.round((NOMINAL_UPCA_BAR_HEIGHT_UPT * bps) / 10_000);
  let dataHeight = req.barHeight;
  if (!Number.isFinite(dataHeight) || dataHeight <= 0) {
    notes.push(`bar height ${req.barHeight} is not usable; nominal applied`);
    dataHeight = nominalBarHeight;
  }
  if (dataHeight < nominalBarHeight) notes.push(NOTE_BAR_HEIGHT_TRUNCATED);

  const guardHeight = dataHeight + GUARD_EXTENSION_X * x;
  const bars = barsFromPattern(symbol.pattern, symbol.classes, quietLeft, x, dataHeight, guardHeight);

  const text: HumanReadableRun[] = [];
  const fontSize = req.humanReadableFontSize;
  const wantsBand = req.showHumanReadable || req.showLightMarginIndicator;
  const baseline = guardHeight + HRI_GAP_X * x + hriAscent(fontSize);

  if (req.showHumanReadable) {
    for (const group of layout.under) {
      if (group.text.length === 0) continue;
      text.push({
        text: group.text,
        x: quietLeft + group.startModule * x,
        baseline,
        fontSize,
        align: "center",
        width: group.widthModules * x,
      });
    }
    if (layout.leftMargin !== null) {
      text.push({
        text: layout.leftMargin,
        x: 0,
        baseline,
        fontSize,
        align: "center",
        width: quietLeft,
      });
    }
  }

  // The light margin indicator's tip marks the outer edge of the quiet zone,
  // so it is always flush right and the check digit gives way to it.
  const indicatorWidth = req.showLightMarginIndicator ? hriAdvance(fontSize, 1) : 0;
  if (req.showHumanReadable && layout.rightMargin !== null) {
    const available = quietRight - indicatorWidth;
    if (available < hriAdvance(fontSize, 1)) {
      notes.push(
        "human-readable check digit and light margin indicator do not both fit in the right light margin",
      );
    }
    text.push({
      text: layout.rightMargin,
      x: quietLeft + EAN_UPC_MODULES * x,
      baseline,
      fontSize,
      align: "center",
      width: Math.max(available, 0),
    });
  }
  if (req.showLightMarginIndicator) {
    text.push({
      text: ">",
      x: width - indicatorWidth,
      baseline,
      fontSize,
      align: "center",
      width: indicatorWidth,
    });
  }

  const height = guardHeight + (wantsBand ? HRI_GAP_X * x + fontSize : 0);

  return {
    ok: true,
    render: {
      symbology: req.symbology,
      encodedValue: symbol.digits,
      width,
      height,
      moduleWidth: x,
      quietLeft,
      quietRight,
      quietTop: 0,
      quietBottom: 0,
      bars,
      text,
      notes,
    },
  };
}

/* ------------------------------------------------------------------ GS1-128 */

function renderGs1_128(req: BarcodeRequest, notes: string[]): BarcodeResult {
  const encoded = encodeGs1_128(req.value);
  if (!encoded.ok) return { ok: false, error: encoded.error };
  notes.push(...encoded.symbol.notes);

  const totalModules = encoded.symbol.modules + 2 * CODE128_QUIET_X;
  const bps = resolveMagnification(req, totalModules, notes);
  const x = moduleWidthFor(req.symbology, bps);

  const quiet = CODE128_QUIET_X * x;
  const width = totalModules * x;

  // Code 128 bar height is an absolute minimum in the standard, not a multiple
  // of X, so it does not scale with magnification the way EAN/UPC height does.
  let dataHeight = req.barHeight;
  if (!Number.isFinite(dataHeight) || dataHeight <= 0) {
    notes.push(`bar height ${req.barHeight} is not usable; nominal applied`);
    dataHeight = NOMINAL_CODE128_BAR_HEIGHT_UPT;
  }
  if (dataHeight < NOMINAL_CODE128_BAR_HEIGHT_UPT) notes.push(NOTE_BAR_HEIGHT_TRUNCATED);

  const classes: BarClass[] = new Array<BarClass>(encoded.symbol.pattern.length).fill("data");
  const bars = barsFromPattern(encoded.symbol.pattern, classes, quiet, x, dataHeight, dataHeight);

  const text: HumanReadableRun[] = [];
  const fontSize = req.humanReadableFontSize;
  if (req.showHumanReadable) {
    text.push({
      text: encoded.symbol.humanReadable,
      x: 0,
      baseline: dataHeight + HRI_GAP_X * x + hriAscent(fontSize),
      fontSize,
      align: "center",
      width,
    });
    const needed = hriAdvance(fontSize, encoded.symbol.humanReadable.length);
    if (needed > width) {
      notes.push("human-readable interpretation is wider than the symbol");
    }
  }

  const height = dataHeight + (req.showHumanReadable ? HRI_GAP_X * x + fontSize : 0);

  return {
    ok: true,
    render: {
      symbology: req.symbology,
      encodedValue: encoded.symbol.humanReadable,
      width,
      height,
      moduleWidth: x,
      quietLeft: quiet,
      quietRight: quiet,
      quietTop: 0,
      quietBottom: 0,
      bars,
      text,
      notes,
    },
  };
}

/* ----------------------------------------------------------------- QR / DL */

function renderMatrix(req: BarcodeRequest, notes: string[]): BarcodeResult {
  const encoded =
    req.symbology === "gs1-digital-link"
      ? encodeDigitalLink(req.value, { domain: req.digitalLinkDomain })
      : encodeQr(req.value);
  if (!encoded.ok) return { ok: false, error: encoded.error };
  notes.push(...encoded.notes);

  const size = encoded.matrix.size;
  const totalModules = size + 2 * QR_QUIET_MODULES;
  const bps = resolveMagnification(req, totalModules, notes);
  const x = moduleWidthFor(req.symbology, bps);

  const quiet = QR_QUIET_MODULES * x;
  const width = totalModules * x;

  const bars: BarModule[] = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!encoded.matrix.dark[row * size + col]) continue;
      bars.push({ x: quiet + col * x, y: quiet + row * x, w: x, h: x });
    }
  }

  const text: HumanReadableRun[] = [];
  const fontSize = req.humanReadableFontSize;
  if (req.showHumanReadable) {
    text.push({
      text: encoded.encodedValue,
      x: 0,
      baseline: width + HRI_GAP_X * x + hriAscent(fontSize),
      fontSize,
      align: "center",
      width,
    });
  }

  notes.push("bar height does not apply to a matrix symbol; module size is set by magnification");

  const height = width + (req.showHumanReadable ? HRI_GAP_X * x + fontSize : 0);

  return {
    ok: true,
    render: {
      symbology: req.symbology,
      encodedValue: encoded.encodedValue,
      width,
      height,
      moduleWidth: x,
      quietLeft: quiet,
      quietRight: quiet,
      quietTop: quiet,
      quietBottom: req.showHumanReadable ? quiet + HRI_GAP_X * x + fontSize : quiet,
      bars,
      text,
      notes,
    },
  };
}

/* ------------------------------------------------------------ magnification */

export type MagnificationFit = {
  magnificationBps: number;
  moduleWidth: Upt;
  /** Total modules across the box, quiet zones included. */
  totalModules: number;
  /** Width the fit actually produces; never greater than the target. */
  width: Upt;
  /** True when the standard's limits, not the target width, decided the size. */
  clamped: boolean;
};

/**
 * Largest magnification whose symbol still fits `targetWidth`.
 *
 * Solved on the X-dimension rather than on the width so that the integer
 * rounding of X can never push the finished symbol past the target: pick the
 * largest whole µpt module that fits, then the largest magnification that
 * rounds to no more than it.
 */
export function magnificationForWidth(
  symbology: BarcodeSymbology,
  totalModules: number,
  targetWidth: Upt,
): MagnificationFit {
  const { nominalX, minBps, maxBps } = METRICS[symbology];
  const maxModule = Math.floor(targetWidth / totalModules);
  const raw = Math.floor((maxModule * 10_000) / nominalX);
  const bps = Math.min(maxBps, Math.max(minBps, raw));
  const moduleWidth = Math.round((nominalX * bps) / 10_000);
  return {
    magnificationBps: bps,
    moduleWidth,
    totalModules,
    width: totalModules * moduleWidth,
    clamped: bps !== raw,
  };
}

function resolveMagnification(
  req: BarcodeRequest,
  totalModules: number,
  notes: string[],
): number {
  if (req.fitWidth !== undefined && req.fitWidth > 0) {
    const fit = magnificationForWidth(req.symbology, totalModules, req.fitWidth);
    if (fit.clamped) {
      notes.push(
        `target width could not be met at a permitted magnification; ${fit.magnificationBps} bps applied`,
      );
    }
    return fit.magnificationBps;
  }
  return clampMagnification(req.symbology, req.magnificationBps, notes);
}

/* -------------------------------------------------------------- dispatcher */

export function renderBarcode(req: BarcodeRequest): BarcodeResult {
  const notes: string[] = [];

  switch (req.symbology) {
    case "upca": {
      const norm = normaliseUpcA(req.value);
      if (!norm.ok) return { ok: false, error: norm.error };
      notes.push(...norm.value.notes);
      const digits = norm.value.gtin;
      return renderEanUpc(req, encodeUpcA(digits), upcaLayout(digits), notes);
    }
    case "ean13": {
      const norm = normaliseEan13(req.value);
      if (!norm.ok) return { ok: false, error: norm.error };
      notes.push(...norm.value.notes);
      const digits = norm.value.gtin;
      return renderEanUpc(req, encodeEan13(digits), ean13Layout(digits), notes);
    }
    case "gs1-128":
      return renderGs1_128(req, notes);
    case "qr":
    case "gs1-digital-link":
      return renderMatrix(req, notes);
    default:
      return fail(
        "UNSUPPORTED",
        `symbology ${String(req.symbology)} is not implemented`,
        req.value,
      );
  }
}

export * from "./types";
export {
  GTIN_LENGTHS,
  appendCheckDigit,
  calculateCheckDigit,
  digitalLinkUri,
  hasValidCheckDigit,
  isDigits,
  narrowGtin,
  normaliseDigitalLinkDomain,
  normaliseGtin,
  normaliseGtin14,
  padGtin,
  sanitiseDigits,
  toGtin14,
  DEFAULT_DIGITAL_LINK_DOMAIN,
} from "./gtin";
export {
  EAN13_PARITY,
  EAN_UPC_MODULES,
  GUARD_EXTENSION_X,
  G_CODES,
  L_CODES,
  R_CODES,
  encodeEan13,
  encodeUpcA,
  normaliseEan13,
  normaliseUpcA,
} from "./upc";
export {
  CODE128_PATTERNS,
  CODE128_QUIET_X,
  FNC1,
  GS1_128_MAX_DATA_CHARACTERS,
  NOMINAL_CODE128_BAR_HEIGHT_UPT,
  NOMINAL_X_CODE128_UPT,
  START_A,
  START_B,
  START_C,
  STOP,
  code128CheckValue,
  encodeCode128Text,
  encodeGs1_128,
  parseAiString,
  widthsToModules,
} from "./code128";
export {
  NOMINAL_X_QR_UPT,
  QR_ERROR_CORRECTION,
  QR_QUIET_MODULES,
  encodeDigitalLink,
  encodeQr,
} from "./qr";
