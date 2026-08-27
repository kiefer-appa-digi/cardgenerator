import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { products } from "@/server/db/schema";
const d = new PgDialect();
const frag = sql`exists (select 1 from card_designs cd where cd.product_id = ${products.id} and cd.org_id = ${"ORG"})`;
console.log("interpolated column ->", d.sqlToQuery(frag).sql);
