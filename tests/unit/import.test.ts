import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";

import { operationsByKind, planImport } from "../../src/lib/import/commit";
import {
  inspectParsedWorkbook,
  parseWorkbook,
  readParsedSheetRows,
  type ParsedWorkbook,
} from "../../src/lib/import/inspect";
import {
  SOURCE_PROFILES,
  TARGET_FIELDS,
  compactHeader,
  detectProfile,
  normalizeHeader,
  scoreHeaderAgainstField,
  splitFieldValue,
  suggestMapping,
  validateMapping,
} from "../../src/lib/import/mapping";
import {
  buildPreview,
  canonicalGtin,
  gtinCheckDigit,
  isValidGtin,
  looksLikeInternalCode,
  parseBooleanCell,
} from "../../src/lib/import/preview";
import {
  IMPORT_FINDING_CODES,
  SHEET_NOTE_CODES,
  type ExistingProduct,
  type ImportPreview,
  type SheetMapping,
} from "../../src/lib/import/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKBOOK_PATH = resolve(
  HERE,
  "../../docs/source/ExportAllProducts_20260826220203076.xlsx",
);

/* ------------------------------------------------------------- fixtures */

type FixtureSheet = {
  name: string;
  rows: (string | number | null)[][];
  merges?: string[];
};

/** Build a real .xlsx in memory so the fixtures go through the same reader. */
async function makeWorkbook(sheets: FixtureSheet[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name);
    for (const row of sheet.rows) ws.addRow(row);
    for (const merge of sheet.merges ?? []) ws.mergeCells(merge);
  }
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

function previewOf(
  parsed: ParsedWorkbook,
  sheetName: string,
  existing: ExistingProduct[] = [],
): { preview: ImportPreview; mapping: SheetMapping } {
  const read = readParsedSheetRows(parsed, { sheetName });
  const mapping = suggestMapping(read.headers, {
    sheetName,
    headerRowNumber: read.headerRowNumber,
  });
  const preview = buildPreview({ orgId: "org1", sheetName, mapping, rows: read.rows, existing });
  return { preview, mapping };
}

function findingCodes(preview: ImportPreview): Set<string> {
  const out = new Set<string>();
  for (const row of preview.rows) for (const f of row.findings) out.add(f.code);
  for (const f of preview.findings) out.add(f.code);
  return out;
}

/* ==================================================================== */
/*  Pure helpers                                                        */
/* ==================================================================== */

describe("GTIN validation", () => {
  it("computes known GS1 check digits", () => {
    expect(gtinCheckDigit("03600029145")).toBe(2);
    expect(gtinCheckDigit("81079703000")).toBe(1);
    expect(gtinCheckDigit("0081079703000")).toBe(1);
    expect(gtinCheckDigit("1234567")).toBe(0);
  });

  it("accepts valid GTIN-8, 12 and 14 values", () => {
    expect(isValidGtin("12345670")).toBe(true);
    expect(isValidGtin("036000291452")).toBe(true);
    expect(isValidGtin("810797030001")).toBe(true);
    expect(isValidGtin("00810797030001")).toBe(true);
  });

  it("rejects bad check digits, bad lengths and non-digits", () => {
    expect(isValidGtin("810797030002")).toBe(false);
    expect(isValidGtin("8107970300")).toBe(false);
    expect(isValidGtin("81079703000X")).toBe(false);
    expect(isValidGtin("")).toBe(false);
  });

  it("right-aligns to 14 digits for matching without altering the source form", () => {
    expect(canonicalGtin("810797030001")).toBe("00810797030001");
    expect(canonicalGtin("00810797030001")).toBe("00810797030001");
    expect(canonicalGtin("12345670")).toBe("00000012345670");
    expect(canonicalGtin("1234")).toBe("");
  });
});

describe("row shape helpers", () => {
  it("recognises a bare internal code", () => {
    expect(looksLikeInternalCode("H-150-09")).toBe(true);
    expect(looksLikeInternalCode("11-500")).toBe(true);
    expect(looksLikeInternalCode("GENUINE AXLETEK HOLD-DOWN KIT")).toBe(false);
    expect(looksLikeInternalCode("Bearing")).toBe(false);
    expect(looksLikeInternalCode("")).toBe(false);
  });

  it("parses the Y/N booleans the GS1 export uses", () => {
    expect(parseBooleanCell("Y")).toBe(true);
    expect(parseBooleanCell("n")).toBe(false);
    expect(parseBooleanCell("TRUE")).toBe(true);
    expect(parseBooleanCell("maybe")).toBeUndefined();
  });
});

/* ==================================================================== */
/*  Mapping                                                             */
/* ==================================================================== */

describe("header normalisation and scoring", () => {
  it("normalises punctuation-heavy GS1 headers", () => {
    expect(normalizeHeader("GTIN-12 (U.P.C.)")).toBe("gtin 12 u p c");
    expect(compactHeader("GTIN-12 (U.P.C.)")).toBe("gtin12upc");
    expect(compactHeader("Product Description-Short")).toBe("productdescriptionshort");
  });

  it("scores an exact alias above a partial one", () => {
    const exact = scoreHeaderAgainstField("Brand Name", "brand.name");
    const partial = scoreHeaderAgainstField("Brand Name 2", "brand.name");
    expect(exact).toBe(100);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(exact);
    expect(scoreHeaderAgainstField("Colour", "brand.name")).toBe(0);
  });
});

describe("target field list", () => {
  it("exposes one list with unique keys for the UI to render", () => {
    const keys = TARGET_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("product.partNumber");
    expect(keys).toContain("identifier.gtin14");
    expect(keys).toContain("bomItem.quantity");
  });

  it("splits list cells on the field's own separators", () => {
    expect(splitFieldValue("alternate.partNumber", "L44610, L44649; 25580")).toEqual([
      "L44610",
      "L44649",
      "25580",
    ]);
    expect(splitFieldValue("product.description", "Bearing, Kit")).toEqual(["Bearing, Kit"]);
    expect(splitFieldValue("alternate.partNumber", "  ")).toEqual([]);
  });
});

describe("source profiles", () => {
  it("ships at least the GS1 Data Hub adapter and a generic fallback", () => {
    const ids = SOURCE_PROFILES.map((p) => p.id);
    expect(ids).toContain("gs1-us-datahub-export");
    expect(ids).toContain("generic-product-bom");
    expect(SOURCE_PROFILES.filter((p) => p.fallback)).toHaveLength(1);
  });

  it("ranks the GS1 adapter first on the GS1 header row", () => {
    const headers = [
      "GS1 Company Prefix",
      "GTIN",
      "GTIN-12 (U.P.C.)",
      "Brand Name",
      "Product Description",
      "Status Label",
      "Packaging Level",
      "SKU",
      "Target Markets",
      "Last Modified Date",
    ];
    const ranked = detectProfile(headers, { sheetName: "ExportAllProducts" });
    expect(ranked[0].profileId).toBe("gs1-us-datahub-export");
    expect(ranked[0].score).toBeGreaterThanOrEqual(85);
    expect(ranked[1].profileId).toBe("generic-product-bom");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("falls back to the generic profile on an unknown sheet", () => {
    const ranked = detectProfile(["Part Number", "Description", "UPC", "Brand"], {
      sheetName: "Items",
    });
    expect(ranked[0].profileId).toBe("generic-product-bom");
  });
});

describe("suggestMapping", () => {
  it("maps a generic item sheet by alias", () => {
    const mapping = suggestMapping(["Part No", "Item Description", "U.P.C.", "Qty"], {
      sheetName: "Items",
    });
    const byIndex = (i: number): string | null => mapping.columns[i].field;
    expect(byIndex(0)).toBe("product.partNumber");
    expect(byIndex(1)).toBe("product.description");
    expect(byIndex(2)).toBe("identifier.gtin12");
    expect(byIndex(3)).toBe("bomItem.quantity");
    expect(mapping.missingRequired).toEqual([]);
    expect(mapping.conflicts).toEqual([]);
  });

  it("reports required fields it cannot satisfy", () => {
    const mapping = suggestMapping(["Colour", "Notes", "Comment"], { sheetName: "Notes" });
    expect(mapping.missingRequired).toHaveLength(1);
    expect(mapping.missingRequired[0]).toContain("product.partNumber");
  });

  it("gives a contested single-valued field to the strongest column", () => {
    const mapping = suggestMapping(["Brand Name", "Brand Name 2"]);
    expect(mapping.columns[0].field).toBe("brand.name");
    expect(mapping.columns[1].field).not.toBe("brand.name");
    expect(mapping.columns[1].supersededBy).toBe(0);
    expect(mapping.conflicts).toEqual([]);
  });

  it("recomputes derived state after a manual edit", () => {
    const mapping = suggestMapping(["Part No", "U.P.C."]);
    const edited = validateMapping({
      ...mapping,
      columns: mapping.columns.map((c) => ({ ...c, field: "product.partNumber", source: "manual" })),
    });
    expect(edited.conflicts).toEqual([{ field: "product.partNumber", columnIndexes: [0, 1] }]);
    expect(edited.mappedFields).toEqual(["product.partNumber"]);
  });
});

/* ==================================================================== */
/*  The real GS1 US Data Hub export                                     */
/* ==================================================================== */

describe("GS1 US Data Hub export (docs/source)", () => {
  let parsed: ParsedWorkbook;
  let preview: ImportPreview;
  let mapping: SheetMapping;

  beforeAll(async () => {
    const bytes = readFileSync(WORKBOOK_PATH);
    parsed = await parseWorkbook(bytes, {
      filename: "ExportAllProducts_20260826220203076.xlsx",
    });
    const built = previewOf(parsed, "ExportAllProducts");
    preview = built.preview;
    mapping = built.mapping;
  });

  it("inspects one sheet with 41 columns and 393 data rows", () => {
    const inspection = inspectParsedWorkbook(parsed);
    expect(inspection.sheetCount).toBe(1);

    const sheet = inspection.sheets[0];
    expect(sheet.name).toBe("ExportAllProducts");
    expect(sheet.headerRowNumber).toBe(1);
    expect(sheet.headerConfidence).toBe("high");
    expect(sheet.firstDataRowNumber).toBe(2);
    expect(sheet.dataRowCount).toBe(393);
    expect(sheet.columnCount).toBe(41);
    expect(sheet.headers).toHaveLength(41);
    expect(sheet.headers.slice(0, 6)).toEqual([
      "GS1 Company Prefix",
      "GTIN",
      "GTIN-8",
      "GTIN-12 (U.P.C.)",
      "GTIN-13 (EAN)",
      "Brand Name",
    ]);
    expect(sheet.kind).toBe("products");
    expect(inspection.primarySheetName).toBe("ExportAllProducts");
    expect(inspection.primaryProfileId).toBe("gs1-us-datahub-export");
  });

  it("samples columns, including the ones the export leaves empty", () => {
    const sheet = inspectParsedWorkbook(parsed).sheets[0];
    const byHeader = (h: string) => sheet.columns.find((c) => c.header === h);

    expect(byHeader("GTIN")?.nonEmptyCount).toBe(390);
    expect(byHeader("SKU")?.nonEmptyCount).toBe(388);
    expect(byHeader("GTIN-12 (U.P.C.)")?.nonEmptyCount).toBe(386);
    expect(byHeader("GTIN-8")?.nonEmptyCount).toBe(0);
    expect(byHeader("GTIN-8")?.valueType).toBe("empty");
    expect(byHeader("Brand Name")?.distinctCount).toBe(6);
    expect(byHeader("Status Label")?.distinctCount).toBe(4);
    expect(byHeader("GTIN")?.letter).toBe("B");
    expect(sheet.notes.some((n) => n.code === SHEET_NOTE_CODES.COLUMN_ENTIRELY_EMPTY)).toBe(true);
  });

  it("maps the export through the GS1 adapter, not by guesswork", () => {
    expect(mapping.profileId).toBe("gs1-us-datahub-export");
    expect(mapping.profileScore).toBeGreaterThanOrEqual(85);
    expect(mapping.missingRequired).toEqual([]);
    expect(mapping.conflicts).toEqual([]);

    const field = (header: string): string | null =>
      mapping.columns.find((c) => c.header === header)?.field ?? null;
    expect(field("GTIN")).toBe("identifier.gtin14");
    expect(field("GTIN-12 (U.P.C.)")).toBe("identifier.gtin12");
    expect(field("SKU")).toBe("product.partNumber");
    expect(field("Brand Name")).toBe("brand.name");
    expect(field("Product Description")).toBe("product.description");
    expect(field("Status Label")).toBe("product.status");
    expect(field("Last Modified Date")).toBe("product.lastModifiedSource");
    // Columns with no first-class home are kept, not dropped.
    expect(field("Brand Name 2")).toBe("product.custom");
    expect(field("Gross Weight")).toBe("product.custom");
    expect(mapping.columns.every((c) => c.source === "profile")).toBe(true);
  });

  it("previews 393 rows with the known GTIN, brand and status distribution", () => {
    const s = preview.summary;
    expect(s.totalRows).toBe(393);
    expect(s.rowsWithGtin).toBe(390);
    expect(s.rowsWithoutGtin).toBe(3);
    expect(s.validGtins).toBe(390);
    expect(s.invalidGtins).toBe(0);
    expect(s.rowsWithSku).toBe(388);

    expect(s.brandCounts).toEqual({
      "Axle Teknology": 216,
      TowPro: 149,
      ProAxle: 19,
      "Carry On Trailers": 4,
      "Axle Tek": 3,
      AxleTek: 2,
    });
    expect(s.statusCounts).toEqual({
      "In Use": 361,
      PreMarket: 25,
      Archived: 4,
      Draft: 3,
    });
  });

  it("treats a repeated GTIN as an error and a repeated part number as a scoped warning", () => {
    const s = preview.summary;
    expect(preview.duplicateGtins).toEqual([]);
    expect(s.duplicateGtinRows).toBe(0);

    // 39 part numbers occur on more than one row, giving 41 repeat rows.
    expect(s.duplicateSkuValues).toBe(39);
    expect(s.duplicateSkuRows).toBe(41);
    // Of those, 24 repeat inside a single brand: that is the warning case.
    expect(s.duplicateSkuInBrandRows).toBe(24);
    expect(preview.duplicatePartNumbersInBrand).toHaveLength(22);
    // The rest are the same part number under a different brand, which is legitimate.
    expect(preview.crossBrandPartNumbers).toHaveLength(17);

    const severities = new Map<string, string>();
    for (const row of preview.rows) {
      for (const f of row.findings) severities.set(f.code, f.severity);
    }
    expect(severities.get(IMPORT_FINDING_CODES.SKU_DUPLICATE_IN_BRAND)).toBe("warning");
    expect(severities.get(IMPORT_FINDING_CODES.SKU_DUPLICATE_CROSS_BRAND)).toBe("info");
  });

  it("classifies bare internal codes as not sellable instead of dropping them", () => {
    const notSellable = preview.rows.filter((r) => r.recordType === "non_sellable");
    expect(preview.summary.nonSellableRows).toBe(3);
    expect(notSellable.map((r) => r.fields["product.description"])).toEqual([
      "H-150-09",
      "H-100-09",
      "H-151-09",
    ]);
    expect(
      notSellable.every((r) =>
        r.findings.some((f) => f.code === IMPORT_FINDING_CODES.ROW_NOT_SELLABLE),
      ),
    ).toBe(true);
    // Two of the three still carry a GTIN, so they are imported and marked.
    expect(notSellable.filter((r) => r.classification === "create")).toHaveLength(2);
  });

  it("skips only the one row that cannot be identified at all", () => {
    const s = preview.summary;
    expect(s.create).toBe(392);
    expect(s.update).toBe(0);
    expect(s.unchanged).toBe(0);
    expect(s.skip).toBe(1);
    expect(s.errorRows).toBe(1);

    const skipped = preview.rows.filter((r) => r.classification === "skip");
    expect(skipped).toHaveLength(1);
    expect(skipped[0].fields["product.description"]).toBe("H-150-09");
    expect(skipped[0].findings.map((f) => f.code)).toContain(
      IMPORT_FINDING_CODES.ROW_NOT_IDENTIFIABLE,
    );
    expect(preview.committable).toBe(true);
  });

  it("keys on the GTIN first and on brand plus part number when there is none", () => {
    const byGtin = preview.rows.filter((r) => r.match.kind === "gtin");
    const byBrandSku = preview.rows.filter((r) => r.match.kind === "brandSku");
    expect(byGtin).toHaveLength(390);
    expect(byBrandSku).toHaveLength(2);
    expect(byGtin[0].match.key).toHaveLength(14);
    expect(byBrandSku.map((r) => r.fields["product.partNumber"])).toEqual(["19-115", "12-808"]);
  });

  it("retains the whole source row for provenance", () => {
    const row = preview.rows.find((r) => r.fields["product.partNumber"] === "10-825");
    expect(row).toBeDefined();
    expect(Object.keys(row?.source.cells ?? {})).toHaveLength(41);
    expect(row?.source.cells["GTIN"]).toBe("00810797030001");
    // Columns with no dedicated field are still carried across.
    expect(row?.custom["Product Industry"]).toBe("General");
    expect(row?.source.rowNumber).toBeGreaterThan(1);
  });

  it("never rewrites a GTIN into its canonical form", () => {
    const row = preview.rows.find((r) => r.fields["product.partNumber"] === "10-825");
    const gtin14 = row?.identifiers.find((i) => i.kind === "gtin14");
    const gtin12 = row?.identifiers.find((i) => i.kind === "gtin12");
    expect(gtin14?.value).toBe("00810797030001");
    expect(gtin12?.value).toBe("810797030001");
    expect(gtin12?.canonical).toBe("00810797030001");
    expect(gtin14?.isPrimary).toBe(true);
    expect(gtin12?.isPrimary).toBe(false);
  });

  it("re-imports the same file as unchanged, and sees a real edit as an update", () => {
    const existing: ExistingProduct[] = preview.rows
      .filter((r) => r.classification === "create")
      .map((r, i) => ({
        id: `existing-${i}`,
        brandName: r.fields["brand.name"] ?? "",
        partNumber: r.fields["product.partNumber"] ?? "",
        gtins: r.identifiers.filter((id) => id.kind.startsWith("gtin")).map((id) => id.value),
        fields: { ...r.fields },
      }));

    const again = previewOf(parsed, "ExportAllProducts", existing).preview;
    expect(again.summary.create).toBe(0);
    expect(again.summary.update).toBe(0);
    expect(again.summary.unchanged).toBe(392);
    expect(again.summary.skip).toBe(1);

    const stale = existing.map((p, i) =>
      i === 0 ? { ...p, fields: { ...p.fields, "product.description": "OLD TEXT" } } : p,
    );
    const third = previewOf(parsed, "ExportAllProducts", stale).preview;
    expect(third.summary.update).toBe(1);
    expect(third.summary.unchanged).toBe(391);
    const updated = third.rows.find((r) => r.classification === "update");
    expect(updated?.changedFields).toEqual(["product.description"]);
  });

  it("plans one product operation per importable row, in dependency order", () => {
    const plan = planImport(preview, { importId: "imp1" });
    expect(plan.counts.upsertProduct).toBe(392);
    expect(plan.counts.create).toBe(392);
    expect(plan.counts.skipped).toBe(1);
    expect(plan.counts.upsertBom).toBe(0);
    expect(plan.blocked).toBe(false);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.brands).toEqual([
      "Axle Teknology",
      "Axle Tek",
      "Carry On Trailers",
      "TowPro",
      "ProAxle",
      "AxleTek",
    ]);

    const kinds = plan.operations.map((op) => op.op);
    const lastProduct = kinds.lastIndexOf("upsertProduct");
    const firstIdentifier = kinds.indexOf("upsertIdentifier");
    expect(lastProduct).toBeLessThan(firstIdentifier);

    const grouped = operationsByKind(plan);
    expect(grouped.upsertProduct).toHaveLength(392);
    // Every row with a GTIN contributes a gtin14 identifier.
    expect(grouped.upsertIdentifier.filter((op) => op.kind === "gtin14")).toHaveLength(390);
    expect(grouped.upsertIdentifier.filter((op) => op.kind === "sku")).toHaveLength(388);

    const first = grouped.upsertProduct[0];
    expect(first.mode).toBe("create");
    expect(first.existingId).toBeNull();
    expect(Object.keys(first.sourceRow)).toHaveLength(41);
    expect(first.values["product.partNumber"]).toBe("19-115");
    // Identifier fields belong to their own operations, not to the product row.
    expect(first.values["identifier.gtin14"]).toBeUndefined();
  });

  it("plans deterministically", () => {
    const a = planImport(preview, { importId: "imp1" });
    const b = planImport(preview, { importId: "imp1" });
    expect(b).toEqual(a);
  });
});

/* ==================================================================== */
/*  Synthetic fixtures                                                  */
/* ==================================================================== */

describe("duplicate and invalid identifiers", () => {
  let parsed: ParsedWorkbook;

  beforeAll(async () => {
    parsed = await parseWorkbook(
      await makeWorkbook([
        {
          name: "Items",
          rows: [
            ["Part Number", "Description", "UPC", "Brand"],
            ["11-500", "Bearing Kit", "810797030001", "AxleTek"],
            ["11-501", "Seal Kit", "810797030001", "AxleTek"],
            ["11-502", "Hub Kit", "810797030002", "AxleTek"],
            ["11-503", "Drum", "", "AxleTek"],
            ["11-500", "Bearing Kit", "036000291452", "TowPro"],
            ["11-500", "Bearing Kit Rev B", "12345670", "AxleTek"],
          ],
        },
      ]),
      { filename: "fixture.xlsx" },
    );
  });

  it("makes a repeated GTIN a blocking error on the later row", () => {
    const { preview } = previewOf(parsed, "Items");
    const dupe = preview.rows.find((r) => r.rowNumber === 3);
    expect(dupe?.classification).toBe("skip");
    const finding = dupe?.findings.find(
      (f) => f.code === IMPORT_FINDING_CODES.GTIN_DUPLICATE_IN_FILE,
    );
    expect(finding?.severity).toBe("error");
    expect(finding?.relatedRows).toEqual([2]);
    expect(preview.duplicateGtins).toEqual([
      { value: "00810797030001", rowNumbers: [2, 3] },
    ]);
    expect(preview.summary.duplicateGtinRows).toBe(1);
  });

  it("fails a bad check digit without correcting the value", () => {
    const { preview } = previewOf(parsed, "Items");
    const bad = preview.rows.find((r) => r.rowNumber === 4);
    const finding = bad?.findings.find(
      (f) => f.code === IMPORT_FINDING_CODES.GTIN_CHECK_DIGIT,
    );
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("should be 1");
    expect(bad?.classification).toBe("skip");
    // The value survives untouched, both on the identifier and in the source row.
    expect(bad?.identifiers.find((i) => i.kind === "gtin12")?.value).toBe("810797030002");
    expect(bad?.identifiers.find((i) => i.kind === "gtin12")?.valid).toBe(false);
    expect(bad?.source.cells["UPC"]).toBe("810797030002");
    expect(preview.summary.invalidGtins).toBe(1);
  });

  it("warns rather than fails when a row has no GTIN at all", () => {
    const { preview } = previewOf(parsed, "Items");
    const none = preview.rows.find((r) => r.rowNumber === 5);
    expect(none?.classification).toBe("create");
    expect(none?.match.kind).toBe("brandSku");
    const finding = none?.findings.find((f) => f.code === IMPORT_FINDING_CODES.GTIN_MISSING);
    expect(finding?.severity).toBe("warning");
  });

  it("separates a cross-brand part number from a repeat inside one brand", () => {
    const { preview } = previewOf(parsed, "Items");
    const crossBrand = preview.rows.find((r) => r.rowNumber === 6);
    const sameBrand = preview.rows.find((r) => r.rowNumber === 7);
    expect(crossBrand?.findings.map((f) => f.code)).toContain(
      IMPORT_FINDING_CODES.SKU_DUPLICATE_CROSS_BRAND,
    );
    expect(sameBrand?.findings.map((f) => f.code)).toContain(
      IMPORT_FINDING_CODES.SKU_DUPLICATE_IN_BRAND,
    );
    expect(preview.summary.duplicateSkuInBrandRows).toBe(1);
    expect(preview.summary.duplicateSkuRows).toBe(2);
    expect(preview.summary.duplicateSkuValues).toBe(1);
    // Neither is fatal: both rows are still imported.
    expect(crossBrand?.classification).toBe("create");
    expect(sameBrand?.classification).toBe("create");
  });

  it("leaves the blocked rows out of the plan and records why", () => {
    const { preview } = previewOf(parsed, "Items");
    const plan = planImport(preview, { importId: "imp-dupe" });
    expect(plan.counts.upsertProduct).toBe(4);
    expect(plan.skipped.map((s) => s.rowNumber)).toEqual([3, 4]);
    expect(plan.skipped[0].reason).toContain("GTIN");
  });
});

describe("awkward sheets", () => {
  it("reads a header row below a merged banner and names blank header cells", async () => {
    const parsed = await parseWorkbook(
      await makeWorkbook([
        {
          name: "Master Data",
          rows: [
            ["Identity", null, "Numbers", null],
            ["Part Number", "Description", "UPC", null],
            ["11-500", "Bearing Kit", "810797030001", "note"],
            ["11-501", "Seal Kit", "036000291452", ""],
          ],
          merges: ["A1:B1", "C1:D1"],
        },
      ]),
    );

    const sheet = inspectParsedWorkbook(parsed).sheets[0];
    expect(sheet.headerRowNumber).toBe(2);
    expect(sheet.headerConfidence).toBe("high");
    expect(sheet.headers).toEqual(["Part Number", "Description", "UPC", "Column D"]);
    expect(sheet.columns[3].headerWasBlank).toBe(true);
    expect(sheet.columns[3].rawHeader).toBe("");
    expect(sheet.dataRowCount).toBe(2);
    expect(sheet.notes.map((n) => n.code)).toContain(SHEET_NOTE_CODES.BANNER_ROWS_ABOVE_HEADER);
    expect(sheet.notes.map((n) => n.code)).toContain(SHEET_NOTE_CODES.HEADER_CELL_BLANK);

    const read = readParsedSheetRows(parsed, { sheetName: "Master Data" });
    expect(read.rows).toHaveLength(2);
    expect(read.rows[0].cells["Column D"]).toBe("note");
    expect(read.rows[0].rowNumber).toBe(3);
  });

  it("keeps duplicated header names distinguishable", async () => {
    const parsed = await parseWorkbook(
      await makeWorkbook([
        {
          name: "Dupes",
          rows: [
            ["Part Number", "Description", "Description"],
            ["11-500", "Bearing Kit", "Second copy"],
          ],
        },
      ]),
    );
    const sheet = inspectParsedWorkbook(parsed).sheets[0];
    expect(sheet.headers).toEqual(["Part Number", "Description", "Description (2)"]);
    expect(sheet.notes.map((n) => n.code)).toContain(SHEET_NOTE_CODES.HEADER_DUPLICATED);
  });

  it("reports an empty sheet without inventing a header row", async () => {
    const parsed = await parseWorkbook(
      await makeWorkbook([
        { name: "Blank", rows: [] },
        {
          name: "Items",
          rows: [
            ["Part Number", "UPC"],
            ["11-500", "810797030001"],
          ],
        },
      ]),
    );

    const inspection = inspectParsedWorkbook(parsed);
    const blank = inspection.sheets.find((s) => s.name === "Blank");
    expect(blank?.kind).toBe("empty");
    expect(blank?.headerRowNumber).toBe(0);
    expect(blank?.headerConfidence).toBe("none");
    expect(blank?.headers).toEqual([]);
    expect(blank?.dataRowCount).toBe(0);
    expect(blank?.notes.map((n) => n.code)).toContain(SHEET_NOTE_CODES.EMPTY_SHEET);
    // The empty sheet is never the one offered to the user.
    expect(inspection.primarySheetName).toBe("Items");

    const read = readParsedSheetRows(parsed, { sheetName: "Blank" });
    expect(read.rows).toEqual([]);

    const mapping = suggestMapping(read.headers, { sheetName: "Blank" });
    const preview = buildPreview({ orgId: "org1", sheetName: "Blank", mapping, rows: read.rows });
    expect(preview.summary.totalRows).toBe(0);
    expect(preview.committable).toBe(false);
  });

  it("refuses to commit a sheet with no identifier column", async () => {
    const parsed = await parseWorkbook(
      await makeWorkbook([
        {
          name: "Notes",
          rows: [
            ["Colour", "Notes", "Comment"],
            ["Red", "n/a", "hello"],
          ],
        },
      ]),
    );
    const { preview, mapping } = previewOf(parsed, "Notes");
    expect(mapping.missingRequired).toHaveLength(1);
    expect(preview.committable).toBe(false);
    expect(findingCodes(preview)).toContain(
      IMPORT_FINDING_CODES.MAPPING_REQUIRED_FIELD_MISSING,
    );
    expect(preview.rows.every((r) => r.classification === "skip")).toBe(true);

    const plan = planImport(preview, { importId: "imp-notes" });
    expect(plan.blocked).toBe(true);
    expect(plan.operations).toEqual([]);
  });

  it("keeps a long numeric identifier out of exponent notation", async () => {
    const parsed = await parseWorkbook(
      await makeWorkbook([
        {
          name: "Numeric",
          rows: [
            ["Part Number", "UPC"],
            ["11-500", 810797030001],
          ],
        },
      ]),
    );
    const read = readParsedSheetRows(parsed, { sheetName: "Numeric" });
    expect(read.rows[0].cells["UPC"]).toBe("810797030001");
  });
});

describe("BOM sheets", () => {
  let parsed: ParsedWorkbook;
  const existing: ExistingProduct[] = [
    { id: "kit-1", brandName: "AxleTek", partNumber: "11-500", gtins: [], fields: {} },
  ];

  beforeAll(async () => {
    parsed = await parseWorkbook(
      await makeWorkbook([
        {
          name: "AxleTek BOM",
          rows: [
            ["Parent Part Number", "Component Part Number", "Component Name", "Qty", "UOM"],
            ["11-500", "L44643", "Inner Bearing", "2", "EA"],
            ["11-500", "L44610", "Inner Race", "2", "EA"],
            ["11-500", "10-36", "Seal", "1", "EA"],
            ["99-999", "X-1", "Widget", "abc", "EA"],
          ],
        },
      ]),
    );
  });

  it("recognises the sheet as a BOM and links lines to their parent", () => {
    const sheet = inspectParsedWorkbook(parsed).sheets[0];
    expect(sheet.kind).toBe("bom");

    const read = readParsedSheetRows(parsed, { sheetName: "AxleTek BOM" });
    const mapping = suggestMapping(read.headers, { sheetName: "AxleTek BOM" });
    const preview = buildPreview({
      orgId: "org1",
      sheetName: "AxleTek BOM",
      mapping,
      rows: read.rows,
      existing,
    });

    expect(preview.summary.bomLineRows).toBe(4);
    expect(preview.rows.every((r) => r.recordType === "bom_line")).toBe(true);
    expect(preview.bomParents).toEqual([
      { partNumber: "11-500", itemCount: 3, rowNumbers: [2, 3, 4], resolved: true },
      { partNumber: "99-999", itemCount: 1, rowNumbers: [5], resolved: false },
    ]);
    expect(preview.rows.map((r) => r.bom?.position)).toEqual([1, 2, 3, 1]);

    const orphan = preview.rows[3];
    expect(orphan.findings.map((f) => f.code)).toContain(
      IMPORT_FINDING_CODES.BOM_PARENT_MISSING,
    );
    expect(orphan.findings.map((f) => f.code)).toContain(
      IMPORT_FINDING_CODES.BOM_QUANTITY_INVALID,
    );
    // A quantity that is not a number is still carried through, unaltered.
    expect(orphan.bom?.quantity).toBe("abc");
  });

  it("plans one BOM per parent with its items after it", () => {
    const read = readParsedSheetRows(parsed, { sheetName: "AxleTek BOM" });
    const mapping = suggestMapping(read.headers, { sheetName: "AxleTek BOM" });
    const preview = buildPreview({
      orgId: "org1",
      sheetName: "AxleTek BOM",
      mapping,
      rows: read.rows,
      existing,
    });
    const plan = planImport(preview, { importId: "imp-bom" });
    const grouped = operationsByKind(plan);

    expect(grouped.upsertProduct).toEqual([]);
    expect(grouped.upsertBom).toHaveLength(2);
    expect(grouped.upsertBomItem).toHaveLength(4);
    expect(grouped.upsertBom[0].parentPartNumber).toBe("11-500");
    expect(grouped.upsertBom[0].rowNumbers).toEqual([2, 3, 4]);
    expect(grouped.upsertBom[0].ref).toBeNull();

    const kinds = plan.operations.map((op) => op.op);
    expect(kinds.lastIndexOf("upsertBom")).toBeLessThan(kinds.indexOf("upsertBomItem"));
    expect(grouped.upsertBomItem[0].bomRef).toBe(grouped.upsertBom[0].bomRef);
    expect(grouped.upsertBomItem[3].bomRef).toBe(grouped.upsertBom[1].bomRef);
  });
});

describe("alternates and defaults", () => {
  it("splits an alternate-part-number cell and applies a mapping default brand", async () => {
    const parsed = await parseWorkbook(
      await makeWorkbook([
        {
          name: "Private Label",
          rows: [
            ["Part Number", "Description", "UPC", "Cross Reference"],
            ["11-500", "Bearing Kit", "810797030001", "L44610, L44649; 25580"],
          ],
        },
      ]),
    );
    const read = readParsedSheetRows(parsed, { sheetName: "Private Label" });
    const mapping = suggestMapping(read.headers, {
      sheetName: "Private Label",
      defaults: { "brand.name": "TowPro" },
    });
    const preview = buildPreview({
      orgId: "org1",
      sheetName: "Private Label",
      mapping,
      rows: read.rows,
    });

    const row = preview.rows[0];
    expect(row.fields["brand.name"]).toBe("TowPro");
    expect(row.alternates).toEqual(["L44610", "L44649", "25580"]);
    expect(row.findings.some((f) => f.code === IMPORT_FINDING_CODES.BRAND_MISSING)).toBe(false);

    const plan = planImport(preview, { importId: "imp-alt" });
    const grouped = operationsByKind(plan);
    expect(grouped.upsertAlternate.map((op) => op.value)).toEqual([
      "L44610",
      "L44649",
      "25580",
    ]);
    expect(grouped.upsertAlternate.map((op) => op.position)).toEqual([0, 1, 2]);
    expect(grouped.upsertAlternate.every((op) => op.ref === grouped.upsertProduct[0].ref)).toBe(
      true,
    );
    expect(plan.brands).toEqual(["TowPro"]);
  });
});
