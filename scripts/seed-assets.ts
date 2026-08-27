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
  // The identity package ships sRGB artwork. A production card is separated
  // CMYK, so the front logo is converted here and the conversion is recorded on
  // the asset: it is a numeric transform, not an ICC one, and preflight raises
  // an INFO saying the separation is unverified until the brand supplies
  // vendor-separated artwork. Converting silently and calling the result "CMYK"
  // would be exactly the sort of quiet lie spec §14 forbids.
  { file: "full-color.png", role: "front" as const, grayscale: false, cmyk: true },
  // The grayscale back is a genuinely grayscale asset, not a black-looking sRGB
  // one. Placing an sRGB file on a side costed for one plate is a real defect
  // and preflight says so, so the seed produces a file that passes rather than a
  // file that merely looks right.
  { file: "full-black.png", role: "back" as const, grayscale: true, cmyk: false },
  // Reversed mark for artwork that sits on a dark band. It stays a PNG with its
  // alpha channel intact: flattening it would put a white box on the black, and
  // a CMYK JPEG cannot carry transparency at all. That costs a DeviceRGB image
  // in the export, which preflight reports honestly — the fix is a reversed mark
  // supplied as CMYK or spot artwork, which the brand has not provided.
  { file: "full-white.png", role: "reversed" as const, grayscale: false, cmyk: false },
];

async function main() {
  const [org] = await db.select().from(organizations).limit(1);
  if (!org) throw new Error("No organisation. Run `npm run db:seed` first.");

  const ids: Record<"front" | "back" | "reversed", string> = { front: "", back: "", reversed: "" };

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
    // JPEG rather than PNG for the grayscale back: pdf-lib's PNG decoder always
    // produces DeviceRGB, so a grayscale PNG would arrive at the press as three
    // plates. A single-channel JPEG embeds as DeviceGray — one plate, which is
    // what a black-and-white back is costed for.
    const bytes = w.grayscale
      ? new Uint8Array(
          await sharp(source)
            .flatten({ background: "#ffffff" })
            .toColourspace("b-w")
            .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
            .toBuffer(),
        )
      : w.cmyk
        ? new Uint8Array(
            await sharp(source)
              .flatten({ background: "#ffffff" })
              .toColourspace("cmyk")
              .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
              .toBuffer(),
          )
        : new Uint8Array(source);
    const meta = await sharp(Buffer.from(bytes)).metadata();

    const filename = w.grayscale
      ? w.file.replace(/\.png$/, "-gray.jpg")
      : w.cmyk
        ? w.file.replace(/\.png$/, "-cmyk.jpg")
        : w.file;
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

    const contentType = w.cmyk || w.grayscale ? "image/jpeg" : "image/png";
    const stored = await putAsset(org.id, filename, bytes, contentType);
    const id = nanoid(24);
    await db.insert(assets).values({
      id,
      orgId: org.id,
      filename,
      contentType,
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
      scanDetail: w.cmyk
        ? "Supplied brand artwork, separated to CMYK numerically by scripts/seed-assets.ts. The separation is not ICC-managed; replace with vendor-separated artwork before a production run."
        : "Supplied brand artwork, loaded by scripts/seed-assets.ts.",
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
          const isLogo = /logo|mark/i.test(el.id) || /logo|mark/i.test(el.name);
          if (!isLogo) return el;
          // A slot whose name says "reversed" needs the white mark whichever
          // side it is on; otherwise the front takes colour and the back mono.
          const reversed = /revers/i.test(el.name) || /revers/i.test(el.id);
          const want = reversed ? ids.reversed : side === "front" ? ids.front : ids.back;
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
