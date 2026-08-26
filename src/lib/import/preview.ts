import { getTargetField, splitFieldValue } from "./mapping";
import {
  IMPORT_FINDING_CODES,
  type BomParentSummary,
  type DuplicateGroup,
  type ExistingProduct,
  type ImportFinding,
  type ImportPreview,
  type ImportSeverity,
  type MappedBomLine,
  type MappedIdentifier,
  type PreviewRow,
  type PreviewSummary,
  type RowClassification,
  type RowMatch,
  type RowRecordType,
  type SheetMapping,
  type SourceRow,
} from "./types";

/**
 * IMPORT PREVIEW — spec §5.5 to §5.8, §5.11, §5.12.
 *
 * Turns a confirmed mapping plus the source rows into a full account of what a
 * commit would do, without writing anything. Every judgement it makes is
 * recorded as a finding on the row, and every row keeps its complete source
 * record, so a reviewer can see exactly why a row was treated the way it was.
 *
 * Matching for safe re-import is GTIN first, then organisation + brand + part
 * number. That order matters for the supplied GS1 export: the same part number
 * legitimately appears under several brands, so a part number alone is not an
 * identity. A repeated part number inside one brand is a warning; a repeated
 * GTIN is an error, because two trade items cannot share one.
 */

export type PreviewOptions = {
  /** Brand for rows with no brand column or a blank brand cell. */
  defaultBrandName?: string;
  /** Name given to a BOM the sheet does not name itself. */
  defaultBomName?: string;
  /** Statuses the source system is expected to use. Anything else is flagged. */
  knownStatuses?: readonly string[];
  /**
   * When true a blank source cell overwrites an existing value. Off by default:
   * a column the supplier left empty is missing data, not an instruction to
   * erase what is already on record.
   */
  treatBlankAsClear?: boolean;
};

export type BuildPreviewInput = {
  orgId: string;
  sheetName?: string;
  mapping: SheetMapping;
  rows: readonly SourceRow[];
  /** Products already on record, loaded by the caller. Never read from here. */
  existing?: readonly ExistingProduct[];
  options?: PreviewOptions;
};

const DEFAULT_STATUSES = ["In Use", "PreMarket", "Draft", "Archived", "Discontinued"] as const;
const DEFAULT_BOM_NAME = "Pack contents";

/* ------------------------------------------------------------------- GTIN */

const DIGITS_ONLY = /^[0-9]+$/;
const VALID_GTIN_LENGTHS = new Set([8, 12, 13, 14]);

export function isDigits(value: string): boolean {
  return DIGITS_ONLY.test(value);
}

/**
 * GS1 modulo-10 check digit. Weights run 3,1,3,1... from the digit immediately
 * left of the check digit, which makes the rule independent of GTIN length.
 */
export function gtinCheckDigit(bodyDigits: string): number {
  let sum = 0;
  for (let i = bodyDigits.length - 1, weight = 3; i >= 0; i -= 1, weight = weight === 3 ? 1 : 3) {
    sum += Number(bodyDigits[i]) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidGtin(value: string): boolean {
  if (!isDigits(value) || !VALID_GTIN_LENGTHS.has(value.length)) return false;
  return gtinCheckDigit(value.slice(0, -1)) === Number(value[value.length - 1]);
}

/**
 * Right-aligned 14-digit form, used only as a matching key. The source value is
 * never replaced by it: a GTIN-12 stays a GTIN-12 everywhere it is stored.
 */
export function canonicalGtin(value: string): string {
  if (!isDigits(value) || !VALID_GTIN_LENGTHS.has(value.length)) return "";
  return value.padStart(14, "0");
}

/* -------------------------------------------------------------- utilities */

function normBrand(value: string): string {
  return value.trim().toLowerCase();
}

function normPart(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Brand names contain spaces, so the two parts are joined with a sentinel a part
 * number cannot hold. It has to be a *printable* one: this key is published on
 * `RowMatch.key` and travels into stored JSON, and U+0000 cannot be represented
 * in Postgres `jsonb`, so it is stripped on the way out - silently fusing
 * "axletek" + "11-500" and "axletek1" + "1-500" into a single key.
 */
const KEY_SEP = "\u241F";

function brandSkuKey(brand: string, sku: string): string {
  return `${normBrand(brand)}${KEY_SEP}${normPart(sku)}`;
}

/**
 * A source row is keyed by header text, and a header is whatever the spreadsheet
 * holds — "__proto__" and "constructor" included. Read straight off a plain
 * object those hand back something from `Object.prototype` rather than a cell,
 * which crashed the extractor on `.trim()`.
 */
function cellText(cells: Record<string, string>, header: string): string {
  if (!Object.prototype.hasOwnProperty.call(cells, header)) return "";
  const value = cells[header];
  return typeof value === "string" ? value : "";
}

const TRUE_WORDS = new Set(["y", "yes", "true", "t", "1"]);
const FALSE_WORDS = new Set(["n", "no", "false", "f", "0"]);

export function parseBooleanCell(value: string): boolean | undefined {
  const v = value.trim().toLowerCase();
  if (TRUE_WORDS.has(v)) return true;
  if (FALSE_WORDS.has(v)) return false;
  return undefined;
}

/**
 * A description that is only an internal code — "H-150-09" — with no part number
 * is a placeholder record, not something anyone can sell. Spec §5 says such rows
 * must be identified rather than assumed to be products; they are still imported.
 */
const INTERNAL_CODE = /^[A-Za-z0-9]+(?:[-/.][A-Za-z0-9]+)+$/;

export function looksLikeInternalCode(value: string): boolean {
  const v = value.trim();
  return v.length > 0 && v.length <= 24 && !/\s/.test(v) && INTERNAL_CODE.test(v);
}

function finding(
  code: string,
  severity: ImportSeverity,
  message: string,
  extra: Partial<Omit<ImportFinding, "code" | "severity" | "message">> = {},
): ImportFinding {
  return {
    code,
    severity,
    message,
    field: extra.field ?? null,
    columnIndex: extra.columnIndex ?? null,
    value: extra.value ?? "",
    relatedRows: extra.relatedRows ?? [],
  };
}

/* --------------------------------------------------------------- extraction */

type FieldIndex = {
  /** Single-valued fields: field key -> source header, in mapping order. */
  scalar: Map<string, { header: string; columnIndex: number }[]>;
  /** Multi-valued fields: field key -> source headers. */
  multi: Map<string, { header: string; columnIndex: number }[]>;
  /** Columns routed to `products.custom`, kept under their own header. */
  custom: { header: string; columnIndex: number }[];
};

function buildFieldIndex(mapping: SheetMapping): FieldIndex {
  const scalar = new Map<string, { header: string; columnIndex: number }[]>();
  const multi = new Map<string, { header: string; columnIndex: number }[]>();
  const custom: { header: string; columnIndex: number }[] = [];

  for (const col of mapping.columns) {
    if (col.field === null) continue;
    const entry = { header: col.header, columnIndex: col.columnIndex };
    if (col.field === "product.custom") {
      custom.push(entry);
      continue;
    }
    if (col.field === "meta.ignore") continue;

    const def = getTargetField(col.field);
    // A key that is not a target field is a broken mapping, not a new field.
    // `mappingLevelFindings` reports it; dropping it here keeps the invented key
    // out of the product values the plan would otherwise carry into the applier.
    if (def === undefined) continue;
    const bucket = def.multiple ? multi : scalar;
    const list = bucket.get(col.field);
    if (list === undefined) bucket.set(col.field, [entry]);
    else list.push(entry);
  }
  return { scalar, multi, custom };
}

type Extracted = {
  fields: Record<string, string>;
  custom: Record<string, string>;
  lists: Map<string, string[]>;
  columnOf: Map<string, number>;
  /** Single-valued fields that had a column on this sheet but no value in this row. */
  blankFields: Set<string>;
};

function extractRow(row: SourceRow, index: FieldIndex, mapping: SheetMapping): Extracted {
  const fields: Record<string, string> = {};
  const columnOf = new Map<string, number>();
  const blankFields = new Set<string>();

  for (const [field, sources] of index.scalar) {
    let found = false;
    for (const src of sources) {
      const value = cellText(row.cells, src.header).trim();
      if (value.length === 0) continue;
      fields[field] = value;
      columnOf.set(field, src.columnIndex);
      found = true;
      break; // First column that actually has a value wins.
    }
    if (!found) blankFields.add(field);
  }

  const lists = new Map<string, string[]>();
  for (const [field, sources] of index.multi) {
    const values: string[] = [];
    for (const src of sources) {
      const raw = cellText(row.cells, src.header).trim();
      if (raw.length === 0) continue;
      if (!columnOf.has(field)) columnOf.set(field, src.columnIndex);
      for (const part of splitFieldValue(field, raw)) {
        if (!values.includes(part)) values.push(part);
      }
    }
    if (values.length > 0) lists.set(field, values);
  }

  // Defaults fill gaps only; they never override a value the sheet supplied. A
  // default for a list field belongs in that list, not in the scalar bag: routed
  // there it would ride into the product record as a `product.fitment` column.
  for (const [field, value] of Object.entries(mapping.defaults)) {
    if (value.length === 0) continue;
    const def = getTargetField(field);
    if (def === undefined || field === "product.custom" || field === "meta.ignore") continue;
    if (def.multiple) {
      if (!lists.has(field)) lists.set(field, splitFieldValue(field, value));
      continue;
    }
    if (fields[field] === undefined) {
      fields[field] = value;
      blankFields.delete(field);
    }
  }

  const custom: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const src of index.custom) {
    const value = cellText(row.cells, src.header).trim();
    if (value.length > 0) custom[src.header] = value;
  }

  return { fields, custom, lists, columnOf, blankFields };
}

/* -------------------------------------------------------------- identifiers */

const GTIN_FIELDS = [
  { field: "identifier.gtin14", kind: "gtin14" },
  { field: "identifier.gtin13", kind: "gtin13" },
  { field: "identifier.gtin12", kind: "gtin12" },
  { field: "identifier.gtin8", kind: "gtin8" },
] as const;

type IdentifierResult = {
  identifiers: MappedIdentifier[];
  /** 14-digit key of the first usable GTIN, in gtin14 > 13 > 12 > 8 order. */
  gtinKey: string;
  findings: ImportFinding[];
  anyGtinPresent: boolean;
};

function buildIdentifiers(extracted: Extracted): IdentifierResult {
  const identifiers: MappedIdentifier[] = [];
  const findings: ImportFinding[] = [];
  let gtinKey = "";
  let anyGtinPresent = false;

  for (const spec of GTIN_FIELDS) {
    const value = extracted.fields[spec.field];
    if (value === undefined || value.length === 0) continue;
    anyGtinPresent = true;
    const columnIndex = extracted.columnOf.get(spec.field) ?? null;

    let valid = true;
    let note = "";
    if (!isDigits(value)) {
      valid = false;
      note = "Not a digit string.";
      findings.push(
        finding(
          IMPORT_FINDING_CODES.GTIN_NOT_NUMERIC,
          "error",
          `${spec.kind} "${value}" contains characters other than digits.`,
          { field: spec.field, columnIndex, value },
        ),
      );
    } else if (!VALID_GTIN_LENGTHS.has(value.length)) {
      valid = false;
      note = `Length ${value.length} is not a GTIN length.`;
      findings.push(
        finding(
          IMPORT_FINDING_CODES.GTIN_LENGTH,
          "error",
          `${spec.kind} "${value}" is ${value.length} digits; a GTIN is 8, 12, 13 or 14.`,
          { field: spec.field, columnIndex, value },
        ),
      );
    } else if (!isValidGtin(value)) {
      valid = false;
      const expected = gtinCheckDigit(value.slice(0, -1));
      note = `Check digit should be ${expected}.`;
      findings.push(
        finding(
          IMPORT_FINDING_CODES.GTIN_CHECK_DIGIT,
          "error",
          `${spec.kind} "${value}" fails the GS1 check digit; the last digit should be ${expected}. The value is imported unchanged.`,
          { field: spec.field, columnIndex, value },
        ),
      );
    }

    const canonical = canonicalGtin(value);
    if (gtinKey.length === 0 && canonical.length > 0) gtinKey = canonical;
    identifiers.push({
      kind: spec.kind,
      value,
      canonical,
      isPrimary: false,
      valid,
      validationNote: note,
    });
  }

  // Two GTIN columns that disagree is a source conflict. Precedence is declared
  // (gtin14 first) so matching stays deterministic; neither value is altered.
  const canonicals = identifiers.map((i) => i.canonical).filter((c) => c.length > 0);
  if (new Set(canonicals).size > 1) {
    findings.push(
      finding(
        IMPORT_FINDING_CODES.GTIN_INCONSISTENT,
        "warning",
        `The GTIN columns on this row disagree (${canonicals.join(", ")}). The GTIN-14 column is used as the key.`,
        { value: canonicals.join(", ") },
      ),
    );
  }

  const primary = identifiers.find((i) => i.canonical === gtinKey && gtinKey.length > 0);
  if (primary !== undefined) primary.isPrimary = true;

  const prefix = extracted.fields["identifier.gs1CompanyPrefix"];
  if (prefix !== undefined && prefix.length > 0) {
    identifiers.push({
      kind: "gs1CompanyPrefix",
      value: prefix,
      canonical: "",
      isPrimary: false,
      valid: true,
      validationNote: "",
    });
  }

  // A part number is also an identifier, so "find by SKU" is one uniform lookup.
  const sku = extracted.fields["identifier.sku"] ?? extracted.fields["product.partNumber"];
  if (sku !== undefined && sku.length > 0) {
    identifiers.push({
      kind: "sku",
      value: sku,
      canonical: "",
      isPrimary: false,
      valid: true,
      validationNote: "",
    });
  }

  return { identifiers, gtinKey, findings, anyGtinPresent };
}

/* ---------------------------------------------------------------- BOM lines */

/**
 * The line number the sheet gave, or null when it gave none. Null and 0 are not
 * the same thing: a sheet that numbers its first line 0 said something, and
 * treating that as "unset" renumbered it to 1 without a word.
 */
function parsePosition(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(n) ? n : null;
}

function buildBomLine(
  extracted: Extracted,
  ownPartNumber: string,
  defaultBomName: string,
): MappedBomLine | null {
  const component = extracted.fields["bomItem.partNumber"] ?? "";
  const name = extracted.fields["bomItem.name"] ?? "";
  const description = extracted.fields["bomItem.description"] ?? "";
  const quantity = extracted.fields["bomItem.quantity"] ?? "";
  const parent = extracted.fields["bom.parentPartNumber"] ?? ownPartNumber;

  const hasLine =
    component.length > 0 || name.length > 0 || description.length > 0 || quantity.length > 0;
  if (!hasLine || parent.length === 0) return null;

  const position = parsePosition(extracted.fields["bomItem.position"] ?? "");

  return {
    parentPartNumber: parent,
    bomName: extracted.fields["bom.name"] ?? defaultBomName,
    revision: extracted.fields["bom.revision"] ?? "",
    position: position ?? 0,
    quantity: quantity.length === 0 ? "1" : quantity,
    unitOfMeasure: extracted.fields["bomItem.unitOfMeasure"] ?? "",
    name,
    partNumber: component,
    description,
  };
}

/* ----------------------------------------------------------------- preview */

type Draft = {
  source: SourceRow;
  extracted: Extracted;
  identifiers: MappedIdentifier[];
  gtinKey: string;
  anyGtinPresent: boolean;
  brandName: string;
  partNumber: string;
  bom: MappedBomLine | null;
  findings: ImportFinding[];
};

export function buildPreview(input: BuildPreviewInput): ImportPreview {
  const options = input.options ?? {};
  const knownStatuses = new Set(options.knownStatuses ?? DEFAULT_STATUSES);
  const defaultBomName = options.defaultBomName ?? DEFAULT_BOM_NAME;
  const index = buildFieldIndex(input.mapping);
  const mappingFindings = mappingLevelFindings(input.mapping);

  /* ---- pass A: extract and validate each row on its own ---- */

  const drafts: Draft[] = input.rows.map((row) => {
    const extracted = extractRow(row, index, input.mapping);
    const ids = buildIdentifiers(extracted);
    const brandName = extracted.fields["brand.name"] ?? options.defaultBrandName ?? "";
    const partNumber = extracted.fields["product.partNumber"] ?? "";
    const bom = buildBomLine(extracted, partNumber, defaultBomName);
    return {
      source: row,
      extracted,
      identifiers: ids.identifiers,
      gtinKey: ids.gtinKey,
      anyGtinPresent: ids.anyGtinPresent,
      brandName,
      partNumber,
      bom,
      findings: [...ids.findings],
    };
  });

  /* ---- in-file indexes, used for duplicate detection ---- */

  const gtinRows = new Map<string, number[]>();
  const brandSkuRows = new Map<string, number[]>();
  const brandSkuLabels = new Map<string, string>();
  const skuRows = new Map<string, number[]>();
  const productPartNumbers = new Set<string>();

  for (const d of drafts) {
    if (d.gtinKey.length > 0) push(gtinRows, d.gtinKey, d.source.rowNumber);
    if (d.partNumber.length > 0) {
      const bsKey = brandSkuKey(d.brandName, d.partNumber);
      push(brandSkuRows, bsKey, d.source.rowNumber);
      // Keep the spelling the sheet used; the key itself is case-folded.
      if (!brandSkuLabels.has(bsKey)) {
        brandSkuLabels.set(bsKey, `${d.brandName} / ${d.partNumber}`);
      }
      push(skuRows, normPart(d.partNumber), d.source.rowNumber);
      productPartNumbers.add(normPart(d.partNumber));
    }
  }
  const bomParentParts = new Set(
    drafts.filter((d) => d.bom !== null).map((d) => normPart(d.bom?.parentPartNumber ?? "")),
  );

  /* ---- existing-record indexes ---- */

  const existing = input.existing ?? [];
  const existingByGtin = new Map<string, ExistingProduct>();
  const existingByBrandSku = new Map<string, ExistingProduct>();
  const existingById = new Map<string, ExistingProduct>();
  const existingParts = new Set<string>();
  for (const p of existing) {
    existingById.set(p.id, p);
    for (const g of p.gtins) {
      const key = canonicalGtin(g.trim());
      if (key.length > 0 && !existingByGtin.has(key)) existingByGtin.set(key, p);
    }
    if (p.partNumber.length > 0) {
      const key = brandSkuKey(p.brandName, p.partNumber);
      if (!existingByBrandSku.has(key)) existingByBrandSku.set(key, p);
      existingParts.add(normPart(p.partNumber));
    }
  }

  /* ---- pass B: duplicates, classification, change detection ---- */

  const seenGtin = new Set<string>();
  const seenBrandSku = new Set<string>();
  const seenSku = new Map<string, string>(); // normalised SKU -> brand it first appeared under
  const claimedKeys = new Set<string>();
  const bomPositionCounter = new Map<string, number>();

  const rows: PreviewRow[] = drafts.map((d) => {
    const findings = d.findings;
    const rowNumber = d.source.rowNumber;
    const description = d.extracted.fields["product.description"] ?? "";

    /* record type */
    let recordType: RowRecordType;
    const hasProductIdentity = d.partNumber.length > 0 || d.gtinKey.length > 0;
    if (d.bom !== null && !hasProductIdentity && description.length === 0) {
      recordType = "bom_line";
    } else if (looksLikeInternalCode(description) && d.partNumber.length === 0) {
      recordType = "non_sellable";
      findings.push(
        finding(
          IMPORT_FINDING_CODES.ROW_NOT_SELLABLE,
          "warning",
          `The description "${description}" is a bare internal code and the row has no part number. Imported and marked as not sellable.`,
          {
            field: "product.description",
            columnIndex: d.extracted.columnOf.get("product.description") ?? null,
            value: description,
          },
        ),
      );
    } else if (
      d.partNumber.length > 0 &&
      bomParentParts.has(normPart(d.partNumber)) &&
      d.bom === null
    ) {
      recordType = "kit_parent";
    } else if (!hasProductIdentity && description.length === 0) {
      recordType = "unknown";
    } else {
      recordType = "product";
    }

    /* duplicates */
    if (d.gtinKey.length > 0) {
      const rowsForGtin = gtinRows.get(d.gtinKey) ?? [];
      if (seenGtin.has(d.gtinKey)) {
        findings.push(
          finding(
            IMPORT_FINDING_CODES.GTIN_DUPLICATE_IN_FILE,
            "error",
            `GTIN ${d.gtinKey} already appears on row ${rowsForGtin[0]}. Two trade items cannot share a GTIN.`,
            { field: "identifier.gtin14", value: d.gtinKey, relatedRows: rowsForGtin.filter((r) => r !== rowNumber) },
          ),
        );
      }
      seenGtin.add(d.gtinKey);
    }

    if (d.partNumber.length > 0) {
      const bsKey = brandSkuKey(d.brandName, d.partNumber);
      const skuKey = normPart(d.partNumber);
      if (seenBrandSku.has(bsKey)) {
        findings.push(
          finding(
            IMPORT_FINDING_CODES.SKU_DUPLICATE_IN_BRAND,
            "warning",
            `Part number ${d.partNumber} already appears under brand "${d.brandName}" on row ${(brandSkuRows.get(bsKey) ?? [])[0]}.`,
            {
              field: "product.partNumber",
              columnIndex: d.extracted.columnOf.get("product.partNumber") ?? null,
              value: d.partNumber,
              relatedRows: (brandSkuRows.get(bsKey) ?? []).filter((r) => r !== rowNumber),
            },
          ),
        );
      } else if (seenSku.has(skuKey)) {
        findings.push(
          finding(
            IMPORT_FINDING_CODES.SKU_DUPLICATE_CROSS_BRAND,
            "info",
            `Part number ${d.partNumber} is also used by brand "${seenSku.get(skuKey) ?? ""}". Part numbers are scoped to a brand, so this is expected.`,
            {
              field: "product.partNumber",
              columnIndex: d.extracted.columnOf.get("product.partNumber") ?? null,
              value: d.partNumber,
              relatedRows: (skuRows.get(skuKey) ?? []).filter((r) => r !== rowNumber),
            },
          ),
        );
      }
      seenBrandSku.add(bsKey);
      if (!seenSku.has(skuKey)) seenSku.set(skuKey, d.brandName);
    }

    /* matching: GTIN first, then org + brand + part number */
    let match: RowMatch = { kind: "none", key: "", existingId: null };
    if (recordType !== "bom_line") {
      if (d.gtinKey.length > 0) {
        match = {
          kind: "gtin",
          key: d.gtinKey,
          existingId: existingByGtin.get(d.gtinKey)?.id ?? null,
        };
        const bySku =
          d.partNumber.length > 0
            ? existingByBrandSku.get(brandSkuKey(d.brandName, d.partNumber))
            : undefined;
        if (
          match.existingId !== null &&
          bySku !== undefined &&
          bySku.id !== match.existingId
        ) {
          findings.push(
            finding(
              IMPORT_FINDING_CODES.GTIN_DUPLICATE_IN_ORG,
              "warning",
              `GTIN ${d.gtinKey} is on a different product than brand "${d.brandName}" part ${d.partNumber}. The GTIN match wins.`,
              { value: d.gtinKey },
            ),
          );
        }
      } else if (d.partNumber.length > 0) {
        const key = brandSkuKey(d.brandName, d.partNumber);
        match = { kind: "brandSku", key, existingId: existingByBrandSku.get(key)?.id ?? null };
        if (claimedKeys.has(key)) {
          findings.push(
            finding(
              IMPORT_FINDING_CODES.KEY_DUPLICATE_IN_FILE,
              "warning",
              `This row has no GTIN, so it is keyed on brand + part number, and an earlier row already claimed "${d.brandName} / ${d.partNumber}". Both rows would write to the same product.`,
              { value: key, relatedRows: (brandSkuRows.get(key) ?? []).filter((r) => r !== rowNumber) },
            ),
          );
        }
      }
      if (match.kind !== "none") claimedKeys.add(match.key);
    }

    /* per-row completeness */
    if (recordType === "product" || recordType === "kit_parent") {
      if (!d.anyGtinPresent) {
        findings.push(
          finding(
            IMPORT_FINDING_CODES.GTIN_MISSING,
            "warning",
            "No GTIN or U.P.C. on this row. It cannot carry a retail barcode until one is supplied.",
            { field: "identifier.gtin14" },
          ),
        );
      }
      if (d.partNumber.length === 0) {
        findings.push(
          finding(
            IMPORT_FINDING_CODES.SKU_MISSING,
            "warning",
            "No part number on this row.",
            { field: "product.partNumber" },
          ),
        );
      }
      if (d.brandName.length === 0) {
        findings.push(
          finding(
            IMPORT_FINDING_CODES.BRAND_MISSING,
            "warning",
            "No brand on this row. Part numbers are scoped to a brand, so matching falls back to the blank brand.",
            { field: "brand.name" },
          ),
        );
      }
    }

    const status = d.extracted.fields["product.status"] ?? "";
    if (status.length > 0 && !knownStatuses.has(status)) {
      findings.push(
        finding(
          IMPORT_FINDING_CODES.STATUS_UNKNOWN,
          "info",
          `Status "${status}" is not one of the statuses this importer knows.`,
          {
            field: "product.status",
            columnIndex: d.extracted.columnOf.get("product.status") ?? null,
            value: status,
          },
        ),
      );
    }
    const purchasable = parseBooleanCell(d.extracted.fields["product.isPurchasable"] ?? "");
    if (purchasable === false) {
      findings.push(
        finding(
          IMPORT_FINDING_CODES.NOT_PURCHASABLE,
          "info",
          "The source marks this item as not purchasable.",
          { field: "product.isPurchasable", value: d.extracted.fields["product.isPurchasable"] ?? "" },
        ),
      );
    }

    /* BOM line checks */
    let bom = d.bom;
    if (bom !== null) {
      const parentKey = normPart(bom.parentPartNumber);
      if (!productPartNumbers.has(parentKey) && !existingParts.has(parentKey)) {
        findings.push(
          finding(
            IMPORT_FINDING_CODES.BOM_PARENT_MISSING,
            "warning",
            `BOM parent "${bom.parentPartNumber}" is not a product in this sheet or on record.`,
            { field: "bom.parentPartNumber", value: bom.parentPartNumber },
          ),
        );
      }
      if (bom.partNumber.length === 0 && bom.name.length === 0) {
        findings.push(
          finding(
            IMPORT_FINDING_CODES.BOM_COMPONENT_MISSING,
            "warning",
            "The BOM line has neither a component part number nor a component name.",
            { field: "bomItem.partNumber" },
          ),
        );
      }
      if (bom.partNumber.length > 0 && normPart(bom.partNumber) === parentKey) {
        findings.push(
          finding(
            IMPORT_FINDING_CODES.BOM_SELF_REFERENCE,
            "error",
            `BOM line lists "${bom.partNumber}" as a component of itself.`,
            { field: "bomItem.partNumber", value: bom.partNumber },
          ),
        );
      }
      if (!Number.isFinite(Number(bom.quantity))) {
        findings.push(
          finding(
            IMPORT_FINDING_CODES.BOM_QUANTITY_INVALID,
            "warning",
            `Quantity "${bom.quantity}" is not a number. It is stored as text, unchanged.`,
            { field: "bomItem.quantity", value: bom.quantity },
          ),
        );
      }
      const positionText = d.extracted.fields["bomItem.position"] ?? "";
      const supplied = parsePosition(positionText);
      if (positionText.trim().length > 0 && supplied === null) {
        findings.push(
          finding(
            IMPORT_FINDING_CODES.BOM_POSITION_INVALID,
            "warning",
            `Line number "${positionText}" is not a whole number. The line was placed in sheet order instead.`,
            {
              field: "bomItem.position",
              columnIndex: d.extracted.columnOf.get("bomItem.position") ?? null,
              value: positionText,
            },
          ),
        );
      }
      if (supplied === null) {
        const next = (bomPositionCounter.get(parentKey) ?? 0) + 1;
        bomPositionCounter.set(parentKey, next);
        bom = { ...bom, position: next };
      } else {
        bomPositionCounter.set(
          parentKey,
          Math.max(bomPositionCounter.get(parentKey) ?? 0, supplied),
        );
      }
    }

    /* classification */
    const existingRecord =
      match.existingId === null ? undefined : existingById.get(match.existingId);
    const changedFields = existingRecord === undefined
      ? []
      : diffFields(
          d.extracted.fields,
          d.extracted.blankFields,
          existingRecord,
          options.treatBlankAsClear ?? false,
        );

    let classification: RowClassification;
    if (recordType === "bom_line") {
      classification = "create";
    } else if (match.kind === "none") {
      // A row with nothing in it at all is noise, not a failure worth an error.
      const blank = Object.values(d.source.cells).every((v) => v.length === 0);
      findings.push(
        blank
          ? finding(IMPORT_FINDING_CODES.ROW_BLANK, "info", "The row is empty.")
          : finding(
              IMPORT_FINDING_CODES.ROW_NOT_IDENTIFIABLE,
              "error",
              "The row has neither a GTIN nor a part number, so it cannot be matched or created.",
            ),
      );
      classification = "skip";
    } else if (existingRecord === undefined) {
      classification = "create";
    } else {
      classification = changedFields.length === 0 ? "unchanged" : "update";
    }
    if (findings.some((f) => f.severity === "error")) classification = "skip";

    return {
      rowNumber,
      classification,
      recordType,
      match,
      fields: { ...d.extracted.fields },
      custom: { ...d.extracted.custom },
      identifiers: d.identifiers,
      alternates: d.extracted.lists.get("alternate.partNumber") ?? [],
      fitments: d.extracted.lists.get("product.fitment") ?? [],
      warnings: d.extracted.lists.get("product.warning") ?? [],
      bom,
      changedFields,
      findings,
      source: d.source,
    };
  });

  /* ---- roll-ups ---- */

  const duplicateGtins = groupsWithMoreThanOne(gtinRows);
  const duplicatePartNumbersInBrand = groupsWithMoreThanOne(brandSkuRows).map((g) => ({
    value: brandSkuLabels.get(g.value) ?? g.value.split(KEY_SEP).join(" / "),
    rowNumbers: g.rowNumbers,
  }));
  const brandOfRow = new Map(drafts.map((d) => [d.source.rowNumber, normBrand(d.brandName)]));
  const crossBrandPartNumbers = groupsWithMoreThanOne(skuRows).filter(
    (g) => new Set(g.rowNumbers.map((r) => brandOfRow.get(r) ?? "")).size > 1,
  );

  const bomParents = buildBomParentSummaries(rows, productPartNumbers, existingParts);
  const summary = summarise(rows, drafts);

  return {
    orgId: input.orgId,
    sheetName: input.sheetName ?? input.mapping.sheetName,
    profileId: input.mapping.profileId,
    mapping: input.mapping,
    rows,
    summary,
    duplicateGtins,
    duplicatePartNumbersInBrand,
    crossBrandPartNumbers,
    bomParents,
    findings: mappingFindings,
    committable:
      mappingFindings.every((f) => f.severity !== "error") &&
      rows.some((r) => r.classification === "create" || r.classification === "update"),
  };
}

/* ------------------------------------------------------------- roll-up bits */

function push(map: Map<string, number[]>, key: string, value: number): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function groupsWithMoreThanOne(map: Map<string, number[]>): DuplicateGroup[] {
  const out: DuplicateGroup[] = [];
  for (const [value, rowNumbers] of map) {
    if (rowNumbers.length > 1) out.push({ value, rowNumbers: [...rowNumbers] });
  }
  out.sort((a, b) => a.value.localeCompare(b.value));
  return out;
}

function mappingLevelFindings(mapping: SheetMapping): ImportFinding[] {
  const out: ImportFinding[] = [];
  for (const group of mapping.missingRequired) {
    out.push(
      finding(
        IMPORT_FINDING_CODES.MAPPING_REQUIRED_FIELD_MISSING,
        "error",
        `No column is mapped to any of: ${group}. Nothing can be matched or created without one.`,
        { field: group },
      ),
    );
  }
  for (const conflict of mapping.conflicts) {
    out.push(
      finding(
        IMPORT_FINDING_CODES.MAPPING_CONFLICT,
        "error",
        `${conflict.columnIndexes.length} columns are mapped to "${conflict.field}", which holds a single value.`,
        { field: conflict.field },
      ),
    );
  }
  for (const col of mapping.columns) {
    if (col.field !== null && getTargetField(col.field) === undefined) {
      out.push(
        finding(
          IMPORT_FINDING_CODES.MAPPING_UNKNOWN_FIELD,
          "error",
          `Column "${col.header}" is mapped to "${col.field}", which is not a target field. Its values would be written under a name nothing reads.`,
          { field: col.field, columnIndex: col.columnIndex },
        ),
      );
    }
    // Reported whether the loser ended up unmapped or was demoted to its
    // runner-up: a column silently re-pointed at a field it merely resembles is
    // the outcome most worth showing the user, and it used to say nothing.
    if (col.supersededBy === null) continue;
    const winner = mapping.columns.find((c) => c.columnIndex === col.supersededBy);
    const winnerName =
      winner === undefined ? `column ${col.supersededBy + 1}` : `"${winner.header}"`;
    out.push(
      finding(
        IMPORT_FINDING_CODES.UNMAPPED_COLUMN_HAS_DATA,
        "info",
        col.field === null
          ? `Column "${col.header}" is not mapped: ${winnerName} matched the same field more strongly.`
          : `Column "${col.header}" lost its best match to ${winnerName} and was mapped to "${col.field}" instead. Confirm that is where it belongs.`,
        { field: col.field, columnIndex: col.columnIndex },
      ),
    );
  }
  return out;
}

/**
 * `blankFields` is what makes `treatBlankAsClear` mean anything. Extraction only
 * ever records non-empty values, so a "blank" field is one that is absent from
 * `fields` — comparing the entries alone could never see an erased cell, and the
 * option quietly did nothing.
 */
function diffFields(
  fields: Record<string, string>,
  blankFields: ReadonlySet<string>,
  existing: ExistingProduct,
  treatBlankAsClear: boolean,
): string[] {
  const changed: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const current = existing.fields[key] ?? "";
    if (value !== current) changed.push(key);
  }
  if (treatBlankAsClear) {
    for (const key of blankFields) {
      const current = existing.fields[key] ?? "";
      if (current.length > 0) changed.push(key);
    }
  }
  changed.sort();
  return changed;
}

function buildBomParentSummaries(
  rows: readonly PreviewRow[],
  productPartNumbers: ReadonlySet<string>,
  existingParts: ReadonlySet<string>,
): BomParentSummary[] {
  const byParent = new Map<string, { partNumber: string; rowNumbers: number[] }>();
  for (const row of rows) {
    if (row.bom === null) continue;
    const key = normPart(row.bom.parentPartNumber);
    const entry = byParent.get(key);
    if (entry === undefined) {
      byParent.set(key, { partNumber: row.bom.parentPartNumber, rowNumbers: [row.rowNumber] });
    } else {
      entry.rowNumbers.push(row.rowNumber);
    }
  }
  return [...byParent.entries()]
    .map(([key, entry]) => ({
      partNumber: entry.partNumber,
      itemCount: entry.rowNumbers.length,
      rowNumbers: entry.rowNumbers,
      resolved: productPartNumbers.has(key) || existingParts.has(key),
    }))
    .sort((a, b) => a.partNumber.localeCompare(b.partNumber));
}

function summarise(rows: readonly PreviewRow[], drafts: readonly Draft[]): PreviewSummary {
  const brandCounts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};
  const findingCounts: Record<string, number> = {};

  let create = 0;
  let update = 0;
  let unchanged = 0;
  let skip = 0;
  let errorRows = 0;
  let warningRows = 0;
  let nonSellableRows = 0;
  let bomLineRows = 0;
  let rowsWithGtin = 0;
  let validGtins = 0;
  let invalidGtins = 0;
  let rowsWithSku = 0;
  let duplicateGtinRows = 0;
  let duplicateSkuRows = 0;
  let duplicateSkuInBrandRows = 0;

  rows.forEach((row, i) => {
    const draft = drafts[i];
    if (row.classification === "create") create += 1;
    else if (row.classification === "update") update += 1;
    else if (row.classification === "unchanged") unchanged += 1;
    else skip += 1;

    if (row.findings.some((f) => f.severity === "error")) errorRows += 1;
    if (row.findings.some((f) => f.severity === "warning")) warningRows += 1;
    if (row.recordType === "non_sellable") nonSellableRows += 1;
    if (row.bom !== null) bomLineRows += 1;

    if (draft.anyGtinPresent) {
      rowsWithGtin += 1;
      const gtins = row.identifiers.filter((id) => id.kind.startsWith("gtin"));
      if (gtins.every((id) => id.valid)) validGtins += 1;
      else invalidGtins += 1;
    }
    if (draft.partNumber.length > 0) rowsWithSku += 1;

    for (const f of row.findings) {
      findingCounts[f.code] = (findingCounts[f.code] ?? 0) + 1;
      if (f.code === IMPORT_FINDING_CODES.GTIN_DUPLICATE_IN_FILE) duplicateGtinRows += 1;
      if (f.code === IMPORT_FINDING_CODES.SKU_DUPLICATE_IN_BRAND) {
        duplicateSkuInBrandRows += 1;
        duplicateSkuRows += 1;
      }
      if (f.code === IMPORT_FINDING_CODES.SKU_DUPLICATE_CROSS_BRAND) duplicateSkuRows += 1;
    }

    const brand = draft.brandName;
    brandCounts[brand] = (brandCounts[brand] ?? 0) + 1;
    const status = row.fields["product.status"] ?? "";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  });

  const skuGroups = new Map<string, number>();
  for (const d of drafts) {
    if (d.partNumber.length === 0) continue;
    const key = normPart(d.partNumber);
    skuGroups.set(key, (skuGroups.get(key) ?? 0) + 1);
  }
  const duplicateSkuValues = [...skuGroups.values()].filter((n) => n > 1).length;

  return {
    totalRows: rows.length,
    create,
    update,
    unchanged,
    skip,
    errorRows,
    warningRows,
    nonSellableRows,
    bomLineRows,
    rowsWithGtin,
    rowsWithoutGtin: rows.length - rowsWithGtin,
    validGtins,
    invalidGtins,
    rowsWithSku,
    duplicateGtinRows,
    duplicateSkuRows,
    duplicateSkuValues,
    duplicateSkuInBrandRows,
    brandCounts,
    statusCounts,
    findingCounts,
  };
}

