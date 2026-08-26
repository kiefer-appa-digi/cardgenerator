"use server";

import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { revalidatePath } from "next/cache";
import {
  brands,
  cardDesigns,
  cardTemplates,
  db,
  exportArtifacts,
  exportJobs,
  products,
  revisions,
} from "@/server/db";
import { assertSameOrg, requireCapability } from "@/server/auth/current";
import { audit } from "@/server/audit";
import { putAsset } from "@/server/storage";
import { assetBytesLoader, loadOrgSettings, planForExport } from "@/server/render";
import { buildProductContext } from "@/server/products";
import { DesignDocSchema, type DesignDoc } from "@/lib/design/schema";
import { runPreflight } from "@/lib/preflight/engine";
import { renderProductionPdf } from "@/lib/pdf/production";
import { expectationForPlans, validateProductionPdf } from "@/lib/pdf/validate";
import type { CardPresetDef } from "@/lib/geometry/presets";

/**
 * BATCH GENERATION — spec §19.
 *
 * One template, many products. Each product is planned, preflighted, rendered and
 * validated independently, and every outcome — success, preflight failure, render
 * failure — is written to the manifest. Nothing disappears from a batch: the
 * spec is explicit that a failed card must not silently vanish, so a failure
 * becomes a manifest row with a reason rather than an absent line.
 *
 * The job advances in slices so a serverless invocation cannot time out on a
 * 400-card run. The client calls `advanceBatchAction` until the job reports
 * `done`, and each slice is committed before the next begins, so an interrupted
 * batch resumes exactly where it stopped.
 */

const SLICE_SIZE = 5;

export type ManifestRow = {
  index: number;
  productId: string;
  sku: string;
  gtin: string;
  presetCode: string;
  template: string;
  revision: number | null;
  filename: string;
  artifactId: string | null;
  exportedAt: string;
  preflight: { blocking: number; error: number; warning: number; info: number };
  validation: { passed: boolean; failed: number } | null;
  status: "ok" | "preflight_blocked" | "invalid" | "failed";
  note: string;
};

export async function createBatchAction(input: {
  templateId: string;
  productIds: string[];
  name?: string;
  /** Generate even for products whose preflight blocks; they are marked in the manifest. */
  continueOnBlocked: boolean;
}) {
  const user = await requireCapability("export.production");

  const [tpl] = await db
    .select()
    .from(cardTemplates)
    .where(eq(cardTemplates.id, input.templateId))
    .limit(1);
  if (!tpl) return { ok: false as const, error: "Template not found." };
  assertSameOrg(user, tpl.orgId);
  if (input.productIds.length === 0) {
    return { ok: false as const, error: "Select at least one product." };
  }
  if (input.productIds.length > 500) {
    return {
      ok: false as const,
      error: "A batch is capped at 500 cards. Split the run so a failure never costs the whole job.",
    };
  }

  const rows = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.orgId, user.orgId), inArray(products.id, input.productIds)));
  const ids = rows.map((r) => r.id);
  if (ids.length !== input.productIds.length) {
    return { ok: false as const, error: "Some of those products are not in your organisation." };
  }

  const jobId = nanoid(24);
  await db.insert(exportJobs).values({
    id: jobId,
    orgId: user.orgId,
    kind: "batch",
    status: "running",
    createdBy: user.id,
    templateId: tpl.id,
    presetCode: tpl.presetCode,
    request: {
      templateId: tpl.id,
      productIds: ids,
      continueOnBlocked: input.continueOnBlocked,
      name: input.name ?? "",
    },
    totalItems: ids.length,
    startedAt: new Date(),
  });

  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: "export.batch_start",
    entityType: "job",
    entityId: jobId,
    detail: { templateId: tpl.id, count: ids.length },
  });

  revalidatePath("/exports");
  return { ok: true as const, jobId, total: ids.length };
}

export type AdvanceResult =
  | { ok: true; done: boolean; completed: number; failed: number; total: number }
  | { ok: false; error: string };

export async function advanceBatchAction(jobId: string): Promise<AdvanceResult> {
  const user = await requireCapability("export.production");

  const [job] = await db.select().from(exportJobs).where(eq(exportJobs.id, jobId)).limit(1);
  if (!job) return { ok: false, error: "Job not found." };
  assertSameOrg(user, job.orgId);
  if (job.status === "complete") {
    return {
      ok: true,
      done: true,
      completed: job.completedItems,
      failed: job.failedItems,
      total: job.totalItems,
    };
  }

  const request = job.request as {
    templateId: string;
    productIds: string[];
    continueOnBlocked: boolean;
  };
  const manifest = (job.manifest ?? []) as ManifestRow[];
  const startIndex = manifest.length;
  const slice = request.productIds.slice(startIndex, startIndex + SLICE_SIZE);

  if (slice.length === 0) {
    await db
      .update(exportJobs)
      .set({ status: "complete", finishedAt: new Date() })
      .where(eq(exportJobs.id, jobId));
    revalidatePath(`/exports/${jobId}`);
    return {
      ok: true,
      done: true,
      completed: job.completedItems,
      failed: job.failedItems,
      total: job.totalItems,
    };
  }

  const [tpl] = await db
    .select()
    .from(cardTemplates)
    .where(eq(cardTemplates.id, request.templateId))
    .limit(1);
  if (!tpl) return { ok: false, error: "The template has been deleted; this batch cannot continue." };

  const parsedTpl = DesignDocSchema.safeParse(tpl.doc);
  if (!parsedTpl.success) return { ok: false, error: "The template no longer validates." };

  const settings = await loadOrgSettings(user.orgId);
  const newRows: ManifestRow[] = [];

  for (let i = 0; i < slice.length; i++) {
    const productId = slice[i];
    const index = startIndex + i;
    newRows.push(
      await renderBatchItem({
        orgId: user.orgId,
        userId: user.id,
        jobId,
        index,
        productId,
        template: tpl,
        doc: parsedTpl.data,
        settings,
        continueOnBlocked: request.continueOnBlocked,
      }),
    );
  }

  const all = [...manifest, ...newRows];
  const completed = all.filter((r) => r.status === "ok").length;
  const failed = all.length - completed;
  const done = all.length >= request.productIds.length;

  await db
    .update(exportJobs)
    .set({
      manifest: all,
      completedItems: completed,
      failedItems: failed,
      status: done ? "complete" : "running",
      finishedAt: done ? new Date() : null,
    })
    .where(eq(exportJobs.id, jobId));

  if (done) {
    await audit({
      orgId: user.orgId,
      userId: user.id,
      action: "export.batch_finish",
      entityType: "job",
      entityId: jobId,
      detail: { completed, failed, total: all.length },
    });
  }

  revalidatePath(`/exports/${jobId}`);
  return { ok: true, done, completed, failed, total: request.productIds.length };
}

async function renderBatchItem(args: {
  orgId: string;
  userId: string;
  jobId: string;
  index: number;
  productId: string;
  template: typeof cardTemplates.$inferSelect;
  doc: DesignDoc;
  settings: Awaited<ReturnType<typeof loadOrgSettings>>;
  continueOnBlocked: boolean;
}): Promise<ManifestRow> {
  const { orgId, userId, jobId, index, productId, template, doc, settings } = args;
  const stamp = new Date();

  const base: ManifestRow = {
    index,
    productId,
    sku: "",
    gtin: "",
    presetCode: template.presetCode,
    template: template.name,
    revision: null,
    filename: "",
    artifactId: null,
    exportedAt: stamp.toISOString(),
    preflight: { blocking: 0, error: 0, warning: 0, info: 0 },
    validation: null,
    status: "failed",
    note: "",
  };

  try {
    const product = await buildProductContext(orgId, productId);
    if (!product) return { ...base, note: "The product record could not be loaded." };

    base.sku = product.identifiers.sku || product.partNumber;
    base.gtin = product.identifiers.gtin14 || product.identifiers.upc12;

    // Each batch card is a real card with its own revision, so the run is
    // auditable afterwards and a single card can be reopened and corrected.
    const designId = nanoid(24);
    const revisionId = nanoid(24);
    const name = `${base.sku || productId} — ${template.presetCode}`;
    await db.insert(cardDesigns).values({
      id: designId,
      orgId,
      productId,
      brandId: template.brandId,
      templateId: template.id,
      presetCode: template.presetCode,
      name,
      status: "draft",
      currentRevisionId: revisionId,
      createdBy: userId,
      updatedAt: stamp,
    });
    await db.insert(revisions).values({
      id: revisionId,
      orgId,
      designId,
      revisionNumber: 1,
      status: "draft",
      doc,
      productSnapshot: product,
      templateVersion: template.version,
      createdBy: userId,
      notes: `Generated by batch ${jobId}.`,
    });
    base.revision = 1;

    const { plans, assets } = await planForExport(doc, product, orgId);
    const report = runPreflight({
      doc,
      plans,
      product,
      profile: settings.profile,
      blackRules: settings.blackRules,
      outputIntent: settings.outputIntent,
      assets,
      designId,
      revisionId,
      productId,
    });
    base.preflight = report.counts;
    await db.update(revisions).set({ preflight: report }).where(eq(revisions.id, revisionId));

    if (!report.exportable && !args.continueOnBlocked) {
      return {
        ...base,
        status: "preflight_blocked",
        note: `${report.counts.blocking} blocking finding(s): ${report.findings
          .filter((f) => f.severity === "blocking")
          .slice(0, 3)
          .map((f) => f.code)
          .join(", ")}`,
      };
    }

    const result = await renderProductionPdf({
      plans,
      outputIntent: settings.outputIntent.iccBase64 ? settings.outputIntent : undefined,
      assetBytes: assetBytesLoader(orgId),
      metadata: {
        title: `${name} rev 1`,
        author: "Freedom Trailer Parts Card Designer",
        subject: product.description,
        keywords: [base.sku, base.gtin, template.presetCode].filter(Boolean),
      },
      timestamp: stamp,
    });

    const filename = `${(base.sku || productId).replace(/[^\w.\-]+/g, "_")}-${template.presetCode}-rev1.pdf`;
    const stored = await putAsset(orgId, filename, result.bytes, "application/pdf");

    const validation = await validateProductionPdf(
      result.bytes,
      expectationForPlans({
        presetCode: template.presetCode as CardPresetDef["code"],
        plans,
        options: { minImageDpi: settings.profile.minImageDpi },
      }),
    );

    const artifactId = nanoid(24);
    await db.insert(exportArtifacts).values({
      id: artifactId,
      orgId,
      jobId,
      revisionId,
      productId,
      filename,
      storageKey: stored.key,
      storageUrl: stored.url,
      byteSize: result.bytes.byteLength,
      kind: "production",
      validation: {
        complianceStatus: result.complianceStatus,
        notes: result.notes,
        pageBoxes: result.pageBoxes,
        checks: validation,
      },
      preflight: report,
      status: validation.passed ? "ok" : "invalid",
      error: validation.passed ? "" : "The exported PDF failed its own post-export validation.",
    });

    return {
      ...base,
      filename,
      artifactId,
      validation: { passed: validation.passed, failed: validation.counts.fail },
      status: validation.passed ? "ok" : "invalid",
      note: report.exportable
        ? ""
        : `Exported under an operator decision to continue past ${report.counts.blocking} blocking finding(s).`,
    };
  } catch (e) {
    return { ...base, status: "failed", note: e instanceof Error ? e.message : String(e) };
  }
}

/** Manifest as CSV (spec §19). Every row appears, including the failures. */
export async function batchManifestCsvAction(jobId: string) {
  const user = await requireCapability("export.proof");
  const [job] = await db.select().from(exportJobs).where(eq(exportJobs.id, jobId)).limit(1);
  if (!job || job.orgId !== user.orgId) return { ok: false as const, error: "Job not found." };

  const rows = (job.manifest ?? []) as ManifestRow[];
  const header = [
    "index", "sku", "gtin", "preset", "template", "revision", "filename",
    "exported_at", "preflight_blocking", "preflight_error", "preflight_warning",
    "validation_passed", "status", "note",
  ];
  const escape = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    header.join(","),
    ...rows.map((r) =>
      [
        r.index, r.sku, r.gtin, r.presetCode, r.template, r.revision ?? "", r.filename,
        r.exportedAt, r.preflight.blocking, r.preflight.error, r.preflight.warning,
        r.validation ? r.validation.passed : "", r.status, r.note,
      ].map(escape).join(","),
    ),
  ].join("\n");

  return { ok: true as const, csv, filename: `batch-${jobId}-manifest.csv` };
}

export async function listBatchTemplatesAction() {
  const user = await requireCapability("export.production");
  const rows = await db
    .select({
      id: cardTemplates.id,
      name: cardTemplates.name,
      presetCode: cardTemplates.presetCode,
      brandName: brands.name,
      isMaster: cardTemplates.isMaster,
    })
    .from(cardTemplates)
    .leftJoin(brands, eq(brands.id, cardTemplates.brandId))
    .where(and(eq(cardTemplates.orgId, user.orgId), eq(cardTemplates.archived, false)))
    .orderBy(cardTemplates.name);
  return rows;
}
