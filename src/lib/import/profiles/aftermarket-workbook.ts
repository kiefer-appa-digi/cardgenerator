import ExcelJS from "exceljs";
import {
  AFTERMARKET_SHEETS,
  mergeAftermarketReads,
  readAftermarketBom,
  readClamshellSheet,
  readGs1Sheet,
  type Cell,
  type ClamshellReference,
  type MergedRead,
} from "./aftermarket";

/**
 * The I/O half of the Aftermarket adapter: turn .xlsx bytes into the grids the
 * pure reader consumes, and nothing else. Keeping the parsing pure means the
 * block logic is testable without a file, and keeping the file handling here
 * means the reader never has to know about exceljs.
 */

function toCell(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    const o = value as unknown as Record<string, unknown>;
    // A formula cell carries its cached result; the formula itself is not data.
    if ("result" in o) return toCell(o.result as ExcelJS.CellValue);
    if (typeof o.text === "string") return o.text;
    if (typeof o.hyperlink === "string") return o.hyperlink;
    if (Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("");
    }
    return null;
  }
  return value as Cell;
}

export function worksheetGrid(ws: ExcelJS.Worksheet): Cell[][] {
  const grid: Cell[][] = [];
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells: Cell[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = toCell(cell.value);
    });
    grid[rowNumber - 1] = cells;
  });
  // eachRow skips trailing gaps; fill them so row indexes stay 1:1 with Excel.
  for (let i = 0; i < grid.length; i++) grid[i] ??= [];
  return grid;
}

export type AftermarketWorkbook = {
  sheetNames: string[];
  bom: MergedRead;
  clamshells: ClamshellReference[];
  gs1: Array<{ partNumber: string; description: string; upc: string }>;
  /** Sheets the adapter recognised but does not read, and why. */
  unread: Array<{ sheet: string; reason: string }>;
};

const UNREAD_REASONS: Record<string, string> = {
  [AFTERMARKET_SHEETS.masterData]:
    "Vendor, category and weight data. Useful for a catalogue, but nothing on it prints on a card.",
  [AFTERMARKET_SHEETS.inventory]:
    "Stock on hand and purchase orders. Not packaging data.",
  [AFTERMARKET_SHEETS.items]:
    "A short working list of part numbers with an OH/Cards tally; superseded by the BOM sheets.",
  [AFTERMARKET_SHEETS.packagingAxleTek]:
    "Carton and pallet quantities. Read by the catalogue importer, not by the pack-contents adapter.",
  [AFTERMARKET_SHEETS.packagingTowPro]: "As above, for TowPro.",
  [AFTERMARKET_SHEETS.privateLabelTowPro]: "As above, for TowPro private label.",
  Sheet1: "An unnamed scratch sheet of part-number fragments with no header row.",
  "QB Inv Curr": "A QuickBooks inventory export. Accounting data, not packaging data.",
};

export async function readAftermarketWorkbook(
  data: Buffer | ArrayBuffer,
): Promise<AftermarketWorkbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as ArrayBuffer);

  const sheetNames = wb.worksheets.map((w) => w.name);
  const grid = (name: string) => {
    const ws = wb.getWorksheet(name);
    return ws ? worksheetGrid(ws) : null;
  };

  const primaryGrid = grid(AFTERMARKET_SHEETS.bomPrimary);
  const fallbackGrid = grid(AFTERMARKET_SHEETS.bomFallback);
  if (!primaryGrid && !fallbackGrid) {
    throw new Error(
      `This workbook has no ${AFTERMARKET_SHEETS.bomPrimary} or ${AFTERMARKET_SHEETS.bomFallback} sheet, so it is not an Aftermarket workbook.`,
    );
  }

  const primary = primaryGrid
    ? readAftermarketBom(primaryGrid, AFTERMARKET_SHEETS.bomPrimary)
    : readAftermarketBom(fallbackGrid!, AFTERMARKET_SHEETS.bomFallback);
  const fallback =
    primaryGrid && fallbackGrid
      ? readAftermarketBom(fallbackGrid, AFTERMARKET_SHEETS.bomFallback)
      : null;

  const clamGrid = grid(AFTERMARKET_SHEETS.clamShells);
  const gs1Grid = grid(AFTERMARKET_SHEETS.gs1);

  return {
    sheetNames,
    bom: mergeAftermarketReads(primary, fallback),
    clamshells: clamGrid ? readClamshellSheet(clamGrid) : [],
    gs1: gs1Grid ? readGs1Sheet(gs1Grid) : [],
    unread: sheetNames
      .filter((n) => UNREAD_REASONS[n])
      .map((n) => ({ sheet: n, reason: UNREAD_REASONS[n] })),
  };
}

/** Does this workbook look like an Aftermarket workbook at all? */
export function looksLikeAftermarket(sheetNames: readonly string[]): boolean {
  return sheetNames.some(
    (n) => n === AFTERMARKET_SHEETS.bomPrimary || n === AFTERMARKET_SHEETS.bomFallback,
  );
}
