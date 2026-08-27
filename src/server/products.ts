import { and, eq, inArray } from "drizzle-orm";
import {
  alternatePartNumbers,
  bomItems,
  boms,
  brands,
  db,
  fitments,
  productIdentifiers,
  productTranslations,
  products,
  warnings,
} from "@/server/db/client";
import { emptyProductContext, type ProductContext } from "@/lib/data/context";

/**
 * Build the ProductContext every binding resolves against.
 *
 * This is the single place the relational product model is flattened for
 * rendering. Everything downstream — the editor preview, preflight, the PDF
 * writer, batch generation — consumes the result, so a card generated today and
 * regenerated next year from the same snapshot produces the same words.
 */
export async function buildProductContext(
  orgId: string,
  productId: string,
): Promise<ProductContext | null> {
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.orgId, orgId), eq(products.id, productId)))
    .limit(1);
  const p = rows[0];
  if (!p) return null;

  const [brandRow] = p.brandId
    ? await db.select().from(brands).where(eq(brands.id, p.brandId)).limit(1)
    : [];

  const [ids, alts, fits, warns, translations, bomRows] = await Promise.all([
    db.select().from(productIdentifiers).where(eq(productIdentifiers.productId, p.id)),
    db.select().from(alternatePartNumbers).where(eq(alternatePartNumbers.productId, p.id)),
    db.select().from(fitments).where(eq(fitments.productId, p.id)),
    db.select().from(warnings).where(eq(warnings.productId, p.id)),
    db.select().from(productTranslations).where(eq(productTranslations.productId, p.id)),
    db.select().from(boms).where(eq(boms.productId, p.id)),
  ]);

  const items = bomRows.length
    ? await db
        .select()
        .from(bomItems)
        .where(inArray(bomItems.bomId, bomRows.map((b) => b.id)))
    : [];

  const idOf = (kind: string) => ids.find((i) => i.kind === kind)?.value ?? "";

  const sortedItems = [...items].sort((a, b) => a.position - b.position);
  const bomContext = sortedItems.map((i, idx) => ({
    quantity: Number(i.quantity) || 0,
    quantityText: i.quantity,
    name: i.name,
    partNumber: i.partNumber,
    description: i.description,
    position: idx + 1,
    unitOfMeasure: i.unitOfMeasure,
  }));

  const translationMap: Record<string, Record<string, string>> = {};
  for (const t of translations) {
    translationMap[t.locale] ??= {};
    translationMap[t.locale][t.field] = t.value;
  }

  const ctx: ProductContext = {
    ...emptyProductContext(),
    id: p.id,
    partNumber: p.partNumber,
    productName: p.productName || p.description,
    description: p.description,
    descriptionShort: p.descriptionShort,
    labelDescription: p.labelDescription,
    subtitle: p.subtitle,
    countryOfOrigin: p.countryOfOrigin,
    status: p.status,
    packagingLevel: p.packagingLevel,
    netContent: [p.netContentCount, p.netContentUom].filter(Boolean).join(" "),
    brand: {
      name: brandRow?.name ?? "",
      legalName: brandRow?.legalName ?? "",
      statement: brandRow?.statement ?? "",
      logoAssetId: brandRow?.logoAssetId ?? null,
    },
    identifiers: {
      gtin14: idOf("gtin14"),
      gtin13: idOf("gtin13"),
      upc12: idOf("gtin12"),
      sku: idOf("sku") || p.partNumber,
      gs1CompanyPrefix: idOf("gs1CompanyPrefix"),
    },
    alternatePartNumbers: [...alts].sort((a, b) => a.position - b.position).map((a) => a.value),
    fitments: [...fits].sort((a, b) => a.position - b.position).map((f) => f.text),
    warnings: [...warns].sort((a, b) => a.position - b.position).map((w) => w.text),
    translations: translationMap,
    bom: {
      items: bomContext,
      packIncludes: bomContext
        .map((i) => `${i.quantityText}) ${i.name}${i.partNumber ? ` (${i.partNumber})` : ""}`)
        .join("\n"),
      itemCount: bomContext.length,
    },
    custom: (p.custom ?? {}) as Record<string, string>,
  };

  return ctx;
}

/**
 * A sample context used when a template is edited without a product attached, so
 * the artboard shows realistic copy lengths instead of empty boxes. It is
 * clearly labelled in the UI as sample data and is never written to a revision.
 */
export function sampleProductContext(): ProductContext {
  return {
    ...emptyProductContext(),
    id: "sample",
    partNumber: "11-500",
    productName: "Bearing & Seal Kit",
    description: "GENUINE AXLETEK 3.5K BEARING & SEAL KIT L44649 / L68149",
    descriptionShort: "3.5K Bearing & Seal Kit",
    labelDescription: "BEARING & SEAL KIT 3.5K",
    subtitle: "L44649 · L68149 · 10-36 Seal",
    countryOfOrigin: "Made in China",
    status: "In Use",
    packagingLevel: "Each",
    netContent: "1 KIT",
    brand: {
      name: "Axle Teknology",
      legalName: "Axle Teknology",
      statement:
        "Genuine AxleTek components are built to the original equipment specification for trailer axle service.",
      logoAssetId: null,
    },
    identifiers: {
      gtin14: "00810797030124",
      gtin13: "0810797030124",
      upc12: "810797030124",
      sku: "11-500",
      gs1CompanyPrefix: "081079703",
    },
    alternatePartNumbers: ["L44649", "L68149", "10-36"],
    fitments: [
      "Fits 3,500 lb trailer axles with 1-1/16 in and 1-3/8 in spindles",
      "Replaces Dexter 031-016-00 and 031-018-00",
    ],
    warnings: [
      "WARNING: This product can expose you to chemicals including lead, known to the State of California to cause cancer and reproductive harm. www.P65Warnings.ca.gov",
    ],
    translations: {
      es: { productName: "Kit de rodamientos y sellos", subtitle: "Para ejes de 3,500 lb" },
      fr: { productName: "Ensemble roulements et joints", subtitle: "Pour essieux de 1 590 kg" },
    },
    bom: {
      items: [
        { quantity: 2, quantityText: "2", name: "Inner Bearing", partNumber: "L44643", description: "", position: 1, unitOfMeasure: "EA" },
        { quantity: 2, quantityText: "2", name: "Outer Bearing", partNumber: "L68111", description: "", position: 2, unitOfMeasure: "EA" },
        { quantity: 2, quantityText: "2", name: "Grease Seal", partNumber: "10-36", description: "", position: 3, unitOfMeasure: "EA" },
        { quantity: 2, quantityText: "2", name: "Cotter Pin", partNumber: "CP-125", description: "", position: 4, unitOfMeasure: "EA" },
        { quantity: 1, quantityText: "1", name: "Spindle Nut", partNumber: "SN-116", description: "", position: 5, unitOfMeasure: "EA" },
      ],
      packIncludes:
        "2) Inner Bearing (L44643)\n2) Outer Bearing (L68111)\n2) Grease Seal (10-36)\n2) Cotter Pin (CP-125)\n1) Spindle Nut (SN-116)",
      itemCount: 5,
    },
    custom: {},
  };
}
