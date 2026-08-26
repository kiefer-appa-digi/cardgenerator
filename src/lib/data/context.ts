import { z } from "zod";

/**
 * PRODUCT CONTEXT — the single object every binding resolves against.
 *
 * This is the contract between the product database (spec §4/§5), the editor's
 * data-field browser (§10), the BOM repeat block (§11), the barcode engine (§12)
 * and the PDF writer (§15). Adding a bindable field means adding it here and to
 * FIELD_CATALOG below; nothing else needs to change.
 */

export const BomItemContextSchema = z.object({
  quantity: z.number(),
  quantityText: z.string(),
  name: z.string(),
  partNumber: z.string(),
  description: z.string(),
  position: z.number().int(),
  unitOfMeasure: z.string(),
});
export type BomItemContext = z.infer<typeof BomItemContextSchema>;

export const ProductContextSchema = z.object({
  id: z.string(),
  partNumber: z.string(),
  productName: z.string(),
  description: z.string(),
  descriptionShort: z.string(),
  labelDescription: z.string(),
  subtitle: z.string(),
  countryOfOrigin: z.string(),
  status: z.string(),
  packagingLevel: z.string(),
  netContent: z.string(),

  brand: z.object({
    name: z.string(),
    legalName: z.string(),
    statement: z.string(),
    logoAssetId: z.string().nullable(),
  }),

  identifiers: z.object({
    gtin14: z.string(),
    gtin13: z.string(),
    upc12: z.string(),
    sku: z.string(),
    gs1CompanyPrefix: z.string(),
  }),

  alternatePartNumbers: z.array(z.string()),
  fitments: z.array(z.string()),
  warnings: z.array(z.string()),
  translations: z.record(z.string(), z.record(z.string(), z.string())),

  bom: z.object({
    items: z.array(BomItemContextSchema),
    packIncludes: z.string(),
    itemCount: z.number().int(),
  }),

  /** Free-form key/value pairs carried over from the import source. */
  custom: z.record(z.string(), z.string()),
});
export type ProductContext = z.infer<typeof ProductContextSchema>;

export function emptyProductContext(): ProductContext {
  return {
    id: "",
    partNumber: "",
    productName: "",
    description: "",
    descriptionShort: "",
    labelDescription: "",
    subtitle: "",
    countryOfOrigin: "",
    status: "",
    packagingLevel: "",
    netContent: "",
    brand: { name: "", legalName: "", statement: "", logoAssetId: null },
    identifiers: { gtin14: "", gtin13: "", upc12: "", sku: "", gs1CompanyPrefix: "" },
    alternatePartNumbers: [],
    fitments: [],
    warnings: [],
    translations: {},
    bom: { items: [], packIncludes: "", itemCount: 0 },
    custom: {},
  };
}

export type FieldDef = {
  path: string;
  label: string;
  group: string;
  /** `list` resolves to an array and is joined with the binding's joiner. */
  type: "text" | "list" | "number" | "collection";
  example: string;
  description: string;
};

/**
 * The catalogue that drives the data-field browser and the {token} autocomplete.
 * Every entry must be resolvable by `resolvePath` against a ProductContext.
 */
export const FIELD_CATALOG: FieldDef[] = [
  { path: "partNumber", label: "Part number", group: "Identity", type: "text", example: "11-500", description: "Primary selling part number / SKU." },
  { path: "productName", label: "Product name", group: "Identity", type: "text", example: "Bearing Kit", description: "Marketing product name." },
  { path: "description", label: "Description", group: "Identity", type: "text", example: "GENUINE AXLETEK 3.5K BEARING L44610/L44649", description: "Full GS1 product description." },
  { path: "descriptionShort", label: "Short description", group: "Identity", type: "text", example: "3.5K Bearing Kit", description: "Condensed description for tight layouts." },
  { path: "labelDescription", label: "Label description", group: "Identity", type: "text", example: "BEARING KIT 3.5K", description: "Description approved for on-pack use." },
  { path: "subtitle", label: "Subtitle / spec line", group: "Identity", type: "text", example: "L44610 / L44649", description: "Specification line under the title." },
  { path: "status", label: "Status", group: "Identity", type: "text", example: "In Use", description: "GS1 lifecycle status." },
  { path: "netContent", label: "Net content", group: "Identity", type: "text", example: "2 EA", description: "Net content count and unit." },

  { path: "brand.name", label: "Brand name", group: "Brand", type: "text", example: "Axle Teknology", description: "Brand shown on pack." },
  { path: "brand.legalName", label: "Brand legal name", group: "Brand", type: "text", example: "Axle Teknology, LLC", description: "Legal entity for compliance copy." },
  { path: "brand.statement", label: "Genuine-parts statement", group: "Brand", type: "text", example: "Genuine AxleTek replacement parts.", description: "Brand assurance paragraph." },

  { path: "identifiers.upc12", label: "UPC (GTIN-12)", group: "Identifiers", type: "text", example: "810797030124", description: "12-digit U.P.C. Drives UPC-A barcodes." },
  { path: "identifiers.gtin14", label: "GTIN-14", group: "Identifiers", type: "text", example: "00810797030124", description: "14-digit GTIN as held by GS1." },
  { path: "identifiers.gtin13", label: "GTIN-13 (EAN)", group: "Identifiers", type: "text", example: "0810797030124", description: "13-digit EAN. Drives EAN-13 barcodes." },
  { path: "identifiers.sku", label: "SKU", group: "Identifiers", type: "text", example: "11-812", description: "Internal stock keeping unit." },
  { path: "identifiers.gs1CompanyPrefix", label: "GS1 company prefix", group: "Identifiers", type: "text", example: "081079703", description: "Licensed GS1 company prefix." },

  { path: "alternatePartNumbers", label: "Alternate part numbers", group: "Cross reference", type: "list", example: "L44610, L44649", description: "Competitor / superseded numbers." },
  { path: "fitments", label: "Fits or replaces", group: "Cross reference", type: "list", example: "Dexter 3.5K axles", description: "Fitment and replacement statements." },

  { path: "countryOfOrigin", label: "Country of origin", group: "Compliance", type: "text", example: "Made in China", description: "Country-of-origin statement." },
  { path: "warnings", label: "Warnings", group: "Compliance", type: "list", example: "WARNING: Cancer and reproductive harm — www.P65Warnings.ca.gov", description: "Regulatory warnings." },

  { path: "bom.packIncludes", label: "Pack includes (text)", group: "Pack contents", type: "text", example: "2) Inner Bearing (L44643)", description: "BOM rendered as newline-separated text." },
  { path: "bom.itemCount", label: "Pack item count", group: "Pack contents", type: "number", example: "4", description: "Number of BOM lines." },
  { path: "bom.items", label: "Pack contents (repeating)", group: "Pack contents", type: "collection", example: "—", description: "Repeating collection for the pack-contents block." },
];

export const FIELD_GROUPS = Array.from(new Set(FIELD_CATALOG.map((f) => f.group)));

/** Resolve a dotted path. Arrays and objects come back as-is; caller formats. */
export function resolvePath(ctx: ProductContext, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function isKnownPath(path: string): boolean {
  return FIELD_CATALOG.some((f) => f.path === path);
}
