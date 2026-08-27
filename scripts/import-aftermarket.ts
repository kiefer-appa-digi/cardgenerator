/**
 * Imports the "Aftermarket Rev B" workbook: pack contents, card-preset
 * assignments and part-number cross references.
 *
 *   npm run import:aftermarket -- "docs/source/Aftermarket Rev B 2026.8.10.xlsx" [--dry-run]
 *
 * This workbook is the source for what a card actually says a pack contains. It
 * matches to products already in the catalogue — the GS1 export is authoritative
 * for identity — and adds only what it is the authority for. A kit it names that
 * the catalogue does not have is REPORTED, not created: a bill of materials is
 * not a product register, and inventing a sellable product from one is exactly
 * the kind of silent correction the specification forbids.
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../src/server/db/client";
import {
  bomItems,
  boms,
  brands,
  organizations,
  productIdentifiers,
  products,
} from "../src/server/db/schema";
import {
  readAftermarketWorkbook,
} from "../src/lib/import/profiles/aftermarket-workbook";
import { packLine, type MergedKit } from "../src/lib/import/profiles/aftermarket";
import { PRESET_CODES } from "../src/lib/geometry/presets";

type Report = {
  kitsRead: number;
  matchedByUpc: number;
  matchedByPart: number;
  unmatched: Array<{ partNumber: string; upc: string; description: string }>;
  bomsWritten: number;
  bomLinesWritten: number;
  presetsAssigned: number;
  presetConflicts: Array<{ partNumber: string; had: string; found: string }>;
  duplicateUpcs: number;
  skippedNoContents: number;
};

async function main() {
  const file = process.argv[2] ?? "docs/source/Aftermarket Rev B 2026.8.10.xlsx";
  const dryRun = process.argv.includes("--dry-run");

  const [org] = await db.select().from(organizations).limit(1);
  if (!org) throw new Error("No organisation. Run `npm run db:seed` first.");

  const wb = await readAftermarketWorkbook(fs.readFileSync(path.resolve(file)));
  console.log(
    `${path.basename(file)}: ${wb.sheetNames.length} sheets · ` +
      `${wb.bom.counts.kits} kits · ${wb.bom.counts.packContentLines} pack lines · ` +
      `${wb.bom.counts.kitsWithPreset} with a card preset ` +
      `(${wb.bom.counts.presetsBorrowed} taken from ${wb.bom.fallback?.sheetName ?? "the other sheet"})`,
  );
  for (const u of wb.unread) console.log(`  not read — ${u.sheet}: ${u.reason}`);
  if (wb.bom.counts.conflictedKeys) {
    console.log(
      `  ${wb.bom.counts.conflictedKeys} UPC(s) appear on more than one kit; those kits are reported, not merged.`,
    );
  }

  // The catalogue as it stands. Identity comes from the GS1 export; this
  // workbook only adds what it is the authority for.
  const existing = await db
    .select({
      id: products.id,
      partNumber: products.partNumber,
      defaultPresetCode: products.defaultPresetCode,
      brandName: brands.name,
    })
    .from(products)
    .leftJoin(brands, eq(brands.id, products.brandId))
    .where(eq(products.orgId, org.id));

  const identifiers = await db
    .select({ productId: productIdentifiers.productId, kind: productIdentifiers.kind, value: productIdentifiers.value })
    .from(productIdentifiers)
    .where(eq(productIdentifiers.orgId, org.id));

  const byUpc = new Map<string, string>();
  for (const i of identifiers) {
    if (i.kind === "gtin12" && i.value) byUpc.set(i.value, i.productId);
  }
  const byPart = new Map<string, string>();
  for (const p of existing) {
    const k = p.partNumber.trim().toUpperCase();
    // Ambiguous part numbers (the same SKU under two brands) are left out: a
    // wrong match writes the wrong pack contents onto a card.
    if (!k) continue;
    byPart.set(k, byPart.has(k) ? "" : p.id);
  }
  const presetOf = new Map(existing.map((p) => [p.id, p.defaultPresetCode]));

  const report: Report = {
    kitsRead: wb.bom.kits.length,
    matchedByUpc: 0,
    matchedByPart: 0,
    unmatched: [],
    bomsWritten: 0,
    bomLinesWritten: 0,
    presetsAssigned: 0,
    presetConflicts: [],
    duplicateUpcs: wb.bom.counts.conflictedKeys,
    skippedNoContents: 0,
  };

  type Plan = { productId: string; kit: MergedKit };
  const plans: Plan[] = [];

  for (const kit of wb.bom.kits) {
    let productId = kit.upc ? byUpc.get(kit.upc) : undefined;
    if (productId) report.matchedByUpc += 1;
    else {
      const byName = byPart.get(kit.partNumber.trim().toUpperCase());
      if (byName) {
        productId = byName;
        report.matchedByPart += 1;
      }
    }
    if (!productId) {
      report.unmatched.push({
        partNumber: kit.partNumber,
        upc: kit.upc,
        description: kit.description.slice(0, 60),
      });
      continue;
    }
    if (kit.packContents.length === 0) {
      report.skippedNoContents += 1;
      continue;
    }
    plans.push({ productId, kit });
  }

  console.log(
    `matched ${report.matchedByUpc} by UPC and ${report.matchedByPart} by part number; ` +
      `${report.unmatched.length} kits are not in the catalogue; ` +
      `${report.skippedNoContents} have no printable contents`,
  );

  if (dryRun) {
    console.log("\ndry run — nothing written");
    for (const u of report.unmatched.slice(0, 10)) {
      console.log(`  unmatched ${u.partNumber || "(no part number)"} ${u.upc} ${u.description}`);
    }
    return;
  }

  /* ------------------------------------------------------------- write */

  const productIds = [...new Set(plans.map((p) => p.productId))];
  const CHUNK = 400;

  // Replace: this workbook is the authority for pack contents, so a line it no
  // longer lists must not survive on the card.
  for (let i = 0; i < productIds.length; i += CHUNK) {
    const slice = productIds.slice(i, i + CHUNK);
    const existingBoms = await db
      .select({ id: boms.id })
      .from(boms)
      .where(and(eq(boms.orgId, org.id), inArray(boms.productId, slice)));
    if (existingBoms.length) {
      await db.delete(bomItems).where(inArray(bomItems.bomId, existingBoms.map((b) => b.id)));
      await db.delete(boms).where(inArray(boms.id, existingBoms.map((b) => b.id)));
    }
  }

  const bomRows: Array<typeof boms.$inferInsert> = [];
  const itemRows: Array<typeof bomItems.$inferInsert> = [];

  for (const { productId, kit } of plans) {
    const bomId = nanoid(24);
    bomRows.push({
      id: bomId,
      orgId: org.id,
      productId,
      name: "Pack contents",
      revision: "Aftermarket Rev B",
      updatedAt: new Date(),
    });
    kit.packContents.forEach((c, i) => {
      itemRows.push({
        id: nanoid(24),
        orgId: org.id,
        bomId,
        position: i,
        quantity: c.quantityText || String(c.quantity || 1),
        unitOfMeasure: "EA",
        name: c.name,
        partNumber: c.partNumber,
        description: "",
      });
    });
    report.bomsWritten += 1;
    report.bomLinesWritten += kit.packContents.length;

    if (kit.presetCode && PRESET_CODES.includes(kit.presetCode as (typeof PRESET_CODES)[number])) {
      const had = presetOf.get(productId);
      if (had && had !== kit.presetCode) {
        // The catalogue already says a different clamshell. Reported, not
        // overwritten: only the brand owner knows which is current.
        report.presetConflicts.push({ partNumber: kit.partNumber, had, found: kit.presetCode });
      } else if (!had) {
        await db
          .update(products)
          .set({ defaultPresetCode: kit.presetCode, updatedAt: new Date() })
          .where(eq(products.id, productId));
        report.presetsAssigned += 1;
      }
    }
  }

  for (let i = 0; i < bomRows.length; i += CHUNK) await db.insert(boms).values(bomRows.slice(i, i + CHUNK));
  for (let i = 0; i < itemRows.length; i += CHUNK) await db.insert(bomItems).values(itemRows.slice(i, i + CHUNK));

  console.log(
    `\nwrote ${report.bomsWritten} bills of materials, ${report.bomLinesWritten} pack lines, ` +
      `${report.presetsAssigned} card-preset assignments`,
  );
  if (report.presetConflicts.length) {
    console.log(`${report.presetConflicts.length} preset conflict(s), left as they were:`);
    for (const c of report.presetConflicts.slice(0, 8)) {
      console.log(`  ${c.partNumber}: catalogue says ${c.had}, workbook says ${c.found}`);
    }
  }
  if (report.unmatched.length) {
    console.log(`\n${report.unmatched.length} kits in the workbook are not in the catalogue:`);
    for (const u of report.unmatched.slice(0, 12)) {
      console.log(`  ${(u.partNumber || "(no part number)").padEnd(12)} ${u.upc.padEnd(14)} ${u.description}`);
    }
    console.log("  These were not created. A bill of materials is not a product register.");
  }

  // A sample, so the numbers above are checkable at a glance.
  const sample = plans.find((p) => p.kit.partNumber === "11-500") ?? plans[0];
  if (sample) {
    console.log(`\nsample — ${sample.kit.partNumber} (${sample.kit.upc}) preset ${sample.kit.presetCode ?? "unknown"}`);
    for (const line of sample.kit.packContents.map(packLine)) console.log(`  ${line}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
