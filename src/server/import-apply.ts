import "server-only";
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
} from "@/server/db";
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

export type ApplyReport = {
  created: number;
  updated: number;
  identifiers: number;
  alternates: number;
  bomsWritten: number;
  bomItems: number;
  brandsCreated: string[];
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

  for (const op of plan.operations) {
    try {
      switch (op.op) {
        case "upsertProduct": {
          const values = {
            orgId,
            brandId: op.brandName ? (brandIds.get(op.brandName) ?? null) : null,
            partNumber: op.values.partNumber ?? "",
            productName: op.values.productName ?? "",
            description: op.values.description ?? "",
            descriptionShort: op.values.descriptionShort ?? "",
            labelDescription: op.values.labelDescription ?? "",
            subtitle: op.values.subtitle ?? "",
            countryOfOrigin: op.values.countryOfOrigin ?? "",
            status: op.values.status || "Draft",
            packagingLevel: op.values.packagingLevel || "Each",
            netContentCount: op.values.netContentCount ?? "",
            netContentUom: op.values.netContentUom ?? "",
            isPurchasable: op.values.isPurchasable !== "N",
            isVariable: op.values.isVariable === "Y",
            recordType: op.recordType,
            targetMarkets: op.values.targetMarkets ?? "",
            gpcBrick: op.values.gpcBrick ?? "",
            sourceImportId: importId,
            sourceRow: op.sourceRow,
            custom: op.custom,
            lastModifiedSource: op.values.lastModifiedSource ?? "",
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
            value: op.canonical || op.value,
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

  return report;
}
