/**
 * Loads the supplied brand artwork into the asset library and wires the master
 * templates' logo slots to it, so a freshly seeded install produces a complete
 * card rather than two "missing asset" placeholders.
 *
 * Two colourways are loaded per brand mark: the full-colour lockup for the
 * process front and the black lockup for the grayscale back.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import { db } from "../src/server/db/client";
import { assets, brands, cardTemplates, organizations } from "../src/server/db/schema";
import { putAsset } from "../src/server/storage";
import { DesignDocSchema } from "../src/lib/design/schema";

const BRAND_DIR = path.join(process.cwd(), "public", "brand");

const WANTED = [
  { file: "full-color.png", role: "front" as const, grayscale: false },
  // The grayscale back is a genuinely grayscale asset, not a black-looking sRGB
  // one. Placing an sRGB file on a side costed for one plate is a real defect
  // and preflight says so, so the seed produces a file that passes rather than a
  // file that merely looks right.
  { file: "full-black.png", role: "back" as const, grayscale: true },
];

async function main() {
  const [org] = await db.select().from(organizations).limit(1);
  if (!org) throw new Error("No organisation. Run `npm run db:seed` first.");

  const ids: Record<"front" | "back", string> = { front: "", back: "" };

  for (const w of WANTED) {
    const p = path.join(BRAND_DIR, w.file);
    if (!fs.existsSync(p)) {
      console.warn(`missing ${p}, skipping`);
      continue;
    }
    const source = fs.readFileSync(p);
    // Flattened onto white as well as converted: a gray+alpha PNG is colour type
    // 4, which pdf-lib expands to RGBA and embeds as DeviceRGB. Dropping the
    // alpha gives colour type 0, which embeds as DeviceGray — one plate, which
    // is what a black-and-white back is costed for.
    const bytes = w.grayscale
      ? new Uint8Array(
          await sharp(source)
            .flatten({ background: "#ffffff" })
            .toColourspace("b-w")
            .png({ palette: false })
            .toBuffer(),
        )
      : new Uint8Array(source);
    const meta = await sharp(Buffer.from(bytes)).metadata();

    const filename = w.grayscale ? w.file.replace(/\.png$/, "-gray.png") : w.file;
    const [existing] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.orgId, org.id), eq(assets.filename, filename)))
      .limit(1);
    if (existing) {
      ids[w.role] = existing.id;
      console.log(`asset exists: ${filename}`);
      continue;
    }

    const stored = await putAsset(org.id, filename, bytes, "image/png");
    const id = nanoid(24);
    await db.insert(assets).values({
      id,
      orgId: org.id,
      filename,
      contentType: "image/png",
      byteSize: bytes.byteLength,
      storageKey: stored.key,
      storageUrl: stored.url,
      pixelWidth: meta.width ?? null,
      pixelHeight: meta.height ?? null,
      declaredDpi: meta.density ?? null,
      colorSpace: meta.space ?? "unknown",
      hasAlpha: Boolean(meta.hasAlpha),
      hasIccProfile: Boolean(meta.icc),
      sha256: stored.sha256,
      scanStatus: "skipped",
      scanDetail: "Supplied brand artwork, loaded by scripts/seed-assets.ts.",
    });
    ids[w.role] = id;
    console.log(`uploaded ${filename} (${meta.width}×${meta.height}, ${meta.space})`);
  }

  const brandRows = await db.select().from(brands).where(eq(brands.orgId, org.id));
  for (const b of brandRows) {
    if (!b.logoAssetId && ids.front) {
      await db.update(brands).set({ logoAssetId: ids.front }).where(eq(brands.id, b.id));
    }
  }

  // Point every master template's logo slots at the right colourway.
  const tpls = await db.select().from(cardTemplates).where(eq(cardTemplates.orgId, org.id));
  let patched = 0;
  for (const t of tpls) {
    const parsed = DesignDocSchema.safeParse(t.doc);
    if (!parsed.success) continue;
    const doc = parsed.data;
    let changed = false;
    for (const side of ["front", "back"] as const) {
      doc[side] = {
        ...doc[side],
        elements: doc[side].elements.map((el) => {
          if (el.kind !== "image") return el;
          if (!/logo/i.test(el.id) && !/logo/i.test(el.name)) return el;
          const want = side === "front" ? ids.front : ids.back;
          if (!want || el.assetId === want) return el;
          changed = true;
          return { ...el, assetId: want };
        }),
      };
    }
    if (changed) {
      await db
        .update(cardTemplates)
        .set({ doc, version: t.version + 1, updatedAt: new Date() })
        .where(eq(cardTemplates.id, t.id));
      patched += 1;
    }
  }
  console.log(`patched ${patched} template(s) with brand logo assets`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
