import "server-only";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * One database handle for two deployment shapes:
 *  - Neon over HTTP on Vercel (no connection pool to exhaust in a serverless fn)
 *  - plain node-postgres for local development and CI
 * `DATABASE_URL` is the only thing that changes.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and point it at a Postgres database.",
  );
}

const isNeon = /neon\.tech|neon\.build/.test(url);

type DB =
  | ReturnType<typeof drizzleNeon<typeof schema>>
  | ReturnType<typeof drizzleNode<typeof schema>>;

declare global {
  // eslint-disable-next-line no-var
  var __cardgen_db: DB | undefined;
  // eslint-disable-next-line no-var
  var __cardgen_pool: Pool | undefined;
}

function create(): DB {
  if (isNeon) {
    return drizzleNeon(neon(url!), { schema });
  }
  const pool =
    globalThis.__cardgen_pool ??
    new Pool({ connectionString: url, max: 5, ssl: /sslmode=require/.test(url!) ? { rejectUnauthorized: false } : undefined });
  globalThis.__cardgen_pool = pool;
  return drizzleNode(pool, { schema });
}

export const db: DB = globalThis.__cardgen_db ?? create();
if (process.env.NODE_ENV !== "production") globalThis.__cardgen_db = db;

export { schema };
export * from "./schema";
