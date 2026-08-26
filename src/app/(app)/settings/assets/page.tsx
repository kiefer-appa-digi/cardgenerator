import { desc, eq, sql } from "drizzle-orm";
import { assets, db, users } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { PageHeader, Stat } from "@/components/ui/panel";
import { AssetLibrary, type AssetRow } from "@/components/settings/asset-library";

export const dynamic = "force-dynamic";

export default async function AssetsSettingsPage() {
  const user = await requireUser();
  const canUpload = can(user.role, "asset.upload");

  const rows = await db
    .select({
      id: assets.id,
      filename: assets.filename,
      contentType: assets.contentType,
      byteSize: assets.byteSize,
      pixelWidth: assets.pixelWidth,
      pixelHeight: assets.pixelHeight,
      declaredDpi: assets.declaredDpi,
      colorSpace: assets.colorSpace,
      hasAlpha: assets.hasAlpha,
      hasIccProfile: assets.hasIccProfile,
      iccProfileName: assets.iccProfileName,
      scanStatus: assets.scanStatus,
      scanDetail: assets.scanDetail,
      createdAt: assets.createdAt,
      uploadedByName: users.name,
      uploadedByEmail: users.email,
    })
    .from(assets)
    .leftJoin(users, eq(users.id, assets.uploadedBy))
    .where(eq(assets.orgId, user.orgId))
    .orderBy(desc(assets.createdAt))
    .limit(500);

  const [totals] = await db
    .select({
      count: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${assets.byteSize}), 0)::bigint`,
    })
    .from(assets)
    .where(eq(assets.orgId, user.orgId));

  const list: AssetRow[] = rows.map((a) => ({
    id: a.id,
    filename: a.filename,
    contentType: a.contentType,
    byteSize: a.byteSize,
    pixelWidth: a.pixelWidth,
    pixelHeight: a.pixelHeight,
    declaredDpi: a.declaredDpi,
    colorSpace: a.colorSpace,
    hasAlpha: a.hasAlpha,
    hasIccProfile: a.hasIccProfile,
    iccProfileName: a.iccProfileName,
    scanStatus: a.scanStatus,
    scanDetail: a.scanDetail,
    createdAt: a.createdAt.toISOString(),
    uploadedBy: a.uploadedByName || a.uploadedByEmail || "",
  }));

  const lowRes = list.filter(
    (a) => a.declaredDpi !== null && a.declaredDpi < 300 && a.pixelWidth !== null,
  ).length;
  const rgb = list.filter((a) => a.colorSpace === "srgb" || a.colorSpace === "rgb").length;
  const totalBytes = Number(totals?.bytes ?? 0);

  return (
    <>
      <PageHeader
        title="Assets"
        description="Artwork placed on cards. Served through the application with an organisation check on every read — the storage URL never reaches a browser."
        meta={
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Assets" value={totals?.count ?? 0} sub="in this organisation" />
            <Stat
              label="Stored"
              value={
                totalBytes < 1024 * 1024
                  ? `${(totalBytes / 1024).toFixed(0)} KB`
                  : `${(totalBytes / 1024 / 1024).toFixed(1)} MB`
              }
              sub="private blob storage"
            />
            <Stat
              label="Below 300 DPI"
              value={lowRes}
              tone={lowRes > 0 ? "warning" : "default"}
              sub="as declared by the file"
            />
            <Stat
              label="RGB sources"
              value={rgb}
              tone={rgb > 0 ? "warning" : "default"}
              sub="embedded as-is, not converted"
            />
          </div>
        }
      />

      <div className="p-8">
        <AssetLibrary assets={list} canUpload={canUpload} />
      </div>
    </>
  );
}
