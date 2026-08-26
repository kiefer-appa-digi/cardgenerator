import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, exportArtifacts } from "@/server/db";
import { getCurrentUser } from "@/server/auth/current";
import { readAsset } from "@/server/storage";

export const runtime = "nodejs";

/** Download an exported PDF. Organisation-checked, like every other asset read. */
export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/artifacts/[id]">,
) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await ctx.params;
  const [artifact] = await db
    .select()
    .from(exportArtifacts)
    .where(eq(exportArtifacts.id, id))
    .limit(1);
  if (!artifact || artifact.orgId !== user.orgId) {
    return new NextResponse("Not found", { status: 404 });
  }

  const bytes = await readAsset(artifact.storageUrl || artifact.storageKey);
  if (!bytes) return new NextResponse("The exported file is no longer in storage", { status: 410 });

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${encodeURIComponent(artifact.filename)}"`,
      "cache-control": "private, no-store",
    },
  });
}
