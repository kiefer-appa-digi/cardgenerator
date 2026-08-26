import ExcelJS from "exceljs";

import { detectProfile, suggestMapping } from "./mapping";
import {
  SHEET_NOTE_CODES,
  type ColumnSample,
  type ColumnValueType,
  type HeaderConfidence,
  type SheetInspection,
  type SheetKind,
  type SheetNote,
  type SourceRow,
  type WorkbookInspection,
} from "./types";

/**
 * WORKBOOK INSPECTION — spec §5.2.
 *
 * Reads an .xlsx into a plain grid of strings, works out where the header row
 * actually is, and reports what each sheet looks like so the mapping UI has
 * something to show before anything is imported.
 *
 * The header row is not assumed to be row 1. Real supplier sheets put a title
 * banner, a merged group row, or a blank spacer above it, so a small rule set
 * picks the first row that behaves like a header: mostly label-shaped text, no
 * repeats, and reasonably full compared with the rest of the sheet.
 *
 * Nothing here repairs data. A blank header cell gets a placeholder name and a
 * note; the cell itself is still reported verbatim as `rawHeader`.
 */

export type WorkbookData = ArrayBuffer | Uint8Array;

export type ParsedCellType = "empty" | "text" | "number" | "date" | "boolean" | "error";

export type ParsedCell = {
  /** Cell contents as text. Formatting is not applied; the raw value is. */
  text: string;
  type: ParsedCellType;
  /** True when the cell is part of a merged range (its value comes from the master). */
  merged: boolean;
};

export type ParsedSheet = {
  name: string;
  /** 0-based worksheet order. */
  index: number;
  /** Last row number the workbook reports a value on. */
  rowCount: number;
  columnCount: number;
  /** Dense grid. `grid[0]` is worksheet row 1; blank rows are empty arrays. */
  grid: ParsedCell[][];
  /** True when reading stopped at `maxRows`. */
  truncated: boolean;
};

export type ParsedWorkbook = {
  filename: string;
  sheets: ParsedSheet[];
};

export type ParseOptions = {
  filename?: string;
  /** Hard ceiling on rows read per sheet. Default 50000. */
  maxRows?: number;
  /** Hard ceiling on columns read per sheet. Default 512. */
  maxColumns?: number;
};

export type SheetRead = {
  sheetName: string;
  headerRowNumber: number;
  headers: string[];
  /** Non-blank rows below the header, each keyed by resolved header name. */
  rows: SourceRow[];
};

const DEFAULT_MAX_ROWS = 50_000;
const DEFAULT_MAX_COLUMNS = 512;
/** Rows scanned when looking for the header row. */
const HEADER_SCAN_ROWS = 50;
/**
 * Rows sampled to learn how wide a full row of this sheet is. It has to reach
 * past the header scan window: a sheet whose first rows are all one-cell notice
 * lines would otherwise make a one-cell row look like a complete header.
 */
const HEADER_WIDTH_SAMPLE_ROWS = 200;
const SAMPLES_PER_COLUMN = 5;

/** A ceiling supplied by a caller is only honoured when it is a usable count. */
function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/* ----------------------------------------------------------------- values */

const EMPTY_CELL: ParsedCell = { text: "", type: "empty", merged: false };

function isRichText(v: object): v is ExcelJS.CellRichTextValue {
  return "richText" in v;
}
function isHyperlink(v: object): v is ExcelJS.CellHyperlinkValue {
  return "hyperlink" in v && "text" in v;
}
function isFormula(v: object): v is ExcelJS.CellFormulaValue | ExcelJS.CellSharedFormulaValue {
  return "formula" in v || "sharedFormula" in v;
}
function isError(v: object): v is ExcelJS.CellErrorValue {
  return "error" in v;
}

/** Dates land as an ISO date when they carry no time, so they compare as text. */
function dateToText(d: Date): string {
  if (Number.isNaN(d.getTime())) return "";
  const iso = d.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

/**
 * Numbers are written out in full. `toFixed(0)` rather than `String()` keeps a
 * long numeric U.P.C. out of exponent notation, which would silently corrupt it.
 */
function numberToText(n: number): string {
  if (!Number.isFinite(n)) return "";
  return Number.isInteger(n) && Math.abs(n) < 1e21 ? n.toFixed(0) : String(n);
}

export function cellToParsed(value: ExcelJS.CellValue, merged: boolean): ParsedCell {
  if (value === null || value === undefined) return merged ? { ...EMPTY_CELL, merged } : EMPTY_CELL;

  if (typeof value === "string") {
    const text = value.trim();
    return { text, type: text.length === 0 ? "empty" : "text", merged };
  }
  if (typeof value === "number") return { text: numberToText(value), type: "number", merged };
  if (typeof value === "boolean") return { text: value ? "TRUE" : "FALSE", type: "boolean", merged };
  if (value instanceof Date) return { text: dateToText(value), type: "date", merged };

  if (typeof value === "object") {
    if (isError(value)) return { text: value.error, type: "error", merged };
    if (isRichText(value)) {
      const text = value.richText.map((r) => r.text).join("").trim();
      return { text, type: text.length === 0 ? "empty" : "text", merged };
    }
    if (isHyperlink(value)) {
      const text = (value.text ?? "").trim();
      return { text, type: text.length === 0 ? "empty" : "text", merged };
    }
    if (isFormula(value)) {
      const result = value.result;
      if (result === undefined || result === null) return { ...EMPTY_CELL, merged };
      if (typeof result === "object" && isError(result)) {
        return { text: result.error, type: "error", merged };
      }
      return cellToParsed(result, merged);
    }
  }
  return { ...EMPTY_CELL, merged };
}

/** 0-based column index to spreadsheet letter. 0 -> A, 26 -> AA. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/* ------------------------------------------------------------------ parse */

/**
 * exceljs types its reader argument as an ArrayBuffer. A Node Buffer is usually a
 * view over a pooled ArrayBuffer, so its `.buffer` holds unrelated bytes either
 * side of the file; copying into an exactly sized ArrayBuffer avoids that trap.
 */
function toArrayBuffer(data: WorkbookData): ArrayBuffer {
  // Buffer subclasses Uint8Array, so the first branch also covers a Buffer input.
  if (data instanceof Uint8Array) {
    const out = new ArrayBuffer(data.byteLength);
    new Uint8Array(out).set(data);
    return out;
  }
  return data;
}

export async function parseWorkbook(
  data: WorkbookData,
  options: ParseOptions = {},
): Promise<ParsedWorkbook> {
  const maxRows = positiveLimit(options.maxRows, DEFAULT_MAX_ROWS);
  const maxColumns = positiveLimit(options.maxColumns, DEFAULT_MAX_COLUMNS);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(toArrayBuffer(data));

  const sheets: ParsedSheet[] = workbook.worksheets.map((ws, index) => {
    const rowCount = ws.rowCount;
    const columnCount = Math.min(ws.columnCount, maxColumns);
    const readRows = Math.min(rowCount, maxRows);

    const grid: ParsedCell[][] = [];
    for (let r = 1; r <= readRows; r += 1) {
      const cells: ParsedCell[] = [];
      let lastFilled = -1;
      for (let c = 1; c <= columnCount; c += 1) {
        const cell = ws.getCell(r, c);
        const parsed = cellToParsed(cell.value, cell.isMerged);
        cells.push(parsed);
        if (parsed.text.length > 0) lastFilled = c - 1;
      }
      // Trailing empties carry no information; drop them to keep the grid small.
      grid.push(lastFilled < 0 ? [] : cells.slice(0, lastFilled + 1));
    }

    return {
      name: ws.name,
      index,
      rowCount,
      columnCount,
      grid,
      truncated: readRows < rowCount,
    };
  });

  return { filename: options.filename ?? "", sheets };
}

/* ---------------------------------------------------- header row detection */

type RowStats = {
  rowNumber: number;
  filled: number;
  distinct: number;
  labelLike: number;
  typedNonText: number;
  merged: number;
};

const DIGIT = /[0-9]/g;
const LETTER = /[A-Za-z]/;

/** A header cell reads like a label: has letters, is short, is not mostly digits. */
function looksLikeLabel(cell: ParsedCell): boolean {
  if (cell.type !== "text" || cell.text.length === 0 || cell.text.length > 80) return false;
  if (!LETTER.test(cell.text)) return false;
  const digits = cell.text.match(DIGIT)?.length ?? 0;
  return digits / cell.text.length <= 0.5;
}

function rowStats(row: ParsedCell[], rowNumber: number): RowStats {
  const seen = new Set<string>();
  let filled = 0;
  let labelLike = 0;
  let typedNonText = 0;
  let merged = 0;
  for (const cell of row) {
    if (cell.text.length === 0) continue;
    filled += 1;
    seen.add(cell.text);
    if (looksLikeLabel(cell)) labelLike += 1;
    if (cell.merged) merged += 1;
    if (cell.type === "number" || cell.type === "date" || cell.type === "boolean") {
      typedNonText += 1;
    }
  }
  return { rowNumber, filled, distinct: seen.size, labelLike, typedNonText, merged };
}

function rowIsBlank(row: ParsedCell[] | undefined): boolean {
  if (row === undefined) return true;
  return row.every((c) => c.text.length === 0);
}

type HeaderChoice = { rowNumber: number; confidence: HeaderConfidence; rejected: RowStats[] };

function findHeaderRow(grid: ParsedCell[][]): HeaderChoice {
  let firstNonBlank = -1;
  for (let i = 0; i < grid.length; i += 1) {
    if (!rowIsBlank(grid[i])) {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank < 0) return { rowNumber: 0, confidence: "none", rejected: [] };

  const window: RowStats[] = [];
  const end = Math.min(grid.length, firstNonBlank + HEADER_SCAN_ROWS);
  for (let i = firstNonBlank; i < end; i += 1) {
    if (rowIsBlank(grid[i])) continue;
    window.push(rowStats(grid[i], i + 1));
  }

  /**
   * How wide a complete row of this sheet is. Sampled well past the header scan
   * window on purpose: measuring it only over the candidates would let a run of
   * narrow banner lines set the bar to their own width, and a one-cell notice
   * line would then pass as a full header row.
   */
  let maxFilled = 0;
  let sampled = 0;
  for (let i = firstNonBlank; i < grid.length && sampled < HEADER_WIDTH_SAMPLE_ROWS; i += 1) {
    const row = grid[i];
    if (rowIsBlank(row)) continue;
    sampled += 1;
    let filled = 0;
    for (const cell of row) if (cell.text.length > 0) filled += 1;
    if (filled > maxFilled) maxFilled = filled;
  }
  if (maxFilled === 0) maxFilled = 1;

  const hasDataBelow = (rowNumber: number): boolean => {
    for (let i = rowNumber; i < grid.length; i += 1) {
      if (!rowIsBlank(grid[i])) return true;
    }
    return false;
  };

  /**
   * A merged group row ("Identity" spanning two columns) repeats its value across
   * the span, so a high merged ratio is what separates a banner from a header row
   * that legitimately carries the same label twice.
   */
  const qualifies = (s: RowStats): boolean =>
    s.filled >= 1 &&
    s.filled / maxFilled >= 0.5 &&
    s.merged / s.filled <= 0.3 &&
    s.distinct / s.filled >= 0.6 &&
    s.labelLike / s.filled >= 0.6 &&
    s.typedNonText / s.filled <= 0.3;

  for (const s of window) {
    if (qualifies(s) && hasDataBelow(s.rowNumber)) {
      return { rowNumber: s.rowNumber, confidence: "high", rejected: window };
    }
  }
  // A header-only sheet still has a usable header row; it just has no data.
  for (const s of window) {
    if (qualifies(s)) return { rowNumber: s.rowNumber, confidence: "low", rejected: window };
  }
  return { rowNumber: firstNonBlank + 1, confidence: "low", rejected: window };
}

/* -------------------------------------------------------------- inspection */

type ResolvedHeaders = { headers: string[]; raw: string[]; blank: boolean[]; merged: boolean[] };

function resolveHeaders(row: ParsedCell[], columnCount: number): ResolvedHeaders {
  const headers: string[] = [];
  const raw: string[] = [];
  const blank: boolean[] = [];
  const merged: boolean[] = [];
  const used = new Map<string, number>();

  for (let c = 0; c < columnCount; c += 1) {
    const cell = row[c] ?? EMPTY_CELL;
    raw.push(cell.text);
    blank.push(cell.text.length === 0);
    merged.push(cell.merged);

    const base = cell.text.length === 0 ? `Column ${columnLetter(c)}` : cell.text;
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    headers.push(seen === 0 ? base : `${base} (${seen + 1})`);
  }
  return { headers, raw, blank, merged };
}

function aggregateType(types: Set<ParsedCellType>): ColumnValueType {
  types.delete("empty");
  if (types.size === 0) return "empty";
  if (types.size > 1) return "mixed";
  const only = [...types][0];
  if (only === "error") return "mixed";
  return only;
}

function buildColumns(
  grid: ParsedCell[][],
  headerRowNumber: number,
  resolved: ResolvedHeaders,
): ColumnSample[] {
  const columnCount = resolved.headers.length;
  const nonEmpty = new Array<number>(columnCount).fill(0);
  const maxLength = new Array<number>(columnCount).fill(0);
  const distinct: Set<string>[] = Array.from({ length: columnCount }, () => new Set<string>());
  const types: Set<ParsedCellType>[] = Array.from(
    { length: columnCount },
    () => new Set<ParsedCellType>(),
  );

  for (let i = headerRowNumber; i < grid.length; i += 1) {
    const row = grid[i];
    if (rowIsBlank(row)) continue;
    for (let c = 0; c < columnCount; c += 1) {
      const cell = row[c] ?? EMPTY_CELL;
      if (cell.text.length === 0) continue;
      nonEmpty[c] += 1;
      if (cell.text.length > maxLength[c]) maxLength[c] = cell.text.length;
      if (distinct[c].size < 10_000) distinct[c].add(cell.text);
      types[c].add(cell.type);
    }
  }

  return resolved.headers.map((header, c) => ({
    index: c,
    letter: columnLetter(c),
    header,
    rawHeader: resolved.raw[c],
    headerWasBlank: resolved.blank[c],
    headerWasMerged: resolved.merged[c],
    nonEmptyCount: nonEmpty[c],
    distinctCount: distinct[c].size,
    valueType: aggregateType(types[c]),
    maxLength: maxLength[c],
    samples: [...distinct[c]].slice(0, SAMPLES_PER_COLUMN),
  }));
}

/** Trailing columns with no header and no data are workbook padding, not columns. */
function usedColumnCount(grid: ParsedCell[][], headerRowNumber: number, declared: number): number {
  let last = -1;
  for (let i = Math.max(0, headerRowNumber - 1); i < grid.length; i += 1) {
    const row = grid[i];
    for (let c = row.length - 1; c >= 0; c -= 1) {
      if (row[c].text.length > 0) {
        if (c > last) last = c;
        break;
      }
    }
  }
  return Math.min(declared, last + 1);
}

const BOM_FIELDS = new Set(["bom.parentPartNumber", "bomItem.partNumber", "bomItem.quantity"]);
const PRODUCT_FIELDS = new Set([
  "product.partNumber",
  "identifier.gtin14",
  "identifier.gtin12",
  "identifier.gtin13",
  "identifier.gtin8",
]);
const DESCRIPTIVE_FIELDS = new Set([
  "product.description",
  "product.productName",
  "product.descriptionShort",
  "product.labelDescription",
]);

function guessKind(
  sheetName: string,
  mappedFields: readonly string[],
  dataRowCount: number,
  profileScore: number,
): { kind: SheetKind; confidence: number } {
  if (dataRowCount === 0) return { kind: "empty", confidence: 100 };

  const mapped = new Set(mappedFields);
  const bomHits = [...BOM_FIELDS].filter((f) => mapped.has(f)).length;
  const productHits = [...PRODUCT_FIELDS].filter((f) => mapped.has(f)).length;
  const descriptiveHits = [...DESCRIPTIVE_FIELDS].filter((f) => mapped.has(f)).length;

  if (bomHits >= 2) return { kind: "bom", confidence: 60 + 10 * bomHits };
  if (productHits >= 1 && descriptiveHits >= 1) {
    return { kind: "products", confidence: Math.max(60, profileScore) };
  }
  if (productHits >= 1) return { kind: "identifiers", confidence: 60 };

  const name = sheetName.toLowerCase();
  if (name.includes("inventory") || name.includes("stock")) {
    return { kind: "inventory", confidence: 40 };
  }
  if (name.includes("clam") || name.includes("packag") || name.includes("card")) {
    return { kind: "packaging", confidence: 40 };
  }
  return { kind: "unknown", confidence: 20 };
}

export function inspectParsedSheet(sheet: ParsedSheet): SheetInspection {
  const notes: SheetNote[] = [];
  const { grid } = sheet;

  const header = findHeaderRow(grid);
  if (header.rowNumber === 0) {
    notes.push({ code: SHEET_NOTE_CODES.EMPTY_SHEET, message: "The sheet has no rows." });
    return {
      name: sheet.name,
      index: sheet.index,
      rowCount: sheet.rowCount,
      headerRowNumber: 0,
      headerConfidence: "none",
      firstDataRowNumber: 0,
      dataRowCount: 0,
      columnCount: 0,
      headers: [],
      columns: [],
      kind: "empty",
      kindConfidence: 100,
      profileMatches: [],
      notes,
    };
  }

  const columnCount = usedColumnCount(grid, header.rowNumber, sheet.columnCount);
  const headerRow = grid[header.rowNumber - 1] ?? [];
  const resolved = resolveHeaders(headerRow, columnCount);

  if (header.confidence !== "high") {
    notes.push({
      code: SHEET_NOTE_CODES.HEADER_ROW_UNCERTAIN,
      message:
        "No row read cleanly as a header row; the first non-blank row was used. Confirm the header row before mapping.",
      rowNumber: header.rowNumber,
    });
  }
  for (let i = 0; i < grid.length && i < header.rowNumber - 1; i += 1) {
    if (!rowIsBlank(grid[i])) {
      notes.push({
        code: SHEET_NOTE_CODES.BANNER_ROWS_ABOVE_HEADER,
        message: `Row ${i + 1} sits above the header row and was not treated as data.`,
        rowNumber: i + 1,
      });
    }
  }
  resolved.blank.forEach((isBlank, c) => {
    if (isBlank) {
      notes.push({
        code: SHEET_NOTE_CODES.HEADER_CELL_BLANK,
        message: `Column ${columnLetter(c)} has no header; it is shown as "${resolved.headers[c]}".`,
        columnIndex: c,
      });
    }
  });
  resolved.merged.forEach((isMerged, c) => {
    if (isMerged) {
      notes.push({
        code: SHEET_NOTE_CODES.HEADER_CELL_MERGED,
        message: `Column ${columnLetter(c)} takes its header from a merged cell.`,
        columnIndex: c,
      });
    }
  });
  resolved.headers.forEach((h, c) => {
    if (h !== resolved.raw[c] && !resolved.blank[c]) {
      notes.push({
        code: SHEET_NOTE_CODES.HEADER_DUPLICATED,
        message: `Header "${resolved.raw[c]}" appears more than once; column ${columnLetter(c)} is shown as "${h}".`,
        columnIndex: c,
      });
    }
  });

  let dataRowCount = 0;
  let firstDataRowNumber = 0;
  for (let i = header.rowNumber; i < grid.length; i += 1) {
    if (rowIsBlank(grid[i])) continue;
    dataRowCount += 1;
    if (firstDataRowNumber === 0) firstDataRowNumber = i + 1;
  }
  if (dataRowCount === 0) {
    notes.push({
      code: SHEET_NOTE_CODES.NO_DATA_ROWS,
      message: "The sheet has a header row but no data rows below it.",
    });
  }

  const columns = buildColumns(grid, header.rowNumber, resolved);
  for (const col of columns) {
    if (col.nonEmptyCount === 0) {
      notes.push({
        code: SHEET_NOTE_CODES.COLUMN_ENTIRELY_EMPTY,
        message: `Column ${col.letter} ("${col.header}") is empty in every data row.`,
        columnIndex: col.index,
      });
    }
  }

  const mapping = suggestMapping(resolved.headers, { sheetName: sheet.name });
  const kind = guessKind(sheet.name, mapping.mappedFields, dataRowCount, mapping.profileScore);

  return {
    name: sheet.name,
    index: sheet.index,
    rowCount: sheet.rowCount,
    headerRowNumber: header.rowNumber,
    headerConfidence: header.confidence,
    firstDataRowNumber,
    dataRowCount,
    columnCount,
    headers: resolved.headers,
    columns,
    kind: kind.kind,
    kindConfidence: kind.confidence,
    profileMatches: [],
    notes,
  };
}

/** "The sheet the user probably means": most data rows among product-ish sheets. */
function pickPrimarySheet<T extends { kind: SheetKind; dataRowCount: number }>(
  sheets: readonly T[],
): T | undefined {
  return [...sheets]
    .filter((s) => s.dataRowCount > 0)
    .sort((a, b) => {
      const rank = (k: SheetKind): number => (k === "products" ? 2 : k === "bom" ? 1 : 0);
      return rank(b.kind) - rank(a.kind) || b.dataRowCount - a.dataRowCount;
    })[0];
}

export function inspectParsedWorkbook(workbook: ParsedWorkbook): WorkbookInspection {
  const sheets = workbook.sheets.map((s) => {
    const inspection = inspectParsedSheet(s);
    // Profile ranking needs the resolved headers, so it happens after inspection.
    const mapping = suggestMapping(inspection.headers, { sheetName: s.name });
    const profileMatches = detectProfile(inspection.headers, { sheetName: s.name }).map((m) =>
      m.profileId === mapping.profileId ? { ...m, missingRequired: mapping.missingRequired } : m,
    );
    return { ...inspection, profileMatches };
  });

  const primary = pickPrimarySheet(sheets);

  return {
    filename: workbook.filename,
    sheetCount: sheets.length,
    sheets,
    primarySheetName: primary?.name ?? null,
    primaryProfileId: primary?.profileMatches[0]?.profileId ?? null,
  };
}

export async function inspectWorkbook(
  data: WorkbookData,
  options: ParseOptions = {},
): Promise<WorkbookInspection> {
  return inspectParsedWorkbook(await parseWorkbook(data, options));
}

/* ------------------------------------------------------------------ reads */

export type ReadSheetOptions = {
  /** Defaults to the workbook's primary sheet. */
  sheetName?: string;
  /** Override the detected header row (1-based). */
  headerRowNumber?: number;
};

export function readParsedSheetRows(
  workbook: ParsedWorkbook,
  options: ReadSheetOptions = {},
): SheetRead {
  // With no sheet named, read the sheet the inspection would offer the user —
  // not sheets[0], which on a workbook with a cover or notes tab is a sheet with
  // no data at all, and would have returned zero rows without saying why.
  const named =
    options.sheetName === undefined
      ? undefined
      : workbook.sheets.find((s) => s.name === options.sheetName);
  let sheet = named;
  if (options.sheetName === undefined) {
    const ranked = workbook.sheets.map((s) => ({ sheet: s, ...inspectParsedSheet(s) }));
    sheet = pickPrimarySheet(ranked)?.sheet ?? workbook.sheets[0];
  }
  if (sheet === undefined) {
    throw new Error(`Sheet not found: ${options.sheetName ?? "(no sheets in workbook)"}`);
  }

  const inspection = inspectParsedSheet(sheet);
  const headerRowNumber = options.headerRowNumber ?? inspection.headerRowNumber;
  if (headerRowNumber === 0) {
    return { sheetName: sheet.name, headerRowNumber: 0, headers: [], rows: [] };
  }

  const columnCount =
    options.headerRowNumber === undefined
      ? inspection.columnCount
      : usedColumnCount(sheet.grid, headerRowNumber, sheet.columnCount);
  const resolved = resolveHeaders(sheet.grid[headerRowNumber - 1] ?? [], columnCount);

  const rows: SourceRow[] = [];
  for (let i = headerRowNumber; i < sheet.grid.length; i += 1) {
    const row = sheet.grid[i];
    if (rowIsBlank(row)) continue;
    // Null prototype: a column headed "__proto__" is a legal spreadsheet header,
    // and assigning it on a normal object is silently swallowed — the column's
    // data would vanish from the provenance record without a word.
    const cells: Record<string, string> = Object.create(null) as Record<string, string>;
    for (let c = 0; c < resolved.headers.length; c += 1) {
      cells[resolved.headers[c]] = (row[c] ?? EMPTY_CELL).text;
    }
    rows.push({ rowNumber: i + 1, cells });
  }

  return { sheetName: sheet.name, headerRowNumber, headers: resolved.headers, rows };
}

export async function readSheetRows(
  data: WorkbookData,
  options: ReadSheetOptions & ParseOptions = {},
): Promise<SheetRead> {
  return readParsedSheetRows(await parseWorkbook(data, options), options);
}
