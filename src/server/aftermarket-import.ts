"use server";

import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { revalidatePath } from "next/cache";
import { createHash } from "node:crypto";
import {
  bomItems,
  boms,
  brands,
  db,
  imports,
  productIdentifiers,
  products,
} from "@/server/db";
import { assertSameOrg, requireCapability } from "@/server/auth/current";
import { audit } from "@/server/audit";
import { jsonSafe } from "@/server/json-safe";
import { readAsset } from "@/server/storage";
import {
  looksLikeAftermarket,
  readAftermarketWorkbook,
} from "@/lib/import/profiles/aftermarket-workbook";
import { packLine, type MergedKit } from "@/lib/import/profiles/aftermarket";
import { PRESET_CODES } from "@/lib/geometry/presets";

/**
 * Server side of the Aftermarket workbook import.
 *
 * It matches to products already in the catalogue rather than creating them: the
 * GS1 export is authoritative for identity, and this workbook is authoritative
 * for what is in the pack and which clamshell it ships in. A kit it names that
 * the catalogue does not have is reported, never invented.
 */

const MAX_BYTES = 40 * 1024 * 1024;

export type AftermarketPreviewRow = {
  partNumber: string;
  upc: string;
  description: string;
  presetCode: string | null;
  presetSource: string | null;
  packLines: string[];
  status: "match" | "match-by-part" | "unmatched" | "no-contents";
  productId: string | null;
  existingPreset: string | null;
  notes: string[];
};

export type AftermarketPreview = {
  importId: string;
  filename: string;
  sheetNames: string[];
  unread: Array<{ sheet: string; reason: string }>;
  clamshells: Array<{ code: string; cardSize: string; cavitySize: string }>;
  duplicateKeys: Array<{ key: string; sheet: string; partNumber: string; rowNumber: number }>;
  rows: AftermarketPreviewRow[];
  counts: {
    kits: number;
    matched: number;
    matchedByPart: number;
    unmatched: number;
    noContents: number;
    packLines: number;
    presetsToAssign: number;
    presetConflicts: number;
    presetsBorrowed: number;
    duplicateUpcs: number;
  };
};

async function buildPreview(orgId: string, kits: MergedKit[]) {
  const existing = await db
    .select({
      id: products.id,
      partNumber: products.partNumber,
      defaultPresetCode: products.defaultPresetCode,
      brandName: brands.name,
    })
    .from(products)
    .leftJoin(brands, eq(brands.id, products.brandId))
    .where(eq(products.orgId, orgId));

  const idRows = await db
    .select({ productId: productIdentifiers.productId, kind: productIdentifiers.kind, value: productIdentifiers.value })
    .from(productIdentifiers)
    .where(and(eq(productIdentifiers.orgId, orgId), eq(productIdentifiers.kind, "gtin12")));

  const byUpc = new Map(idRows.filter((r) => r.value).map((r) => [r.value, r.productId]));
  const byPart = new Map<string, string>();
  for (const p of existing) {
    const k = p.partNumber.trim().toUpperCase();
    if (!k) continue;
    // An ambiguous part number (the same SKU under two brands) is deliberately
    // left unmatched: a wrong match writes the wrong pack contents onto a card.
    byPart.set(k, byPart.has(k) ? "" : p.id);
  }
  const presetOf = new Map(existing.map((p) => [p.id, p.defaultPresetCode]));

  const rows: AftermarketPreviewRow[] = kits.map((kit) => {
    const viaUpc = kit.upc ? byUpc.get(kit.upc) : undefined;
    const viaPart = viaUpc ? undefined : byPart.get(kit.partNumber.trim().toUpperCase()) || undefined;
    const productId = viaUpc ?? viaPart ?? null;
    const status: AftermarketPreviewRow["status"] = !productId
      ? "unmatched"
      : kit.packContents.length === 0
        ? "no-contents"
        : viaUpc
          ? "match"
          : "match-by-part";
    return {
      partNumber: kit.partNumber,
      upc: kit.upc,
      description: kit.description,
      presetCode: kit.presetCode,
      presetSource: kit.presetSource,
      packLines: kit.packContents.map(packLine),
      status,
      productId,
      existingPreset: productId ? (presetOf.get(productId) ?? null) : null,
      notes: kit.notes,
    };
  });

  const counts = {
    kits: rows.length,
    matched: rows.filter((r) => r.status === "match").length,
    matchedByPart: rows.filter((r) => r.status === "match-by-part").length,
    unmatched: rows.filter((r) => r.status === "unmatched").length,
    noContents: rows.filter((r) => r.status === "no-contents").length,
    packLines: rows.reduce((n, r) => n + (r.status.startsWith("match") ? r.packLines.length : 0), 0),
    presetsToAssign: rows.filter(
      (r) => r.productId && r.presetCode && !r.existingPreset,
    ).length,
    presetConflicts: rows.filter(
      (r) => r.productId && r.presetCode && r.existingPreset && r.existingPreset !== r.presetCode,
    ).length,
    presetsBorrowed: 0,
    duplicateUpcs: 0,
  };

  return { rows, counts };
}

export async function uploadAftermarketAction(formData: FormData) {
  const user = await requireCapability("product.import");
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false as const, error: "No file was uploaded." };
  if (file.size > MAX_BYTES) {
    return { ok: false as const, error: `The file is larger than ${MAX_BYTES / 1024 / 1024} MB.` };
  }

  const buf = Buffer.from(await file.arrayBuffer());
  return ingestAftermarket(user.orgId, user.id, file.name, buf);
}

/**
 * The same import, from a file already in blob storage.
 *
 * Large workbooks cannot travel through a Server Action — every serverless
 * platform caps the request body — so the browser puts the file straight into
 * Blob and hands this action the URL. The organisation prefix on the pathname is
 * re-checked here rather than trusted: the client supplied the URL.
 */
export async function ingestAftermarketFromBlobAction(input: {
  url: string;
  pathname: string;
  filename: string;
}) {
  const user = await requireCapability("product.import");
  if (!input.pathname.startsWith(`org/${user.orgId}/`)) {
    return { ok: false as const, error: "That upload does not belong to your organisation." };
  }
  const bytes = await readAsset(input.url);
  if (!bytes) return { ok: false as const, error: "The uploaded file could not be read back." };
  if (bytes.byteLength > MAX_BYTES) {
    return { ok: false as const, error: `The file is larger than ${MAX_BYTES / 1024 / 1024} MB.` };
  }
  return ingestAftermarket(user.orgId, user.id, input.filename, Buffer.from(bytes));
}

async function ingestAftermarket(
  orgId: string,
  userId: string,
  filename: string,
  buf: Buffer,
) {
  if (buf.subarray(0, 2).toString("latin1") !== "PK") {
    return { ok: false as const, error: "That file is not a valid .xlsx workbook." };
  }

  let wb;
  try {
    wb = await readAftermarketWorkbook(buf);
  } catch (e) {
    return {
      ok: false as const,
      error: e instanceof Error ? e.message : "The workbook could not be read.",
    };
  }
  if (!looksLikeAftermarket(wb.sheetNames)) {
    return {
      ok: false as const,
      error: "This workbook has no BOM_AxleTek sheet, so it is not an Aftermarket workbook.",
    };
  }

  const { rows, counts } = await buildPreview(orgId, wb.bom.kits);
  counts.presetsBorrowed = wb.bom.counts.presetsBorrowed;
  counts.duplicateUpcs = wb.bom.counts.conflictedKeys;

  const importId = nanoid(24);
  const preview: AftermarketPreview = {
    importId,
    filename,
    sheetNames: wb.sheetNames,
    unread: wb.unread,
    clamshells: wb.clamshells.map((c) => ({
      code: c.code,
      cardSize: c.cardSize,
      cavitySize: c.cavitySize,
    })),
    duplicateKeys: wb.bom.duplicateKeys,
    rows,
    counts,
  };

  await db.insert(imports).values({
    id: importId,
    orgId,
    createdBy: userId,
    filename,
    byteSize: buf.byteLength,
    sha256: createHash("sha256").update(buf).digest("hex"),
    status: "previewed",
    inspection: jsonSafe({
      profile: "aftermarket-rev-b",
      sheets: wb.sheetNames,
      unread: wb.unread,
      bomCounts: wb.bom.counts,
      presetCounts: wb.bom.presetCounts,
    }).value,
    mapping: { profileId: "aftermarket-rev-b" },
    preview: jsonSafe(preview).value,
    rowsTotal: rows.length,
  });

  await audit({
    orgId,
    userId,
    action: "import.upload",
    entityType: "import",
    entityId: importId,
    detail: { filename, profile: "aftermarket-rev-b", kits: rows.length },
  });

  revalidatePath("/imports");
  return { ok: true as const, importId };
}

export async function commitAftermarketAction(importId: string) {
  const user = await requireCapability("product.import");
  const [row] = await db.select().from(imports).where(eq(imports.id, importId)).limit(1);
  if (!row) return { ok: false as const, error: "Import not found." };
  assertSameOrg(user, row.orgId);
  if (row.status === "committed") {
    return { ok: false as const, error: "This import has already been committed." };
  }

  const preview = row.preview as AftermarketPreview | null;
  if (!preview?.rows) return { ok: false as const, error: "This import has no preview to commit." };

  const applicable = preview.rows.filter((r) => r.productId && r.packLines.length > 0);
  const productIds = [...new Set(applicable.map((r) => r.productId!))];
  const CHUNK = 400;

  // Replace: this workbook is the authority for pack contents, so a line it no
  // longer lists must not survive on a card.
  for (let i = 0; i < productIds.length; i += CHUNK) {
    const slice = productIds.slice(i, i + CHUNK);
    const existingBoms = await db
      .select({ id: boms.id })
      .from(boms)
      .where(and(eq(boms.orgId, user.orgId), inArray(boms.productId, slice)));
    if (existingBoms.length) {
      const ids = existingBoms.map((b) => b.id);
      await db.delete(bomItems).where(inArray(bomItems.bomId, ids));
      await db.delete(boms).where(inArray(boms.id, ids));
    }
  }

  const bomRows: Array<typeof boms.$inferInsert> = [];
  const itemRows: Array<typeof bomItems.$inferInsert> = [];
  let presetsAssigned = 0;
  const presetConflicts: Array<{ partNumber: string; had: string; found: string }> = [];

  for (const r of applicable) {
    const bomId = nanoid(24);
    bomRows.push({
      id: bomId,
      orgId: user.orgId,
      productId: r.productId!,
      name: "Pack contents",
      revision: "Aftermarket Rev B",
      sourceImportId: importId,
      updatedAt: new Date(),
    });
    r.packLines.forEach((line, i) => {
      // The line is already written the way it prints; the parts are recovered
      // so the block can be re-formatted without re-reading the workbook.
      const m = line.match(/^\s*([\d.]+)\)\s*(.*?)(?:\s*\(([^()]*)\))?\s*$/);
      itemRows.push({
        id: nanoid(24),
        orgId: user.orgId,
        bomId,
        position: i,
        quantity: m?.[1] ?? "1",
        unitOfMeasure: "EA",
        name: m?.[2] ?? line,
        partNumber: m?.[3] ?? "",
        description: "",
      });
    });

    if (r.presetCode && PRESET_CODES.includes(r.presetCode as (typeof PRESET_CODES)[number])) {
      if (r.existingPreset && r.existingPreset !== r.presetCode) {
        presetConflicts.push({
          partNumber: r.partNumber,
          had: r.existingPreset,
          found: r.presetCode,
        });
      } else if (!r.existingPreset) {
        await db
          .update(products)
          .set({ defaultPresetCode: r.presetCode, updatedAt: new Date() })
          .where(eq(products.id, r.productId!));
        presetsAssigned += 1;
      }
    }
  }

  for (let i = 0; i < bomRows.length; i += CHUNK) {
    await db.insert(boms).values(bomRows.slice(i, i + CHUNK));
  }
  for (let i = 0; i < itemRows.length; i += CHUNK) {
    await db.insert(bomItems).values(itemRows.slice(i, i + CHUNK));
  }

  const report = {
    profile: "aftermarket-rev-b",
    bomsWritten: bomRows.length,
    packLinesWritten: itemRows.length,
    presetsAssigned,
    presetConflicts,
    unmatched: preview.rows.filter((r) => r.status === "unmatched").map((r) => ({
      partNumber: r.partNumber,
      upc: r.upc,
      description: r.description,
      reason: "Named in the workbook but not in the catalogue; not created.",
    })),
    duplicateUpcs: preview.duplicateKeys,
  };

  await db
    .update(imports)
    .set({
      status: "committed",
      report: jsonSafe(report).value,
      rowsUpdated: bomRows.length,
      rowsSkipped: report.unmatched.length,
      committedAt: new Date(),
      preview: {},
    })
    .where(eq(imports.id, importId));

  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: "import.commit",
    entityType: "import",
    entityId: importId,
    detail: {
      profile: "aftermarket-rev-b",
      boms: bomRows.length,
      lines: itemRows.length,
      presets: presetsAssigned,
    },
  });

  revalidatePath("/imports");
  revalidatePath("/products");
  return { ok: true as const, report };
}
