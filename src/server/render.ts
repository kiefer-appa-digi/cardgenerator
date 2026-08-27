import "server-only";
import { eq } from "drizzle-orm";
import { assets as assetsTable, db, organizations } from "@/server/db";
import { readAsset } from "@/server/storage";
import { planDocument, type AssetInfo } from "@/lib/design/plan";
import type { DesignDoc } from "@/lib/design/schema";
import type { ProductContext } from "@/lib/data/context";
import { BlackRulesSchema, OutputIntentSchema } from "@/lib/color/types";
import { PreflightProfileSchema } from "@/lib/preflight/types";

/**
 * Shared setup for anything that has to resolve a design into pixels or points:
 * the asset map, the org's preflight profile, black rules and output intent.
 * The editor preview, the preflight route and both PDF writers all start here so
 * they cannot drift apart.
 */

export async function loadAssetMap(orgId: string): Promise<Map<string, AssetInfo>> {
  const rows = await db.select().from(assetsTable).where(eq(assetsTable.orgId, orgId));
  return new Map(
    rows.map((a) => [
      a.id,
      {
        id: a.id,
        pixelWidth: a.pixelWidth,
        pixelHeight: a.pixelHeight,
        colorSpace: a.colorSpace,
        contentType: a.contentType,
        hasIccProfile: a.hasIccProfile,
      } satisfies AssetInfo,
    ]),
  );
}

export type OrgRenderSettings = {
  profile: ReturnType<typeof PreflightProfileSchema.parse>;
  blackRules: ReturnType<typeof BlackRulesSchema.parse>;
  outputIntent: ReturnType<typeof OutputIntentSchema.parse>;
  treatErrorAsBlocking: boolean;
  allowOverride: boolean;
};

export async function loadOrgSettings(orgId: string): Promise<OrgRenderSettings> {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const s = (org?.settings ?? {}) as Record<string, unknown>;
  const exportPolicy = (s.exportPolicy ?? {}) as Record<string, unknown>;
  const profile = PreflightProfileSchema.parse({
    ...((s.preflightProfile as object) ?? {}),
    treatErrorAsBlocking: Boolean(exportPolicy.treatErrorAsBlocking),
  });
  return {
    profile,
    blackRules: BlackRulesSchema.parse((s.blackRules as object) ?? {}),
    outputIntent: OutputIntentSchema.parse((s.outputIntent as object) ?? {}),
    treatErrorAsBlocking: Boolean(exportPolicy.treatErrorAsBlocking),
    allowOverride: exportPolicy.allowOverride !== false,
  };
}

export async function planForExport(doc: DesignDoc, product: ProductContext, orgId: string) {
  const assets = await loadAssetMap(orgId);
  return { plans: planDocument({ doc, product, assets }), assets };
}

/**
 * Byte loader handed to the PDF writers. Keeping I/O behind a callback is what
 * lets the writers stay pure and unit-testable with no database or blob store.
 */
export function assetBytesLoader(orgId: string) {
  return async (assetId: string) => {
    const [asset] = await db
      .select()
      .from(assetsTable)
      .where(eq(assetsTable.id, assetId))
      .limit(1);
    if (!asset || asset.orgId !== orgId) return null;
    const bytes = await readAsset(asset.storageUrl || asset.storageKey);
    if (!bytes) return null;
    return { bytes, contentType: asset.contentType };
  };
}
