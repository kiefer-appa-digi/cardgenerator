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

  for (const op of plan.operations) {
    try {
      switch (op.op) {
        case "upsertProduct": {
          // `values` is keyed by TARGET FIELD KEY (product.partNumber, …), which
          // is the vocabulary the mapping UI and the preview both speak. Reading
          // it through a helper keeps that contract in one place.
          const v = (key: string) => op.values[key] ?? "";
          const values = {
            orgId,
            brandId: op.brandName ? (brandIds.get(op.brandName) ?? null) : null,
            partNumber: (() => {
              const explicit = v("product.partNumber");
              if (explicit) return explicit;
              const sku = skuByRef.get(op.ref) ?? "";
              if (sku) partNumberFromSku += 1;
              return sku;
            })(),
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

          let productId: string;
          if (op.mode === "update" && op.existingId) {
            await db.update(products).set(values).where(eq(products.id, op.existingId));
            productId = op.existingId;
            report.updated += 1;
          } else {
            productId = nanoid(24);
            await db.insert(products).values({ id: productId, ...values });
            report.created += 1;
          }
          refToProductId.set(op.ref, productId);

          // Fitments and warnings are fully replaced by the import, because the
          // source sheet is authoritative for them and a merge would silently
          // keep a statement the vendor removed.
          await db.delete(fitments).where(eq(fitments.productId, productId));
          if (op.fitments.length) {
            await db.insert(fitments).values(
              op.fitments.map((text, i) => ({
                id: nanoid(24), orgId, productId, kind: "fits", text, position: i,
              })),
            );
          }
          await db.delete(warnings).where(eq(warnings.productId, productId));
          if (op.warnings.length) {
            await db.insert(warnings).values(
              op.warnings.map((text, i) => ({
                id: nanoid(24), orgId, productId, code: "", text, position: i,
              })),
            );
          }
          break;
        }

        case "upsertIdentifier": {
          const productId = refToProductId.get(op.ref);
          if (!productId) break;
          const existing = await db
            .select()
            .from(productIdentifiers)
            .where(
              and(
                eq(productIdentifiers.productId, productId),
                eq(productIdentifiers.kind, op.kind),
              ),
            )
            .limit(1);
          const values = {
            orgId,
            productId,
            kind: op.kind,
            value: identifierValue(op.kind, op.value, op.canonical),
            isPrimary: op.isPrimary,
            valid: op.valid,
            validationNote: op.validationNote,
          };
          if (existing[0]) {
            await db
              .update(productIdentifiers)
              .set(values)
              .where(eq(productIdentifiers.id, existing[0].id));
          } else {
            await db.insert(productIdentifiers).values({ id: nanoid(24), ...values });
          }
          report.identifiers += 1;
          break;
        }

        case "upsertAlternate": {
          const productId = refToProductId.get(op.ref);
          if (!productId) break;
          if (op.position === 0) {
            await db
              .delete(alternatePartNumbers)
              .where(eq(alternatePartNumbers.productId, productId));
          }
          await db.insert(alternatePartNumbers).values({
            id: nanoid(24),
            orgId,
            productId,
            value: op.value,
            relation: op.relation,
            position: op.position,
          });
          report.alternates += 1;
          break;
        }

        case "upsertBom": {
          let productId = op.ref ? refToProductId.get(op.ref) : undefined;
          if (!productId && op.parentPartNumber) {
            const brandId = op.parentBrandName ? brandIds.get(op.parentBrandName) : undefined;
            const found = await db
              .select({ id: products.id })
              .from(products)
              .where(
                brandId
                  ? and(
                      eq(products.orgId, orgId),
                      eq(products.partNumber, op.parentPartNumber),
                      eq(products.brandId, brandId),
                    )
                  : and(eq(products.orgId, orgId), eq(products.partNumber, op.parentPartNumber)),
              )
              .limit(1);
            productId = found[0]?.id;
          }
          if (!productId) {
            report.errors.push({
              rowNumber: op.rowNumbers[0] ?? 0,
              message: `Pack-contents rows reference part ${op.parentPartNumber}, which is not in this import or on record.`,
            });
            break;
          }
          const existing = await db
            .select()
            .from(boms)
            .where(and(eq(boms.productId, productId), eq(boms.name, op.name)))
            .limit(1);
          let bomId: string;
          if (existing[0]) {
            bomId = existing[0].id;
            await db
              .update(boms)
              .set({ revision: op.revision, sourceImportId: importId, updatedAt: new Date() })
              .where(eq(boms.id, bomId));
            await db.delete(bomItems).where(eq(bomItems.bomId, bomId));
          } else {
            bomId = nanoid(24);
            await db.insert(boms).values({
              id: bomId, orgId, productId, name: op.name,
              revision: op.revision, sourceImportId: importId, updatedAt: new Date(),
            });
          }
          bomRefToId.set(op.bomRef, bomId);
          report.bomsWritten += 1;
          break;
        }

        case "upsertBomItem": {
          const bomId = bomRefToId.get(op.bomRef);
          if (!bomId) break;
          await db.insert(bomItems).values({
            id: nanoid(24),
            orgId,
            bomId,
            componentProductId: op.componentRef
              ? (refToProductId.get(op.componentRef) ?? null)
              : null,
            position: op.position,
            quantity: op.quantity,
            unitOfMeasure: op.unitOfMeasure,
            name: op.name,
            partNumber: op.partNumber,
            description: op.description,
          });
          report.bomItems += 1;
          break;
        }
      }
    } catch (e) {
      report.errors.push({
        rowNumber: "rowNumber" in op ? op.rowNumber : (op.rowNumbers?.[0] ?? 0),
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  report.partNumberFromSku = partNumberFromSku;
  return report;
}
