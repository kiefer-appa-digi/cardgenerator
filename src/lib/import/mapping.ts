import type {
  ColumnMapping,
  MappingConflict,
  ProfileMatch,
  SheetKind,
  SheetMapping,
  TargetEntity,
  TargetField,
} from "./types";

/**
 * MAPPING MODEL — spec §5.3/§5.4.
 *
 * Two independent layers, on purpose:
 *
 *  1. `TARGET_FIELDS` is the single list of things a column can be pointed at.
 *     The mapping UI renders exactly this array; nothing else defines targets.
 *  2. `SOURCE_PROFILES` are adapters. A profile is a named header rule set for
 *     one shape of workbook. Adding support for a new supplier sheet means
 *     adding a profile, not editing the engine (spec §5, "create adapters
 *     rather than hard-coding").
 *
 * When no profile matches, header scoring against the field aliases still runs,
 * so an unknown sheet degrades to a reasonable guess instead of nothing.
 */

/* ------------------------------------------------------------ normalising */

/** Lowercase, punctuation to single spaces. "GTIN-12 (U.P.C.)" -> "gtin 12 u p c". */
export function normalizeHeader(header: string): string {
  return header
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Letters and digits only. "GTIN-12 (U.P.C.)" -> "gtin12upc". */
export function compactHeader(header: string): string {
  return header.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function tokens(normalized: string): string[] {
  return normalized.length === 0 ? [] : normalized.split(" ");
}

/* ----------------------------------------------------------- target fields */

type TargetFieldDef = {
  readonly key: string;
  readonly label: string;
  readonly group: string;
  readonly entity: TargetEntity;
  readonly required: boolean;
  readonly multiple: boolean;
  readonly splitOn: readonly string[];
  readonly description: string;
  readonly example: string;
  readonly aliases: readonly string[];
};

const LIST_SPLITTERS = [",", ";", "|", "\n"] as const;

/**
 * The one target-field list. Order is display order in the mapping UI.
 *
 * `identifier.sku` deliberately has a narrow alias set: a plain "SKU" column
 * belongs on `product.partNumber`, and the planner mirrors the part number into
 * an `sku` identifier by itself. The target still exists for sheets that carry a
 * separate SKU column alongside a different selling part number.
 */
export const TARGET_FIELDS = [
  {
    key: "product.partNumber",
    label: "Part number",
    group: "Identity",
    entity: "product",
    required: true,
    multiple: false,
    splitOn: [],
    description: "Selling part number. Unique per organisation and brand, not globally.",
    example: "11-500",
    aliases: [
      "part number",
      "part no",
      "part num",
      "part",
      "sku",
      "item number",
      "item no",
      "stock number",
      "stock code",
      "mfg part number",
      "manufacturer part number",
      "selling part number",
      "our part number",
    ],
  },
  {
    key: "product.productName",
    label: "Product name",
    group: "Identity",
    entity: "product",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Marketing product name.",
    example: "Bearing Kit",
    aliases: ["product name", "name", "title", "marketing name", "product title"],
  },
  {
    key: "product.description",
    label: "Description",
    group: "Identity",
    entity: "product",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Full product description as registered with GS1.",
    example: "GENUINE AXLETEK HOLD-DOWN KIT ELECTRIC BRAKES",
    aliases: [
      "description",
      "product description",
      "item description",
      "long description",
      "full description",
      "desc",
    ],
  },
  {
    key: "product.descriptionShort",
    label: "Short description",
    group: "Identity",
    entity: "product",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Condensed description for tight layouts.",
    example: "3.5K Bearing Kit",
    aliases: [
      "product description short",
      "short description",
      "description short",
      "desc short",
      "short desc",
    ],
  },
  {
    key: "product.labelDescription",
    label: "Label description",
    group: "Identity",
    entity: "product",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Description approved for on-pack use.",
    example: "BEARING KIT 3.5K",
    aliases: ["label description", "label copy", "on pack description", "package description"],
  },
  {
    key: "product.subtitle",
    label: "Subtitle / sub-brand",
    group: "Identity",
    entity: "product",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Specification line or sub-brand shown under the title.",
    example: "L44610 / L44649",
    aliases: ["sub brand name", "sub brand", "subbrand", "subtitle", "spec line", "sub title"],
  },
  {
    key: "product.status",
    label: "Status",
    group: "Identity",
    entity: "product",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Lifecycle status: In Use, PreMarket, Draft, Archived.",
    example: "In Use",
    aliases: ["status", "status label", "product status", "lifecycle status", "item status"],
  },
  {
    key: "product.packagingLevel",
    label: "Packaging level",
    group: "Identity",
    entity: "product",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Each, Case, Pallet.",
    example: "Each",
    aliases: ["packaging level", "package level", "pack level", "packaging type level"],
  },
  {
    key: "product.netContentCount",
    label: "Net content count",
    group: "Identity",
    entity: "product",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Numeric part of the net content statement.",
    example: "2",
    aliases: ["net content 1 count", "net content count", "net content"],
  },
  {
    key: "product.netContentUom",
    label: "Net content unit",
    group: "Identity",
    entity: "product",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Unit part of the net content statement.",
    example: "EA",
    aliases: ["net content 1 unit of measure", "net content unit of measure", "net content uom"],
  },
  {
    key: "product.isPurchasable",
    label: "Is purchasable",
    group: "Identity",
    entity: "product",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Y/N. An N row is kept and flagged, never dropped.",
    example: "Y",
    aliases: ["is purchasable", "purchasable", "orderable", "is orderable"],
  },
  {
    key: "product.isVariable",
    label: "Is variable measure",
    group: "Identity",
    entity: "product",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Y/N variable-measure trade item flag.",
    example: "N",
    aliases: ["is variable", "variable measure", "is variable measure", "variable weight"],
  },
  {
    key: "product.targetMarkets",
    label: "Target markets",
    group: "Compliance",
    entity: "product",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Country codes the item is published for.",
    example: "US",
    aliases: ["target markets", "target market", "markets", "market"],
  },
  {
    key: "product.gpcBrick",
    label: "GPC brick",
    group: "Compliance",
    entity: "product",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Global Product Classification brick code and name.",
    example: "99999999 - Temporary Classification",
    aliases: ["gpc brick", "gpc", "global product classification", "gpc code"],
  },
  {
    key: "product.countryOfOrigin",
    label: "Country of origin",
    group: "Compliance",
    entity: "product",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Country-of-origin statement printed on the card.",
    example: "Made in China",
    aliases: ["country of origin", "coo", "origin", "made in", "country"],
  },
  {
    key: "product.fitment",
    label: "Fits or replaces",
    group: "Cross reference",
    entity: "product",
    required: false,
    multiple: true,
    splitOn: [...LIST_SPLITTERS],
    description: "Fitment and replacement statements. One cell may hold a list.",
    example: "Dexter 3.5K axles",
    aliases: ["fits", "fitment", "fits or replaces", "application", "replaces", "vehicle fitment"],
  },
  {
    key: "product.warning",
    label: "Warning",
    group: "Compliance",
    entity: "product",
    required: false,
    multiple: true,
    splitOn: [...LIST_SPLITTERS],
    description: "Regulatory warning text.",
    example: "WARNING: Cancer and reproductive harm",
    aliases: ["warning", "warnings", "prop 65", "proposition 65", "safety warning"],
  },
  {
    key: "product.defaultPresetCode",
    label: "Card preset / package",
    group: "Packaging",
    entity: "product",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Card preset or clamshell code this item normally ships in.",
    example: "409TF",
    aliases: [
      "card preset",
      "preset",
      "card type",
      "clamshell",
      "clam shell",
      "package type",
      "packaging code",
      "card code",
    ],
  },
  {
    key: "product.lastModifiedSource",
    label: "Source last modified",
    group: "Provenance",
    entity: "product",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Last-modified stamp as reported by the source system.",
    example: "2026-08-26",
    aliases: ["last modified date", "last modified", "modified date", "last updated", "updated"],
  },
  {
    key: "product.custom",
    label: "Keep as custom field",
    group: "Provenance",
    entity: "product",
    required: false,
    multiple: true,
    splitOn: [],
    description:
      "Column has no first-class home but is worth keeping. Stored on the product under its source header.",
    example: "Gross Weight",
    aliases: [],
  },
  {
    key: "brand.name",
    label: "Brand name",
    group: "Brand",
    entity: "brand",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Brand the part is sold under. Part numbers are scoped to it.",
    example: "Axle Teknology",
    aliases: ["brand name", "brand", "brand 1", "marque", "manufacturer brand"],
  },
  {
    key: "identifier.gtin14",
    label: "GTIN-14",
    group: "Identifiers",
    entity: "identifier",
    required: true,
    multiple: false,
    splitOn: [],
    description: "14-digit GTIN. Primary matching key for re-import.",
    example: "00810797030001",
    aliases: ["gtin", "gtin 14", "gtin14", "global trade item number", "trade item number"],
  },
  {
    key: "identifier.gtin13",
    label: "GTIN-13 (EAN)",
    group: "Identifiers",
    entity: "identifier",
    required: false,
    multiple: false,
    splitOn: [],
    description: "13-digit EAN.",
    example: "0810797030001",
    aliases: ["gtin 13 ean", "gtin 13", "gtin13", "ean", "ean 13", "ean13"],
  },
  {
    key: "identifier.gtin12",
    label: "GTIN-12 (U.P.C.)",
    group: "Identifiers",
    entity: "identifier",
    required: true,
    multiple: false,
    splitOn: [],
    description: "12-digit U.P.C. Drives UPC-A barcodes.",
    example: "810797030001",
    aliases: ["gtin 12 u p c", "gtin 12", "gtin12", "upc", "u p c", "upc a", "upc code", "upc 12"],
  },
  {
    key: "identifier.gtin8",
    label: "GTIN-8",
    group: "Identifiers",
    entity: "identifier",
    required: false,
    multiple: false,
    splitOn: [],
    description: "8-digit GTIN.",
    example: "80797031",
    aliases: ["gtin 8", "gtin8", "ean 8", "ean8"],
  },
  {
    key: "identifier.sku",
    label: "SKU identifier",
    group: "Identifiers",
    entity: "identifier",
    required: false,
    multiple: false,
    splitOn: [],
    description:
      "Separate SKU identifier. Only needed when the sheet carries a SKU distinct from the selling part number.",
    example: "11-500",
    aliases: ["sku identifier", "stock keeping unit"],
  },
  {
    key: "identifier.gs1CompanyPrefix",
    label: "GS1 company prefix",
    group: "Identifiers",
    entity: "identifier",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Licensed GS1 company prefix.",
    example: "081079703",
    aliases: ["gs1 company prefix", "company prefix", "gs1 prefix", "prefix"],
  },
  {
    key: "alternate.partNumber",
    label: "Alternate part number",
    group: "Cross reference",
    entity: "alternate",
    required: false,
    multiple: true,
    splitOn: [...LIST_SPLITTERS],
    description: "Competitor, superseded or interchange numbers. One cell may hold a list.",
    example: "L44610, L44649",
    aliases: [
      "alternate part number",
      "alternate part numbers",
      "alt part number",
      "cross reference",
      "cross ref",
      "competitor part number",
      "superseded part number",
      "interchange",
      "oem number",
      "oem part number",
    ],
  },
  {
    key: "bom.parentPartNumber",
    label: "BOM parent part number",
    group: "Pack contents",
    entity: "bom",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Part number of the kit this line belongs to.",
    example: "11-500",
    aliases: [
      "parent part number",
      "parent",
      "parent sku",
      "parent item",
      "assembly part number",
      "assembly",
      "kit part number",
      "kit number",
      "bom parent",
    ],
  },
  {
    key: "bom.name",
    label: "BOM name",
    group: "Pack contents",
    entity: "bom",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Name of the bill of materials, e.g. Pack contents.",
    example: "Pack contents",
    aliases: ["bom name", "bill of materials name", "kit name"],
  },
  {
    key: "bom.revision",
    label: "BOM revision",
    group: "Pack contents",
    entity: "bom",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Revision label of the bill of materials.",
    example: "Rev B",
    aliases: ["bom revision", "bom rev", "revision", "rev"],
  },
  {
    key: "bomItem.partNumber",
    label: "Component part number",
    group: "Pack contents",
    entity: "bomItem",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Part number of the component on this BOM line.",
    example: "L44643",
    aliases: [
      "component part number",
      "component",
      "component sku",
      "component number",
      "child part number",
      "child part",
      "sub part number",
    ],
  },
  {
    key: "bomItem.name",
    label: "Component name",
    group: "Pack contents",
    entity: "bomItem",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Short component name for the pack-contents block.",
    example: "Inner Bearing",
    aliases: ["component name", "part name", "component title"],
  },
  {
    key: "bomItem.description",
    label: "Component description",
    group: "Pack contents",
    entity: "bomItem",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Longer component description.",
    example: "Tapered roller bearing",
    aliases: ["component description", "line description", "component desc"],
  },
  {
    key: "bomItem.quantity",
    label: "Component quantity",
    group: "Pack contents",
    entity: "bomItem",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Quantity per pack. Kept as text; a non-numeric value is flagged.",
    example: "2",
    aliases: ["qty", "quantity", "qty per", "quantity per", "component qty", "qty per assembly"],
  },
  {
    key: "bomItem.unitOfMeasure",
    label: "Component unit",
    group: "Pack contents",
    entity: "bomItem",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Unit of measure for the component quantity.",
    example: "EA",
    aliases: ["uom", "unit of measure", "component uom", "u o m"],
  },
  {
    key: "bomItem.position",
    label: "Component line number",
    group: "Pack contents",
    entity: "bomItem",
    required: false,
    multiple: false,
    splitOn: [],
    description: "Explicit ordering of BOM lines. Defaults to sheet order.",
    example: "1",
    aliases: ["line", "line no", "line number", "seq", "sequence", "position", "bom line"],
  },
  {
    key: "meta.ignore",
    label: "Do not import",
    group: "Ignored",
    entity: "meta",
    required: false,
    multiple: true,
    splitOn: [],
    description: "Recognised column deliberately left out. The value stays in the source row.",
    example: "",
    aliases: [],
  },
] as const satisfies readonly TargetFieldDef[];

export type TargetFieldKey = (typeof TARGET_FIELDS)[number]["key"];

const TARGET_FIELD_BY_KEY = new Map<string, TargetFieldDef>(
  TARGET_FIELDS.map((f) => [f.key, f]),
);

export function getTargetField(key: string): TargetFieldDef | undefined {
  return TARGET_FIELD_BY_KEY.get(key);
}

export function isTargetFieldKey(key: string): key is TargetFieldKey {
  return TARGET_FIELD_BY_KEY.has(key);
}

/** Mutable copy for callers that need the plain `TargetField` shape. */
export function targetFieldList(): TargetField[] {
  return TARGET_FIELDS.map((f) => ({
    key: f.key,
    label: f.label,
    group: f.group,
    entity: f.entity,
    required: f.required,
    multiple: f.multiple,
    splitOn: [...f.splitOn],
    description: f.description,
    example: f.example,
    aliases: [...f.aliases],
  }));
}

export const TARGET_FIELD_GROUPS: string[] = Array.from(
  new Set(TARGET_FIELDS.map((f) => f.group)),
);

/* --------------------------------------------------------------- profiles */

export type SourceProfile = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly kind: SheetKind;
  /** Normalised substrings that hint at this profile from the sheet name alone. */
  readonly sheetNamePatterns: readonly string[];
  /** Headers whose presence identifies the profile. */
  readonly signatureHeaders: readonly string[];
  /** Exact header rules. Anything not listed falls through to alias scoring. */
  readonly columns: readonly { readonly header: string; readonly field: TargetFieldKey }[];
  /** Each group needs at least one mapped field for the profile to be usable. */
  readonly requiredAnyOf: readonly (readonly TargetFieldKey[])[];
  /** The profile used when nothing else matches. */
  readonly fallback: boolean;
};

/**
 * GS1 US Data Hub "Export All Products". Column set as shipped by Data Hub in
 * 2026: 41 columns, one row per trade item, GTIN-14 left-padded with zeros.
 *
 * Columns with no first-class home (dimensions, weights, second-language brand
 * and description, image URLs) are routed to `product.custom` rather than
 * dropped, so nothing in the export is lost on the way in.
 */
const GS1_DATAHUB_PROFILE: SourceProfile = {
  id: "gs1-us-datahub-export",
  label: "GS1 US Data Hub — Export All Products",
  description:
    "One row per trade item as exported by GS1 US Data Hub. GTIN-14 is the matching key; SKU is the selling part number and is scoped to the brand.",
  kind: "products",
  sheetNamePatterns: ["export all products", "exportallproducts", "gs1"],
  signatureHeaders: [
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
  ],
  columns: [
    { header: "GS1 Company Prefix", field: "identifier.gs1CompanyPrefix" },
    { header: "GTIN", field: "identifier.gtin14" },
    { header: "GTIN-8", field: "identifier.gtin8" },
    { header: "GTIN-12 (U.P.C.)", field: "identifier.gtin12" },
    { header: "GTIN-13 (EAN)", field: "identifier.gtin13" },
    { header: "Brand Name", field: "brand.name" },
    { header: "Brand 1 Language", field: "product.custom" },
    { header: "Product Description", field: "product.description" },
    { header: "Desc 1 Language", field: "product.custom" },
    { header: "Product Industry", field: "product.custom" },
    { header: "Packaging Level", field: "product.packagingLevel" },
    { header: "Is Variable", field: "product.isVariable" },
    { header: "Is Purchasable", field: "product.isPurchasable" },
    { header: "Status Label", field: "product.status" },
    { header: "Height", field: "product.custom" },
    { header: "Width", field: "product.custom" },
    { header: "Depth", field: "product.custom" },
    { header: "Dimension Measure", field: "product.custom" },
    { header: "Gross Weight", field: "product.custom" },
    { header: "Net Weight", field: "product.custom" },
    { header: "Weight Measure", field: "product.custom" },
    { header: "SKU", field: "product.partNumber" },
    { header: "Sub-brand Name", field: "product.subtitle" },
    { header: "Product Description-Short", field: "product.descriptionShort" },
    { header: "Label Description", field: "product.labelDescription" },
    { header: "Net Content 1 Count", field: "product.netContentCount" },
    { header: "Net Content 1 Unit of Measure", field: "product.netContentUom" },
    { header: "Net Content 2 Count", field: "product.custom" },
    { header: "Net Content 2 Unit of Measure", field: "product.custom" },
    { header: "Net Content 3 Count", field: "product.custom" },
    { header: "Net Content 3 Unit of Measure", field: "product.custom" },
    { header: "Brand Name 2", field: "product.custom" },
    { header: "Brand 2 Language", field: "product.custom" },
    { header: "Description 2", field: "product.custom" },
    { header: "Desc 2 Language", field: "product.custom" },
    { header: "GPC Brick", field: "product.gpcBrick" },
    { header: "GPC Attribute : GPC Attribute Value", field: "product.custom" },
    { header: "Image URL", field: "product.custom" },
    { header: "Image URL Validation", field: "product.custom" },
    { header: "Target Markets", field: "product.targetMarkets" },
    { header: "Last Modified Date", field: "product.lastModifiedSource" },
  ],
  requiredAnyOf: [["identifier.gtin14", "identifier.gtin12", "product.partNumber"]],
  fallback: false,
};

/**
 * Everything else: an in-house item master, a kit/BOM sheet, a clamshell or
 * inventory list. No fixed column set — it relies entirely on alias scoring, so
 * it works on sheets nobody has seen before.
 */
const GENERIC_PROFILE: SourceProfile = {
  id: "generic-product-bom",
  label: "Generic product / BOM sheet",
  description:
    "Header-driven fallback for item masters and kit/BOM sheets. Columns are matched by name against the target field aliases.",
  kind: "products",
  sheetNamePatterns: [
    "item",
    "items",
    "product",
    "products",
    "master data",
    "bom",
    "kit",
    "clam shell",
    "clamshell",
    "inventory",
    "packaging",
  ],
  signatureHeaders: [
    "Part Number",
    "Description",
    "UPC",
    "Brand",
    "Quantity",
    "Parent Part Number",
    "Component Part Number",
  ],
  columns: [],
  requiredAnyOf: [
    ["product.partNumber", "identifier.gtin14", "identifier.gtin12", "bomItem.partNumber"],
  ],
  fallback: true,
};

export const SOURCE_PROFILES: readonly SourceProfile[] = [GS1_DATAHUB_PROFILE, GENERIC_PROFILE];

export const DEFAULT_PROFILE_ID = GENERIC_PROFILE.id;

export function getProfile(id: string): SourceProfile | undefined {
  return SOURCE_PROFILES.find((p) => p.id === id);
}

/* ---------------------------------------------------------------- scoring */

type AliasIndex = { compact: string; normalized: string; tokenSet: Set<string> };

const ALIAS_INDEX: Map<string, AliasIndex[]> = new Map(
  TARGET_FIELDS.map((f) => [
    f.key,
    f.aliases.map((a) => {
      const normalized = normalizeHeader(a);
      return { compact: compactHeader(a), normalized, tokenSet: new Set(tokens(normalized)) };
    }),
  ]),
);

const PROFILE_COLUMN_INDEX: Map<string, Map<string, TargetFieldKey>> = new Map(
  SOURCE_PROFILES.map((p) => [
    p.id,
    new Map(p.columns.map((c) => [compactHeader(c.header), c.field])),
  ]),
);

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * How well a source header names a target field, 0..100.
 *
 * The bands are deliberately coarse: an exact match on a written alias is 100,
 * a whole-alias prefix/suffix ("Brand Name 2" against "brand name") is 80, and
 * anything below that is token overlap capped at 70 so it can never outrank a
 * real match.
 */
export function scoreHeaderAgainstField(header: string, fieldKey: string): number {
  const aliases = ALIAS_INDEX.get(fieldKey);
  if (aliases === undefined || aliases.length === 0) return 0;

  const hc = compactHeader(header);
  if (hc.length === 0) return 0;
  const hn = normalizeHeader(header);
  const ht = new Set(tokens(hn));

  let best = 0;
  for (const alias of aliases) {
    if (alias.compact.length === 0) continue;
    if (hc === alias.compact) return 100;

    let score = 0;
    if (ht.size === alias.tokenSet.size && jaccard(ht, alias.tokenSet) === 1) {
      score = 95;
    } else if (hn.startsWith(`${alias.normalized} `) || hn.endsWith(` ${alias.normalized}`)) {
      score = 80;
    } else if (alias.normalized.length >= 4 && hn.includes(alias.normalized)) {
      score = 72;
    } else if (hn.length >= 4 && alias.normalized.includes(hn)) {
      score = 68;
    } else {
      const j = jaccard(ht, alias.tokenSet);
      if (j > 0) score = Math.round(30 + 40 * j);
    }
    if (score > best) best = score;
  }
  return best;
}

/* ------------------------------------------------------- profile detection */

export type DetectProfileOptions = {
  sheetName?: string;
};

/** Rank every profile against a header row. Highest score first. */
export function detectProfile(
  headers: readonly string[],
  options: DetectProfileOptions = {},
): ProfileMatch[] {
  const present = new Set(headers.map(compactHeader).filter((h) => h.length > 0));
  const sheetName = normalizeHeader(options.sheetName ?? "");

  const matches: ProfileMatch[] = SOURCE_PROFILES.map((profile) => {
    const matchedHeaders: string[] = [];
    const missingHeaders: string[] = [];
    for (const h of profile.signatureHeaders) {
      if (present.has(compactHeader(h))) matchedHeaders.push(h);
      else missingHeaders.push(h);
    }
    const ratio =
      profile.signatureHeaders.length === 0
        ? 0
        : matchedHeaders.length / profile.signatureHeaders.length;

    const nameHit = profile.sheetNamePatterns.some(
      (p) => sheetName.length > 0 && sheetName.includes(normalizeHeader(p)),
    );

    let score = ratio * 75 + (nameHit ? 15 : 0) + (profile.fallback ? 10 : 0);
    if (score > 100) score = 100;

    return {
      profileId: profile.id,
      label: profile.label,
      score: Math.round(score),
      matchedHeaders,
      missingHeaders,
      missingRequired: [] as string[],
    };
  });

  matches.sort((a, b) => b.score - a.score || a.profileId.localeCompare(b.profileId));
  return matches;
}

/* ------------------------------------------------------------ suggestion */

export type SuggestMappingOptions = {
  sheetName?: string;
  headerRowNumber?: number;
  /** Force a profile instead of taking the best-scoring one. */
  profileId?: string;
  /** Minimum score for an alias/fuzzy match to be accepted. Default 55. */
  threshold?: number;
  /** How many runner-up targets to keep per column. Default 3. */
  alternativeCount?: number;
  defaults?: Record<string, string>;
};

const DEFAULT_THRESHOLD = 55;

/**
 * Score every header against every target field and build a full mapping.
 *
 * Single-valued fields are contested: the highest-scoring column wins and the
 * others are recorded with `supersededBy` so the UI can show why a column that
 * "looks like" a UPC ended up unmapped. Nothing is silently discarded.
 */
export function suggestMapping(
  headers: readonly string[],
  options: SuggestMappingOptions = {},
): SheetMapping {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const altCount = options.alternativeCount ?? 3;

  const profileMatches = detectProfile(headers, { sheetName: options.sheetName });
  const chosenId =
    options.profileId !== undefined && getProfile(options.profileId) !== undefined
      ? options.profileId
      : (profileMatches[0]?.profileId ?? DEFAULT_PROFILE_ID);
  const profile = getProfile(chosenId) ?? GENERIC_PROFILE;
  const profileScore = profileMatches.find((m) => m.profileId === profile.id)?.score ?? 0;
  const profileColumns = PROFILE_COLUMN_INDEX.get(profile.id) ?? new Map<string, TargetFieldKey>();

  type Candidate = { field: string; confidence: number; source: ColumnMapping["source"] };

  const columns: ColumnMapping[] = headers.map((header, columnIndex) => {
    const compact = compactHeader(header);
    const profileField = compact.length > 0 ? profileColumns.get(compact) : undefined;

    const scored: Candidate[] = [];
    for (const field of TARGET_FIELDS) {
      const score = scoreHeaderAgainstField(header, field.key);
      if (score >= threshold) {
        scored.push({ field: field.key, confidence: score, source: score === 100 ? "alias" : "fuzzy" });
      }
    }
    scored.sort((a, b) => b.confidence - a.confidence || a.field.localeCompare(b.field));

    const chosen: Candidate | undefined =
      profileField !== undefined
        ? { field: profileField, confidence: 100, source: "profile" }
        : scored[0];

    return {
      columnIndex,
      header,
      field: chosen?.field ?? null,
      confidence: chosen?.confidence ?? 0,
      source: chosen?.source ?? "none",
      supersededBy: null,
      alternatives: scored
        .filter((c) => c.field !== chosen?.field)
        .slice(0, altCount)
        .map((c) => ({ field: c.field, confidence: c.confidence })),
    };
  });

  resolveConflicts(columns);

  return validateMapping({
    sheetName: options.sheetName ?? "",
    headerRowNumber: options.headerRowNumber ?? 1,
    profileId: profile.id,
    profileScore,
    columns,
    mappedFields: [],
    missingRequired: [],
    conflicts: [],
    defaults: { ...(options.defaults ?? {}) },
  });
}

/**
 * Keep the best column per single-valued field. Losers become unmapped but keep
 * a pointer to the winner so the mapping UI can explain the decision.
 */
function resolveConflicts(columns: ColumnMapping[]): void {
  const claim = new Map<string, ColumnMapping>();
  for (const col of columns) {
    if (col.field === null) continue;
    const def = TARGET_FIELD_BY_KEY.get(col.field);
    if (def === undefined || def.multiple) continue;

    const held = claim.get(col.field);
    if (held === undefined) {
      claim.set(col.field, col);
      continue;
    }
    const loser = col.confidence > held.confidence ? held : col;
    const winner = loser === held ? col : held;
    loser.supersededBy = winner.columnIndex;
    // Demote to the best alternative that is still free, else leave unmapped.
    const fallback = loser.alternatives.find((a) => {
      const d = TARGET_FIELD_BY_KEY.get(a.field);
      return d !== undefined && (d.multiple || !claim.has(a.field));
    });
    if (fallback !== undefined) {
      loser.field = fallback.field;
      loser.confidence = fallback.confidence;
      loser.source = "fuzzy";
      const d = TARGET_FIELD_BY_KEY.get(fallback.field);
      if (d !== undefined && !d.multiple) claim.set(fallback.field, loser);
    } else {
      loser.field = null;
      loser.confidence = 0;
      loser.source = "none";
    }
    claim.set(winner.field ?? "", winner);
  }
}

/**
 * Recompute the derived parts of a mapping. Call after the user edits columns by
 * hand — `columns` is the truth, everything else on `SheetMapping` is a view of it.
 */
export function validateMapping(mapping: SheetMapping): SheetMapping {
  const byField = new Map<string, number[]>();
  for (const col of mapping.columns) {
    if (col.field === null) continue;
    const list = byField.get(col.field);
    if (list === undefined) byField.set(col.field, [col.columnIndex]);
    else list.push(col.columnIndex);
  }

  const conflicts: MappingConflict[] = [];
  for (const [field, indexes] of byField) {
    const def = TARGET_FIELD_BY_KEY.get(field);
    if (indexes.length > 1 && def !== undefined && !def.multiple) {
      conflicts.push({ field, columnIndexes: [...indexes] });
    }
  }

  const profile = getProfile(mapping.profileId) ?? GENERIC_PROFILE;
  const satisfied = (key: string): boolean =>
    byField.has(key) || Object.prototype.hasOwnProperty.call(mapping.defaults, key);

  const missingRequired: string[] = [];
  for (const group of profile.requiredAnyOf) {
    if (!group.some(satisfied)) missingRequired.push(group.join(" | "));
  }

  return {
    ...mapping,
    mappedFields: Array.from(byField.keys()).sort(),
    missingRequired,
    conflicts,
  };
}

/** Column indexes feeding a field, in sheet order. */
export function columnsForField(mapping: SheetMapping, field: string): ColumnMapping[] {
  return mapping.columns.filter((c) => c.field === field);
}

/** Split a cell that holds a list, using the target field's own separators. */
export function splitFieldValue(fieldKey: string, value: string): string[] {
  const def = TARGET_FIELD_BY_KEY.get(fieldKey);
  if (def === undefined || def.splitOn.length === 0) {
    const single = value.trim();
    return single.length === 0 ? [] : [single];
  }
  const pattern = new RegExp(
    `[${def.splitOn.map((s) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("")}]`,
  );
  return value
    .split(pattern)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
