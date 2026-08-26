"use server";

import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { revalidatePath } from "next/cache";
import {
  brands,
  cardDesigns,
  db,
  exportArtifacts,
  exportJobs,
  productIdentifiers,
  products,
  revisions,
} from "@/server/db";
import { assertSameOrg, requireCapability, requireUser } from "@/server/auth/current";
import { audit } from "@/server/audit";
import { putAsset } from "@/server/storage";
import { assetBytesLoader, loadOrgSettings, planForExport } from "@/server/render";
import { buildProductContext, sampleProductContext } from "@/server/products";
import { DesignDocSchema, type DesignDoc } from "@/lib/design/schema";
import { runPreflight } from "@/lib/preflight/engine";
import { renderProductionPdf } from "@/lib/pdf/production";
import { renderProofPdf } from "@/lib/pdf/proof";
import { expectationForPlans, validateProductionPdf } from "@/lib/pdf/validate";
import type { CardPresetDef } from "@/lib/geometry/presets";
import type { PreflightReport } from "@/lib/preflight/types";
import type { ProductContext } from "@/lib/data/context";

/**
 * EXPORT (spec §15, §19, §21, §22).
 *
 * Every production export runs preflight first. A blocking finding stops the run
 * unless an Admin supplies an explicit override note, which is written to the
 * job and to the audit log — the spec's "privileged override with an audit
 * note". Proofs are never blocked: the whole point of a proof is to look at what
 * is wrong.
 *
 * After the bytes are written they are read back and validated against what the
 * plan said they should be, and the result is stored on the artifact. An export
 * nobody checked is not an export anyone should trust.
 */

export type ExportKind = "production" | "proof";

export type ExportResult =
  | { ok: true; jobId: string; artifactId: string; filename: string; blocked: false }
  | { ok: false; error: string; blocked?: boolean; report?: PreflightReport };

type DesignBundle = {
  design: typeof cardDesigns.$inferSelect;
  revision: typeof revisions.$inferSelect;
  doc: DesignDoc;
  product: ProductContext;
  productLabel: string;
  gtin: string;
  sku: string;
};

async function loadDesign(orgId: string, designId: string): Promise<DesignBundle | string> {
  const [design] = await db.select().from(cardDesigns).where(eq(cardDesigns.id, designId)).limit(1);
  if (!design || design.orgId !== orgId) return "Card not found.";

  // An approved card exports its approved revision, not whatever draft came
  // after it. Exporting the draft of an approved card is how the wrong artwork
  // reaches a press.
  const revisionId =
    design.status === "approved" && design.approvedRevisionId
      ? design.approvedRevisionId
      : design.currentRevisionId;
  if (!revisionId) return "This card has no revision to export.";

  const [revision] = await db.select().from(revisions).where(eq(revisions.id, revisionId)).limit(1);
  if (!revision) return "Revision not found.";

  const parsed = DesignDocSchema.safeParse(revision.doc);
  if (!parsed.success) {
    return `Revision ${revision.revisionNumber} does not validate: ${parsed.error.issues[0]?.message}`;
  }

  const product = design.productId
    ? ((await buildProductContext(orgId, design.productId)) ?? sampleProductContext())
    : sampleProductContext();

  return {
    design,
    revision,
    doc: parsed.data,
    product,
    productLabel: product.partNumber || design.name,
    gtin: product.identifiers.gtin14 || product.identifiers.upc12,
    sku: product.identifiers.sku || product.partNumber,
  };
}

function safeFilename(parts: string[], ext: string): string {
  const base = parts
    .filter(Boolean)
    .join("-")
    .replace(/[^\w.\-]+/g, "_")
    .slice(0, 120);
  return `${base}.${ext}`;
}

export async function exportDesignAction(input: {
  designId: string;
  kind: ExportKind;
  overrideNote?: string;
}): Promise<ExportResult> {
  const user = await requireCapability(
    input.kind === "production" ? "export.production" : "export.proof",
  );

  const loaded = await loadDesign(user.orgId, input.designId);
  if (typeof loaded === "string") return { ok: false, error: loaded };
  const { design, revision, doc, product } = loaded;

  const settings = await loadOrgSettings(user.orgId);
  const { plans, assets } = await planForExport(doc, product, user.orgId);

  const report = runPreflight({
    doc,
    plans,
    product,
    profile: settings.profile,
    blackRules: settings.blackRules,
    outputIntent: settings.outputIntent,
    assets,
    designId: design.id,
    revisionId: revision.id,
    productId: design.productId ?? undefined,
  });

  const override = (input.overrideNote ?? "").trim();
  if (input.kind === "production" && !report.exportable) {
    if (!settings.allowOverride) {
      return {
        ok: false,
        blocked: true,
        report,
        error:
          "This card has blocking preflight findings and this organisation does not permit overrides.",
      };
    }
    if (!override) {
      return {
        ok: false,
        blocked: true,
        report,
        error: `${report.counts.blocking} blocking finding(s) stop this production export. An administrator can proceed by recording a reason.`,
      };
    }
    const admin = await requireCapability("export.override_blocking");
    void admin;
    if (override.length < 12) {
      return {
        ok: false,
        blocked: true,
        report,
        error: "The override reason must say something specific — at least a sentence.",
      };
    }
  }

  const jobId = nanoid(24);
  await db.insert(exportJobs).values({
    id: jobId,
    orgId: user.orgId,
    kind: input.kind,
    status: "running",
    createdBy: user.id,
    templateId: design.templateId,
    presetCode: design.presetCode,
    request: { designId: design.id, revisionId: revision.id, kind: input.kind },
    totalItems: 1,
    overrideBy: override ? user.id : null,
    overrideNote: override,
    startedAt: new Date(),
  });

  try {
    const artifact = await renderOne({
      orgId: user.orgId,
      jobId,
      kind: input.kind,
      design,
      revision,
      doc,
      product,
      plans,
      report,
      settings,
    });

    await db
      .update(exportJobs)
      .set({
        status: "complete",
        completedItems: 1,
        manifest: [artifact.manifestRow],
        finishedAt: new Date(),
      })
      .where(eq(exportJobs.id, jobId));

    await db
      .update(revisions)
      .set({ preflight: report })
      .where(eq(revisions.id, revision.id));

    await audit({
      orgId: user.orgId,
      userId: user.id,
      action: `export.${input.kind}`,
      entityType: "revision",
      entityId: revision.id,
      detail: {
        jobId,
        filename: artifact.filename,
        blocking: report.counts.blocking,
        errors: report.counts.error,
        override: override || undefined,
      },
    });

    revalidatePath("/exports");
    revalidatePath(`/designs/${design.id}`);
    return {
      ok: true,
      jobId,
      artifactId: artifact.artifactId,
      filename: artifact.filename,
      blocked: false,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db
      .update(exportJobs)
      .set({ status: "failed", failedItems: 1, error: message, finishedAt: new Date() })
      .where(eq(exportJobs.id, jobId));
    return { ok: false, error: `The export failed: ${message}` };
  }
}

type RenderArgs = {
  orgId: string;
  jobId: string;
  kind: ExportKind;
  design: typeof cardDesigns.$inferSelect;
  revision: typeof revisions.$inferSelect;
  doc: DesignDoc;
  product: ProductContext;
  plans: Awaited<ReturnType<typeof planForExport>>["plans"];
  report: PreflightReport;
  settings: Awaited<ReturnType<typeof loadOrgSettings>>;
};

async function renderOne(args: RenderArgs) {
  const { orgId, jobId, kind, design, revision, product, plans, report, settings } = args;
  const stamp = new Date();

  const common = {
    plans,
    outputIntent: settings.outputIntent.iccBase64 ? settings.outputIntent : undefined,
    assetBytes: assetBytesLoader(orgId),
    metadata: {
      title: `${design.name} — ${design.presetCode} rev ${revision.revisionNumber}`,
      author: "Freedom Trailer Parts Card Designer",
      subject: product.description || design.name,
      keywords: [product.partNumber, product.identifiers.gtin14, design.presetCode].filter(Boolean),
      creator: "Freedom Trailer Parts Card Designer",
    },
    timestamp: stamp,
  };

  const result =
    kind === "production"
      ? await renderProductionPdf(common)
      : await renderProofPdf({
          ...common,
          info: {
            cardName: design.name,
            sku: product.identifiers.sku || product.partNumber,
            gtin: product.identifiers.gtin14 || product.identifiers.upc12,
            presetCode: design.presetCode as CardPresetDef["code"],
            revision: String(revision.revisionNumber),
            approvalStatus:
              revision.status === "approved"
                ? `Approved${revision.frozenAt ? ` ${revision.frozenAt.toISOString().slice(0, 10)}` : ""}`
                : revision.status === "in_review"
                  ? "In review"
                  : "Draft — not approved for production",
            exportedAt: stamp.toISOString().replace("T", " ").slice(0, 19) + " UTC",
            productName: product.productName || product.description,
            preflight: report,
          },
        });

  const filename = safeFilename(
    [
      product.partNumber || design.name,
      design.presetCode,
      `rev${revision.revisionNumber}`,
      kind,
    ],
    "pdf",
  );

  const stored = await putAsset(orgId, filename, result.bytes, "application/pdf");

  // Read the bytes back and check them against what the plan promised.
  const validation =
    kind === "production"
      ? await validateProductionPdf(
          result.bytes,
          expectationForPlans({
            presetCode: design.presetCode as CardPresetDef["code"],
            plans,
            options: { minImageDpi: settings.profile.minImageDpi },
          }),
        )
      : null;

  const artifactId = nanoid(24);
  await db.insert(exportArtifacts).values({
    id: artifactId,
    orgId,
    jobId,
    revisionId: revision.id,
    productId: design.productId,
    filename,
    storageKey: stored.key,
    storageUrl: stored.url,
    byteSize: result.bytes.byteLength,
    kind,
    validation: {
      complianceStatus: result.complianceStatus,
      notes: result.notes,
      pageBoxes: result.pageBoxes,
      ...(validation ? { checks: validation } : {}),
    },
    preflight: report,
    status: validation && !validation.passed ? "invalid" : "ok",
    error:
      validation && !validation.passed
        ? "The exported PDF did not match the expected geometry or resources; see the validation report."
        : "",
  });

  return {
    artifactId,
    filename,
    manifestRow: {
      sku: product.identifiers.sku || product.partNumber,
      gtin: product.identifiers.gtin14 || product.identifiers.upc12,
      presetCode: design.presetCode,
      template: design.templateId ?? "",
      revision: revision.revisionNumber,
      filename,
      exportedAt: stamp.toISOString(),
      preflight: {
        blocking: report.counts.blocking,
        error: report.counts.error,
        warning: report.counts.warning,
        exportable: report.exportable,
      },
      validation: validation ? { passed: validation.passed, failed: validation.counts.fail } : null,
      status: validation && !validation.passed ? "invalid" : "ok",
    },
  };
}

export async function listExportsAction() {
  const user = await requireUser();
  return db
    .select()
    .from(exportJobs)
    .where(eq(exportJobs.orgId, user.orgId))
    .orderBy(desc(exportJobs.createdAt))
    .limit(100);
}

export async function listExportableProductsAction(presetCode: string) {
  const user = await requireCapability("export.production");
  void presetCode;
  const rows = await db
    .select({
      id: products.id,
      partNumber: products.partNumber,
      description: products.description,
      brandName: brands.name,
      status: products.status,
    })
    .from(products)
    .leftJoin(brands, eq(brands.id, products.brandId))
    .where(and(eq(products.orgId, user.orgId), eq(products.recordType, "product")))
    .orderBy(products.partNumber)
    .limit(2000);

  const upcs = await db
    .select({ productId: productIdentifiers.productId, value: productIdentifiers.value })
    .from(productIdentifiers)
    .where(
      and(eq(productIdentifiers.orgId, user.orgId), eq(productIdentifiers.kind, "gtin12")),
    );
  const upcMap = new Map(upcs.map((u) => [u.productId, u.value]));
  return rows.map((r) => ({ ...r, upc: upcMap.get(r.id) ?? "" }));
}
