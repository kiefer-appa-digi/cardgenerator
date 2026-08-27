"use server";

import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { revalidatePath } from "next/cache";
import { createHash } from "node:crypto";
import { db, imports } from "@/server/db";
import { assertSameOrg, requireCapability } from "@/server/auth/current";
import { audit } from "@/server/audit";
import { inspectWorkbook, parseWorkbook, readParsedSheetRows } from "@/lib/import/inspect";
import { suggestMapping } from "@/lib/import/mapping";
import { buildPreview } from "@/lib/import/preview";
import { planImport } from "@/lib/import/commit";
import { SheetMappingSchema, type SheetMapping } from "@/lib/import/types";
import { applyImportPlan } from "@/server/import-apply";
import { loadExistingProducts } from "@/server/import-existing";
import { jsonSafe } from "@/server/json-safe";

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/octet-stream",
]);

/**
 * Import is a four-step flow: upload → inspect + suggest → preview → commit.
 * Nothing is written to the catalogue until the commit step, and the preview a
 * user sees is produced by the same pure functions that build the commit plan.
 */

export async function uploadImportAction(formData: FormData) {
  const user = await requireCapability("product.import");
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false as const, error: "No file was uploaded." };
  if (file.size > MAX_BYTES) {
    return { ok: false as const, error: `The file is larger than ${MAX_BYTES / 1024 / 1024} MB.` };
  }
  if (file.type && !ALLOWED.has(file.type) && !file.name.toLowerCase().endsWith(".xlsx")) {
    return { ok: false as const, error: "Upload an .xlsx workbook." };
  }

  const buf = Buffer.from(await file.arrayBuffer());
  // A ZIP local file header. An .xlsx that does not start with PK is not one,
  // whatever the browser called it.
  if (buf.subarray(0, 2).toString("latin1") !== "PK") {
    return { ok: false as const, error: "That file is not a valid .xlsx workbook." };
  }

  let inspection;
  try {
    inspection = await inspectWorkbook(buf);
  } catch (e) {
    return {
      ok: false as const,
      error: `The workbook could not be read: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const primary = inspection.sheets[0];
  const mapping = primary
    ? suggestMapping(primary.headers, { sheetName: primary.name })
    : null;

  const id = nanoid(24);
  await db.insert(imports).values({
    id,
    orgId: user.orgId,
    createdBy: user.id,
    filename: file.name,
    byteSize: buf.byteLength,
    sha256: createHash("sha256").update(buf).digest("hex"),
    status: "mapping",
    inspection: jsonSafe(inspection).value,
    mapping: mapping ?? {},
    rowsTotal: primary?.dataRowCount ?? 0,
  });

  // The workbook bytes are kept in memory only for the life of this request; the
  // parsed rows are re-read from the stored inspection on the preview step. That
  // avoids holding a customer's price list in blob storage without being asked.
  await stashRows(id, buf, mapping?.sheetName);

  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: "import.upload",
    entityType: "import",
    entityId: id,
    detail: { filename: file.name, bytes: buf.byteLength, sheets: inspection.sheets.length },
  });

  revalidatePath("/imports");
  return { ok: true as const, importId: id };
}

/**
 * Parsed rows are cached on the import record so the mapping screen can be
 * revisited without re-uploading. They are cleared on commit or cancel.
 */
async function stashRows(importId: string, buf: Buffer, sheetName?: string) {
  const parsed = await parseWorkbook(buf);
  const read = readParsedSheetRows(parsed, { sheetName });
  const safe = jsonSafe({ rows: read.rows, headers: read.headers, sheetName: read.sheetName });
  await db
    .update(imports)
    .set({
      preview: safe.value,
      // Surfaced rather than hidden: a cell that carried an unrepresentable
      // control character is a fact about the source file.
      error: safe.removed
        ? `${safe.removed} unrepresentable control character(s) removed from ${safe.fields.length} cell(s) so the rows could be stored.`
        : "",
    })
    .where(eq(imports.id, importId));
}

export async function previewImportAction(importId: string, rawMapping: unknown) {
  const user = await requireCapability("product.import");
  const [row] = await db.select().from(imports).where(eq(imports.id, importId)).limit(1);
  if (!row) return { ok: false as const, error: "Import not found." };
  assertSameOrg(user, row.orgId);

  const mappingParsed = SheetMappingSchema.safeParse(rawMapping);
  if (!mappingParsed.success) {
    return { ok: false as const, error: "The column mapping is not valid." };
  }
  const mapping: SheetMapping = mappingParsed.data;

  const stash = row.preview as { rows?: Array<Record<string, string>> } | null;
  const rows = stash?.rows ?? [];
  if (!rows.length) {
    return { ok: false as const, error: "The uploaded rows are no longer cached. Upload again." };
  }

  const existing = await loadExistingProducts(user.orgId);
  const preview = buildPreview({
    orgId: user.orgId,
    sheetName: mapping.sheetName,
    mapping,
    rows: rows as never,
    existing,
  });

  await db
    .update(imports)
    .set({
      mapping,
      status: "previewed",
      preview: jsonSafe({ ...(row.preview as object), report: preview }).value,
      rowsTotal: preview.rows.length,
    })
    .where(eq(imports.id, importId));

  return { ok: true as const, preview };
}

export async function commitImportAction(importId: string) {
  const user = await requireCapability("product.import");
  const [row] = await db.select().from(imports).where(eq(imports.id, importId)).limit(1);
  if (!row) return { ok: false as const, error: "Import not found." };
  assertSameOrg(user, row.orgId);
  if (row.status === "committed") {
    return { ok: false as const, error: "This import has already been committed." };
  }

  const stash = row.preview as { report?: unknown } | null;
  if (!stash?.report) {
    return { ok: false as const, error: "Run a preview before committing." };
  }

  const plan = planImport(stash.report as never, { importId });
  if (plan.blocked) {
    return {
      ok: false as const,
      error: `The import is blocked by ${plan.blockingFindings.length} finding(s). Resolve them and preview again.`,
    };
  }

  const preview = (stash.report as { mapping?: { mappedFields?: string[] } }).mapping;
  const report = await applyImportPlan(
    user.orgId,
    plan,
    importId,
    preview?.mappedFields ?? [],
  );

  await db
    .update(imports)
    .set({
      status: report.errors.length ? "committed" : "committed",
      report: { ...report, counts: plan.counts, skipped: plan.skipped },
      rowsCreated: report.created,
      rowsUpdated: report.updated,
      rowsSkipped: plan.skipped.length,
      committedAt: new Date(),
      // Drop the cached source rows once they have been applied.
      preview: {},
      error: report.errors.length ? `${report.errors.length} row(s) failed` : "",
    })
    .where(eq(imports.id, importId));

  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: "import.commit",
    entityType: "import",
    entityId: importId,
    detail: {
      created: report.created,
      updated: report.updated,
      skipped: plan.skipped.length,
      errors: report.errors.length,
    },
  });

  revalidatePath("/imports");
  revalidatePath("/products");
  return { ok: true as const, report };
}

export async function cancelImportAction(importId: string) {
  const user = await requireCapability("product.import");
  const [row] = await db
    .select()
    .from(imports)
    .where(and(eq(imports.id, importId), eq(imports.orgId, user.orgId)))
    .limit(1);
  if (!row) return { ok: false as const, error: "Import not found." };
  if (row.status === "committed") {
    return { ok: false as const, error: "A committed import cannot be cancelled." };
  }
  await db
    .update(imports)
    .set({ status: "cancelled", preview: {} })
    .where(eq(imports.id, importId));
  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: "import.cancel",
    entityType: "import",
    entityId: importId,
  });
  revalidatePath("/imports");
  return { ok: true as const };
}
