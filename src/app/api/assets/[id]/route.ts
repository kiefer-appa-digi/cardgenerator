import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { assets, db } from "@/server/db";
import { getCurrentUser } from "@/server/auth/current";

/**
 * Assets are served through the app, not straight from blob storage, so that
 * every read is checked against the requester's organisation (spec §25). The
 * storage URL is never handed to a browser.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;
  const [asset] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
  if (!asset || asset.orgId !== user.orgId) {
    return new NextResponse("Not found", { status: 404 });
  }
  if (asset.scanStatus === "flagged") {
    return new NextResponse("Asset failed malware screening", { status: 403 });
  }
  if (!asset.storageUrl) return new NextResponse("Not found", { status: 404 });

  const upstream = await fetch(asset.storageUrl);
  if (!upstream.ok || !upstream.body) {
    return new NextResponse("Upstream unavailable", { status: 502 });
  }
  return new NextResponse(upstream.body, {
    headers: {
      "content-type": asset.contentType,
      "cache-control": "private, max-age=3600",
      "content-disposition": `inline; filename="${encodeURIComponent(asset.filename)}"`,
    },
  });
}
