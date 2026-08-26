/**
 * Seed: organisation, the four roles' default users, brands and the three card
 * presets. Idempotent — safe to re-run against an existing database.
 *
 * The default gate account's password comes from SEED_ADMIN_PASSWORD. It is
 * hashed with bcrypt before it touches the database and is never written to any
 * file the repository tracks.
 */
import { config } from "dotenv";
config({ path: [".env.local", ".env"] });
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "./client";
import { brands, cardPresets, organizations, packageTypes, users } from "./schema";
import { hashPassword } from "../auth/password";
import { CARD_PRESETS, PRESET_CODES } from "@/lib/geometry/presets";
import { BRAND_SWATCHES } from "@/lib/color/types";

const ORG_SLUG = "freedom-trailer-parts";

async function main() {
  const email = (process.env.SEED_ADMIN_EMAIL ?? "kiefer@towparts.com").toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) {
    throw new Error(
      "SEED_ADMIN_PASSWORD is not set. Set it in the environment before seeding; it is never stored in the repo.",
    );
  }

  let org = (await db.select().from(organizations).where(eq(organizations.slug, ORG_SLUG)).limit(1))[0];
  if (!org) {
    const id = nanoid(24);
    await db.insert(organizations).values({
      id,
      name: "Freedom Trailer Parts",
      slug: ORG_SLUG,
      settings: {
        blackRules: {
          textBlack: { space: "cmyk", c: 0, m: 0, y: 0, k: 1000 },
          richBlack: { space: "cmyk", c: 600, m: 400, y: 400, k: 1000 },
          totalAreaCoverageLimit: 3000,
          richBlackMinTextSize: 14_000_000,
        },
        preflightProfile: { name: "Default sheetfed CMYK" },
        outputIntent: {
          identifier: "none",
          conditionName: "Not specified — configure per printer",
          registryName: "",
          info: "No ICC output intent has been configured for this deployment. Production PDFs are DeviceCMYK with no OutputIntent; see /docs/print-pipeline.md.",
        },
        exportPolicy: { treatErrorAsBlocking: false, allowOverride: true },
      },
      updatedAt: new Date(),
    });
    org = (await db.select().from(organizations).where(eq(organizations.id, id)).limit(1))[0];
    console.log("created organization", org.name);
  } else {
    console.log("organization exists:", org.name);
  }

  const existingAdmin = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  const hash = await hashPassword(password);
  if (!existingAdmin) {
    await db.insert(users).values({
      id: nanoid(24),
      orgId: org.id,
      email,
      name: "Kiefer",
      passwordHash: hash,
      role: "admin",
      active: true,
      updatedAt: new Date(),
    });
    console.log("created admin", email);
  } else {
    await db
      .update(users)
      .set({ passwordHash: hash, active: true, failedLoginCount: 0, lockedUntil: null, role: "admin" })
      .where(eq(users.id, existingAdmin.id));
    console.log("reset admin password for", email);
  }

  // The brands present in the supplied GS1 export, so an import lands on real
  // records rather than inventing new brands mid-import.
  const brandNames = [
    { name: "Axle Teknology", legalName: "Axle Teknology", statement: "Genuine AxleTek replacement parts — engineered for trailer axle service." },
    { name: "TowPro", legalName: "TowPro", statement: "TowPro trailer components." },
    { name: "ProAxle", legalName: "ProAxle", statement: "ProAxle trailer components." },
    { name: "Carry On Trailers", legalName: "Carry-On Trailer Corp.", statement: "" },
    { name: "Axle Tek", legalName: "Axle Teknology", statement: "" },
    { name: "AxleTek", legalName: "Axle Teknology", statement: "" },
    { name: "Freedom Trailer Parts", legalName: "Freedom Trailer Parts", statement: "Freedom Trailer Parts — trailer service components." },
  ];
  for (const b of brandNames) {
    const found = (
      await db.select().from(brands).where(and(eq(brands.orgId, org.id), eq(brands.name, b.name))).limit(1)
    )[0];
    if (found) continue;
    await db.insert(brands).values({
      id: nanoid(24),
      orgId: org.id,
      name: b.name,
      legalName: b.legalName,
      statement: b.statement,
      swatches: BRAND_SWATCHES,
      updatedAt: new Date(),
    });
    console.log("created brand", b.name);
  }

  for (const code of PRESET_CODES) {
    const p = CARD_PRESETS[code];
    const existingPkg = (
      await db.select().from(packageTypes).where(and(eq(packageTypes.orgId, org.id), eq(packageTypes.code, code))).limit(1)
    )[0];
    let pkgId = existingPkg?.id;
    if (!pkgId) {
      pkgId = nanoid(24);
      await db.insert(packageTypes).values({
        id: pkgId,
        orgId: org.id,
        code,
        name: `${code} clamshell`,
        vendor: "Sinclair & Rush (StockCap / VisiPak)",
        material: `${p.cadReference.material}, ${p.cadReference.sheetThicknessIn} in sheet, ${p.cadReference.color}`,
        notes: `Drawing ${p.cadReference.drawingNumber} rev ${p.cadReference.revision}, drawn ${p.cadReference.drawnDate}. Source: ${p.cadReference.sourceFile}`,
        cadReference: p.cadReference,
      });
    }

    const existing = (
      await db.select().from(cardPresets).where(and(eq(cardPresets.orgId, org.id), eq(cardPresets.code, code))).limit(1)
    )[0];
    const values = {
      orgId: org.id,
      packageTypeId: pkgId,
      code,
      name: p.name,
      description: p.description,
      trimWidth: p.trimWidth,
      trimHeight: p.trimHeight,
      cornerRadius: p.cornerRadius,
      bleedTop: p.bleed.top,
      bleedRight: p.bleed.right,
      bleedBottom: p.bleed.bottom,
      bleedLeft: p.bleed.left,
      safeTop: p.safeArea.top,
      safeRight: p.safeArea.right,
      safeBottom: p.safeArea.bottom,
      safeLeft: p.safeArea.left,
      cavity: p.cavity,
      cadReference: p.cadReference,
    };
    if (existing) {
      await db.update(cardPresets).set(values).where(eq(cardPresets.id, existing.id));
      console.log("updated preset", code);
    } else {
      await db.insert(cardPresets).values({ id: nanoid(24), ...values });
      console.log("created preset", code);
    }
  }

  console.log("\nSeed complete.");
  console.log(`Sign in as ${email}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
