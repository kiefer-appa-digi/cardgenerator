import { describe, expect, it } from "vitest";
import {
  CODE128_PATTERNS,
  CODE128_QUIET_X,
  EAN13_PARITY,
  EAN_UPC_MODULES,
  GUARD_EXTENSION_X,
  G_CODES,
  L_CODES,
  NOMINAL_X_CODE128_UPT,
  NOMINAL_X_QR_UPT,
  QR_QUIET_MODULES,
  R_CODES,
  START_A,
  START_B,
  START_C,
  STOP,
  appendCheckDigit,
  calculateCheckDigit,
  code128CheckValue,
  digitalLinkUri,
  encodeCode128Text,
  encodeEan13,
  encodeGs1_128,
  encodeQr,
  encodeUpcA,
  hasValidCheckDigit,
  magnificationForWidth,
  narrowGtin,
  normaliseGtin14,
  padGtin,
  sanitiseDigits,
  moduleWidthFor,
  normaliseEan13,
  normaliseUpcA,
  parseAiString,
  renderBarcode,
  widthsToModules,
  NOMINAL_X_UPT,
  NOTE_BAR_HEIGHT_TRUNCATED,
  UPCA_QUIET_LEFT_X,
  UPCA_QUIET_RIGHT_X,
  EAN13_QUIET_LEFT_X,
  EAN13_QUIET_RIGHT_X,
  MIN_MAGNIFICATION_BPS,
  MAX_MAGNIFICATION_BPS,
  type BarcodeRequest,
  type BarcodeResult,
} from "@/lib/barcode";

/* ------------------------------------------------------------------ helpers */

function req(over: Partial<BarcodeRequest> & Pick<BarcodeRequest, "symbology" | "value">): BarcodeRequest {
  return {
    magnificationBps: 10_000,
    barHeight: 73_440_000,
    showHumanReadable: true,
    humanReadableFontSize: 7_000_000,
    showLightMarginIndicator: true,
    ...over,
  };
}

function expectOk(r: BarcodeResult) {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.render;
}

function expectErr(r: BarcodeResult) {
  if (r.ok) throw new Error("expected an error");
  return r.error;
}

/** Element widths of a 7-module character, e.g. "0001101" -> [3, 2, 1, 1]. */
function elementWidths(seven: string): number[] {
  const out: number[] = [];
  let run = 1;
  for (let i = 1; i < seven.length; i += 1) {
    if (seven[i] === seven[i - 1]) run += 1;
    else {
      out.push(run);
      run = 1;
    }
  }
  out.push(run);
  return out;
}

function darkCount(s: string): number {
  return s.split("").filter((c) => c === "1").length;
}

/* ------------------------------------------------- EAN/UPC encodation tables */

/**
 * Published element-width table for number set A (space, bar, space, bar), GS1
 * General Specifications figure 5.2.1.3-1. This is the same table as L_CODES
 * expressed the other way round, so agreeing with it catches a mistyped module
 * string that a self-consistency check would miss.
 */
const SET_A_ELEMENT_WIDTHS: readonly (readonly number[])[] = [
  [3, 2, 1, 1],
  [2, 2, 2, 1],
  [2, 1, 2, 2],
  [1, 4, 1, 1],
  [1, 1, 3, 2],
  [1, 2, 3, 1],
  [1, 1, 1, 4],
  [1, 3, 1, 2],
  [1, 2, 1, 3],
  [3, 1, 1, 2],
];

describe("EAN/UPC encodation tables", () => {
  it("set A matches the published element widths", () => {
    for (let d = 0; d < 10; d += 1) {
      expect(elementWidths(L_CODES[d])).toEqual([...SET_A_ELEMENT_WIDTHS[d]]);
    }
  });

  it("every character is 7 modules of exactly four elements", () => {
    for (const table of [L_CODES, G_CODES, R_CODES]) {
      for (const code of table) {
        expect(code).toHaveLength(7);
        expect(elementWidths(code)).toHaveLength(4);
        expect(elementWidths(code).reduce((a, b) => a + b, 0)).toBe(7);
      }
    }
  });

  it("carries the parities the symbology depends on", () => {
    for (let d = 0; d < 10; d += 1) {
      // Set A is odd parity; sets B and C are even. EAN-13's thirteenth digit
      // is recoverable only because of this.
      expect(darkCount(L_CODES[d]) % 2).toBe(1);
      expect(darkCount(G_CODES[d]) % 2).toBe(0);
      expect(darkCount(R_CODES[d]) % 2).toBe(0);
      // Left-hand characters begin with a space and end with a bar; right-hand
      // characters are the other way round.
      expect(L_CODES[d][0]).toBe("0");
      expect(L_CODES[d][6]).toBe("1");
      expect(G_CODES[d][0]).toBe("0");
      expect(R_CODES[d][0]).toBe("1");
      expect(R_CODES[d][6]).toBe("0");
    }
  });

  it("set B is set C reversed and set C is set A complemented", () => {
    for (let d = 0; d < 10; d += 1) {
      expect(G_CODES[d]).toBe(R_CODES[d].split("").reverse().join(""));
      expect(R_CODES[d]).toBe(
        L_CODES[d]
          .split("")
          .map((c) => (c === "1" ? "0" : "1"))
          .join(""),
      );
    }
  });
});

/* ------------------------------------------------------------ UPC-A pattern */

describe("UPC-A known answer 036000291452", () => {
  // Textbook example. 95 modules: 101 | six set A characters | 01010 |
  // six set C characters | 101.
  const EXPECTED =
    "10100011010111101010111100011010001101000110101010" +
    "110110011101001100110101110010011101101100101";

  it("encodes module for module", () => {
    const sym = encodeUpcA("036000291452");
    expect(sym.pattern).toHaveLength(EAN_UPC_MODULES);
    expect(sym.pattern).toBe(EXPECTED);
  });

  it("decodes back to the same digits through the element-width table", () => {
    const sym = encodeUpcA("036000291452");
    const p = sym.pattern;
    expect(p.slice(0, 3)).toBe("101");
    expect(p.slice(45, 50)).toBe("01010");
    expect(p.slice(92, 95)).toBe("101");

    const decoded: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const widths = elementWidths(p.slice(3 + i * 7, 10 + i * 7));
      const d = SET_A_ELEMENT_WIDTHS.findIndex(
        (w) => w.length === widths.length && w.every((v, k) => v === widths[k]),
      );
      decoded.push(d);
    }
    for (let i = 0; i < 6; i += 1) {
      // Set C is set A complemented, so complement then read the same table.
      const seven = p
        .slice(50 + i * 7, 57 + i * 7)
        .split("")
        .map((c) => (c === "1" ? "0" : "1"))
        .join("");
      const widths = elementWidths(seven);
      const d = SET_A_ELEMENT_WIDTHS.findIndex(
        (w) => w.length === widths.length && w.every((v, k) => v === widths[k]),
      );
      decoded.push(d);
    }
    expect(decoded.join("")).toBe("036000291452");
  });

  it("descends the guards, the number system character and the check character", () => {
    const sym = encodeUpcA("036000291452");
    const guard = sym.classes
      .map((c, i) => (c === "guard" ? i : -1))
      .filter((i) => i >= 0);
    const expected: number[] = [];
    for (const [a, b] of [
      [0, 3],
      [3, 10],
      [45, 50],
      [85, 92],
      [92, 95],
    ]) {
      for (let i = a; i < b; i += 1) expected.push(i);
    }
    expect(guard).toEqual(expected);
  });
});

/* ---------------------------------------------------------- EAN-13 patterns */

describe("EAN-13 parity", () => {
  const FIXTURES: ReadonlyArray<readonly [string, string, string]> = [
    [
      "5901234123457",
      "OEEOOE",
      "10100010110100111011001100100110111101001110101010" +
        "110011011011001000010101110010011101000100101",
    ],
    [
      "4006381333931",
      "OEOOEE",
      "10100011010100111010111101111010001001011001101010" +
        "100001010000101000010111010010000101100110101",
    ],
    [
      "9780201379624",
      "OEEOEO",
      "10101110110001001010011100100110100111001100101010" +
        "100001010001001110100101000011011001011100101",
    ],
  ];

  for (const [gtin, parity, pattern] of FIXTURES) {
    it(`leading digit ${gtin[0]} uses parity ${parity}`, () => {
      expect(EAN13_PARITY[Number(gtin[0])]).toBe(parity);
      const sym = encodeEan13(gtin);
      expect(sym.pattern).toHaveLength(EAN_UPC_MODULES);
      expect(sym.pattern).toBe(pattern);

      // Read the parity straight back out of the modules: odd dark count means
      // set A, even means set B.
      const read: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const seven = sym.pattern.slice(3 + i * 7, 10 + i * 7);
        read.push(darkCount(seven) % 2 === 1 ? "O" : "E");
      }
      expect(read.join("")).toBe(parity);
    });
  }

  it("only the three guard patterns descend", () => {
    const sym = encodeEan13("5901234123457");
    const guard = sym.classes.map((c, i) => (c === "guard" ? i : -1)).filter((i) => i >= 0);
    expect(guard).toEqual([
      0, 1, 2, 45, 46, 47, 48, 49, 92, 93, 94,
    ]);
  });
});

/* -------------------------------------------------------------- check digits */

describe("GTIN check digits", () => {
  const REAL_PRODUCT_GTINS = ["810797030124", "810797030001", "810797030018"];

  for (const gtin of REAL_PRODUCT_GTINS) {
    it(`${gtin} validates`, () => {
      expect(hasValidCheckDigit(gtin)).toBe(true);
      expect(appendCheckDigit(gtin.slice(0, 11))).toBe(gtin);
      const r = renderBarcode(req({ symbology: "upca", value: gtin }));
      expect(expectOk(r).encodedValue).toBe(gtin);
    });

    it(`${gtin} with the last digit changed is rejected`, () => {
      const wrong = gtin.slice(0, 11) + String((Number(gtin[11]) + 1) % 10);
      expect(hasValidCheckDigit(wrong)).toBe(false);
      const e = expectErr(renderBarcode(req({ symbology: "upca", value: wrong })));
      expect(e.code).toBe("BAD_CHECK_DIGIT");
      // Never silently corrected: the offending value is reported verbatim.
      expect(e.value).toBe(wrong);
    });
  }

  it("computes the check digit for a body", () => {
    expect(calculateCheckDigit("81079703012")).toBe(4);
    expect(calculateCheckDigit("81079703000")).toBe(1);
    expect(calculateCheckDigit("81079703001")).toBe(8);
    expect(calculateCheckDigit("03600029145")).toBe(2);
    expect(calculateCheckDigit("590123412345")).toBe(7);
    expect(calculateCheckDigit("0081079703012")).toBe(4);
  });

  it("accepts an 11-digit UPC body and says that it appended the check digit", () => {
    const norm = normaliseUpcA("81079703012");
    expect(norm.ok).toBe(true);
    if (!norm.ok) return;
    expect(norm.value.gtin).toBe("810797030124");
    expect(norm.value.notes.join(" ")).toContain("computed and appended");

    const render = expectOk(renderBarcode(req({ symbology: "upca", value: "81079703012" })));
    expect(render.encodedValue).toBe("810797030124");
    expect(render.notes.some((n) => n.includes("computed and appended"))).toBe(true);
  });

  it("reads the GTIN-13 and GTIN-14 forms of a UPC", () => {
    const thirteen = normaliseUpcA("0810797030124");
    expect(thirteen.ok && thirteen.value.gtin).toBe("810797030124");
    const fourteen = normaliseUpcA("00810797030124");
    expect(fourteen.ok && fourteen.value.gtin).toBe("810797030124");
    // An indicator digit is significant, so it must not be thrown away.
    const indicator = normaliseUpcA("10810797030121");
    expect(indicator.ok).toBe(false);
  });

  it("zero-pads a GTIN-12 into an EAN-13", () => {
    const norm = normaliseEan13("810797030124");
    expect(norm.ok && norm.value.gtin).toBe("0810797030124");
    const render = expectOk(renderBarcode(req({ symbology: "ean13", value: "810797030124" })));
    expect(render.encodedValue).toBe("0810797030124");
  });
});

/* ------------------------------------------------------------------ rejects */

describe("rejects", () => {
  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ["empty", "", "EMPTY"],
    ["blank", "   ", "EMPTY"],
    ["short", "12345", "BAD_LENGTH"],
    ["long", "1234567890123456", "BAD_LENGTH"],
    ["non-numeric", "03600029145X", "BAD_CHARSET"],
    ["bad check digit", "036000291453", "BAD_CHECK_DIGIT"],
  ];

  for (const [name, value, code] of CASES) {
    it(`UPC-A rejects ${name}`, () => {
      expect(expectErr(renderBarcode(req({ symbology: "upca", value }))).code).toBe(code);
    });
  }

  it("EAN-13 rejects a bad check digit", () => {
    expect(
      expectErr(renderBarcode(req({ symbology: "ean13", value: "5901234123458" }))).code,
    ).toBe("BAD_CHECK_DIGIT");
  });

  it("GS1-128 rejects a bad GTIN check digit inside AI (01)", () => {
    expect(
      expectErr(renderBarcode(req({ symbology: "gs1-128", value: "(01)00810797030125" }))).code,
    ).toBe("BAD_CHECK_DIGIT");
  });

  it("GS1-128 rejects a defined-length AI of the wrong length", () => {
    expect(
      expectErr(renderBarcode(req({ symbology: "gs1-128", value: "(17)2612" }))).code,
    ).toBe("BAD_LENGTH");
  });

  it("GS1 Digital Link rejects a bad check digit", () => {
    expect(
      expectErr(renderBarcode(req({ symbology: "gs1-digital-link", value: "810797030125" }))).code,
    ).toBe("BAD_CHECK_DIGIT");
  });
});

/* ------------------------------------------------------------------- layout */

describe("UPC-A layout", () => {
  it("is 113 modules wide including quiet zones, at every magnification", () => {
    const totalModules = UPCA_QUIET_LEFT_X + EAN_UPC_MODULES + UPCA_QUIET_RIGHT_X;
    expect(totalModules).toBe(113);
    for (const bps of [8_000, 9_000, 10_000, 12_500, 15_000, 20_000]) {
      const r = expectOk(
        renderBarcode(req({ symbology: "upca", value: "036000291452", magnificationBps: bps })),
      );
      const x = Math.round((NOMINAL_X_UPT * bps) / 10_000);
      expect(r.moduleWidth).toBe(x);
      expect(r.width).toBe(totalModules * x);
      expect(r.quietLeft).toBe(UPCA_QUIET_LEFT_X * x);
      expect(r.quietRight).toBe(UPCA_QUIET_RIGHT_X * x);
      expect(Number.isInteger(r.width)).toBe(true);
    }
  });

  it("is 1.469 in wide at 100 %, the GS1 nominal", () => {
    const r = expectOk(renderBarcode(req({ symbology: "upca", value: "036000291452" })));
    expect(r.width).toBe(105_768_000);
    expect(r.width / 72_000_000).toBeCloseTo(1.469, 3);
  });

  it("draws guard extensions 5X below the data bars", () => {
    const r = expectOk(renderBarcode(req({ symbology: "upca", value: "036000291452" })));
    const x = r.moduleWidth;
    const heights = new Set(r.bars.map((b) => b.h));
    expect(heights.size).toBe(2);
    const data = Math.min(...heights);
    const guard = Math.max(...heights);
    expect(data).toBe(73_440_000);
    expect(guard).toBe(data + GUARD_EXTENSION_X * x);

    // The first bar is the left guard and it descends.
    expect(r.bars[0]).toEqual({ x: r.quietLeft, y: 0, w: x, h: guard });
    // The last bar is the right guard and it descends too.
    expect(r.bars[r.bars.length - 1]).toEqual({
      x: r.quietLeft + 94 * x,
      y: 0,
      w: x,
      h: guard,
    });
    // Every bar sits on a whole module boundary.
    for (const b of r.bars) {
      expect((b.x - r.quietLeft) % x).toBe(0);
      expect(b.w % x).toBe(0);
    }
  });

  it("sets the number system and check digits outside the symbol", () => {
    const r = expectOk(renderBarcode(req({ symbology: "upca", value: "036000291452" })));
    const byText = new Map(r.text.map((t) => [t.text, t]));
    const ns = byText.get("0");
    const check = byText.get("2");
    expect(ns).toBeDefined();
    expect(check).toBeDefined();
    if (!ns || !check) return;
    // Number system digit lives entirely in the left light margin.
    expect(ns.x).toBe(0);
    expect(ns.x + ns.width).toBeLessThanOrEqual(r.quietLeft);
    // Check digit starts at the right edge of the symbol proper.
    expect(check.x).toBe(r.quietLeft + EAN_UPC_MODULES * r.moduleWidth);
    // The five-digit halves sit under the shortened bars.
    expect(byText.get("36000")?.x).toBe(r.quietLeft + 10 * r.moduleWidth);
    expect(byText.get("29145")?.x).toBe(r.quietLeft + 50 * r.moduleWidth);
  });

  it("places the light margin indicator flush with the outer edge", () => {
    const r = expectOk(renderBarcode(req({ symbology: "upca", value: "036000291452" })));
    const indicator = r.text.find((t) => t.text === ">");
    expect(indicator).toBeDefined();
    if (!indicator) return;
    expect(indicator.x + indicator.width).toBe(r.width);

    const without = expectOk(
      renderBarcode(
        req({ symbology: "upca", value: "036000291452", showLightMarginIndicator: false }),
      ),
    );
    expect(without.text.some((t) => t.text === ">")).toBe(false);
  });

  it("omits human-readable runs when they are switched off", () => {
    const r = expectOk(
      renderBarcode(
        req({
          symbology: "upca",
          value: "036000291452",
          showHumanReadable: false,
          showLightMarginIndicator: false,
        }),
      ),
    );
    expect(r.text).toHaveLength(0);
    expect(r.height).toBe(73_440_000 + GUARD_EXTENSION_X * r.moduleWidth);
  });
});

describe("EAN-13 layout", () => {
  it("uses an 11X left and 7X right light margin", () => {
    const r = expectOk(renderBarcode(req({ symbology: "ean13", value: "5901234123457" })));
    const x = r.moduleWidth;
    expect(EAN13_QUIET_LEFT_X).toBe(11);
    expect(EAN13_QUIET_RIGHT_X).toBe(7);
    expect(r.quietLeft).toBe(11 * x);
    expect(r.quietRight).toBe(7 * x);
    expect(r.width).toBe((11 + 95 + 7) * x);
  });

  it("sets the first digit outside the guard bars", () => {
    const r = expectOk(renderBarcode(req({ symbology: "ean13", value: "5901234123457" })));
    const first = r.text.find((t) => t.text === "5");
    expect(first).toBeDefined();
    if (!first) return;
    expect(first.x).toBe(0);
    expect(first.x + first.width).toBeLessThanOrEqual(r.quietLeft);
    expect(r.text.some((t) => t.text === "901234")).toBe(true);
    expect(r.text.some((t) => t.text === "123457")).toBe(true);
  });
});

/* ------------------------------------------------------------- magnification */

describe("magnification", () => {
  it("scales X strictly and never distorts width independently", () => {
    const a = expectOk(
      renderBarcode(req({ symbology: "upca", value: "036000291452", magnificationBps: 10_000 })),
    );
    const b = expectOk(
      renderBarcode(req({ symbology: "upca", value: "036000291452", magnificationBps: 20_000 })),
    );
    expect(b.moduleWidth).toBe(2 * a.moduleWidth);
    expect(b.width).toBe(2 * a.width);
  });

  it("clamps below the GS1 minimum and reports it", () => {
    const r = expectOk(
      renderBarcode(req({ symbology: "upca", value: "036000291452", magnificationBps: 4_000 })),
    );
    expect(r.moduleWidth).toBe(moduleWidthFor("upca", MIN_MAGNIFICATION_BPS));
    expect(r.notes.some((n) => n.includes("clamped"))).toBe(true);
  });

  it("clamps above the GS1 maximum and reports it", () => {
    const r = expectOk(
      renderBarcode(req({ symbology: "upca", value: "036000291452", magnificationBps: 40_000 })),
    );
    expect(r.moduleWidth).toBe(moduleWidthFor("upca", MAX_MAGNIFICATION_BPS));
    expect(r.notes.some((n) => n.includes("clamped"))).toBe(true);
  });

  it("fits a target width without ever exceeding it", () => {
    const target = 90_000_000; // 1.25 in
    const fit = magnificationForWidth("upca", 113, target);
    expect(fit.width).toBeLessThanOrEqual(target);
    expect(fit.magnificationBps).toBeGreaterThanOrEqual(MIN_MAGNIFICATION_BPS);
    const r = expectOk(
      renderBarcode(req({ symbology: "upca", value: "036000291452", fitWidth: target })),
    );
    expect(r.width).toBeLessThanOrEqual(target);
    expect(r.width).toBe(fit.width);
    // One more basis point overflows the target. The old assertion compared
    // against `target - 113`, which a width that still FITS also satisfies.
    const bigger = 113 * Math.round((NOMINAL_X_UPT * (fit.magnificationBps + 1)) / 10_000);
    expect(bigger).toBeGreaterThan(target);
    expect(fit.width).toBe(89_997_946);
    expect(fit.magnificationBps).toBe(8_509);
  });

  it("reports when the target width is unreachable inside the standard", () => {
    const r = expectOk(
      renderBarcode(req({ symbology: "upca", value: "036000291452", fitWidth: 20_000_000 })),
    );
    expect(r.moduleWidth).toBe(moduleWidthFor("upca", MIN_MAGNIFICATION_BPS));
    expect(r.notes.some((n) => n.includes("target width"))).toBe(true);
  });
});

describe("bar height", () => {
  it("still renders below nominal but pushes a note", () => {
    const r = expectOk(
      renderBarcode(req({ symbology: "upca", value: "036000291452", barHeight: 40_000_000 })),
    );
    expect(r.notes).toContain(NOTE_BAR_HEIGHT_TRUNCATED);
    expect(r.bars.every((b) => b.h >= 40_000_000)).toBe(true);
    expect(Math.min(...r.bars.map((b) => b.h))).toBe(40_000_000);
  });

  it("says nothing when the bars are at or above nominal", () => {
    const r = expectOk(
      renderBarcode(req({ symbology: "upca", value: "036000291452", barHeight: 73_440_000 })),
    );
    expect(r.notes).not.toContain(NOTE_BAR_HEIGHT_TRUNCATED);
  });

  it("scales the nominal with the magnification", () => {
    // 1.02 in of bar at 100 % is only 51 % of nominal at 200 %.
    const r = expectOk(
      renderBarcode(
        req({
          symbology: "upca",
          value: "036000291452",
          magnificationBps: 20_000,
          barHeight: 73_440_000,
        }),
      ),
    );
    expect(r.notes).toContain(NOTE_BAR_HEIGHT_TRUNCATED);
  });
});

/* ------------------------------------------------------------------ Code 128 */

describe("Code 128 pattern table", () => {
  it("holds 107 characters", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
  });

  it("gives every character 11 modules, and the stop character 13", () => {
    for (let v = 0; v <= 105; v += 1) {
      const widths = CODE128_PATTERNS[v].split("").map(Number);
      expect(widths).toHaveLength(6);
      expect(widths.reduce((a, b) => a + b, 0)).toBe(11);
    }
    expect(CODE128_PATTERNS[STOP].split("").map(Number).reduce((a, b) => a + b, 0)).toBe(13);
  });

  it("gives every character an even number of bar modules", () => {
    // The parity property of Code 128. A single mistyped digit breaks it.
    for (let v = 0; v <= 105; v += 1) {
      const widths = CODE128_PATTERNS[v].split("").map(Number);
      const bars = widths[0] + widths[2] + widths[4];
      expect(bars % 2).toBe(0);
    }
  });

  it("matches the published start and stop module strings", () => {
    expect(widthsToModules(CODE128_PATTERNS[START_A])).toBe("11010000100");
    expect(widthsToModules(CODE128_PATTERNS[START_B])).toBe("11010010000");
    expect(widthsToModules(CODE128_PATTERNS[START_C])).toBe("11010011100");
    expect(widthsToModules(CODE128_PATTERNS[STOP])).toBe("1100011101011");
    expect(widthsToModules(CODE128_PATTERNS[0])).toBe("11011001100");
  });
});

describe("Code 128 check character", () => {
  it('matches the published "Wikipedia" vector', () => {
    const r = encodeCode128Text("Wikipedia");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.symbol.values]).toEqual([START_B, 55, 73, 75, 73, 80, 69, 68, 73, 65]);
    expect(r.symbol.checkValue).toBe(88);
    expect(r.symbol.modules).toBe(11 * 11 + 13);
    expect(r.symbol.pattern).toHaveLength(r.symbol.modules);
    expect(r.symbol.pattern.startsWith("11010010000")).toBe(true);
    expect(r.symbol.pattern.endsWith("1100011101011")).toBe(true);
  });

  it("computes modulo 103 over position-weighted values", () => {
    expect(code128CheckValue([START_B, 55, 73, 75, 73, 80, 69, 68, 73, 65])).toBe(88);
    expect(code128CheckValue([START_C, 102, 1, 0, 81, 7, 97, 3, 1, 24])).toBe(56);
    // Worked by hand: (105 + 1*102 + 2*1 + 3*0 + 4*81 + 5*7 + 6*97 + 7*3 +
    // 8*1 + 9*24) = 1395; 1395 mod 103 = 56.
    expect(1395 % 103).toBe(56);
  });
});

describe("GS1-128", () => {
  it("leads with FNC1 and encodes a GTIN element in subset C", () => {
    const r = encodeGs1_128("(01)00810797030124");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.symbol.values]).toEqual([START_C, 102, 1, 0, 81, 7, 97, 3, 1, 24]);
    expect(r.symbol.checkValue).toBe(56);
    expect(r.symbol.humanReadable).toBe("(01)00810797030124");
    expect(r.symbol.modules).toBe(11 * 11 + 13);
  });

  it("zero-pads a GTIN-12 in AI (01) up to GTIN-14", () => {
    const r = encodeGs1_128("(01)810797030124");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.symbol.humanReadable).toBe("(01)00810797030124");
    expect(r.symbol.notes.join(" ")).toContain("zero-padded to GTIN-14");
  });

  it("reads a bare GTIN as AI (01)", () => {
    const r = encodeGs1_128("810797030124");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.symbol.humanReadable).toBe("(01)00810797030124");
  });

  it("chooses subsets to minimise the symbol", () => {
    // A long numeric run belongs in subset C, two digits per character.
    const numeric = encodeCode128Text("1234567890");
    expect(numeric.ok).toBe(true);
    if (!numeric.ok) return;
    expect(numeric.symbol.values[0]).toBe(START_C);
    expect(numeric.symbol.values).toHaveLength(6); // start + five pairs

    // A short run does not pay for the switch.
    const mixed = encodeCode128Text("AB12CD");
    expect(mixed.ok).toBe(true);
    if (!mixed.ok) return;
    expect(mixed.symbol.values[0]).toBe(START_B);
    expect(mixed.symbol.values).toHaveLength(7); // start + six characters

    // An odd-length run mid-string: the leading digit stays in B, then CODE C
    // and three pairs. Asserted as the exact sequence — "<= 8 characters" was
    // satisfied by encodings that are not the optimal one.
    const odd = encodeCode128Text("A1234567");
    expect(odd.ok).toBe(true);
    if (!odd.ok) return;
    // START_B, 'A'(33), '1'(17), CODE C(99), 23, 45, 67.
    expect([...odd.symbol.values]).toEqual([START_B, 33, 17, 99, 23, 45, 67]);
  });

  it("separates variable-length elements with FNC1 but not fixed ones", () => {
    const fixedThenVar = encodeGs1_128("(01)00810797030124(10)LOT42");
    expect(fixedThenVar.ok).toBe(true);
    if (!fixedThenVar.ok) return;
    // AI 01 has a defined length, so no separator follows it and the last
    // element needs none either: exactly one FNC1, in the lead position.
    expect(fixedThenVar.symbol.values.filter((v) => v === 102)).toHaveLength(1);

    const varThenFixed = encodeGs1_128("(10)LOT42(17)261231");
    expect(varThenFixed.ok).toBe(true);
    if (!varThenFixed.ok) return;
    // Lead FNC1 plus one closing the variable-length lot number.
    expect(varThenFixed.symbol.values.filter((v) => v === 102)).toHaveLength(2);
  });

  it("parses bracketed AI strings", () => {
    const p = parseAiString("(01)00810797030124(17)261231(10)LOT 42");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.elements).toEqual([
      { ai: "01", value: "00810797030124" },
      { ai: "17", value: "261231" },
      { ai: "10", value: "LOT 42" },
    ]);
  });

  it("lays out at 10X light margins and the module count times X", () => {
    const r = expectOk(
      renderBarcode(req({ symbology: "gs1-128", value: "(01)00810797030124" })),
    );
    const x = r.moduleWidth;
    expect(x).toBe(NOMINAL_X_CODE128_UPT);
    const totalModules = 11 * 11 + 13 + 2 * CODE128_QUIET_X;
    expect(r.width).toBe(totalModules * x);
    expect(r.quietLeft).toBe(10 * x);
    expect(r.quietRight).toBe(10 * x);
    expect(r.encodedValue).toBe("(01)00810797030124");
    expect(r.bars.every((b) => b.h === r.bars[0].h)).toBe(true);
    // Bar module count must equal the dark modules of the pattern.
    const darkModules = r.bars.reduce((n, b) => n + b.w / x, 0);
    const enc = encodeGs1_128("(01)00810797030124");
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    expect(darkModules).toBe(darkCount(enc.symbol.pattern));
  });

  it("refuses more than 48 data characters", () => {
    const long = `(10)${"A".repeat(60)}`;
    expect(expectErr(renderBarcode(req({ symbology: "gs1-128", value: long }))).code).toBe(
      "TOO_LONG",
    );
  });
});

/* ------------------------------------------------------------------ QR / DL */

describe("QR and GS1 Digital Link", () => {
  it("builds a canonical Digital Link URI", () => {
    expect(digitalLinkUri("00810797030124")).toBe("https://id.gs1.org/01/00810797030124");
    expect(digitalLinkUri("00810797030124", { domain: "https://example.com/" })).toBe(
      "https://example.com/01/00810797030124",
    );
    expect(digitalLinkUri("00810797030124", { domain: "id.example.com" })).toBe(
      "https://id.example.com/01/00810797030124",
    );
    expect(
      digitalLinkUri("00810797030124", { lot: "L42", serial: "S1", expiry: "261231" }),
    ).toBe("https://id.gs1.org/01/00810797030124/10/L42/21/S1?17=261231");
  });

  it("encodes a GTIN as a Digital Link QR", () => {
    const r = expectOk(
      renderBarcode(
        req({
          symbology: "gs1-digital-link",
          value: "810797030124",
          digitalLinkDomain: "https://example.com",
        }),
      ),
    );
    expect(r.encodedValue).toBe("https://example.com/01/00810797030124");
    expect(r.moduleWidth).toBe(NOMINAL_X_QR_UPT);

    const matrix = encodeQr(r.encodedValue);
    expect(matrix.ok).toBe(true);
    if (!matrix.ok) return;
    const size = matrix.matrix.size;
    // 4-module quiet zone on all four sides is mandatory.
    expect(r.quietLeft).toBe(QR_QUIET_MODULES * r.moduleWidth);
    expect(r.quietTop).toBe(QR_QUIET_MODULES * r.moduleWidth);
    expect(r.width).toBe((size + 2 * QR_QUIET_MODULES) * r.moduleWidth);

    // One square rect per dark module, none inside the quiet zone.
    const dark = matrix.matrix.dark.filter(Boolean).length;
    expect(r.bars).toHaveLength(dark);
    for (const b of r.bars) {
      expect(b.w).toBe(r.moduleWidth);
      expect(b.h).toBe(r.moduleWidth);
      expect(b.x).toBeGreaterThanOrEqual(r.quietLeft);
      expect(b.y).toBeGreaterThanOrEqual(r.quietTop);
      expect(b.x + b.w).toBeLessThanOrEqual(r.width - r.quietLeft);
    }
  });

  it("encodes a plain QR verbatim", () => {
    const r = expectOk(
      renderBarcode(
        req({ symbology: "qr", value: "https://freedomcombatgear.com/p/409TF", showHumanReadable: false }),
      ),
    );
    expect(r.encodedValue).toBe("https://freedomcombatgear.com/p/409TF");
    expect(r.width).toBe(r.height);
    expect(r.bars.length).toBeGreaterThan(0);
  });

  it("passes a supplied resolver URI straight through", () => {
    const r = expectOk(
      renderBarcode(
        req({ symbology: "gs1-digital-link", value: "https://id.gs1.org/01/09506000134352/21/XYZ" }),
      ),
    );
    expect(r.encodedValue).toBe("https://id.gs1.org/01/09506000134352/21/XYZ");
  });

  it("rejects an empty QR value", () => {
    expect(expectErr(renderBarcode(req({ symbology: "qr", value: "  " }))).code).toBe("EMPTY");
  });
});


/* --------------------------------------------- adversarial review regressions */

describe("regressions found by adversarial review", () => {
  it("reports a wrong check digit on a 13/14-digit GTIN as BAD_CHECK_DIGIT, not BAD_LENGTH", () => {
    // The widened UPC-A/EAN-13 readings used to collapse every failure of the
    // 13/14-digit attempt into "expected 11, 12, 13 or 14 digits", telling the
    // operator the length was wrong when the length was fine.
    for (const value of ["0810797030125", "00810797030125"]) {
      const norm = normaliseUpcA(value);
      expect(norm.ok).toBe(false);
      if (norm.ok) return;
      expect(norm.error.code).toBe("BAD_CHECK_DIGIT");
      expect(norm.error.value).toBe(value);
      expect(norm.error.message).toContain("4 is correct");
    }
    const ean = normaliseEan13("00810797030125");
    expect(ean.ok).toBe(false);
    if (ean.ok) return;
    expect(ean.error.code).toBe("BAD_CHECK_DIGIT");

    // A genuine length failure still reads as one.
    const short = normaliseUpcA("12345");
    expect(short.ok).toBe(false);
    if (short.ok) return;
    expect(short.error.code).toBe("BAD_LENGTH");
  });

  it("never turns a signed number into a valid-looking GTIN", () => {
    // "-36000291452" is 12 characters. Stripping the "-" leaves an 11-digit
    // body, which the UPC-A reading would then hand a computed check digit —
    // printing 360002914522, a real-looking barcode for a value nobody typed.
    for (const value of ["-36000291452", "+36000291452", ".036000291452", "036000291452-"]) {
      const norm = normaliseUpcA(value);
      expect(norm.ok).toBe(false);
      if (norm.ok) return;
      expect(norm.error.code).toBe("BAD_CHARSET");
    }
    // Separators BETWEEN digits are still the ordinary printed form, and their
    // removal is now stated in a note rather than passing unremarked.
    const spaced = normaliseUpcA("0 36000 29145 2");
    expect(spaced.ok && spaced.value.gtin).toBe("036000291452");
    expect(spaced.ok && spaced.value.notes.join(" ")).toContain("separators removed");
    expect(sanitiseDigits("036-000 291.452")).toBe("036000291452");
    expect(sanitiseDigits("-36000291452")).toBe("-36000291452");
    // A trailing ".0" is a spreadsheet artefact, not a check digit.
    const decimal = normaliseUpcA("036000291452.0");
    expect(decimal.ok).toBe(false);
  });

  it("accepts only GS1 GTIN lengths in AI (01)", () => {
    // 9, 10 and 11 digits are not GTIN lengths. Padding them to 14 invents an
    // identifier: (01)1234567895 used to encode as (01)00001234567895.
    for (const value of ["1234567895", "12345678905", "123456789"]) {
      const r = encodeGs1_128(`(01)${value}`);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(["BAD_LENGTH", "BAD_CHECK_DIGIT"]).toContain(r.error.code);
    }
    const ten = encodeGs1_128("(01)1234567895");
    expect(ten.ok).toBe(false);
    if (ten.ok) return;
    expect(ten.error.code).toBe("BAD_LENGTH");
    expect(ten.error.message).toContain("8, 12, 13 or 14");

    // The four real lengths all still work and all pad to the same GTIN-14.
    for (const value of ["810797030124", "0810797030124", "00810797030124"]) {
      const r = encodeGs1_128(`(01)${value}`);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.symbol.humanReadable).toBe("(01)00810797030124");
    }
    const eight = encodeGs1_128("(01)96385074");
    expect(eight.ok && eight.symbol.humanReadable).toBe("(01)00000096385074");
  });

  it("refuses AI data outside GS1 encodable character set 82", () => {
    // The set is not "printable ASCII": it excludes space, #, $, @, [, \, ],
    // ^, `, {, |, } and ~. A GS1-128 carrying one of those scans but fails
    // verification, so it is reported instead of encoded.
    for (const ch of [" ", "#", "$", "@", "[", "]", "^", "`", "{", "|", "}", "~", "\\"]) {
      const r = encodeGs1_128(`(10)A${ch}B`);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("BAD_CHARSET");
      expect(r.error.message).toContain("82");
    }
    // Everything the set does allow still encodes.
    for (const value of ["LOT-42", "LOT.42/A", "L!O\"T%42", "a_z:;<=>?", "A*B+C,D'E"]) {
      expect(encodeGs1_128(`(10)${value}`).ok).toBe(true);
    }
  });

  it("refuses to build a symbol from an unvalidated value instead of emitting one made of undefined", () => {
    // encodeUpcA("12345") used to return a 109-module "pattern" containing the
    // literal text "undefined" and report it as a valid symbol.
    expect(() => encodeUpcA("12345")).toThrow(/12 validated digits/);
    expect(() => encodeUpcA("abcdefghijkl")).toThrow(/12 validated digits/);
    expect(() => encodeUpcA("0360002914521")).toThrow(/12 validated digits/);
    expect(() => encodeEan13("")).toThrow(/13 validated digits/);
    expect(() => encodeEan13("036000291452")).toThrow(/13 validated digits/);
    // The validated forms are untouched.
    expect(encodeUpcA("036000291452").pattern).toHaveLength(EAN_UPC_MODULES);
    expect(encodeEan13("5901234123457").pattern).toHaveLength(EAN_UPC_MODULES);
  });

  it("keeps every geometric quantity finite when the font size is not", () => {
    // A NaN font size used to come back as render.height === NaN and a NaN
    // baseline on every run, straight through to the PDF writer.
    for (const fontSize of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const r = expectOk(
        renderBarcode(req({ symbology: "upca", value: "036000291452", humanReadableFontSize: fontSize })),
      );
      expect(Number.isInteger(r.height)).toBe(true);
      expect(Number.isInteger(r.width)).toBe(true);
      for (const t of r.text) {
        expect(Number.isInteger(t.baseline)).toBe(true);
        expect(Number.isInteger(t.fontSize)).toBe(true);
        expect(Number.isInteger(t.width)).toBe(true);
      }
      expect(r.notes.some((n) => n.includes("font size"))).toBe(true);
    }
    // Silent when no human-readable text is drawn at all.
    const hidden = expectOk(
      renderBarcode(
        req({
          symbology: "upca",
          value: "036000291452",
          humanReadableFontSize: Number.NaN,
          showHumanReadable: false,
          showLightMarginIndicator: false,
        }),
      ),
    );
    expect(hidden.notes.some((n) => n.includes("font size"))).toBe(false);
    expect(Number.isInteger(hidden.height)).toBe(true);
  });

  it("reports a Digital Link domain that cannot resolve rather than encoding it", () => {
    for (const domain of ["exa mple.com", "javascript:alert(1)", "ftp://x.com", "http://"]) {
      const e = expectErr(
        renderBarcode(
          req({ symbology: "gs1-digital-link", value: "810797030124", digitalLinkDomain: domain }),
        ),
      );
      expect(e.code).toBe("BAD_CHARSET");
    }
    // A supplied resolver URI is held to the same standard.
    expect(
      expectErr(renderBarcode(req({ symbology: "gs1-digital-link", value: "https://exa mple.com/01/x" }))).code,
    ).toBe("BAD_CHARSET");
    // Usable domains, bare or with a scheme or a trailing slash, still work.
    for (const domain of ["https://example.com", "id.example.com", "https://example.com/", "https://example.com/gs1"]) {
      const r = expectOk(
        renderBarcode(
          req({ symbology: "gs1-digital-link", value: "810797030124", digitalLinkDomain: domain }),
        ),
      );
      expect(r.encodedValue.endsWith("/01/00810797030124")).toBe(true);
    }
  });

  it("covers the GTIN helpers the first suite left untested", () => {
    expect(padGtin("96385074", 14)).toBe("00000096385074");
    expect(padGtin("00810797030124", 14)).toBe("00810797030124");
    expect(narrowGtin("00810797030124", 12)).toBe("810797030124");
    expect(narrowGtin("10810797030121", 12)).toBeNull();
    expect(narrowGtin("810797030124", 14)).toBeNull();
    // Zero padding never disturbs the check digit, whatever the parity of the
    // number of zeros added, because a zero weighs nothing at either weight.
    for (const gtin of ["96385074", "810797030124", "0810797030124"]) {
      expect(hasValidCheckDigit(gtin)).toBe(true);
      expect(hasValidCheckDigit(padGtin(gtin, 14))).toBe(true);
    }
    const eight = normaliseGtin14("96385074");
    expect(eight.ok && eight.value.gtin).toBe("00000096385074");
    expect(eight.ok && eight.value.notes.join(" ")).toContain("GTIN-8 zero-padded");
    // A GTIN-8 is not a UPC-A and is not quietly widened into one.
    expect(expectErr(renderBarcode(req({ symbology: "upca", value: "96385074" }))).code).toBe("BAD_LENGTH");
    // But it is a perfectly good Digital Link.
    expect(
      expectOk(renderBarcode(req({ symbology: "gs1-digital-link", value: "96385074" }))).encodedValue,
    ).toBe("https://id.gs1.org/01/00000096385074");
  });

  it("reaches subset A for control characters, with SHIFT only when it is cheaper", () => {
    // Nothing in the first suite exercised subset A or the SHIFT character.
    // Upper case plus a control character is cheapest wholly inside A: START_A,
    // 'A'(33), 'B'(34), TAB(9 + 64 = 73), 'C'(35), 'D'(36) — no SHIFT at all.
    const upperWithControl = encodeCode128Text(`AB${String.fromCharCode(9)}CD`);
    expect(upperWithControl.ok).toBe(true);
    if (!upperWithControl.ok) return;
    expect([...upperWithControl.symbol.values]).toEqual([START_A, 33, 34, 73, 35, 36]);

    // Lower case cannot live in A, so the one control character is borrowed
    // from A with SHIFT(98) rather than paying for two subset switches.
    const lowerWithControl = encodeCode128Text(`ab${String.fromCharCode(9)}cd`);
    expect(lowerWithControl.ok).toBe(true);
    if (!lowerWithControl.ok) return;
    expect([...lowerWithControl.symbol.values]).toEqual([START_B, 65, 66, 98, 73, 67, 68]);
    expect(lowerWithControl.symbol.pattern).toHaveLength(lowerWithControl.symbol.modules);

    // Non-ASCII is refused, not truncated to a low byte.
    const emoji = encodeCode128Text("A\u{1F600}B");
    expect(emoji.ok).toBe(false);
    if (emoji.ok) return;
    expect(emoji.error.code).toBe("BAD_CHARSET");
    expect(encodeCode128Text("").ok).toBe(false);
  });

  it("survives degenerate magnifications, bar heights and fit widths", () => {
    for (const magnificationBps of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      const r = expectOk(renderBarcode(req({ symbology: "upca", value: "036000291452", magnificationBps })));
      expect(r.moduleWidth).toBe(moduleWidthFor("upca", 10_000));
      expect(r.notes.some((n) => n.includes("not usable"))).toBe(true);
    }
    for (const barHeight of [Number.NaN, 0, -1_000]) {
      const r = expectOk(renderBarcode(req({ symbology: "upca", value: "036000291452", barHeight })));
      expect(r.bars.every((b) => Number.isInteger(b.h) && b.h > 0)).toBe(true);
      expect(r.notes.some((n) => n.includes("bar height"))).toBe(true);
    }
    // A fit width no symbol can meet clamps to the floor and says so; it never
    // returns a zero-width or fractional symbol.
    const tiny = expectOk(renderBarcode(req({ symbology: "upca", value: "036000291452", fitWidth: 1 })));
    expect(tiny.moduleWidth).toBe(moduleWidthFor("upca", MIN_MAGNIFICATION_BPS));
    expect(tiny.notes.some((n) => n.includes("target width"))).toBe(true);
    // Zero and negative fit widths fall back to the requested magnification.
    for (const fitWidth of [0, -100, Number.NaN]) {
      const r = expectOk(renderBarcode(req({ symbology: "upca", value: "036000291452", fitWidth })));
      expect(r.moduleWidth).toBe(moduleWidthFor("upca", 10_000));
    }
    // Every symbology fits a target without exceeding it.
    for (const symbology of ["upca", "ean13", "gs1-128", "qr"] as const) {
      const fit = magnificationForWidth(symbology, 113, 120_000_000);
      expect(Number.isInteger(fit.moduleWidth)).toBe(true);
      expect(fit.clamped || fit.width <= 120_000_000).toBe(true);
    }
  });

  it("rejects QR data it cannot hold instead of truncating it", () => {
    const e = expectErr(renderBarcode(req({ symbology: "qr", value: "A".repeat(10_000) })));
    expect(e.code).toBe("TOO_LONG");
    // Just inside capacity still renders, one square rect per dark module.
    const r = expectOk(
      renderBarcode(req({ symbology: "qr", value: "A".repeat(500), showHumanReadable: false })),
    );
    expect(r.width).toBe(r.height);
    expect(r.bars.every((b) => b.w === r.moduleWidth && b.h === r.moduleWidth)).toBe(true);
  });
});
