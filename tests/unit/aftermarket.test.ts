import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  classifyComponent,
  mergeAftermarketReads,
  packLine,
  parseDisplayLine,
  presetFromItemNumber,
  readAftermarketBom,
  type Cell,
} from "@/lib/import/profiles/aftermarket";
import {
  looksLikeAftermarket,
  readAftermarketWorkbook,
  type AftermarketWorkbook,
} from "@/lib/import/profiles/aftermarket-workbook";

const WORKBOOK = path.join(process.cwd(), "docs/source/Aftermarket Rev B 2026.8.10.xlsx");

describe("pack-contents line parsing", () => {
  it("splits the format the workbook already writes", () => {
    expect(parseDisplayLine('2) Grease Seal 1.25" ID (DL-125-03)')).toEqual({
      quantity: 2,
      quantityText: "2",
      name: 'Grease Seal 1.25" ID',
      partNumber: "DL-125-03",
    });
  });

  it("keeps parentheses that belong to the name", () => {
    // Only a TRAILING parenthesis is a part code.
    const r = parseDisplayLine("1) Bearing (inner) and race (L44610)");
    expect(r.name).toBe("Bearing (inner) and race");
    expect(r.partNumber).toBe("L44610");
  });

  it("handles a line with no count and no code", () => {
    expect(parseDisplayLine("Cotter Pin")).toEqual({
      quantity: null,
      quantityText: "",
      name: "Cotter Pin",
      partNumber: "",
    });
  });

  it("round-trips back to a printable line", () => {
    const line = '2) Inner Bearing (L44643)';
    const p = parseDisplayLine(line);
    expect(
      packLine({
        rowNumber: 1,
        itemNumber: "",
        formerNumber: "",
        displayLine: line,
        quantityText: p.quantityText,
        quantity: p.quantity ?? 0,
        name: p.name,
        partNumber: p.partNumber,
        role: "component",
        presetCode: null,
      }),
    ).toBe(line);
  });
});

describe("component classification", () => {
  it("separates cost lines from pack contents", () => {
    expect(classifyComponent("Clam", "206TF")).toBe("clamshell");
    expect(classifyComponent("Label", "206LABEL")).toBe("label");
    // The sheet appends the clamshell size to some label lines.
    expect(classifyComponent("Label206", "Z-11-500")).toBe("label");
    expect(classifyComponent("Labor", "LABOR75")).toBe("labor");
    expect(classifyComponent("Box", "")).toBe("packaging");
    expect(classifyComponent('2) Inner Bearing (L44643)', "L44643")).toBe("component");
  });

  it("reads the card preset off a clamshell line", () => {
    expect(presetFromItemNumber("206TF")).toBe("206TF");
    expect(presetFromItemNumber("409TF")).toBe("409TF");
    expect(presetFromItemNumber("206LABEL")).toBeNull();
    // A clamshell we do not have a preset for is reported, not invented.
    expect(presetFromItemNumber("999TF")).toBeNull();
  });
});

describe("block reader", () => {
  const header: Cell[] = ["AFTMKT #", "Former AxleTek #", "Item #", "Parts Included in Kit", "Description", "GS1 Code", "QTY Inc"];
  const grid: Cell[][] = [
    ["Aftermarket Rev B", null, null, null, null, null, null],
    header,
    ["11-850", "K-DL-125-03", "11-850", "", "GENUINE AXLETEK 2K KIT", "810797031398", "1"],
    ["12-892", "DL-125-03", "12-892", '2) Grease Seal 1.25" ID (DL-125-03)', "", "", "2"],
    ["RG06-010", "206TF", "206TF", "Clam", "", "", "1"],
    ["", "", "206LABEL", "Label", "", "", "1"],
    ["", "", "LABOR75", "Labor", "", "", "1"],
    ["", "", "", "Box", "", "", "0.25"],
    [null, null, null, null, null, null, null],
    ["11-855", "K-DL-150-03", "11-855", "", "GENUINE AXLETEK 2K KIT B", "810797031404", "1"],
    ["12-860", "DL-150-03", "12-860", '2) Grease Seal 1.50" ID (DL-150-03)', "", "", "2"],
  ];

  it("finds the header under a title row", () => {
    expect(readAftermarketBom(grid, "t").headerRowNumber).toBe(2);
  });

  it("splits blocks on the blank row and keeps every line", () => {
    const read = readAftermarketBom(grid, "t");
    expect(read.counts.kits).toBe(2);
    expect(read.kits[0].partNumber).toBe("11-850");
    expect(read.kits[0].components).toHaveLength(5);
    expect(read.orphanRows).toHaveLength(0);
  });

  it("prints only what is in the pack", () => {
    const kit = readAftermarketBom(grid, "t").kits[0];
    expect(kit.packContents.map((c) => c.partNumber)).toEqual(["DL-125-03"]);
    // The clamshell, label, labour and box are on the bill and off the card.
    expect(kit.components.filter((c) => c.role !== "component")).toHaveLength(4);
  });

  it("reads the card preset from the clamshell line", () => {
    expect(readAftermarketBom(grid, "t").kits[0].presetCode).toBe("206TF");
  });

  it("reports a kit with no clamshell rather than guessing one", () => {
    const kit = readAftermarketBom(grid, "t").kits[1];
    expect(kit.presetCode).toBeNull();
    expect(kit.notes.join(" ")).toContain("card preset is unknown");
  });

  it("records a component line that has no kit above it", () => {
    const broken: Cell[][] = [header, ["", "", "X-1", "1) Orphan (X-1)", "", "", "1"]];
    const read = readAftermarketBom(broken, "t");
    expect(read.kits).toHaveLength(0);
    expect(read.orphanRows).toHaveLength(1);
    expect(read.orphanRows[0].reason).toContain("no kit above it");
  });

  it("returns an empty read for a sheet with no recognisable header", () => {
    const read = readAftermarketBom([["a", "b"], ["c", "d"]], "t");
    expect(read.headerRowNumber).toBe(0);
    expect(read.kits).toHaveLength(0);
  });
});

describe("merging the two BOM sheets", () => {
  const mk = (name: string, preset: string | null) => ({
    sheetName: name,
    headerRowNumber: 2,
    kits: [
      {
        rowNumber: 3,
        partNumber: "11-850",
        formerNumber: "",
        itemNumber: "",
        description: "Kit",
        upc: "810797031398",
        quantityText: "1",
        components: [],
        presetCode: preset,
        packContents: [],
        notes: [],
      },
    ],
    orphanRows: [],
    counts: {
      blocks: 1, kits: 1, kitsWithUpc: 1, kitsWithPreset: preset ? 1 : 0,
      components: 0, packContentLines: 0, nonPrintingLines: 0,
    },
    presetCounts: preset ? { [preset]: 1 } : {},
  });

  it("fills a missing preset from the other sheet and says where it came from", () => {
    const merged = mergeAftermarketReads(mk("A", null), mk("B", "206TF"));
    expect(merged.kits[0].presetCode).toBe("206TF");
    expect(merged.kits[0].presetSource).toBe("B");
    expect(merged.counts.presetsBorrowed).toBe(1);
    expect(merged.kits[0].notes.join(" ")).toContain("taken from B");
  });

  it("does not overwrite a preset the newer sheet already states", () => {
    const merged = mergeAftermarketReads(mk("A", "409TF"), mk("B", "206TF"));
    expect(merged.kits[0].presetCode).toBe("409TF");
    expect(merged.kits[0].presetSource).toBe("A");
    expect(merged.counts.presetsBorrowed).toBe(0);
  });
});

describe("the real Aftermarket Rev B workbook", () => {
  let wb: AftermarketWorkbook;

  beforeAll(async () => {
    expect(fs.existsSync(WORKBOOK)).toBe(true);
    wb = await readAftermarketWorkbook(fs.readFileSync(WORKBOOK));
  }, 120_000);

  it("is recognised as an Aftermarket workbook", () => {
    expect(looksLikeAftermarket(wb.sheetNames)).toBe(true);
    expect(wb.sheetNames).toHaveLength(12);
  });

  it("parses every BOM block without orphaning a row", () => {
    expect(wb.bom.primary.orphanRows).toHaveLength(0);
    expect(wb.bom.fallback?.orphanRows ?? []).toHaveLength(0);
    expect(wb.bom.counts.kits).toBeGreaterThan(130);
    expect(wb.bom.counts.packContentLines).toBeGreaterThan(600);
  });

  it("recovers card presets the newer sheet alone does not name", () => {
    expect(wb.bom.counts.presetsBorrowed).toBeGreaterThan(0);
    expect(wb.bom.counts.kitsWithPreset).toBeGreaterThan(
      wb.bom.primary.counts.kitsWithPreset,
    );
    expect(Object.keys(wb.bom.presetCounts).sort()).toEqual(["206TF", "277TF", "409TF"]);
  });

  it("keeps both kits when one UPC is on two of them, and says so", () => {
    // Three UPCs are on two kits each in the supplied file. A GTIN identifies
    // one trade item, so this is a conflict for the brand owner to resolve — the
    // importer must not pick a winner.
    expect(wb.bom.counts.conflictedKeys).toBe(3);
    expect(wb.bom.duplicateKeys.length).toBeGreaterThanOrEqual(6);
    for (const d of wb.bom.duplicateKeys) {
      const both = wb.bom.kits.filter((k) => (k.upc || k.partNumber.toUpperCase()) === d.key);
      expect(both.length).toBeGreaterThan(1);
      expect(both.some((k) => k.notes.join(" ").includes("more than one kit"))).toBe(true);
    }
  });

  it("loses no kit to the merge", () => {
    const a = wb.bom.primary.counts.kits;
    const b = wb.bom.fallback?.counts.kits ?? 0;
    // Every kit from the newer sheet, plus the ones only the older sheet has.
    expect(wb.bom.counts.kits).toBe(a + wb.bom.counts.kitsOnlyInFallback + (b > 0 ? wb.bom.duplicateKeys.filter((d) => d.sheet === wb.bom.fallback!.sheetName).length : 0));
  });

  it("reads the 11-500 benchmark kit with its real pack contents", () => {
    const kit = wb.bom.kits.find((k) => k.partNumber === "11-500");
    expect(kit).toBeDefined();
    expect(kit!.upc).toBe("810797031626");
    expect(kit!.presetCode).toBe("206TF");
    expect(kit!.packContents.map(packLine)).toEqual([
      "2) Inner Bearing (L44643)",
      "2) Inner Race (L44610)",
      '1) Grease Seal 1.25" ID (DL-125-03)',
      '1) Cotter Pin 1/8" x 1-3/4" (A01900200)',
      "1) Tang Washer (A00510100)",
    ]);
    // The clamshell, label, labour and box are on the bill and off the card.
    expect(kit!.components.length).toBeGreaterThan(kit!.packContents.length);
  });

  it("reads the clamshell reference sheet as text, not as [object Object]", () => {
    expect(wb.clamshells).toHaveLength(3);
    const c409 = wb.clamshells.find((c) => c.code === "409TF")!;
    expect(c409.cardSize).toContain("7.125");
    expect(c409.cavitySize).toContain("5.563");
    for (const c of wb.clamshells) expect(c.link).not.toContain("[object");
  });

  it("reads the GS1 sheet as a second source for the same UPCs", () => {
    expect(wb.gs1.length).toBeGreaterThan(200);
    const row = wb.gs1.find((g) => g.partNumber === "10-825");
    expect(row?.upc).toBe("810797030001");
  });

  it("names the sheets it does not read, and why", () => {
    expect(wb.unread.length).toBeGreaterThan(4);
    for (const u of wb.unread) expect(u.reason.length).toBeGreaterThan(20);
  });
});
