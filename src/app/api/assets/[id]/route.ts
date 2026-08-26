import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { assets, db } from "@/server/db";
import { getCurrentUser } from "@/server/auth/current";
import { readAsset } from "@/server/storage";

/**
 * Assets are served through the app, not straight from blob storage, so that
 * every read is checked against the requester's organisation (spec §25). The
 * storage URL is never handed to a browser.
 */
export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/assets/[id]">,
) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await ctx.params;
  const [asset] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  if (!asset || asset.orgId !== user.orgId) {
    return new NextResponse("Not found", { status: 404 });
  }
  if (asset.scanStatus === "flagged") {
    return new NextResponse("Asset failed malware screening", { status: 403 });
  }
  const bytes = await readAsset(asset.storageUrl || asset.storageKey);
  if (!bytes) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": asset.contentType,
      "cache-control": "private, max-age=3600",
      "content-disposition": `inline; filename="${encodeURIComponent(asset.filename)}"`,
    },
  });
}
