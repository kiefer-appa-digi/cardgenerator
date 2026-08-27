import Link from "next/link";
import { and, asc, eq } from "drizzle-orm";
import { brands, db, gs1Connections, productIdentifiers, products } from "@/server/db";
import { requireCapability } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { PageHeader, Panel } from "@/components/ui/panel";
import { Gs1Verify, type VerifyProduct } from "@/components/settings/gs1-verify";

export const dynamic = "force-dynamic";

/**
 * Verify and enrich, reachable from Settings → GS1 and from a product.
 *
 * The product is chosen here rather than baked into a product route, so the
 * same screen serves "check this one product" (arrive with ?product=…) and
 * "work through several".
 */
export default async function Gs1VerifyPage(props: PageProps<"/settings/gs1/verify">) {
  const user = await requireCapability("gs1.read");
  const sp = await props.searchParams;
  const requested = typeof sp.product === "string" ? sp.product : null;

  const [connection] = await db
    .select({ enabled: gs1Connections.enabled, provider: gs1Connections.provider })
    .from(gs1Connections)
    .where(eq(gs1Connections.orgId, user.orgId))
    .limit(1);
  const live = Boolean(connection?.enabled) && (connection?.provider ?? "disabled") !== "disabled";

  const rows = await db
    .select({
      id: products.id,
      partNumber: products.partNumber,
      description: products.description,
      brandName: brands.name,
    })
    .from(products)
    .leftJoin(brands, eq(brands.id, products.brandId))
    .where(and(eq(products.orgId, user.orgId), eq(products.recordType, "product")))
    .orderBy(asc(products.partNumber))
    .limit(2000);

  const identifiers = await db
    .select({
      productId: productIdentifiers.productId,
      kind: productIdentifiers.kind,
      value: productIdentifiers.value,
    })
    .from(productIdentifiers)
    .where(eq(productIdentifiers.orgId, user.orgId));

  // A product can carry several identifiers; the 14-digit form is the one the
  // registry is keyed on, with the UPC as the fallback the mapper zero-pads.
  const gtinOf = new Map<string, string>();
  for (const i of identifiers) {
    if (i.value === "") continue;
    if (i.kind === "gtin14") gtinOf.set(i.productId, i.value);
    else if (!gtinOf.has(i.productId) && (i.kind === "gtin13" || i.kind === "gtin12")) {
      gtinOf.set(i.productId, i.value);
    }
  }

  const list: VerifyProduct[] = rows.map((p) => ({
    id: p.id,
    partNumber: p.partNumber,
    description: p.description,
    brandName: p.brandName ?? "",
    gtin: gtinOf.get(p.id) ?? "",
  }));

  const initialProductId = requested && list.some((p) => p.id === requested) ? requested : null;
  // The list is sellable products only. A deep link that names a kit parent, a
  // BOM-only component or a deleted row must say so rather than quietly opening
  // an unselected screen and leaving the reader to wonder what happened.
  const requestedMissing = requested !== null && initialProductId === null;

  return (
    <>
      <PageHeader
        title="Verify &amp; enrich"
        description="Compare a product against the GS1 registry and accept differences field by field. Nothing is written until you tick it."
        actions={
          <Link href="/settings/gs1" className="text-xs text-brand-300 hover:text-brand-200">
            ← GS1 connector
          </Link>
        }
      />

      <div className="space-y-4 p-8">
        {requestedMissing ? (
          <Panel>
            <p className="px-4 py-3 text-[13px] leading-relaxed text-sev-warning">
              That link named a product this screen cannot check. Only sellable product records
              carry a GTIN the registry is keyed on, so kit parents, BOM-only components and
              deleted rows are not listed. Pick one below instead.
            </p>
          </Panel>
        ) : null}

        {list.length === 0 ? (
          <Panel>
            <div className="px-4 py-8 text-center text-sm text-ink-400">
              There are no products to check yet.{" "}
              <Link href="/imports/new" className="text-brand-300 hover:text-brand-200">
                Import a workbook
              </Link>{" "}
              first.
            </div>
          </Panel>
        ) : (
          <Gs1Verify
            products={list}
            initialProductId={initialProductId}
            live={live}
            canCheck={can(user.role, "gs1.sync")}
            canAccept={can(user.role, "gs1.sync") && can(user.role, "product.write")}
          />
        )}
      </div>
    </>
  );
}
