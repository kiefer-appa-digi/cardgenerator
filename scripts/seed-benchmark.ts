/**
 * Seeds the pack-contents, fitment, alternate-number, warning and origin data
 * for the 11-500 benchmark product (spec §23).
 *
 * The supplied GS1 export carries identity and identifiers only, and the
 * Aftermarket workbook carries pack contents but no fitment, translation or
 * compliance copy. This fills only that remaining gap, from the sample 11-500
 * package described in the brief, and every product it touches is marked in
 * `custom.benchmarkSource` so seeded copy is never mistaken for source data.
 *
 * It deliberately does NOT write pack contents any more: `npm run
 * import:aftermarket` reads the real bill of materials, and a seeded guess
 * sitting alongside real data is worse than no guess at all.
 */
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../src/server/db/client";
import {
  alternatePartNumbers,
  bomItems,
  boms,
  brands,
  fitments,
  organizations,
  productTranslations,
  products,
  warnings,
} from "../src/server/db/schema";

const BENCHMARK = {
  partNumber: "11-500",
  productName: "Bearing & Seal Kit",
  subtitle: "L44649 · L68149 · 10-36 Seal",
  countryOfOrigin: "Made in China",
  fitments: [
    "Fits 3,500 lb trailer axles with 1-1/16 in and 1-3/8 in spindles",
    "Replaces Dexter 031-016-00 and 031-018-00",
  ],
  alternates: ["L44649", "L68149", "10-36", "031-016-00"],
  warnings: [
    "WARNING: This product can expose you to chemicals including lead, known to the State of California to cause cancer and reproductive harm. www.P65Warnings.ca.gov",
  ],
  translations: {
    es: { productName: "Kit de rodamientos y sellos", subtitle: "Para ejes de 3,500 lb" },
    fr: { productName: "Ensemble roulements et joints", subtitle: "Pour essieux de 1 590 kg" },
  },
};

const BRAND_STATEMENT =
  "Genuine AxleTek components are manufactured to the original equipment specification for trailer axle service. Use only complete kits; mixing worn and new components will shorten bearing life.";

async function main() {
  const [org] = await db.select().from(organizations).limit(1);
  if (!org) throw new Error("No organisation. Run `npm run db:seed` first.");

  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.orgId, org.id), eq(products.partNumber, BENCHMARK.partNumber)))
    .limit(1);
  if (!product) {
    throw new Error(
      `Product ${BENCHMARK.partNumber} is not in the catalogue. Import the workbook first.`,
    );
  }

  await db
    .update(products)
    .set({
      productName: BENCHMARK.productName,
      subtitle: BENCHMARK.subtitle,
      countryOfOrigin: BENCHMARK.countryOfOrigin,
      custom: {
        ...((product.custom ?? {}) as Record<string, string>),
        benchmarkSource: "11-500 sample package, seeded by scripts/seed-benchmark.ts",
      },
      updatedAt: new Date(),
    })
    .where(eq(products.id, product.id));

  if (product.brandId) {
    await db
      .update(brands)
      .set({ statement: BRAND_STATEMENT, updatedAt: new Date() })
      .where(eq(brands.id, product.brandId));
  }

  await db.delete(fitments).where(eq(fitments.productId, product.id));
  await db.insert(fitments).values(
    BENCHMARK.fitments.map((text, i) => ({
      id: nanoid(24), orgId: org.id, productId: product.id,
      kind: i === 0 ? "fits" : "replaces", text, position: i,
    })),
  );

  await db.delete(alternatePartNumbers).where(eq(alternatePartNumbers.productId, product.id));
  await db.insert(alternatePartNumbers).values(
    BENCHMARK.alternates.map((value, i) => ({
      id: nanoid(24), orgId: org.id, productId: product.id,
      value, relation: "interchange", position: i,
    })),
  );

  await db.delete(warnings).where(eq(warnings.productId, product.id));
  await db.insert(warnings).values(
    BENCHMARK.warnings.map((text, i) => ({
      id: nanoid(24), orgId: org.id, productId: product.id,
      code: "P65", text, position: i,
    })),
  );

  await db.delete(productTranslations).where(eq(productTranslations.productId, product.id));
  const rows = Object.entries(BENCHMARK.translations).flatMap(([locale, fieldsObj]) =>
    Object.entries(fieldsObj).map(([field, value]) => ({
      id: nanoid(24), orgId: org.id, productId: product.id, locale, field, value,
    })),
  );
  await db.insert(productTranslations).values(rows);

  const [bomRow] = await db.select().from(boms).where(eq(boms.productId, product.id)).limit(1);
  const bomLines = bomRow
    ? (await db.select().from(bomItems).where(eq(bomItems.bomId, bomRow.id))).length
    : 0;

  console.log(
    `Seeded 11-500 benchmark: ${BENCHMARK.alternates.length} alternate numbers, ` +
      `${BENCHMARK.fitments.length} fitment lines, ${rows.length} translation values, ` +
      `country of origin and the brand statement.`,
  );
  console.log(
    bomLines
      ? `Pack contents left alone: ${bomLines} real lines from the Aftermarket workbook.`
      : "No pack contents on this product yet — run `npm run import:aftermarket`.",
  );
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
