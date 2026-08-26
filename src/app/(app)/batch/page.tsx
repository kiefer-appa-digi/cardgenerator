import { and, asc, eq } from "drizzle-orm";
import { brands, cardTemplates, db, productIdentifiers, products } from "@/server/db";
import { requireCapability } from "@/server/auth/current";
import { PageHeader } from "@/components/ui/panel";
import { BatchRunner } from "@/components/design/batch-runner";

export const dynamic = "force-dynamic";

export default async function BatchPage() {
  const user = await requireCapability("export.production");

  const templates = await db
    .select({
      id: cardTemplates.id,
      name: cardTemplates.name,
      presetCode: cardTemplates.presetCode,
      brandName: brands.name,
      isMaster: cardTemplates.isMaster,
    })
    .from(cardTemplates)
    .leftJoin(brands, eq(brands.id, cardTemplates.brandId))
    .where(and(eq(cardTemplates.orgId, user.orgId), eq(cardTemplates.archived, false)))
    .orderBy(asc(cardTemplates.name));

  const productRows = await db
    .select({
      id: products.id,
      partNumber: products.partNumber,
      description: products.description,
      brandName: brands.name,
      status: products.status,
    })
    .from(products)
    .leftJoin(brands, eq(brands.id, products.brandId))
    .where(and(eq(products.orgId, user.orgId), eq(products.recordType, "product")))
    .orderBy(asc(products.partNumber))
    .limit(2000);

  const upcs = await db
    .select({ productId: productIdentifiers.productId, value: productIdentifiers.value })
    .from(productIdentifiers)
    .where(and(eq(productIdentifiers.orgId, user.orgId), eq(productIdentifiers.kind, "gtin12")));
  const upcMap = new Map(upcs.map((u) => [u.productId, u.value]));

  return (
    <>
      <PageHeader
        title="Batch generation"
        description="One template, many products. Every card is planned, preflighted, rendered and validated on its own, and every outcome lands in the manifest — including the failures."
      />
      <div className="p-8">
        <BatchRunner
          templates={templates.map((t) => ({ ...t, brandName: t.brandName ?? "" }))}
          products={productRows.map((p) => ({
            id: p.id,
            partNumber: p.partNumber,
            description: p.description,
            brandName: p.brandName ?? "",
            status: p.status,
            upc: upcMap.get(p.id) ?? "",
          }))}
        />
      </div>
    </>
  );
}
