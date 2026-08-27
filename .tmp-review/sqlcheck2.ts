import { sql, eq, and } from "drizzle-orm";
import { PgDialect, alias } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { products, productIdentifiers, brands, cardDesigns } from "@/server/db/schema";

const d = new PgDialect();
const db = drizzle.mock ? null : null;
// build query objects without a driver using the query builder
import { QueryBuilder } from "drizzle-orm/pg-core";
const qb = new QueryBuilder();

const hasCard = sql`exists (select 1 from card_designs cd where cd.product_id = ${products.id} and cd.org_id = ${"ORG"})`;

const q1 = qb
  .select({
    total: sql<number>`count(*)::int`,
    withUpc: sql<number>`count(*) filter (where exists (select 1 from product_identifiers i where i.product_id = ${products.id} and i.kind = 'gtin12' and i.value <> ''))::int`,
    withCard: sql<number>`count(*) filter (where exists (select 1 from card_designs cd where cd.product_id = ${products.id} and cd.org_id = ${"ORG"}))::int`,
  })
  .from(products)
  .where(eq(products.orgId, "ORG"));
console.log("--- totals ---");
console.log(q1.toSQL().sql);

const upc = alias(productIdentifiers, "upc");
const q2 = qb
  .select({
    id: products.id,
    cardCount: sql<number>`(select count(*)::int from card_designs cd where cd.product_id = ${products.id} and cd.org_id = ${"ORG"})`,
  })
  .from(products)
  .leftJoin(upc, and(eq(upc.productId, products.id), eq(upc.kind, "gtin12")))
  .where(and(eq(products.orgId, "ORG"), hasCard))
  .orderBy(sql`nullif(products.part_number, '') asc nulls last`);
console.log("--- rows ---");
console.log(q2.toSQL().sql);
