import { and, asc, eq } from "drizzle-orm";
import { brands, cardTemplates, db, productIdentifiers, products } from "@/server/db";
import { requireCapability } from "@/server/auth/current";
import { PageHeader } from "@/components/ui/panel";
import { NewCardForm } from "./form";
import { CARD_PRESETS, PRESET_CODES } from "@/lib/geometry/presets";
import { formatLength } from "@/lib/units";

export const dynamic = "force-dynamic";

export default async function NewDesignPage() {
  const user = await requireCapability("design.write");

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
    .where(
      and(eq(productIdentifiers.orgId, user.orgId), eq(productIdentifiers.kind, "gtin12")),
    );
  const upcMap = new Map(upcs.map((u) => [u.productId, u.value]));

  const templates = await db
    .select({
      id: cardTemplates.id,
      name: cardTemplates.name,
      presetCode: cardTemplates.presetCode,
      description: cardTemplates.description,
      isMaster: cardTemplates.isMaster,
    })
    .from(cardTemplates)
    .where(and(eq(cardTemplates.orgId, user.orgId), eq(cardTemplates.archived, false)))
    .orderBy(asc(cardTemplates.name));

  return (
    <>
      <PageHeader
        title="New card"
        description="Pick the dieline the card will be printed on, the product it carries, and the template it starts from."
      />
      <div className="p-8">
        <NewCardForm
          presets={PRESET_CODES.map((code) => {
            const p = CARD_PRESETS[code];
            return {
              code,
              name: p.name,
              trim: `${formatLength(p.trimWidth, "in")} × ${formatLength(p.trimHeight, "in")} in`,
              bleed: `${formatLength(p.trimWidth + p.bleed.left + p.bleed.right, "in")} × ${formatLength(p.trimHeight + p.bleed.top + p.bleed.bottom, "in")} in`,
            };
          })}
          products={productRows.map((p) => ({
            id: p.id,
            partNumber: p.partNumber,
            description: p.description,
            brandName: p.brandName ?? "",
            upc: upcMap.get(p.id) ?? "",
            status: p.status,
          }))}
          templates={templates}
        />
      </div>
    </>
  );
}
