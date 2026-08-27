import Link from "next/link";
import { and, asc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { brands, db, productIdentifiers, products } from "@/server/db";
import { requireCapability } from "@/server/auth/current";
import { PageHeader, Panel, EmptyState, Badge, Stat } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { ProductFilters, type ProductFilterState } from "@/components/product/product-filters";
import { checkIdentifier } from "@/components/product/identifier-check";

export const dynamic = "force-dynamic";

/**
 * 392 products is small enough to hold in one table and far too many to scroll.
 * The page is therefore a filter over a fixed window rather than an infinite
 * list: 50 rows a page, every filter in the URL, and the counts stated so the
 * operator always knows how much of the catalogue they are looking at.
 */
const PAGE_SIZE = 50;

const STATUS_TONE: Record<string, "neutral" | "ok" | "info" | "warning"> = {
  "In Use": "ok",
  PreMarket: "info",
  Draft: "neutral",
  Archived: "warning",
};

/** Postgres ILIKE treats % and _ as wildcards; a part number may contain either. */
function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
}

export default async function ProductsPage(props: PageProps<"/products">) {
  const user = await requireCapability("product.read");
  const sp = await props.searchParams;

  const q = first(sp.q);
  const brandFilter = first(sp.brand);
  const statusFilter = first(sp.status);
  const cardFilter = first(sp.card) === "yes" ? "yes" : first(sp.card) === "no" ? "no" : "";
  const requestedPage = Math.max(1, Math.floor(Number(first(sp.page))) || 1);

  const filters: ProductFilterState = {
    q,
    brand: brandFilter,
    status: statusFilter,
    card: cardFilter,
  };

  // One identifier row per kind per product, so these joins cannot fan out.
  const upc = alias(productIdentifiers, "upc");
  const gtin = alias(productIdentifiers, "gtin");

  // Table names are written out rather than interpolated as columns: drizzle
  // renders an interpolated column without its table qualifier inside a `sql`
  // fragment, and a bare "id" inside these correlated subqueries binds to the
  // subquery's own table instead of to the product, which matches nothing.
  const hasCard = sql`exists (select 1 from card_designs cd where cd.product_id = products.id and cd.org_id = ${user.orgId})`;

  const conditions: SQL[] = [eq(products.orgId, user.orgId)];
  if (q) {
    const term = likeTerm(q);
    const search = or(
      ilike(products.partNumber, term),
      ilike(products.description, term),
      ilike(products.productName, term),
      ilike(brands.name, term),
      ilike(upc.value, term),
      ilike(gtin.value, term),
    );
    if (search) conditions.push(search);
  }
  if (brandFilter === "none") conditions.push(isNull(products.brandId));
  else if (brandFilter) conditions.push(eq(products.brandId, brandFilter));
  if (statusFilter) conditions.push(eq(products.status, statusFilter));
  if (cardFilter === "yes") conditions.push(hasCard);
  if (cardFilter === "no") conditions.push(sql`not ${hasCard}`);

  const where = and(...conditions);

  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withUpc: sql<number>`count(*) filter (where exists (select 1 from product_identifiers i where i.product_id = products.id and i.kind = 'gtin12' and i.value <> ''))::int`,
      withCard: sql<number>`count(*) filter (where exists (select 1 from card_designs cd where cd.product_id = products.id and cd.org_id = ${user.orgId}))::int`,
      withOrigin: sql<number>`count(*) filter (where products.country_of_origin <> '')::int`,
      withoutBrand: sql<number>`count(*) filter (where products.brand_id is null)::int`,
    })
    .from(products)
    .where(eq(products.orgId, user.orgId));

  const [matched] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(products)
    .leftJoin(brands, eq(brands.id, products.brandId))
    .leftJoin(upc, and(eq(upc.productId, products.id), eq(upc.kind, "gtin12")))
    .leftJoin(gtin, and(eq(gtin.productId, products.id), eq(gtin.kind, "gtin14")))
    .where(where);

  const resultCount = matched?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(resultCount / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);

  const rows = await db
    .select({
      id: products.id,
      partNumber: products.partNumber,
      description: products.description,
      productName: products.productName,
      status: products.status,
      recordType: products.recordType,
      countryOfOrigin: products.countryOfOrigin,
      brandName: brands.name,
      upc: upc.value,
      gtin14: gtin.value,
      cardCount: sql<number>`(select count(*)::int from card_designs cd where cd.product_id = products.id and cd.org_id = ${user.orgId})`,
    })
    .from(products)
    .leftJoin(brands, eq(brands.id, products.brandId))
    .leftJoin(upc, and(eq(upc.productId, products.id), eq(upc.kind, "gtin12")))
    .leftJoin(gtin, and(eq(gtin.productId, products.id), eq(gtin.kind, "gtin14")))
    .where(where)
    // Four records carry no part number at all; they sort last rather than
    // occupying the top of the first page. `id` is the final tiebreaker so the
    // order is total: LIMIT/OFFSET over a partial order lets Postgres return a
    // row on two pages and skip another, and part number is not unique here —
    // 12-805 exists twice.
    .orderBy(
      sql`nullif(products.part_number, '') asc nulls last`,
      asc(products.description),
      asc(products.id),
    )
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  const brandRows = await db
    .select({
      id: brands.id,
      name: brands.name,
      n: sql<number>`count(${products.id})::int`,
    })
    .from(brands)
    .leftJoin(
      products,
      and(eq(products.brandId, brands.id), eq(products.orgId, user.orgId)),
    )
    .where(eq(brands.orgId, user.orgId))
    .groupBy(brands.id, brands.name)
    .orderBy(asc(brands.name));

  const statusRows = await db
    .select({ status: products.status, n: sql<number>`count(*)::int` })
    .from(products)
    .where(eq(products.orgId, user.orgId))
    .groupBy(products.status)
    .orderBy(sql`count(*) desc`);

  const brandOptions = [
    ...brandRows.map((b) => ({ value: b.id, label: b.name, count: b.n })),
    ...(totals?.withoutBrand
      ? [{ value: "none", label: "No brand", count: totals.withoutBrand }]
      : []),
  ];

  const pageHref = (n: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (brandFilter) params.set("brand", brandFilter);
    if (statusFilter) params.set("status", statusFilter);
    if (cardFilter) params.set("card", cardFilter);
    if (n > 1) params.set("page", String(n));
    const qs = params.toString();
    return qs ? `/products?${qs}` : "/products";
  };

  const anyFilter = Boolean(q || brandFilter || statusFilter || cardFilter);
  const firstRow = resultCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastRow = Math.min(page * PAGE_SIZE, resultCount);

  return (
    <>
      <PageHeader
        title="Products"
        description="The product records a card is generated from. Identifiers, pack contents and the country-of-origin statement all come from here, so a gap in this table is a gap on the printed card."
        actions={
          <>
            <Link href="/imports/new">
              <Button variant="outline">Import products</Button>
            </Link>
            <Link href="/designs/new">
              <Button variant="primary">New card</Button>
            </Link>
          </>
        }
      />

      <div className="space-y-6 p-8">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Products" value={totals?.total ?? 0} sub="in this organisation" />
          <Stat
            label="Carry a UPC"
            value={totals?.withUpc ?? 0}
            tone={(totals?.withUpc ?? 0) === (totals?.total ?? 0) ? "ok" : "warning"}
            // Not "cannot be barcoded": a product with only a variable-measure
            // GTIN-14 still carries an ITF-14 or a Digital Link. What it cannot
            // carry is the retail symbol, which is the narrower, true claim.
            sub={`${(totals?.total ?? 0) - (totals?.withUpc ?? 0)} cannot carry a UPC-A`}
          />
          <Stat
            label="Country of origin"
            value={totals?.withOrigin ?? 0}
            tone={(totals?.withOrigin ?? 0) === (totals?.total ?? 0) ? "ok" : "warning"}
            sub={`${(totals?.total ?? 0) - (totals?.withOrigin ?? 0)} have no statement`}
          />
          <Stat label="Have a card" value={totals?.withCard ?? 0} sub="one or more designs" />
        </div>

        <Panel>
          <div className="border-b border-ink-800 p-3">
            <ProductFilters
              initial={filters}
              brands={brandOptions}
              statuses={statusRows.map((s) => ({
                value: s.status,
                label: s.status,
                count: s.n,
              }))}
              resultCount={resultCount}
              totalCount={totals?.total ?? 0}
            />
          </div>

          {rows.length === 0 ? (
            anyFilter ? (
              <EmptyState
                title="No products match these filters"
                description="Nothing in the catalogue matches the search and filters currently applied. Widen them, or clear them to see all products again."
                action={
                  <Link href="/products">
                    <Button variant="outline">Clear filters</Button>
                  </Link>
                }
              />
            ) : (
              <EmptyState
                title="No products yet"
                description="Cards are generated from product records. Import the GS1 product export to load part numbers, descriptions, GTINs and brands — you review every mapped column before anything is written."
                action={
                  <Link href="/imports/new">
                    <Button variant="primary">Import a workbook</Button>
                  </Link>
                }
              />
            )
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Products {firstRow} to {lastRow} of {resultCount}
                </caption>
                <thead>
                  <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                    <th scope="col" className="px-4 py-2 font-medium">
                      Part number
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Description
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Brand
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      UPC
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      GTIN-14
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Card
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const upcState = p.upc ? checkIdentifier("gtin12", p.upc) : null;
                    const gtinState = p.gtin14 ? checkIdentifier("gtin14", p.gtin14) : null;
                    return (
                      <tr
                        key={p.id}
                        className="border-b border-ink-800/60 last:border-0 hover:bg-ink-800/30"
                      >
                        <th
                          scope="row"
                          className="px-4 py-2.5 text-left font-normal whitespace-nowrap"
                        >
                          <Link
                            href={`/products/${p.id}`}
                            className="numeric font-medium text-ink-100 hover:text-brand-300"
                          >
                            {p.partNumber || "no part number"}
                          </Link>
                          {p.recordType !== "product" ? (
                            <Badge className="ml-2">{p.recordType.replace("_", " ")}</Badge>
                          ) : null}
                        </th>
                        <td className="max-w-md px-4 py-2.5">
                          <span
                            className="block truncate text-ink-300"
                            title={p.description || p.productName}
                          >
                            {p.description || p.productName || (
                              <span className="text-ink-600">no description</span>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-ink-400">
                          {p.brandName ?? <span className="text-ink-600">—</span>}
                        </td>
                        <td className="numeric px-4 py-2.5 whitespace-nowrap">
                          {p.upc ? (
                            <span
                              className={
                                upcState?.state === "valid" ? "text-ink-200" : "text-sev-warning"
                              }
                              title={upcState?.note}
                            >
                              {p.upc}
                            </span>
                          ) : (
                            <span className="text-sev-warning" title="No UPC-A can be encoded.">
                              none
                            </span>
                          )}
                        </td>
                        <td className="numeric px-4 py-2.5 whitespace-nowrap">
                          {p.gtin14 ? (
                            <span
                              className={
                                gtinState?.state === "valid" ? "text-ink-400" : "text-sev-warning"
                              }
                              title={gtinState?.note}
                            >
                              {p.gtin14}
                            </span>
                          ) : (
                            <span className="text-ink-600">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          <Badge tone={STATUS_TONE[p.status] ?? "neutral"}>{p.status}</Badge>
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          {p.cardCount > 0 ? (
                            <Badge tone="ok">
                              <span className="numeric">{p.cardCount}</span>
                            </Badge>
                          ) : (
                            <span className="text-[11px] text-ink-600">none</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {resultCount > PAGE_SIZE ? (
            <nav
              aria-label="Product pages"
              className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-800 px-4 py-2.5"
            >
              <p className="numeric text-xs text-ink-400">
                {firstRow}–{lastRow} of {resultCount}
              </p>
              <div className="flex items-center gap-2">
                {page > 1 ? (
                  <Link href={pageHref(page - 1)}>
                    <Button variant="outline" size="sm">
                      <ChevronLeft size={13} aria-hidden /> Previous
                    </Button>
                  </Link>
                ) : (
                  <Button variant="outline" size="sm" disabled>
                    <ChevronLeft size={13} aria-hidden /> Previous
                  </Button>
                )}
                <span className="numeric px-1 text-xs text-ink-400">
                  Page {page} of {pageCount}
                </span>
                {page < pageCount ? (
                  <Link href={pageHref(page + 1)}>
                    <Button variant="outline" size="sm">
                      Next <ChevronRight size={13} aria-hidden />
                    </Button>
                  </Link>
                ) : (
                  <Button variant="outline" size="sm" disabled>
                    Next <ChevronRight size={13} aria-hidden />
                  </Button>
                )}
              </div>
            </nav>
          ) : null}
        </Panel>
      </div>
    </>
  );
}
