"use server";

import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { revalidatePath } from "next/cache";
import { cardDesigns, cardTemplates, db, revisions } from "@/server/db";
import { assertSameOrg, requireCapability } from "@/server/auth/current";
import { audit } from "@/server/audit";
import { DesignDocSchema, type DesignDoc } from "@/lib/design/schema";
import {
  MASTER_TEMPLATE_DESCRIPTION,
  buildBlankTemplate,
  buildMasterTemplate,
} from "@/lib/templates/factory";
import { AXLETEK_TEMPLATE_DESCRIPTION, buildAxleTekTemplate } from "@/lib/templates/axletek";
import { PRESET_CODES, type CardPresetDef } from "@/lib/geometry/presets";

/**
 * Seeds the three 11-500-structure master templates. Idempotent, so an
 * organisation that already has them keeps its edits.
 */
export async function ensureMasterTemplatesAction() {
  const user = await requireCapability("template.write");
  const created: string[] = [];

  const families = [
    { suffix: "11-500 master", description: MASTER_TEMPLATE_DESCRIPTION, build: buildMasterTemplate },
    { suffix: "AxleTek layout", description: AXLETEK_TEMPLATE_DESCRIPTION, build: buildAxleTekTemplate },
  ];

  for (const code of PRESET_CODES) {
    for (const fam of families) {
      const name = `${code} — ${fam.suffix}`;
      const [existing] = await db
        .select()
        .from(cardTemplates)
        .where(and(eq(cardTemplates.orgId, user.orgId), eq(cardTemplates.name, name)))
        .limit(1);
      if (existing) continue;

      await db.insert(cardTemplates).values({
        id: nanoid(24),
        orgId: user.orgId,
        presetCode: code,
        name,
        description: fam.description,
        doc: fam.build(code),
        isMaster: true,
        createdBy: user.id,
        updatedAt: new Date(),
      });
      created.push(name);
    }
  }

  if (created.length) {
    await audit({
      orgId: user.orgId,
      userId: user.id,
      action: "template.seed",
      entityType: "template",
      detail: { created },
    });
    revalidatePath("/templates");
  }
  return { ok: true as const, created };
}

export async function createDesignAction(input: {
  name: string;
  presetCode: string;
  productId: string | null;
  templateId: string | null;
}) {
  const user = await requireCapability("design.write");

  if (!PRESET_CODES.includes(input.presetCode as CardPresetDef["code"])) {
    return { ok: false as const, error: "Unknown card preset." };
  }
  const presetCode = input.presetCode as CardPresetDef["code"];

  let doc: DesignDoc;
  let templateVersion: number | null = null;
  if (input.templateId) {
    const [tpl] = await db
      .select()
      .from(cardTemplates)
      .where(eq(cardTemplates.id, input.templateId))
      .limit(1);
    if (!tpl) return { ok: false as const, error: "Template not found." };
    assertSameOrg(user, tpl.orgId);
    if (tpl.presetCode !== presetCode) {
      return {
        ok: false as const,
        error: `That template is built for ${tpl.presetCode}; it cannot be used on a ${presetCode} card.`,
      };
    }
    const parsed = DesignDocSchema.safeParse(tpl.doc);
    if (!parsed.success) return { ok: false as const, error: "That template no longer validates." };
    // Element ids are re-issued so two cards from one template never collide.
    doc = reissueIds(parsed.data);
    templateVersion = tpl.version;
  } else {
    doc = buildBlankTemplate(presetCode);
  }

  const designId = nanoid(24);
  const revisionId = nanoid(24);

  await db.insert(cardDesigns).values({
    id: designId,
    orgId: user.orgId,
    productId: input.productId,
    templateId: input.templateId,
    presetCode,
    name: input.name.trim() || `${presetCode} card`,
    status: "draft",
    currentRevisionId: revisionId,
    createdBy: user.id,
    updatedAt: new Date(),
  });
  await db.insert(revisions).values({
    id: revisionId,
    orgId: user.orgId,
    designId,
    revisionNumber: 1,
    status: "draft",
    doc,
    templateVersion,
    createdBy: user.id,
  });

  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: "design.create",
    entityType: "design",
    entityId: designId,
    detail: { presetCode, templateId: input.templateId, productId: input.productId },
  });

  revalidatePath("/designs");
  return { ok: true as const, designId };
}

function reissueIds(doc: DesignDoc): DesignDoc {
  const map = new Map<string, string>();
  const next = (old: string) => {
    if (!map.has(old)) map.set(old, nanoid(12));
    return map.get(old)!;
  };
  const remap = (side: "front" | "back") => ({
    ...doc[side],
    elements: doc[side].elements.map((el) =>
      el.kind === "group"
        ? { ...el, id: next(el.id), childIds: el.childIds.map(next) }
        : { ...el, id: next(el.id) },
    ),
  });
  return { ...doc, front: remap("front"), back: remap("back") };
}

export async function saveAsTemplateAction(designId: string, name: string) {
  const user = await requireCapability("template.write");
  const [design] = await db.select().from(cardDesigns).where(eq(cardDesigns.id, designId)).limit(1);
  if (!design?.currentRevisionId) return { ok: false as const, error: "Card not found." };
  assertSameOrg(user, design.orgId);

  const [rev] = await db
    .select()
    .from(revisions)
    .where(eq(revisions.id, design.currentRevisionId))
    .limit(1);
  if (!rev) return { ok: false as const, error: "Revision not found." };

  const id = nanoid(24);
  await db.insert(cardTemplates).values({
    id,
    orgId: user.orgId,
    brandId: design.brandId,
    presetCode: design.presetCode,
    name: name.trim() || `${design.name} template`,
    description: `Saved from card "${design.name}" revision ${rev.revisionNumber}.`,
    doc: rev.doc,
    createdBy: user.id,
    updatedAt: new Date(),
  });
  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: "template.create",
    entityType: "template",
    entityId: id,
    detail: { fromDesign: designId },
  });
  revalidatePath("/templates");
  return { ok: true as const, templateId: id };
}

export async function duplicateTemplateAction(templateId: string) {
  const user = await requireCapability("template.write");
  const [tpl] = await db.select().from(cardTemplates).where(eq(cardTemplates.id, templateId)).limit(1);
  if (!tpl) return { ok: false as const, error: "Template not found." };
  assertSameOrg(user, tpl.orgId);

  const id = nanoid(24);
  await db.insert(cardTemplates).values({
    id,
    orgId: user.orgId,
    brandId: tpl.brandId,
    presetCode: tpl.presetCode,
    name: `${tpl.name} copy`,
    description: tpl.description,
    doc: tpl.doc,
    isMaster: false,
    createdBy: user.id,
    updatedAt: new Date(),
  });
  revalidatePath("/templates");
  return { ok: true as const, templateId: id };
}

export async function listTemplatesAction() {
  const user = await requireCapability("template.read");
  return db
    .select()
    .from(cardTemplates)
    .where(and(eq(cardTemplates.orgId, user.orgId), eq(cardTemplates.archived, false)))
    .orderBy(desc(cardTemplates.updatedAt));
}
