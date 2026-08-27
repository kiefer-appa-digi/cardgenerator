import { config } from "dotenv";
config({ path: [".env.local", ".env"] });
import { db } from "@/server/db/client";
import { cardPresets, cardTemplates, cardDesigns, packageTypes, organizations, users } from "@/server/db/schema";

async function main() {
  console.log("orgs", (await db.select().from(organizations)).map((o) => ({ id: o.id, name: o.name })));
  console.log("users", (await db.select().from(users)).map((u) => ({ email: u.email, org: u.orgId })));
  console.log("presets", (await db.select().from(cardPresets)).map((p) => ({ org: p.orgId, code: p.code, name: p.name, tw: p.trimWidth, th: p.trimHeight, cr: p.cornerRadius, bt: p.bleedTop, st: p.safeTop, pkg: p.packageTypeId })));
  console.log("templates", (await db.select().from(cardTemplates)).map((t) => ({ org: t.orgId, code: t.presetCode, name: t.name, arch: t.archived })));
  console.log("designs", (await db.select().from(cardDesigns)).map((d) => ({ org: d.orgId, code: d.presetCode, name: d.name })));
  console.log("pkgs", (await db.select().from(packageTypes)).map((p) => ({ id: p.id, org: p.orgId, name: p.name, vendor: p.vendor, material: p.material, notes: p.notes })));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
