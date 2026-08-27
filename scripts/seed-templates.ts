/**
 * Creates the three 11-500-structure master templates for the organisation.
 * Idempotent: a template that already exists keeps whatever edits it has.
 */
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../src/server/db/client";
import { cardTemplates, organizations } from "../src/server/db/schema";
import { MASTER_TEMPLATE_DESCRIPTION, buildMasterTemplate } from "../src/lib/templates/factory";
import { AXLETEK_TEMPLATE_DESCRIPTION, buildAxleTekTemplate } from "../src/lib/templates/axletek";
import { PRESET_CODES } from "../src/lib/geometry/presets";

async function main() {
  const [org] = await db.select().from(organizations).limit(1);
  if (!org) throw new Error("No organisation. Run `npm run db:seed` first.");

  const families = [
    {
      suffix: "11-500 master",
      description: MASTER_TEMPLATE_DESCRIPTION,
      build: buildMasterTemplate,
    },
    {
      suffix: "AxleTek layout",
      description: AXLETEK_TEMPLATE_DESCRIPTION,
      build: buildAxleTekTemplate,
    },
  ];

  for (const code of PRESET_CODES) for (const fam of families) {
    const name = `${code} — ${fam.suffix}`;
    const [existing] = await db
      .select()
      .from(cardTemplates)
      .where(and(eq(cardTemplates.orgId, org.id), eq(cardTemplates.name, name)))
      .limit(1);
    if (existing) {
      console.log(`template exists: ${name}`);
      continue;
    }
    await db.insert(cardTemplates).values({
      id: nanoid(24),
      orgId: org.id,
      presetCode: code,
      name,
      description: fam.description,
      doc: fam.build(code),
      isMaster: true,
      updatedAt: new Date(),
    });
    console.log(`created template: ${name}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
