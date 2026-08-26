import { z } from "zod";

/**
 * WORKBOOK IMPORT — shared contract (spec §5).
 *
 * The import pipeline is four pure stages, each of which hands a plain,
 * zod-validated object to the next:
 *
 *   inspect.ts  buffer          -> WorkbookInspection
 *   mapping.ts  headers         -> SheetMapping        (user-editable in the UI)
 *   preview.ts  mapping + rows  -> ImportPreview       (nothing written yet)
 *   commit.ts   preview         -> ImportPlan          (ordered typed operations)
 *
 * Two rules run through all of it:
 *  - Source data is never silently corrected. Anything questionable becomes a
 *    finding on the row; the value itself travels through verbatim.
 *  - The complete source row is retained on every row and on every product
 *    operation, so a committed record can always be traced back to its cells.
 */

/* ------------------------------------------------------------- primitives */

export const IMPORT_SEVERITIES = ["error", "warning", "info"] as const;
export const ImportSeveritySchema = z.enum(IMPORT_SEVERITIES);
export type ImportSeverity = (typeof IMPORT_SEVERITIES)[number];

/**
 * One row of the source sheet, kept exactly as it was read: header -> cell text.
 * Numbers, dates and formula results are stringified once, on read, and are not
 * re-parsed anywhere downstream except for explicit validation.
 */
export const SourceRowSchema = z.object({
  /** 1-based worksheet row number, so a finding can point at the real cell. */
  rowNumber: z.number().int().positive(),
  cells: z.record(z.string(), z.string()),
});
export type SourceRow = z.infer<typeof SourceRowSchema>;

/* ------------------------------------------------------------- inspection */

export const COLUMN_VALUE_TYPES = ["empty", "text", "number", "date", "boolean", "mixed"] as const;
export const ColumnValueTypeSchema = z.enum(COLUMN_VALUE_TYPES);
export type ColumnValueType = (typeof COLUMN_VALUE_TYPES)[number];

/**
 * Guessed role of a sheet. Only ever a hint for the mapping UI — the user's
 * confirmed mapping is what the preview actually runs on.
 */
export const SHEET_KINDS = [
  "products",
  "bom",
  "identifiers",
  "packaging",
  "inventory",
  "reference",
  "empty",
  "unknown",
] as const;
export const SheetKindSchema = z.enum(SHEET_KINDS);
export type SheetKind = (typeof SHEET_KINDS)[number];

export const HEADER_CONFIDENCES = ["high", "low", "none"] as const;
export const HeaderConfidenceSchema = z.enum(HEADER_CONFIDENCES);
export type HeaderConfidence = (typeof HEADER_CONFIDENCES)[number];

export const SHEET_NOTE_CODES = {
  EMPTY_SHEET: "EMPTY_SHEET",
  HEADER_ROW_UNCERTAIN: "HEADER_ROW_UNCERTAIN",
  HEADER_CELL_BLANK: "HEADER_CELL_BLANK",
  HEADER_CELL_MERGED: "HEADER_CELL_MERGED",
  HEADER_DUPLICATED: "HEADER_DUPLICATED",
  BANNER_ROWS_ABOVE_HEADER: "BANNER_ROWS_ABOVE_HEADER",
  NO_DATA_ROWS: "NO_DATA_ROWS",
  COLUMN_ENTIRELY_EMPTY: "COLUMN_ENTIRELY_EMPTY",
} as const;
export type SheetNoteCode = (typeof SHEET_NOTE_CODES)[keyof typeof SHEET_NOTE_CODES];

export const SheetNoteSchema = z.object({
  code: z.string(),
  message: z.string(),
  /** 0-based column index when the note is about one column. */
  columnIndex: z.number().int().nonnegative().optional(),
  rowNumber: z.number().int().positive().optional(),
});
export type SheetNote = z.infer<typeof SheetNoteSchema>;

export const ColumnSampleSchema = z.object({
  /** 0-based position in the header row. */
  index: z.number().int().nonnegative(),
  /** Spreadsheet column letter, for talking to a human about the file. */
  letter: z.string(),
  /** Resolved header: de-duplicated, with a placeholder when the cell was blank. */
  header: z.string(),
  /** Whatever the header cell actually contained, before any repair. */
  rawHeader: z.string(),
  headerWasBlank: z.boolean(),
  headerWasMerged: z.boolean(),
  nonEmptyCount: z.number().int().nonnegative(),
  distinctCount: z.number().int().nonnegative(),
  valueType: ColumnValueTypeSchema,
  maxLength: z.number().int().nonnegative(),
  samples: z.array(z.string()),
});
export type ColumnSample = z.infer<typeof ColumnSampleSchema>;

export const ProfileMatchSchema = z.object({
  profileId: z.string(),
  label: z.string(),
  /** 0..100. */
  score: z.number(),
  matchedHeaders: z.array(z.string()),
  missingHeaders: z.array(z.string()),
  missingRequired: z.array(z.string()),
});
export type ProfileMatch = z.infer<typeof ProfileMatchSchema>;

export const SheetInspectionSchema = z.object({
  name: z.string(),
  /** 0-based worksheet order. */
  index: z.number().int().nonnegative(),
  /** Last row number holding any value, as reported by the workbook. */
  rowCount: z.number().int().nonnegative(),
  /** 1-based row the headers were read from; 0 when the sheet has no rows. */
  headerRowNumber: z.number().int().nonnegative(),
  headerConfidence: HeaderConfidenceSchema,
  firstDataRowNumber: z.number().int().nonnegative(),
  /** Non-blank rows below the header row. */
  dataRowCount: z.number().int().nonnegative(),
  columnCount: z.number().int().nonnegative(),
  headers: z.array(z.string()),
  columns: z.array(ColumnSampleSchema),
  kind: SheetKindSchema,
  /** 0..100 confidence in `kind`. */
  kindConfidence: z.number(),
  profileMatches: z.array(ProfileMatchSchema),
  notes: z.array(SheetNoteSchema),
});
export type SheetInspection = z.infer<typeof SheetInspectionSchema>;

export const WorkbookInspectionSchema = z.object({
  filename: z.string(),
  sheetCount: z.number().int().nonnegative(),
  sheets: z.array(SheetInspectionSchema),
  /** Best candidate for "the sheet the user probably means"; null if none. */
  primarySheetName: z.string().nullable(),
  primaryProfileId: z.string().nullable(),
});
export type WorkbookInspection = z.infer<typeof WorkbookInspectionSchema>;

/* ---------------------------------------------------------------- mapping */

export const TARGET_ENTITIES = [
  "product",
  "brand",
  "identifier",
  "alternate",
  "bom",
  "bomItem",
  "meta",
] as const;
export const TargetEntitySchema = z.enum(TARGET_ENTITIES);
export type TargetEntity = (typeof TARGET_ENTITIES)[number];

/**
 * A field a source column can be pointed at. `TARGET_FIELDS` in mapping.ts is
 * the one list; the mapping UI renders it and nothing else defines targets.
 */
export const TargetFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  group: z.string(),
  entity: TargetEntitySchema,
  /** Part of a required field group for at least one profile. */
  required: z.boolean(),
  /** True when several columns may feed the same field (alternates, custom). */
  multiple: z.boolean(),
  /** Cell separators to split on when one cell holds a list. */
  splitOn: z.array(z.string()),
  description: z.string(),
  example: z.string(),
  aliases: z.array(z.string()),
});
export type TargetField = z.infer<typeof TargetFieldSchema>;

export const MAPPING_SOURCES = ["profile", "alias", "fuzzy", "manual", "none"] as const;
export const MappingSourceSchema = z.enum(MAPPING_SOURCES);
export type MappingSource = (typeof MAPPING_SOURCES)[number];

export const ColumnMappingSchema = z.object({
  /** 0-based column index in the header row. */
  columnIndex: z.number().int().nonnegative(),
  header: z.string(),
  /** Target field key, or null for "do not import this column". */
  field: z.string().nullable(),
  /** 0..100. */
  confidence: z.number(),
  source: MappingSourceSchema,
  /** Set when a better-scoring column already claimed a single-valued field. */
  supersededBy: z.number().int().nonnegative().nullable(),
  /** Runner-up targets, so the UI can offer a short pick list. */
  alternatives: z.array(z.object({ field: z.string(), confidence: z.number() })),
});
export type ColumnMapping = z.infer<typeof ColumnMappingSchema>;

export const MappingConflictSchema = z.object({
  field: z.string(),
  columnIndexes: z.array(z.number().int().nonnegative()),
});
export type MappingConflict = z.infer<typeof MappingConflictSchema>;

export const SheetMappingSchema = z.object({
  sheetName: z.string(),
  headerRowNumber: z.number().int().nonnegative(),
  profileId: z.string(),
  profileScore: z.number(),
  columns: z.array(ColumnMappingSchema),
  /** Distinct target field keys the mapping currently feeds. */
  mappedFields: z.array(z.string()),
  /** Required field groups the mapping cannot satisfy. */
  missingRequired: z.array(z.string()),
  conflicts: z.array(MappingConflictSchema),
  /**
   * Values applied when a field has no column, or when its cell is blank —
   * e.g. a private-label sheet with no brand column at all.
   */
  defaults: z.record(z.string(), z.string()),
});
export type SheetMapping = z.infer<typeof SheetMappingSchema>;

/* ---------------------------------------------------------------- preview */

export const IMPORT_FINDING_CODES = {
  ROW_BLANK: "ROW_BLANK",
  ROW_NOT_IDENTIFIABLE: "ROW_NOT_IDENTIFIABLE",
  ROW_NOT_SELLABLE: "ROW_NOT_SELLABLE",
  GTIN_MISSING: "GTIN_MISSING",
  GTIN_NOT_NUMERIC: "GTIN_NOT_NUMERIC",
  GTIN_LENGTH: "GTIN_LENGTH",
  GTIN_CHECK_DIGIT: "GTIN_CHECK_DIGIT",
  GTIN_INCONSISTENT: "GTIN_INCONSISTENT",
  GTIN_DUPLICATE_IN_FILE: "GTIN_DUPLICATE_IN_FILE",
  GTIN_DUPLICATE_IN_ORG: "GTIN_DUPLICATE_IN_ORG",
  SKU_MISSING: "SKU_MISSING",
  SKU_DUPLICATE_IN_BRAND: "SKU_DUPLICATE_IN_BRAND",
  SKU_DUPLICATE_CROSS_BRAND: "SKU_DUPLICATE_CROSS_BRAND",
  KEY_DUPLICATE_IN_FILE: "KEY_DUPLICATE_IN_FILE",
  BRAND_MISSING: "BRAND_MISSING",
  STATUS_UNKNOWN: "STATUS_UNKNOWN",
  NOT_PURCHASABLE: "NOT_PURCHASABLE",
  BOM_PARENT_MISSING: "BOM_PARENT_MISSING",
  BOM_COMPONENT_MISSING: "BOM_COMPONENT_MISSING",
  BOM_QUANTITY_INVALID: "BOM_QUANTITY_INVALID",
  BOM_SELF_REFERENCE: "BOM_SELF_REFERENCE",
  MAPPING_REQUIRED_FIELD_MISSING: "MAPPING_REQUIRED_FIELD_MISSING",
  MAPPING_CONFLICT: "MAPPING_CONFLICT",
  UNMAPPED_COLUMN_HAS_DATA: "UNMAPPED_COLUMN_HAS_DATA",
} as const;
export type ImportFindingCode = (typeof IMPORT_FINDING_CODES)[keyof typeof IMPORT_FINDING_CODES];

export const ImportFindingSchema = z.object({
  code: z.string(),
  severity: ImportSeveritySchema,
  message: z.string(),
  /** Target field key the finding is about, when it is about one field. */
  field: z.string().nullable(),
  /** Source column the value came from, when known. */
  columnIndex: z.number().int().nonnegative().nullable(),
  /** The offending value, verbatim. Never a corrected version of it. */
  value: z.string(),
  /** Other rows involved, for duplicate findings. */
  relatedRows: z.array(z.number().int().positive()),
});
export type ImportFinding = z.infer<typeof ImportFindingSchema>;

export const ROW_CLASSIFICATIONS = ["create", "update", "unchanged", "skip"] as const;
export const RowClassificationSchema = z.enum(ROW_CLASSIFICATIONS);
export type RowClassification = (typeof ROW_CLASSIFICATIONS)[number];

/**
 * What the row appears to be. `non_sellable` is the "do not assume every row is
 * a product" case from spec §5: it is imported and marked, never dropped.
 */
export const ROW_RECORD_TYPES = [
  "product",
  "non_sellable",
  "kit_parent",
  "bom_line",
  "unknown",
] as const;
export const RowRecordTypeSchema = z.enum(ROW_RECORD_TYPES);
export type RowRecordType = (typeof ROW_RECORD_TYPES)[number];

export const MATCH_KINDS = ["gtin", "brandSku", "none"] as const;
export const MatchKindSchema = z.enum(MATCH_KINDS);
export type MatchKind = (typeof MATCH_KINDS)[number];

export const RowMatchSchema = z.object({
  kind: MatchKindSchema,
  /** Canonical key used for matching. For GTINs this is the 14-digit form. */
  key: z.string(),
  /** Existing product id when the key resolved to one, else null. */
  existingId: z.string().nullable(),
});
export type RowMatch = z.infer<typeof RowMatchSchema>;

export const MappedIdentifierSchema = z.object({
  /** gtin14 | gtin13 | gtin12 | gtin8 | sku | gs1CompanyPrefix */
  kind: z.string(),
  /** Verbatim source value. */
  value: z.string(),
  /** 14-digit right-aligned form for GTIN kinds; "" otherwise. */
  canonical: z.string(),
  isPrimary: z.boolean(),
  valid: z.boolean(),
  validationNote: z.string(),
});
export type MappedIdentifier = z.infer<typeof MappedIdentifierSchema>;

export const MappedBomLineSchema = z.object({
  parentPartNumber: z.string(),
  bomName: z.string(),
  revision: z.string(),
  position: z.number().int().nonnegative(),
  quantity: z.string(),
  unitOfMeasure: z.string(),
  name: z.string(),
  partNumber: z.string(),
  description: z.string(),
});
export type MappedBomLine = z.infer<typeof MappedBomLineSchema>;

export const PreviewRowSchema = z.object({
  rowNumber: z.number().int().positive(),
  classification: RowClassificationSchema,
  recordType: RowRecordTypeSchema,
  match: RowMatchSchema,
  /** Scalar product/brand fields, keyed by target field key. Blank = absent. */
  fields: z.record(z.string(), z.string()),
  /** Free-form columns routed to `products.custom`, keyed by source header. */
  custom: z.record(z.string(), z.string()),
  identifiers: z.array(MappedIdentifierSchema),
  alternates: z.array(z.string()),
  fitments: z.array(z.string()),
  warnings: z.array(z.string()),
  bom: MappedBomLineSchema.nullable(),
  /** Target field keys whose value differs from the matched existing record. */
  changedFields: z.array(z.string()),
  findings: z.array(ImportFindingSchema),
  /** Provenance: the whole source row, verbatim (spec §5.11). */
  source: SourceRowSchema,
});
export type PreviewRow = z.infer<typeof PreviewRowSchema>;

export const DuplicateGroupSchema = z.object({
  value: z.string(),
  rowNumbers: z.array(z.number().int().positive()),
});
export type DuplicateGroup = z.infer<typeof DuplicateGroupSchema>;

export const BomParentSummarySchema = z.object({
  partNumber: z.string(),
  itemCount: z.number().int().nonnegative(),
  rowNumbers: z.array(z.number().int().positive()),
  /** True when the parent exists in this sheet or in the existing products. */
  resolved: z.boolean(),
});
export type BomParentSummary = z.infer<typeof BomParentSummarySchema>;

export const PreviewSummarySchema = z.object({
  totalRows: z.number().int().nonnegative(),
  create: z.number().int().nonnegative(),
  update: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  skip: z.number().int().nonnegative(),
  errorRows: z.number().int().nonnegative(),
  warningRows: z.number().int().nonnegative(),
  nonSellableRows: z.number().int().nonnegative(),
  bomLineRows: z.number().int().nonnegative(),
  rowsWithGtin: z.number().int().nonnegative(),
  rowsWithoutGtin: z.number().int().nonnegative(),
  validGtins: z.number().int().nonnegative(),
  invalidGtins: z.number().int().nonnegative(),
  rowsWithSku: z.number().int().nonnegative(),
  /** Rows whose GTIN already appeared earlier in this file. */
  duplicateGtinRows: z.number().int().nonnegative(),
  /** Rows whose SKU already appeared earlier in this file, under any brand. */
  duplicateSkuRows: z.number().int().nonnegative(),
  /** Distinct SKU values that occur on more than one row. */
  duplicateSkuValues: z.number().int().nonnegative(),
  /** Rows whose brand+SKU pair already appeared earlier — the scoped warning. */
  duplicateSkuInBrandRows: z.number().int().nonnegative(),
  brandCounts: z.record(z.string(), z.number()),
  statusCounts: z.record(z.string(), z.number()),
  findingCounts: z.record(z.string(), z.number()),
});
export type PreviewSummary = z.infer<typeof PreviewSummarySchema>;

export const ImportPreviewSchema = z.object({
  orgId: z.string(),
  sheetName: z.string(),
  profileId: z.string(),
  mapping: SheetMappingSchema,
  rows: z.array(PreviewRowSchema),
  summary: PreviewSummarySchema,
  duplicateGtins: z.array(DuplicateGroupSchema),
  /** brand + SKU groups that occur on more than one row. */
  duplicatePartNumbersInBrand: z.array(DuplicateGroupSchema),
  /** SKU values shared across two or more brands — legitimate, reported anyway. */
  crossBrandPartNumbers: z.array(DuplicateGroupSchema),
  bomParents: z.array(BomParentSummarySchema),
  /** Mapping-level problems that apply to every row. */
  findings: z.array(ImportFindingSchema),
  /** False when a blocking error means the plan must not be committed as-is. */
  committable: z.boolean(),
});
export type ImportPreview = z.infer<typeof ImportPreviewSchema>;

/**
 * A product already in the database, reduced to what matching and change
 * detection need. The caller loads these; preview.ts never touches the DB.
 */
export const ExistingProductSchema = z.object({
  id: z.string(),
  brandName: z.string(),
  partNumber: z.string(),
  /** Every GTIN identifier on the product, in whatever form it is stored. */
  gtins: z.array(z.string()),
  /** Current values keyed by target field key, for change detection. */
  fields: z.record(z.string(), z.string()),
});
export type ExistingProduct = z.infer<typeof ExistingProductSchema>;

/* ------------------------------------------------------------------- plan */

export const IMPORT_OPERATION_KINDS = [
  "upsertProduct",
  "upsertIdentifier",
  "upsertAlternate",
  "upsertBom",
  "upsertBomItem",
] as const;
export type ImportOperationKind = (typeof IMPORT_OPERATION_KINDS)[number];

/**
 * `ref` is a plan-local handle for a product. The applier creates or updates the
 * product for an `upsertProduct` op and remembers the resulting id under `ref`;
 * every later op names the product only through that handle, so the plan itself
 * stays free of database ids it cannot know.
 */
export const UpsertProductOpSchema = z.object({
  op: z.literal("upsertProduct"),
  ref: z.string(),
  rowNumber: z.number().int().positive(),
  /** create | update — never "unchanged": those rows produce no operations. */
  mode: z.enum(["create", "update"]),
  existingId: z.string().nullable(),
  match: RowMatchSchema,
  recordType: RowRecordTypeSchema,
  brandName: z.string(),
  /** Only the fields the mapping actually supplied a non-blank value for. */
  values: z.record(z.string(), z.string()),
  custom: z.record(z.string(), z.string()),
  /** Provenance, retained verbatim on the product row (spec §5.11). */
  sourceRow: z.record(z.string(), z.string()),
});
export type UpsertProductOp = z.infer<typeof UpsertProductOpSchema>;

export const UpsertIdentifierOpSchema = z.object({
  op: z.literal("upsertIdentifier"),
  ref: z.string(),
  rowNumber: z.number().int().positive(),
  kind: z.string(),
  value: z.string(),
  canonical: z.string(),
  isPrimary: z.boolean(),
  valid: z.boolean(),
  validationNote: z.string(),
});
export type UpsertIdentifierOp = z.infer<typeof UpsertIdentifierOpSchema>;

export const UpsertAlternateOpSchema = z.object({
  op: z.literal("upsertAlternate"),
  ref: z.string(),
  rowNumber: z.number().int().positive(),
  value: z.string(),
  relation: z.string(),
  position: z.number().int().nonnegative(),
});
export type UpsertAlternateOp = z.infer<typeof UpsertAlternateOpSchema>;

export const UpsertBomOpSchema = z.object({
  op: z.literal("upsertBom"),
  /** Handle for the BOM itself, referenced by its items. */
  bomRef: z.string(),
  /** Handle of the parent product, when this import also creates it. */
  ref: z.string().nullable(),
  /** Parent lookup key for the applier when `ref` is null. */
  parentPartNumber: z.string(),
  parentBrandName: z.string(),
  name: z.string(),
  revision: z.string(),
  rowNumbers: z.array(z.number().int().positive()),
});
export type UpsertBomOp = z.infer<typeof UpsertBomOpSchema>;

export const UpsertBomItemOpSchema = z.object({
  op: z.literal("upsertBomItem"),
  bomRef: z.string(),
  rowNumber: z.number().int().positive(),
  position: z.number().int().nonnegative(),
  quantity: z.string(),
  unitOfMeasure: z.string(),
  name: z.string(),
  partNumber: z.string(),
  description: z.string(),
  /** Handle of the component's own product row, when the import creates it. */
  componentRef: z.string().nullable(),
});
export type UpsertBomItemOp = z.infer<typeof UpsertBomItemOpSchema>;

export const ImportOperationSchema = z.discriminatedUnion("op", [
  UpsertProductOpSchema,
  UpsertIdentifierOpSchema,
  UpsertAlternateOpSchema,
  UpsertBomOpSchema,
  UpsertBomItemOpSchema,
]);
export type ImportOperation = z.infer<typeof ImportOperationSchema>;

export const ImportPlanSchema = z.object({
  importId: z.string(),
  orgId: z.string(),
  sheetName: z.string(),
  profileId: z.string(),
  /** Brands referenced by the plan, in first-seen order, for pre-creation. */
  brands: z.array(z.string()),
  /** Apply in array order: products, identifiers, alternates, BOMs, BOM items. */
  operations: z.array(ImportOperationSchema),
  counts: z.object({
    upsertProduct: z.number().int().nonnegative(),
    upsertIdentifier: z.number().int().nonnegative(),
    upsertAlternate: z.number().int().nonnegative(),
    upsertBom: z.number().int().nonnegative(),
    upsertBomItem: z.number().int().nonnegative(),
    create: z.number().int().nonnegative(),
    update: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
  /** Rows the plan deliberately leaves out, with the reason. */
  skipped: z.array(
    z.object({
      rowNumber: z.number().int().positive(),
      reason: z.string(),
      recordType: RowRecordTypeSchema,
    }),
  ),
  blocked: z.boolean(),
  blockingFindings: z.array(ImportFindingSchema),
});
export type ImportPlan = z.infer<typeof ImportPlanSchema>;
