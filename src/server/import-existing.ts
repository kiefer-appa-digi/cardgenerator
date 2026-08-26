import { eq } from "drizzle-orm";
import { brands, db, productIdentifiers, products } from "@/server/db/client";
import type { ExistingProduct } from "@/lib/import/types";

/**
 * Load the catalogue in the shape the import preview compares against.
 *
 * The preview classifies a row create / update / unchanged by diffing the mapped
 * values against `ExistingProduct.fields`, which is keyed by TARGET FIELD KEY
 * ("product.partNumber", "brand.name", "identifier.gtin12", …). Supplying a
 * partial map here does not merely lose detail: every unlisted field reads as
 * empty, so a re-import of an untouched catalogue classifies all 392 rows as
 * changed and issues 392 pointless UPDATEs. Spec §5.12 asks for safe re-import,
 * and safe re-import means an unchanged row is recognised as unchanged.
 *
 * Both the wizard and the CLI importer come through here so the two can never
 * disagree about what "unchanged" means.
 */
export async function loadExistingProducts(orgId: string): Promise<ExistingProduct[]> {
  const rows = await db
    .select({
      id: products.id,
      partNumber: products.partNumber,
      productName: products.productName,
      description: products.description,
      descriptionShort: products.descriptionShort,
      labelDescription: products.labelDescription,
      subtitle: products.subtitle,
      countryOfOrigin: products.countryOfOrigin,
      status: products.status,
      packagingLevel: products.packagingLevel,
      netContentCount: products.netContentCount,
      netContentUom: products.netContentUom,
      isPurchasable: products.isPurchasable,
      isVariable: products.isVariable,
      targetMarkets: products.targetMarkets,
      gpcBrick: products.gpcBrick,
      defaultPresetCode: products.defaultPresetCode,
      lastModifiedSource: products.lastModifiedSource,
      brandName: brands.name,
    })
    .from(products)
    .leftJoin(brands, eq(brands.id, products.brandId))
    .where(eq(products.orgId, orgId));

  const identifierRows = await db
    .select({
      productId: productIdentifiers.productId,
      kind: productIdentifiers.kind,
      value: productIdentifiers.value,
    })
    .from(productIdentifiers)
    .where(eq(productIdentifiers.orgId, orgId));

  const byProduct = new Map<string, Record<string, string>>();
  for (const i of identifierRows) {
    const m = byProduct.get(i.productId) ?? {};
    m[i.kind] = i.value;
    byProduct.set(i.productId, m);
  }

  return rows.map((r) => {
    const identifiers = byProduct.get(r.id) ?? {};
    const fields: Record<string, string> = {
      "product.partNumber": r.partNumber,
      "product.productName": r.productName,
      "product.description": r.description,
      "product.descriptionShort": r.descriptionShort,
      "product.labelDescription": r.labelDescription,
      "product.subtitle": r.subtitle,
      "product.countryOfOrigin": r.countryOfOrigin,
      "product.status": r.status,
      "product.packagingLevel": r.packagingLevel,
      "product.netContentCount": r.netContentCount,
      "product.netContentUom": r.netContentUom,
      // Stored as booleans, compared as the Y/N the source sheets use.
      "product.isPurchasable": r.isPurchasable ? "Y" : "N",
      "product.isVariable": r.isVariable ? "Y" : "N",
      "product.targetMarkets": r.targetMarkets,
      "product.gpcBrick": r.gpcBrick,
      "product.defaultPresetCode": r.defaultPresetCode ?? "",
      "product.lastModifiedSource": r.lastModifiedSource,
      "brand.name": r.brandName ?? "",
    };
    for (const [kind, value] of Object.entries(identifiers)) {
      fields[`identifier.${kind}`] = value;
    }

    return {
      id: r.id,
      partNumber: r.partNumber,
      brandName: r.brandName ?? "",
      // Every GTIN form the product carries, so a re-import matching on a
      // 12-digit UPC still recognises a product stored under its GTIN-14.
      gtins: Object.entries(identifiers)
        .filter(([kind]) => kind.startsWith("gtin"))
        .map(([, value]) => value)
        .filter(Boolean),
      fields,
    };
  });
}
