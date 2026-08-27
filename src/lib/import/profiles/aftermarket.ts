import { z } from "zod";

/**
 * ADAPTER: the "Aftermarket Rev B" workbook.
 *
 * This is a different shape from a flat product export and needs its own reader
 * rather than a column mapping (spec §5: "Create adapters rather than
 * hard-coding the entire application to this one workbook").
 *
 * The BOM sheets are block-structured, not tabular. A block is:
 *
 *   AFTMKT #   Former #        Item #     Parts Included in Kit          GS1 Code       QTY
 *   11-850     K-DL-125-03     11-850                                    810797031398   1     <- kit
 *   12-892     DL-125-03       12-892     2) Grease Seal 1.25" ID (…)                   2     <- component
 *              206TF           206TF      Clam                                          1     <- clamshell
 *                              206LABEL   Label                                         1     <- label
 *                              LABOR75    Labor                                         1     <- labour
 *                                         Box                                           0.25  <- packaging
 *   (blank row ends the block)
 *
 * Three things fall out of that which nothing else in the source materials
 * provides:
 *
 *  1. A real "This Pack Includes" list. The `Parts Included in Kit` cell is
 *     already written the way it prints — "2) Grease Seal 1.25" ID (DL-125-03)"
 *     — which is exactly the format §11 asks for.
 *  2. Which clamshell each kit ships in, from the `Clam` line's item number.
 *     That is the product → card-preset mapping.
 *  3. An honest distinction between a pack content and a cost line. Labour, the
 *     box and the label are on the bill of materials and must NOT be printed on
 *     the card; §5 warns that not every row is a sellable product, and this is
 *     the same problem one level down.
 *
 * Nothing here writes to a database or reads a file. It turns cell values into
 * typed records, and reports what it could not understand instead of guessing.
 */

/* ------------------------------------------------------------------ types */

export const AFTERMARKET_SHEETS = {
  /** Preferred BOM sheet: carries the item number on the kit row as well. */
  bomPrimary: "BOM_AxleTekA",
  /** Older BOM sheet, same block shape, kept as a fallback. */
  bomFallback: "BOM_AxleTek",
  packagingAxleTek: "Private Pkg_AxleTek",
  packagingTowPro: "Private Pkg_TowPro",
  privateLabelTowPro: "Private Label_TowPro",
  masterData: "Master Data",
  gs1: "GS1",
  clamShells: "Clam Shells",
  items: "Items",
  inventory: "Inventory",
} as const;

export const COMPONENT_ROLES = [
  "component",
  "clamshell",
  "label",
  "labor",
  "packaging",
  "unknown",
] as const;
export type ComponentRole = (typeof COMPONENT_ROLES)[number];

/** Roles that are cost lines, not things a customer finds in the pack. */
export const NON_PRINTING_ROLES: ReadonlySet<ComponentRole> = new Set([
  "clamshell",
  "label",
  "labor",
  "packaging",
]);

export const AftermarketComponentSchema = z.object({
  rowNumber: z.number().int().positive(),
  itemNumber: z.string(),
  formerNumber: z.string(),
  /** The cell verbatim, e.g. `2) Grease Seal 1.25" ID (DL-125-03)`. */
  displayLine: z.string(),
  quantityText: z.string(),
  quantity: z.number(),
  /** Parsed out of the display line: the part's name, without the count or code. */
  name: z.string(),
  /** The code in the trailing parentheses, or the item number when there is none. */
  partNumber: z.string(),
  role: z.enum(COMPONENT_ROLES),
  /** Set on a clamshell line: the card preset the kit ships in. */
  presetCode: z.string().nullable(),
});
export type AftermarketComponent = z.infer<typeof AftermarketComponentSchema>;

export const AftermarketKitSchema = z.object({
  rowNumber: z.number().int().positive(),
  partNumber: z.string(),
  formerNumber: z.string(),
  itemNumber: z.string(),
  description: z.string(),
  /** The workbook calls the UPC a "GS1 Code". 12 digits. */
  upc: z.string(),
  quantityText: z.string(),
  components: z.array(AftermarketComponentSchema),
  /** Card preset from the kit's `Clam` line, when it has one. */
  presetCode: z.string().nullable(),
  /** Lines a customer will actually find in the pack. */
  packContents: z.array(AftermarketComponentSchema),
  notes: z.array(z.string()),
});
export type AftermarketKit = z.infer<typeof AftermarketKitSchema>;

export const AftermarketReadSchema = z.object({
  sheetName: z.string(),
  headerRowNumber: z.number().int().nonnegative(),
  kits: z.array(AftermarketKitSchema),
  /** Rows inside a block that could not be classified as kit or component. */
  orphanRows: z.array(z.object({ rowNumber: z.number().int(), reason: z.string() })),
  counts: z.object({
    blocks: z.number().int(),
    kits: z.number().int(),
    kitsWithUpc: z.number().int(),
    kitsWithPreset: z.number().int(),
    components: z.number().int(),
    packContentLines: z.number().int(),
    nonPrintingLines: z.number().int(),
  }),
  presetCounts: z.record(z.string(), z.number()),
});
export type AftermarketRead = z.infer<typeof AftermarketReadSchema>;

/* ------------------------------------------------------------- primitives */

export type Cell = string | number | boolean | Date | object | null | undefined;
export type Grid = readonly (readonly Cell[])[];

export function cellText(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // A hyperlink or rich-text cell arrives as an object; taking String() of it
  // yields "[object Object]", which is worse than an empty cell because it looks
  // like data.
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text.trim();
    if (typeof o.hyperlink === "string") return o.hyperlink.trim();
    if (Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((t) => t.text ?? "").join("").trim();
    }
    if ("result" in o) return cellText(o.result as Cell);
    return "";
  }
  // Excel hands back a float for anything numeric; a UPC must not become
  // 8.10797031398e+11, and a quantity of 2 must not become "2.0".
  if (typeof v === "number") {
    return Number.isInteger(v) ? String(v) : String(v);
  }
  return String(v).replace(/ /g, " ").trim();
}

/** Known clamshell codes. Anything else on a `Clam` line is reported, not assumed. */
export const PRESET_CODES_IN_WORKBOOK = ["409TF", "277TF", "206TF"] as const;

export function presetFromItemNumber(item: string): string | null {
  const m = item.toUpperCase().match(/\b(\d{3}TF)\b/);
  if (!m) return null;
  return (PRESET_CODES_IN_WORKBOOK as readonly string[]).includes(m[1]) ? m[1] : null;
}

/**
 * Classify a BOM line. The display line is the reliable signal: the item-number
 * column is inconsistently filled and occasionally carries a stray barcode.
 */
export function classifyComponent(displayLine: string, itemNumber: string): ComponentRole {
  const d = displayLine.trim().toLowerCase();
  const i = itemNumber.trim().toUpperCase();
  if (d === "clam" || d.startsWith("clam ") || /\d{3}TF$/.test(i)) return "clamshell";
  // "Label", "Label206", "Label 409" — the sheet is inconsistent about whether
  // the clamshell size is appended, and a trailer part is never called "Label".
  if (/^label\b/.test(d) || /^label\d/.test(d) || /LABEL/.test(i)) return "label";
  if (d === "labor" || d === "labour" || /^LABOR/.test(i)) return "labor";
  if (d === "box" || d === "carton" || d === "bag" || d === "poly bag") return "packaging";
  if (!d && !i) return "unknown";
  return "component";
}

/**
 * Split `2) Grease Seal 1.25" ID (DL-125-03)` into its parts.
 *
 * The leading count and the trailing code are both optional, and a line with
 * neither is still a component — it just contributes no part number, which the
 * caller can report rather than inventing one.
 */
export function parseDisplayLine(line: string): {
  quantity: number | null;
  quantityText: string;
  name: string;
  partNumber: string;
} {
  const raw = line.replace(/ /g, " ").trim();
  let rest = raw;
  let quantity: number | null = null;
  let quantityText = "";

  const qty = rest.match(/^\s*(\d+(?:\.\d+)?)\s*[)\].:-]\s*/);
  if (qty) {
    quantityText = qty[1];
    quantity = Number(qty[1]);
    rest = rest.slice(qty[0].length);
  }

  let partNumber = "";
  // Only a trailing parenthesis is a part code; parentheses mid-string are part
  // of the name ("Bearing (inner) and race").
  const code = rest.match(/\(([^()]{1,40})\)\s*$/);
  if (code) {
    partNumber = code[1].trim();
    rest = rest.slice(0, code.index).trim();
  }

  return {
    quantity,
    quantityText,
    name: rest.replace(/[,;:\s]+$/, "").trim(),
    partNumber,
  };
}

/* ----------------------------------------------------------------- header */

const HEADER_TOKENS = ["aftmkt", "parts included", "item #", "gs1 code"];

/** Locate the header row: these sheets carry a title row above it. */
export function findHeaderRow(grid: Grid, maxScan = 12): number {
  for (let i = 0; i < Math.min(maxScan, grid.length); i++) {
    const joined = (grid[i] ?? []).map((c) => cellText(c).toLowerCase()).join(" | ");
    const hits = HEADER_TOKENS.filter((t) => joined.includes(t)).length;
    if (hits >= 2) return i + 1; // 1-based
  }
  return 0;
}

export type ColumnIndex = {
  aftmkt: number;
  former: number;
  item: number;
  parts: number;
  description: number;
  gs1: number;
  qty: number;
};

export function findColumns(headerRow: readonly Cell[]): ColumnIndex | null {
  const find = (...needles: string[]) =>
    headerRow.findIndex((c) => {
      const t = cellText(c).toLowerCase().replace(/\s+/g, " ");
      return needles.some((n) => t.startsWith(n));
    });

  const idx: ColumnIndex = {
    aftmkt: find("aftmkt"),
    former: find("former"),
    item: find("item #", "item#"),
    parts: find("parts included"),
    description: find("description", "desc"),
    gs1: find("gs1 code", "gs1", "upc"),
    qty: find("qty inc", "qty"),
  };
  // The two columns the block structure actually depends on.
  if (idx.parts < 0 || idx.gs1 < 0) return null;
  return idx;
}

/* ------------------------------------------------------------------ read */

const UPC_RE = /^\d{12,14}$/;

export function readAftermarketBom(grid: Grid, sheetName: string): AftermarketRead {
  const headerRowNumber = findHeaderRow(grid);
  const empty: AftermarketRead = {
    sheetName,
    headerRowNumber,
    kits: [],
    orphanRows: [],
    counts: {
      blocks: 0,
      kits: 0,
      kitsWithUpc: 0,
      kitsWithPreset: 0,
      components: 0,
      packContentLines: 0,
      nonPrintingLines: 0,
    },
    presetCounts: {},
  };
  if (headerRowNumber === 0) return empty;

  const cols = findColumns(grid[headerRowNumber - 1] ?? []);
  if (!cols) return { ...empty, headerRowNumber };

  const at = (row: readonly Cell[], i: number) => (i < 0 ? "" : cellText(row[i]));

  const kits: AftermarketKit[] = [];
  const orphanRows: AftermarketRead["orphanRows"] = [];
  let blocks = 0;
  let current: AftermarketKit | null = null;

  const closeBlock = () => {
    if (!current) return;
    const clam = current.components.find((c) => c.role === "clamshell");
    current.presetCode = clam?.presetCode ?? null;
    current.packContents = current.components.filter((c) => c.role === "component");
    if (!current.upc) current.notes.push("The kit row carries no GS1 code, so it has no UPC.");
    if (!current.presetCode) {
      current.notes.push("No clamshell line, so the card preset is unknown for this kit.");
    }
    if (current.packContents.length === 0) {
      current.notes.push("No printable pack contents: every line is packaging, labour or a label.");
    }
    kits.push(current);
    current = null;
  };

  for (let r = headerRowNumber; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const rowNumber = r + 1;

    const aftmkt = at(row, cols.aftmkt);
    const former = at(row, cols.former);
    const item = at(row, cols.item);
    const parts = at(row, cols.parts);
    const description = at(row, cols.description);
    const gs1 = at(row, cols.gs1).replace(/\D/g, "");
    const qtyText = at(row, cols.qty);

    const blank = !aftmkt && !former && !item && !parts && !description && !gs1;
    if (blank) {
      closeBlock();
      continue;
    }

    // A kit row is the one that carries the trade item's own identity: a
    // description AND a GS1 code, with no "parts included" line of its own.
    const isKit = Boolean(description) && UPC_RE.test(gs1) && !parts;

    if (isKit) {
      closeBlock();
      blocks += 1;
      current = {
        rowNumber,
        partNumber: aftmkt,
        formerNumber: former,
        itemNumber: item,
        description,
        upc: gs1,
        quantityText: qtyText,
        components: [],
        presetCode: null,
        packContents: [],
        notes: [],
      };
      continue;
    }

    if (!current) {
      // A description with no GS1 code, outside any block: a kit the sheet has
      // not been given a UPC for. Recorded, not dropped.
      if (description) {
        blocks += 1;
        current = {
          rowNumber,
          partNumber: aftmkt,
          formerNumber: former,
          itemNumber: item,
          description,
          upc: UPC_RE.test(gs1) ? gs1 : "",
          quantityText: qtyText,
          components: [],
          presetCode: null,
          packContents: [],
          notes: [],
        };
        continue;
      }
      orphanRows.push({
        rowNumber,
        reason: "A component line with no kit above it; the block structure is broken here.",
      });
      continue;
    }

    const role = classifyComponent(parts, item);
    const parsed = parseDisplayLine(parts);
    const qtyFromColumn = Number(qtyText.replace(/[^0-9.]/g, ""));
    current.components.push({
      rowNumber,
      itemNumber: item,
      formerNumber: former,
      displayLine: parts,
      // The count printed inside the line wins over the QTY column: it is what
      // the card will say, and the two disagree often enough to matter.
      quantityText: parsed.quantityText || (Number.isFinite(qtyFromColumn) ? qtyText : ""),
      quantity: parsed.quantity ?? (Number.isFinite(qtyFromColumn) ? qtyFromColumn : 0),
      name: parsed.name || parts,
      partNumber: parsed.partNumber || (role === "component" ? item : ""),
      role,
      presetCode: role === "clamshell" ? (presetFromItemNumber(item) ?? presetFromItemNumber(former)) : null,
    });
  }
  closeBlock();

  const components = kits.reduce((n, k) => n + k.components.length, 0);
  const packContentLines = kits.reduce((n, k) => n + k.packContents.length, 0);
  const presetCounts: Record<string, number> = {};
  for (const k of kits) {
    if (k.presetCode) presetCounts[k.presetCode] = (presetCounts[k.presetCode] ?? 0) + 1;
  }

  return {
    sheetName,
    headerRowNumber,
    kits,
    orphanRows,
    counts: {
      blocks,
      kits: kits.length,
      kitsWithUpc: kits.filter((k) => k.upc).length,
      kitsWithPreset: kits.filter((k) => k.presetCode).length,
      components,
      packContentLines,
      nonPrintingLines: components - packContentLines,
    },
    presetCounts,
  };
}

/* --------------------------------------------------------- reference data */

export const ClamshellReferenceSchema = z.object({
  code: z.string(),
  cardSize: z.string(),
  cavitySize: z.string(),
  link: z.string(),
});
export type ClamshellReference = z.infer<typeof ClamshellReferenceSchema>;

/** The `Clam Shells` sheet: vendor dimensions, kept as reference metadata. */
export function readClamshellSheet(grid: Grid): ClamshellReference[] {
  const out: ClamshellReference[] = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const code = cellText(row[0]);
    if (!code) continue;
    out.push({
      code,
      cardSize: cellText(row[1]),
      cavitySize: cellText(row[2]),
      link: cellText(row[3]),
    });
  }
  return out;
}

/** The `GS1` sheet: part number → UPC, a second source for the same fact. */
export function readGs1Sheet(grid: Grid): Array<{ partNumber: string; description: string; upc: string }> {
  const out: Array<{ partNumber: string; description: string; upc: string }> = [];
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const partNumber = cellText(row[0]);
    const upc = cellText(row[2]).replace(/\D/g, "");
    if (!partNumber || !upc) continue;
    out.push({ partNumber, description: cellText(row[1]).trim(), upc });
  }
  return out;
}

/* ------------------------------------------------------------------ merge */

export const MergedKitSchema = AftermarketKitSchema.extend({
  /** Which sheet the kit itself came from. */
  source: z.string(),
  /** Set when the preset had to be taken from the other BOM sheet. */
  presetSource: z.string().nullable(),
});
export type MergedKit = z.infer<typeof MergedKitSchema>;

export type MergedRead = {
  kits: MergedKit[];
  primary: AftermarketRead;
  fallback: AftermarketRead | null;
  /** UPCs (or part numbers) that appear on more than one kit in the source. */
  duplicateKeys: Array<{ key: string; sheet: string; rowNumber: number; partNumber: string }>;
  counts: {
    kits: number;
    kitsWithUpc: number;
    kitsWithPreset: number;
    presetsBorrowed: number;
    kitsOnlyInFallback: number;
    conflictedKeys: number;
    packContentLines: number;
  };
  presetCounts: Record<string, number>;
};

/**
 * Merge the two BOM sheets.
 *
 * `BOM_AxleTekA` is the newer sheet and wins on everything it states, but the
 * older `BOM_AxleTek` names a clamshell for kits the newer one leaves blank —
 * 60 against 46 in the supplied file. Rather than pick one sheet and lose data,
 * a missing preset is filled from the other and the borrow is recorded on the
 * kit, so a reviewer can see which facts came from where instead of being handed
 * a merged result with no provenance.
 *
 * A kit that exists only in the older sheet is carried over whole, marked with
 * its source. Nothing is dropped because it appears in the wrong file.
 */
export function mergeAftermarketReads(
  primary: AftermarketRead,
  fallback: AftermarketRead | null,
): MergedRead {
  const key = (k: { partNumber: string; upc: string }) =>
    k.upc || k.partNumber.trim().toUpperCase();

  /**
   * A UPC that appears on two kits is a conflict in the source, not a duplicate
   * to discard: a GTIN identifies exactly one trade item, so one of the two rows
   * is wrong and only the brand owner can say which. Both are kept, both are
   * reported, and neither is used to fill anything in on the other.
   */
  const conflictedKeys = new Set<string>();
  const countKeys = (read: AftermarketRead) => {
    const seen = new Map<string, number>();
    for (const k of read.kits) {
      const id = key(k);
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    for (const [id, n] of seen) if (n > 1) conflictedKeys.add(id);
  };
  countKeys(primary);
  if (fallback) countKeys(fallback);

  const byKey = new Map<string, MergedKit>();
  const kits: MergedKit[] = [];
  const duplicateKeys: MergedRead["duplicateKeys"] = [];

  const add = (k: AftermarketKit, source: string, mergeable: boolean) => {
    const merged: MergedKit = {
      ...k,
      source,
      presetSource: k.presetCode ? source : null,
    };
    kits.push(merged);
    if (mergeable) byKey.set(key(k), merged);
    return merged;
  };

  for (const k of primary.kits) {
    const id = key(k);
    if (conflictedKeys.has(id)) {
      const dup = add(k, primary.sheetName, false);
      dup.notes.push(
        `${id.length >= 12 ? "UPC" : "Part number"} ${id} is on more than one kit in ${primary.sheetName}. ` +
          `A GTIN identifies one trade item, so one of these rows is wrong; both are kept for review.`,
      );
      duplicateKeys.push({ key: id, sheet: primary.sheetName, rowNumber: k.rowNumber, partNumber: k.partNumber });
      continue;
    }
    add(k, primary.sheetName, true);
  }

  let presetsBorrowed = 0;
  let kitsOnlyInFallback = 0;

  if (fallback) {
    for (const k of fallback.kits) {
      const id = key(k);
      if (conflictedKeys.has(id)) {
        const dup = add(k, fallback.sheetName, false);
        dup.notes.push(
          `${id.length >= 12 ? "UPC" : "Part number"} ${id} is on more than one kit. Kept for review; not merged.`,
        );
        duplicateKeys.push({ key: id, sheet: fallback.sheetName, rowNumber: k.rowNumber, partNumber: k.partNumber });
        continue;
      }
      const existing = byKey.get(id);
      if (!existing) {
        add(k, fallback.sheetName, true);
        kitsOnlyInFallback += 1;
        continue;
      }
      if (!existing.presetCode && k.presetCode) {
        existing.presetCode = k.presetCode;
        existing.presetSource = fallback.sheetName;
        existing.notes = existing.notes.filter((n) => !n.startsWith("No clamshell line"));
        existing.notes.push(
          `Card preset ${k.presetCode} taken from ${fallback.sheetName}; ${primary.sheetName} names no clamshell for this kit.`,
        );
        presetsBorrowed += 1;
      }
      // A longer pack-contents list in the older sheet is worth reporting, but
      // never worth silently substituting: the newer sheet is authoritative.
      if (k.packContents.length > existing.packContents.length) {
        existing.notes.push(
          `${fallback.sheetName} lists ${k.packContents.length} pack lines for this kit against ${existing.packContents.length} here; the newer sheet was used.`,
        );
      }
    }
  }

  kits.sort((a, b) => a.partNumber.localeCompare(b.partNumber) || a.rowNumber - b.rowNumber);
  const presetCounts: Record<string, number> = {};
  for (const k of kits) {
    if (k.presetCode) presetCounts[k.presetCode] = (presetCounts[k.presetCode] ?? 0) + 1;
  }

  return {
    kits,
    primary,
    fallback,
    duplicateKeys,
    counts: {
      kits: kits.length,
      kitsWithUpc: kits.filter((k) => k.upc).length,
      kitsWithPreset: kits.filter((k) => k.presetCode).length,
      presetsBorrowed,
      kitsOnlyInFallback,
      conflictedKeys: conflictedKeys.size,
      packContentLines: kits.reduce((n, k) => n + k.packContents.length, 0),
    },
    presetCounts,
  };
}

/** The pack-contents line as it will print, rebuilt from the parsed parts. */
export function packLine(c: AftermarketComponent): string {
  const qty = c.quantityText || String(c.quantity || 1);
  return c.partNumber ? `${qty}) ${c.name} (${c.partNumber})` : `${qty}) ${c.name}`;
}
