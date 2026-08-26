/**
 * Raw database handle with no `server-only` guard, so CLI scripts (seed,
 * migrate, fixtures) can import it. Application code imports ./index instead,
 * which adds the guard that keeps this out of a client bundle.
 *
 * One handle for two deployment shapes:
 *  - Neon over HTTP on Vercel, so a serverless invocation never holds a socket
 *    from a pool it cannot drain;
 *  - plain node-postgres for local development and CI.
 * `DATABASE_URL` is the only thing that changes between them.
 *
 * The connection is created lazily on first query so that importing this module
 * (which a script may do before it has finished loading its .env) is never fatal.
 */
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";
import * as schema from "./schema";

type NeonDb = ReturnType<typeof drizzleNeon<typeof schema>>;
type NodeDb = ReturnType<typeof drizzleNode<typeof schema>>;
export type Database = NeonDb | NodeDb;

declare global {
  // eslint-disable-next-line no-var
  var __cardgen_db: Database | undefined;
  // eslint-disable-next-line no-var
  var __cardgen_pool: Pool | undefined;
}

function create(): Database {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and point it at a Postgres database.",
    );
  }
  if (/neon\.tech|neon\.build/.test(url)) {
    return drizzleNeon(neon(url), { schema });
  }
  const pool =
    globalThis.__cardgen_pool ??
    new Pool({
      connectionString: url,
      max: 5,
      ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
    });
  globalThis.__cardgen_pool = pool;
  return drizzleNode(pool, { schema });
}

function resolve(): Database {
  if (!globalThis.__cardgen_db) globalThis.__cardgen_db = create();
  return globalThis.__cardgen_db;
}

/**
 * Proxy so `db.select(...)` connects on first use rather than on import.
 * Drizzle's query builders are plain methods, so forwarding property access is
 * sufficient — there is no constructor or private state to preserve.
 */
export const db = new Proxy({} as Database, {
  get(_t, prop, receiver) {
    const target = resolve() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(target, prop, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
  has(_t, prop) {
    return Reflect.has(resolve() as object, prop);
  },
}) as Database;

export { schema };
export * from "./schema";
