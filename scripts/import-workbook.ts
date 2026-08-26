/**
 * Command-line importer.
 *
 * Runs the identical pipeline the UI runs — inspect, suggest a mapping, build a
 * preview, plan, apply — so a scheduled or scripted catalogue load behaves
 * exactly like an operator clicking through the wizard. Useful for CI fixtures
 * and for the first load of a large workbook.
 *
 *   npm run import:workbook -- docs/source/ExportAllProducts_20260826220203076.xlsx
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../src/server/db/client";
import { brands, imports, organizations, productIdentifiers, products } from "../src/server/db/schema";
import { parseWorkbook, readParsedSheetRows, inspectParsedWorkbook } from "../src/lib/import/inspect";
import { suggestMapping } from "../src/lib/import/mapping";
import { buildPreview } from "../src/lib/import/preview";
import { planImport } from "../src/lib/import/commit";
import type { ExistingProduct } from "../src/lib/import/types";
import { applyImportPlan } from "../src/server/import-apply";

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: tsx scripts/import-workbook.ts <workbook.xlsx> [--dry-run]");
    process.exit(1);
  }
  const dryRun = process.argv.includes("--dry-run");

  const [org] = await db.select().from(organizations).limit(1);
  if (!org) throw new Error("No organisation found. Run `npm run db:seed` first.");

  const buf = fs.readFileSync(path.resolve(file));
  const parsed = await parseWorkbook(buf);
  const inspection = inspectParsedWorkbook(parsed);
  const read = readParsedSheetRows(parsed, {});
  const mapping = suggestMapping(read.headers, { sheetName: read.sheetName });

  console.log(`sheet "${read.sheetName}" · ${read.rows.length} rows · profile ${mapping.profileId}`);
  console.log(`mapped fields: ${mapping.mappedFields.length}`);
  if (mapping.missingRequired.length) {
    console.log(`missing required: ${mapping.missingRequired.join(", ")}`);
  }

  const existing = await loadExisting(org.id);
  const preview = buildPreview({
    orgId: org.id,
    sheetName: read.sheetName,
    mapping,
    rows: read.rows,
    existing,
  });

  console.log(
    `preview: create ${preview.summary.create} · update ${preview.summary.update} · ` +
      `unchanged ${preview.summary.unchanged} · skip ${preview.summary.skip} · ` +
      `invalid GTIN ${preview.summary.invalidGtins}`,
  );

  if (dryRun) {
    console.log("dry run — nothing written");
    return;
  }
  if (!preview.committable) {
    console.error("preview is not committable; resolve the blocking findings first");
    process.exit(2);
  }

  const importId = nanoid(24);
  await db.insert(imports).values({
    id: importId,
    orgId: org.id,
    filename: path.basename(file),
    byteSize: buf.byteLength,
    sha256: createHash("sha256").update(buf).digest("hex"),
    status: "previewed",
    inspection,
    mapping,
    rowsTotal: preview.rows.length,
  });

  const plan = planImport(preview, { importId });
  const report = await applyImportPlan(org.id, plan, importId);

  await db
    .update(imports)
    .set({
      status: "committed",
      report: { ...report, counts: plan.counts, skipped: plan.skipped },
      rowsCreated: report.created,
      rowsUpdated: report.updated,
      rowsSkipped: plan.skipped.length,
      committedAt: new Date(),
    })
    .where(eq(imports.id, importId));

  console.log(
    `committed: ${report.created} created · ${report.updated} updated · ` +
      `${report.identifiers} identifiers · ${report.bomItems} pack-contents lines · ` +
      `${report.errors.length} failed`,
  );
  if (report.partNumberFromSku) {
    console.log(`${report.partNumberFromSku} part numbers taken from the SKU column`);
  }
  for (const e of report.errors.slice(0, 10)) console.log(`  row ${e.rowNumber}: ${e.message}`);
}

async function loadExisting(orgId: string): Promise<ExistingProduct[]> {
  const rows = await db
    .select({
      id: products.id,
      partNumber: products.partNumber,
      brandName: brands.name,
      description: products.description,
      status: products.status,
    })
    .from(products)
    .leftJoin(brands, eq(brands.id, products.brandId))
    .where(eq(products.orgId, orgId));
  const ids = await db
    .select({
      productId: productIdentifiers.productId,
      kind: productIdentifiers.kind,
      value: productIdentifiers.value,
    })
    .from(productIdentifiers)
    .where(eq(productIdentifiers.orgId, orgId));
  const byProduct = new Map<string, Record<string, string>>();
  for (const i of ids) {
    const m = byProduct.get(i.productId) ?? {};
    m[i.kind] = i.value;
    byProduct.set(i.productId, m);
  }
  return rows.map((r) => {
    const identifiers = byProduct.get(r.id) ?? {};
    return {
      id: r.id,
      partNumber: r.partNumber,
      brandName: r.brandName ?? "",
      gtins: Object.entries(identifiers)
        .filter(([k]) => k.startsWith("gtin"))
        .map(([, v]) => v)
        .filter(Boolean),
      fields: {
        description: r.description,
        status: r.status,
        partNumber: r.partNumber,
        brandName: r.brandName ?? "",
      },
    };
  });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
