import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { brands, cardDesigns, db, products, revisions } from "@/server/db";
import { assertSameOrg, requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { PageHeader } from "@/components/ui/panel";
import { ExportPanel } from "@/components/design/export-panel";
import { CARD_PRESETS, type CardPresetDef } from "@/lib/geometry/presets";
import { formatLength } from "@/lib/units";
import { loadOrgSettings } from "@/server/render";
import type { PreflightReport } from "@/lib/preflight/types";

export const dynamic = "force-dynamic";

export default async function ExportPage({ params }: PageProps<"/designs/[id]/export">) {
  const { id } = await params;
  const user = await requireUser();

  const [design] = await db.select().from(cardDesigns).where(eq(cardDesigns.id, id)).limit(1);
  if (!design) notFound();
  assertSameOrg(user, design.orgId);

  const [rev] = design.currentRevisionId
    ? await db.select().from(revisions).where(eq(revisions.id, design.currentRevisionId)).limit(1)
    : [];

  const [product] = design.productId
    ? await db
        .select({
          partNumber: products.partNumber,
          description: products.description,
          brandName: brands.name,
        })
        .from(products)
        .leftJoin(brands, eq(brands.id, products.brandId))
        .where(eq(products.id, design.productId))
        .limit(1)
    : [];

  const preset = CARD_PRESETS[design.presetCode as CardPresetDef["code"]];
  const settings = await loadOrgSettings(user.orgId);

  return (
    <>
      <PageHeader
        title={`Export — ${design.name}`}
        description={
          product
            ? `${product.partNumber} · ${product.description}`
            : "This card has no product linked; it will export with sample data."
        }
      />
      <div className="p-8">
        <ExportPanel
          designId={design.id}
          designName={design.name}
          presetCode={design.presetCode}
          trim={`${formatLength(preset.trimWidth, "in")} × ${formatLength(preset.trimHeight, "in")} in`}
          fullBleed={`${formatLength(preset.trimWidth + preset.bleed.left + preset.bleed.right, "in")} × ${formatLength(preset.trimHeight + preset.bleed.top + preset.bleed.bottom, "in")} in`}
          status={design.status}
          revisionNumber={rev?.revisionNumber ?? 0}
          report={(rev?.preflight as PreflightReport | null) ?? null}
          canProduction={can(user.role, "export.production")}
          canOverride={can(user.role, "export.override_blocking") && settings.allowOverride}
          outputIntent={{
            configured: Boolean(settings.outputIntent.iccBase64),
            conditionName: settings.outputIntent.conditionName,
          }}
        />
      </div>
    </>
  );
}
