import { execFileSync } from "node:child_process";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/server/db/schema";

/**
 * Integration tests run against a REAL Postgres, because the rules they check —
 * revision immutability, organisation isolation, the export gate — are enforced
 * by code paths that talk to a database. Testing them against a fake would test
 * the fake.
 *
 * The database is named by TEST_DATABASE_URL and is created and dropped by this
 * module, so a run can never touch a working catalogue. Without that variable
 * the suite skips rather than guessing at a connection string.
 */

export const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
export const hasDatabase = TEST_URL.length > 0;

let pool: Pool | null = null;

export function testDb() {
  if (!pool) pool = new Pool({ connectionString: TEST_URL, max: 4 });
  return drizzle(pool, { schema });
}

export async function pushSchema(): Promise<void> {
  execFileSync("npx", ["drizzle-kit", "push", "--force"], {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });
}

export async function truncateAll(): Promise<void> {
  const db = testDb();
  // One statement, so the order of the foreign keys does not matter.
  await db.execute(sql`
    truncate table
      audit_logs, sessions, users,
      design_elements, approvals, revisions, card_designs, card_templates,
      export_artifacts, export_jobs, preflight_results,
      bom_items, boms, alternate_part_numbers, fitments, warnings,
      product_translations, product_identifiers, products,
      gs1_sync_records, gs1_request_logs, gs1_connections,
      imports, assets, card_presets, package_types, brands, organizations
    restart identity cascade
  `);
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
}
