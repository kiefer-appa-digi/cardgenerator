import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/server/db/client";

export const dynamic = "force-dynamic";

/** Liveness + database reachability. Never leaks connection details. */
export async function GET() {
  const started = Date.now();
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({
      ok: true,
      database: "reachable",
      ms: Date.now() - started,
    });
  } catch {
    return NextResponse.json(
      { ok: false, database: "unreachable", ms: Date.now() - started },
      { status: 503 },
    );
  }
}
