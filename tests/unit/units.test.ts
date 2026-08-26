import { describe, expect, it } from "vitest";
import {
  UPT_PER_IN,
  formatLength,
  inToUpt,
  mmToUpt,
  parseLength,
  uptToIn,
  uptToPt,
  degToMdeg,
  pctToBps,
} from "@/lib/units";

describe("units", () => {
  it("maps every supplied preset dimension to an exact integer", () => {
    // If any of these were not integral the whole "no drift" claim would be false.
    for (const v of [4.3675, 7.11175, 4.343, 5.7875, 3.1175, 6.4775, 0.125, 0.25, 0.1875]) {
      const u = inToUpt(v);
      expect(Number.isInteger(u)).toBe(true);
      expect(u).toBe(v * UPT_PER_IN);
      expect(uptToIn(u)).toBeCloseTo(v, 10);
    }
  });

  it("converts to PDF points exactly for the full-bleed canvases", () => {
    expect(uptToPt(inToUpt(4.6175))).toBeCloseTo(332.46, 10);
    expect(uptToPt(inToUpt(7.36175))).toBeCloseTo(530.046, 10);
  });

  it("does not drift over repeated addition", () => {
    let acc = 0;
    for (let i = 0; i < 10_000; i++) acc += inToUpt(0.0625);
    expect(acc).toBe(inToUpt(0.0625) * 10_000);
    expect(uptToIn(acc)).toBe(625);
  });

  it("round-trips millimetres to sub-nanometre precision", () => {
    const u = mmToUpt(110.31);
    expect(Math.abs(u / (UPT_PER_IN / 25.4) - 110.31)).toBeLessThan(1e-6);
  });

  it("parses the input forms a print operator actually types", () => {
    expect(parseLength("4.3675", "in")).toBe(inToUpt(4.3675));
    expect(parseLength('4.3675"', "mm")).toBe(inToUpt(4.3675));
    expect(parseLength("110.31mm", "in")).toBe(mmToUpt(110.31));
    expect(parseLength("4 3/8", "in")).toBe(inToUpt(4.375));
    expect(parseLength("3/8", "in")).toBe(inToUpt(0.375));
    expect(parseLength("12pt", "in")).toBe(inToUpt(12 / 72));
    expect(parseLength("", "in")).toBeNull();
    expect(parseLength("abc", "in")).toBeNull();
    expect(parseLength("1/0", "in")).toBeNull();
  });

  it("formats without lying about precision", () => {
    expect(formatLength(inToUpt(4.3675), "in")).toBe("4.3675");
    expect(formatLength(inToUpt(0.25), "in")).toBe("0.25");
    expect(formatLength(inToUpt(1), "in")).toBe("1.0");
  });

  it("stores angles and percentages as integers", () => {
    expect(degToMdeg(1.5)).toBe(1500);
    expect(pctToBps(33.33)).toBe(3333);
  });
});
