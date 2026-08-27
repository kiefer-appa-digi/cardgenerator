import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { getCurrentUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { storageMode } from "@/server/storage";

export const runtime = "nodejs";

/**
 * Direct-to-Blob upload for large source files.
 *
 * A Server Action posts through the app server, and every serverless platform
 * caps that body — Vercel at 4.5 MB. The Aftermarket workbook is 13 MB, so it
 * has to go to storage directly and the app has to be handed a URL rather than
 * bytes. This route only issues the token: it authorises the request, pins the
 * content type and size, and namespaces the pathname to the caller's
 * organisation so an upload cannot land in someone else's folder.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  if (!can(user.role, "product.import") && !can(user.role, "asset.upload")) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  if (storageMode() !== "vercel-blob") {
    return NextResponse.json(
      { error: "No blob store is configured for this deployment." },
      { status: 503 },
    );
  }

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "Expected a JSON upload event." }, { status: 400 });
  }

  try {
    const result = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        // The SDK does not let the server rewrite the destination, so the
        // organisation prefix is VALIDATED rather than imposed. A client asking
        // for a path outside its own folder is refused, not quietly moved.
        const prefix = `org/${user.orgId}/upload/`;
        if (!pathname.startsWith(prefix) || pathname.includes("..")) {
          throw new Error(`Uploads must be addressed to ${prefix}`);
        }
        return {
          allowedContentTypes: [
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-excel",
            "application/octet-stream",
            "image/png",
            "image/jpeg",
            "image/tiff",
            "image/svg+xml",
            "application/pdf",
          ],
          maximumSizeInBytes: 60 * 1024 * 1024,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ orgId: user.orgId, userId: user.id }),
        };
      },
      // No onUploadCompleted: that callback needs a publicly reachable URL, which
      // localhost does not have, and there is nothing for it to do. The client
      // hands the blob URL straight to the action that reads it, and that action
      // re-checks the organisation prefix before it does.
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Upload could not be authorised." },
      { status: 400 },
    );
  }
}
