/**
 * Produces the sample production and proof PDFs the specification asks for
 * (§31.23 and §31.24): one of each for all three presets, built from the
 * 11-500 benchmark product through the same code path the application uses.
 *
 * Writes to artifacts/pdf/ and prints the measured page geometry so the numbers
 * can be checked without opening the files.
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "../src/server/db/client";
import { assets, cardTemplates, organizations, products } from "../src/server/db/schema";
import { buildProductContext } from "../src/server/products";
import { readAsset } from "../src/server/storage";
import { DesignDocSchema } from "../src/lib/design/schema";
import { planDocument, type AssetInfo } from "../src/lib/design/plan";
import { runPreflight } from "../src/lib/preflight/engine";
import { renderProductionPdf } from "../src/lib/pdf/production";
import { renderProofPdf } from "../src/lib/pdf/proof";
import { expectationForPlans, validateProductionPdf } from "../src/lib/pdf/validate";
import { BlackRulesSchema, OutputIntentSchema } from "../src/lib/color/types";
import { PreflightProfileSchema } from "../src/lib/preflight/types";
import { CARD_PRESETS, PRESET_CODES } from "../src/lib/geometry/presets";
import { uptToIn, uptToPt } from "../src/lib/units";

const OUT = path.join(process.cwd(), "artifacts", "pdf");
const BENCHMARK_PART = process.env.SAMPLE_PART ?? "11-500";
// Fixed so two runs of this script produce byte-identical files.
const STAMP = new Date("2026-08-26T23:00:00Z");

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const [org] = await db.select().from(organizations).limit(1);
  if (!org) throw new Error("No organisation. Run `npm run db:seed` first.");

  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.orgId, org.id), eq(products.partNumber, BENCHMARK_PART)))
    .limit(1);
  if (!product) throw new Error(`Product ${BENCHMARK_PART} is not in the catalogue.`);

  const ctx = await buildProductContext(org.id, product.id);
  if (!ctx) throw new Error("Could not build the product context.");

  const assetRows = await db.select().from(assets).where(eq(assets.orgId, org.id));
  const assetMap = new Map<string, AssetInfo>(
    assetRows.map((a) => [
      a.id,
      {
        id: a.id,
        pixelWidth: a.pixelWidth,
        pixelHeight: a.pixelHeight,
        colorSpace: a.colorSpace,
        contentType: a.contentType,
        hasIccProfile: a.hasIccProfile,
      },
    ]),
  );
  const assetBytes = async (assetId: string) => {
    const a = assetRows.find((r) => r.id === assetId);
    if (!a) return null;
    const bytes = await readAsset(a.storageUrl || a.storageKey);
    return bytes ? { bytes, contentType: a.contentType } : null;
  };

  const settings = (org.settings ?? {}) as Record<string, unknown>;
  const profile = PreflightProfileSchema.parse((settings.preflightProfile as object) ?? {});
  const blackRules = BlackRulesSchema.parse((settings.blackRules as object) ?? {});
  const outputIntent = OutputIntentSchema.parse((settings.outputIntent as object) ?? {});

  for (const code of PRESET_CODES) {
    const [tpl] = await db
      .select()
      .from(cardTemplates)
      .where(and(eq(cardTemplates.orgId, org.id), eq(cardTemplates.presetCode, code)))
      .limit(1);
    if (!tpl) {
      console.log(`${code}: no template — run \`npm run seed:templates\``);
      continue;
    }
    const doc = DesignDocSchema.parse(tpl.doc);
    const plans = planDocument({ doc, product: ctx, assets: assetMap });
    const report = runPreflight({
      doc, plans, product: ctx, profile, blackRules, outputIntent, assets: assetMap,
    });

    const production = await renderProductionPdf({
      plans,
      assetBytes,
      timestamp: STAMP,
      metadata: {
        title: `${BENCHMARK_PART} — ${code} sample`,
        author: "Freedom Trailer Parts Card Designer",
        subject: ctx.description,
      },
    });
    const prodPath = path.join(OUT, `${BENCHMARK_PART}-${code}-production.pdf`);
    fs.writeFileSync(prodPath, production.bytes);

    const proof = await renderProofPdf({
      plans,
      assetBytes,
      timestamp: STAMP,
      info: {
        cardName: `${BENCHMARK_PART} — ${code}`,
        sku: ctx.identifiers.sku,
        gtin: ctx.identifiers.gtin14,
        presetCode: code,
        revision: "sample",
        approvalStatus: "Sample — not approved for production",
        exportedAt: STAMP.toISOString().replace("T", " ").slice(0, 19) + " UTC",
        productName: ctx.productName,
        preflight: report,
      },
    });
    const proofPath = path.join(OUT, `${BENCHMARK_PART}-${code}-proof.pdf`);
    fs.writeFileSync(proofPath, proof.bytes);

    const validation = await validateProductionPdf(
      production.bytes,
      expectationForPlans({ presetCode: code, plans, options: { minImageDpi: profile.minImageDpi } }),
    );

    const preset = CARD_PRESETS[code];
    const w = preset.trimWidth + preset.bleed.left + preset.bleed.right;
    const h = preset.trimHeight + preset.bleed.top + preset.bleed.bottom;
    console.log(
      `${code}  page ${uptToPt(w).toFixed(3)} × ${uptToPt(h).toFixed(3)} pt ` +
        `(${uptToIn(w).toFixed(5)} × ${uptToIn(h).toFixed(5)} in)  ` +
        `production ${(production.bytes.byteLength / 1024).toFixed(0)} KB, ` +
        `proof ${(proof.bytes.byteLength / 1024).toFixed(0)} KB  ` +
        `validation ${validation.passed ? "PASS" : `FAIL (${validation.counts.fail})`}  ` +
        `preflight ${report.counts.blocking}B/${report.counts.error}E/${report.counts.warning}W`,
    );
    if (!validation.passed) {
      for (const c of validation.checks.filter((x) => x.status === "fail")) {
        console.log(`    FAIL ${c.id}: ${c.detail}`);
      }
    }
    console.log(`    ${path.relative(process.cwd(), prodPath)}`);
    console.log(`    ${path.relative(process.cwd(), proofPath)}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
