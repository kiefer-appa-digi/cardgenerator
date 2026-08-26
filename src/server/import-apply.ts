import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  alternatePartNumbers,
  bomItems,
  boms,
  brands,
  db,
  fitments,
  productIdentifiers,
  products,
  warnings,
} from "@/server/db/client";
import type { ImportPlan } from "@/lib/import/types";

/**
 * Apply a committed import plan.
 *
 * The plan is computed as pure data (src/lib/import/commit.ts) and only reaches
 * the database here, which is why the preview a user approves and the write that
 * follows can never disagree. Everything runs inside one transaction where the
 * driver supports it, so a failure halfway through leaves no half-imported
 * catalogue.
 */


/**
 * Store an identifier in the form its own kind names.
 *
 * The preview's `canonical` is always the zero-padded GTIN-14, because that is
 * what row matching compares. Writing that into the `gtin12` row would give the
 * barcode engine a 14-digit string for a UPC-A, so each kind is stored at its
 * own length: the source value when it already has the right number of digits,
 * otherwise the correct slice of the canonical GTIN-14.
 */
const GTIN_LENGTHS: Record<string, number> = { gtin8: 8, gtin12: 12, gtin13: 13, gtin14: 14 };

function identifierValue(kind: string, value: string, canonical: string): string {
  const want = GTIN_LENGTHS[kind];
  if (want === undefined) return (value || canonical).trim();
  const digitsValue = value.replace(/\D/g, "");
  if (digitsValue.length === want) return digitsValue;
  const digitsCanonical = canonical.replace(/\D/g, "");
  if (digitsCanonical.length >= want) {
    const sliced = digitsCanonical.slice(digitsCanonical.length - want);
    // Only safe when the dropped leading digits are padding zeros; a GTIN-14
    // with a real indicator digit is not the same trade item as its GTIN-12.
    const dropped = digitsCanonical.slice(0, digitsCanonical.length - want);
    if (/^0*$/.test(dropped)) return sliced;
  }
  return digitsValue || digitsCanonical;
}

export type ApplyReport = {
  created: number;
  updated: number;
  identifiers: number;
  alternates: number;
  bomsWritten: number;
  bomItems: number;
  brandsCreated: string[];
  /** Products whose part number was taken from the SKU column. */
  partNumberFromSku: number;
  errors: Array<{ rowNumber: number; message: string }>;
};

export async function applyImportPlan(
  orgId: string,
  plan: ImportPlan,
  importId: string,
): Promise<ApplyReport> {
  const report: ApplyReport = {
    created: 0,
    updated: 0,
    identifiers: 0,
    alternates: 0,
    bomsWritten: 0,
    bomItems: 0,
    brandsCreated: [],
    partNumberFromSku: 0,
    errors: [],
  };

  // Brands first: a product row cannot be written without its brand id, and the
  // plan lists them in first-seen order precisely so this pass is one query.
  const brandIds = new Map<string, string>();
  if (plan.brands.length) {
    const existing = await db
      .select()
      .from(brands)
      .where(and(eq(brands.orgId, orgId), inArray(brands.name, plan.brands)));
    for (const b of existing) brandIds.set(b.name, b.id);
    for (const name of plan.brands) {
      if (brandIds.has(name) || !name) continue;
      const id = nanoid(24);
      await db.insert(brands).values({ id, orgId, name, legalName: name, updatedAt: new Date() });
      brandIds.set(name, id);
      report.brandsCreated.push(name);
    }
  }

  const refToProductId = new Map<string, string>();
  const bomRefToId = new Map<string, string>();

  /**
   * Many catalogue exports — the supplied GS1 Data Hub sheet among them — have
   * no column called "part number"; the selling number lives in the SKU column
   * and GS1 calls it a SKU. A product with no part number would be unusable on a
   * card, so the SKU identifier is used as the part number when the mapping
   * supplied no separate one. This is a documented fallback, not a silent
   * correction: the SKU identifier is still written in its own right, and the
   * source row is retained verbatim.
   */
  const skuByRef = new Map<string, string>();
  for (const op of plan.operations) {
    if (op.op === "upsertIdentifier" && op.kind === "sku" && op.value) {
      if (!skuByRef.has(op.ref)) skuByRef.set(op.ref, op.canonical || op.value);
    }
  }
  let partNumberFromSku = 0;

  /**
   * Writes are batched by kind rather than issued per row.
   *
   * A 392-row catalogue produces about 2,500 operations. One statement each is
   * fine against a local socket and unusable against a network database — Neon
   * over HTTP would spend minutes on round trips alone. Because every id is
   * generated here rather than by the database, a whole kind can be inserted in
   * one statement, which turns those 2,500 round trips into about a dozen.
   */
  const CHUNK = 500;
  const insertChunked = async <T>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one insert per table; the row types differ by table and are checked at each call site
    table: any,
    rows: T[],
  ) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db.insert(table).values(rows.slice(i, i + CHUNK));
    }
  };

  /* ------------------------------------------------------------- products */

  const productOps = plan.operations.filter((o) => o.op === "upsertProduct");
  const creates: Array<typeof products.$inferInsert> = [];
  const updates: Array<{ id: string; values: Partial<typeof products.$inferInsert> }> = [];
  const productIdsTouched: string[] = [];

  for (const op of productOps) {
    const v = (key: string) => op.values[key] ?? "";
    const partNumber = (() => {
      const explicit = v("product.partNumber");
      if (explicit) return explicit;
      const sku = skuByRef.get(op.ref) ?? "";
      if (sku) partNumberFromSku += 1;
      return sku;
    })();

    const values = {
      orgId,
      brandId: op.brandName ? (brandIds.get(op.brandName) ?? null) : null,
      partNumber,
      productName: v("product.productName"),
      description: v("product.description"),
      descriptionShort: v("product.descriptionShort"),
      labelDescription: v("product.labelDescription"),
      subtitle: v("product.subtitle"),
      countryOfOrigin: v("product.countryOfOrigin"),
      status: v("product.status") || "Draft",
      packagingLevel: v("product.packagingLevel") || "Each",
      netContentCount: v("product.netContentCount"),
      netContentUom: v("product.netContentUom"),
      isPurchasable: v("product.isPurchasable") !== "N",
      isVariable: v("product.isVariable") === "Y",
      recordType: op.recordType,
      targetMarkets: v("product.targetMarkets"),
      gpcBrick: v("product.gpcBrick"),
      defaultPresetCode: v("product.defaultPresetCode") || null,
      sourceImportId: importId,
      sourceRow: op.sourceRow,
      custom: op.custom,
      lastModifiedSource: v("product.lastModifiedSource"),
      updatedAt: new Date(),
    };

    if (op.mode === "update" && op.existingId) {
      updates.push({ id: op.existingId, values });
      refToProductId.set(op.ref, op.existingId);
      productIdsTouched.push(op.existingId);
      report.updated += 1;
    } else {
      const id = nanoid(24);
      creates.push({ id, ...values });
      refToProductId.set(op.ref, id);
      productIdsTouched.push(id);
      report.created += 1;
    }
  }

  await insertChunked(products, creates);
  // Updates cannot be collapsed the way inserts can, because each row carries
  // different values; they are rare in practice (a re-import of unchanged rows
  // produces none at all).
  for (const u of updates) {
    await db.update(products).set(u.values).where(eq(products.id, u.id));
  }

  /* --------------------------------------------- fitments and warnings */

  // The import is authoritative for these, so they are replaced wholesale: a
  // merge would keep a fitment statement the vendor has removed.
  const fitmentRows: Array<typeof fitments.$inferInsert> = [];
  const warningRows: Array<typeof warnings.$inferInsert> = [];
  for (const op of productOps) {
    const productId = refToProductId.get(op.ref);
    if (!productId) continue;
    op.fitments.forEach((text, i) =>
      fitmentRows.push({ id: nanoid(24), orgId, productId, kind: "fits", text, position: i }),
    );
    op.warnings.forEach((text, i) =>
      warningRows.push({ id: nanoid(24), orgId, productId, code: "", text, position: i }),
    );
  }
  if (productIdsTouched.length) {
    for (let i = 0; i < productIdsTouched.length; i += CHUNK) {
      const slice = productIdsTouched.slice(i, i + CHUNK);
      await db.delete(fitments).where(inArray(fitments.productId, slice));
      await db.delete(warnings).where(inArray(warnings.productId, slice));
      await db.delete(alternatePartNumbers).where(inArray(alternatePartNumbers.productId, slice));
    }
  }
  await insertChunked(fitments, fitmentRows);
  await insertChunked(warnings, warningRows);

  /* ---------------------------------------------------------- identifiers */

  // Existing identifiers are read once and matched in memory, rather than a
  // SELECT per identifier.
  const existingIdentifiers = new Map<string, string>();
  if (productIdsTouched.length) {
    for (let i = 0; i < productIdsTouched.length; i += CHUNK) {
      const slice = productIdsTouched.slice(i, i + CHUNK);
      const rows = await db
        .select({
          id: productIdentifiers.id,
          productId: productIdentifiers.productId,
          kind: productIdentifiers.kind,
        })
        .from(productIdentifiers)
        .where(inArray(productIdentifiers.productId, slice));
      for (const r of rows) existingIdentifiers.set(`${r.productId}:${r.kind}`, r.id);
    }
  }

  const identifierInserts: Array<typeof productIdentifiers.$inferInsert> = [];
  const identifierUpdates: Array<{ id: string; values: Partial<typeof productIdentifiers.$inferInsert> }> = [];

  for (const op of plan.operations) {
    if (op.op !== "upsertIdentifier") continue;
    const productId = refToProductId.get(op.ref);
    if (!productId) continue;
    const values = {
      orgId,
      productId,
      kind: op.kind,
      value: identifierValue(op.kind, op.value, op.canonical),
      isPrimary: op.isPrimary,
      valid: op.valid,
      validationNote: op.validationNote,
    };
    const existingId = existingIdentifiers.get(`${productId}:${op.kind}`);
    if (existingId) identifierUpdates.push({ id: existingId, values });
    else identifierInserts.push({ id: nanoid(24), ...values });
    report.identifiers += 1;
  }

  await insertChunked(productIdentifiers, identifierInserts);
  for (const u of identifierUpdates) {
    await db.update(productIdentifiers).set(u.values).where(eq(productIdentifiers.id, u.id));
  }

  /* ------------------------------------------------------------ alternates */

  const alternateRows: Array<typeof alternatePartNumbers.$inferInsert> = [];
  for (const op of plan.operations) {
    if (op.op !== "upsertAlternate") continue;
    const productId = refToProductId.get(op.ref);
    if (!productId) continue;
    alternateRows.push({
      id: nanoid(24),
      orgId,
      productId,
      value: op.value,
      relation: op.relation,
      position: op.position,
    });
    report.alternates += 1;
  }
  await insertChunked(alternatePartNumbers, alternateRows);

  /* ------------------------------------------------------------------ BOMs */

  const bomOps = plan.operations.filter((o) => o.op === "upsertBom");
  if (bomOps.length) {
    // Parents that this import did not create are looked up in one query.
    const lookupNeeded = bomOps.filter((o) => !o.ref || !refToProductId.get(o.ref));
    const parentByPart = new Map<string, string>();
    if (lookupNeeded.length) {
      const partNumbers = [...new Set(lookupNeeded.map((o) => o.parentPartNumber).filter(Boolean))];
      if (partNumbers.length) {
        const rows = await db
          .select({ id: products.id, partNumber: products.partNumber, brandId: products.brandId })
          .from(products)
          .where(and(eq(products.orgId, orgId), inArray(products.partNumber, partNumbers)));
        for (const r of rows) {
          const brandName = [...brandIds.entries()].find(([, v]) => v === r.brandId)?.[0] ?? "";
          parentByPart.set(`${r.partNumber}::${brandName}`, r.id);
          if (!parentByPart.has(r.partNumber)) parentByPart.set(r.partNumber, r.id);
        }
      }
    }

    const bomInserts: Array<typeof boms.$inferInsert> = [];
    const bomIdsToClear: string[] = [];

    const existingBoms = new Map<string, string>();
    const parentIds = bomOps
      .map((o) => (o.ref ? refToProductId.get(o.ref) : undefined) ?? parentByPart.get(o.parentPartNumber))
      .filter((x): x is string => Boolean(x));
    if (parentIds.length) {
      const rows = await db
        .select({ id: boms.id, productId: boms.productId, name: boms.name })
        .from(boms)
        .where(inArray(boms.productId, [...new Set(parentIds)]));
      for (const r of rows) existingBoms.set(`${r.productId}:${r.name}`, r.id);
    }

    for (const op of bomOps) {
      const productId =
        (op.ref ? refToProductId.get(op.ref) : undefined) ??
        parentByPart.get(`${op.parentPartNumber}::${op.parentBrandName}`) ??
        parentByPart.get(op.parentPartNumber);
      if (!productId) {
        report.errors.push({
          rowNumber: op.rowNumbers[0] ?? 0,
          message: `Pack-contents rows reference part ${op.parentPartNumber}, which is not in this import or on record.`,
        });
        continue;
      }
      const existing = existingBoms.get(`${productId}:${op.name}`);
      if (existing) {
        bomRefToId.set(op.bomRef, existing);
        bomIdsToClear.push(existing);
        await db
          .update(boms)
          .set({ revision: op.revision, sourceImportId: importId, updatedAt: new Date() })
          .where(eq(boms.id, existing));
      } else {
        const id = nanoid(24);
        bomRefToId.set(op.bomRef, id);
        bomInserts.push({
          id,
          orgId,
          productId,
          name: op.name,
          revision: op.revision,
          sourceImportId: importId,
          updatedAt: new Date(),
        });
      }
      report.bomsWritten += 1;
    }

    if (bomIdsToClear.length) {
      await db.delete(bomItems).where(inArray(bomItems.bomId, bomIdsToClear));
    }
    await insertChunked(boms, bomInserts);

    const bomItemRows: Array<typeof bomItems.$inferInsert> = [];
    for (const op of plan.operations) {
      if (op.op !== "upsertBomItem") continue;
      const bomId = bomRefToId.get(op.bomRef);
      if (!bomId) continue;
      bomItemRows.push({
        id: nanoid(24),
        orgId,
        bomId,
        componentProductId: op.componentRef ? (refToProductId.get(op.componentRef) ?? null) : null,
        position: op.position,
        quantity: op.quantity,
        unitOfMeasure: op.unitOfMeasure,
        name: op.name,
        partNumber: op.partNumber,
        description: op.description,
      });
      report.bomItems += 1;
    }
    await insertChunked(bomItems, bomItemRows);
  }

  report.partNumberFromSku = partNumberFromSku;
  return report;
}
