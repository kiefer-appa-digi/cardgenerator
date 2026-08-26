"use server";

import { and, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { revalidatePath } from "next/cache";
import {
  approvals,
  cardDesigns,
  db,
  designElements,
  revisions,
} from "@/server/db";
import { assertSameOrg, requireCapability, requireUser } from "@/server/auth/current";
import { audit } from "@/server/audit";
import { DesignDocSchema, type DesignDoc } from "@/lib/design/schema";
import { collectBindingPaths } from "@/lib/data/binding";

/**
 * Revision rules (spec §20):
 *  - a design always has exactly one editable revision, its `currentRevisionId`;
 *  - approving a revision freezes it (`frozenAt`) and it is never written again;
 *  - editing an approved card creates a fresh draft revision that supersedes it.
 * The immutability is enforced here, in the only code path that can write a
 * revision, rather than by convention.
 */

export type SaveResult =
  | { ok: true; revisionId: string; revisionNumber: number; savedAt: string }
  | { ok: false; error: string };

export async function saveDesignAction(
  designId: string,
  rawDoc: unknown,
): Promise<SaveResult> {
  const user = await requireCapability("design.write");

  const parsed = DesignDocSchema.safeParse(rawDoc);
  if (!parsed.success) {
    return { ok: false, error: `Design failed validation: ${parsed.error.issues[0]?.message}` };
  }
  const doc = parsed.data;

  const [design] = await db
    .select()
    .from(cardDesigns)
    .where(eq(cardDesigns.id, designId))
    .limit(1);
  if (!design) return { ok: false, error: "Card not found." };
  assertSameOrg(user, design.orgId);

  const [current] = design.currentRevisionId
    ? await db.select().from(revisions).where(eq(revisions.id, design.currentRevisionId)).limit(1)
    : [];

  // An approved (frozen) revision is immutable. Editing it forks a new draft.
  if (!current || current.frozenAt || current.status === "approved") {
    const created = await createRevision(design.id, design.orgId, doc, user.id, current?.revisionNumber ?? 0);
    await db
      .update(cardDesigns)
      .set({ currentRevisionId: created.id, status: "draft", updatedAt: new Date() })
      .where(eq(cardDesigns.id, design.id));
    if (current) {
      await db.update(revisions).set({ status: "superseded" }).where(eq(revisions.id, current.id));
    }
    await audit({
      orgId: design.orgId,
      userId: user.id,
      action: "design.fork_revision",
      entityType: "revision",
      entityId: created.id,
      detail: { from: current?.id ?? null, reason: "edit of a frozen revision" },
    });
    revalidatePath(`/designs/${designId}`);
    return {
      ok: true,
      revisionId: created.id,
      revisionNumber: created.revisionNumber,
      savedAt: new Date().toISOString(),
    };
  }

  await db
    .update(revisions)
    .set({ doc })
    .where(eq(revisions.id, current.id));
  await projectElements(design.orgId, current.id, doc);
  await db.update(cardDesigns).set({ updatedAt: new Date() }).where(eq(cardDesigns.id, design.id));

  return {
    ok: true,
    revisionId: current.id,
    revisionNumber: current.revisionNumber,
    savedAt: new Date().toISOString(),
  };
}

async function createRevision(
  designId: string,
  orgId: string,
  doc: DesignDoc,
  userId: string,
  afterNumber: number,
) {
  const [max] = await db
    .select({ n: sql<number>`coalesce(max(${revisions.revisionNumber}), 0)::int` })
    .from(revisions)
    .where(eq(revisions.designId, designId));
  const revisionNumber = Math.max(afterNumber, max?.n ?? 0) + 1;
  const id = nanoid(24);
  await db.insert(revisions).values({
    id,
    orgId,
    designId,
    revisionNumber,
    status: "draft",
    doc,
    createdBy: userId,
  });
  await projectElements(orgId, id, doc);
  return { id, revisionNumber };
}

/**
 * Project the design document into normalised rows.
 *
 * Spec §4 requires that print- and data-critical properties be queryable without
 * parsing the document blob — "which cards carry this GTIN", "which cards use a
 * font we are removing", "which cards reference an asset about to be deleted".
 */
async function projectElements(orgId: string, revisionId: string, doc: DesignDoc) {
  await db.delete(designElements).where(eq(designElements.revisionId, revisionId));
  const rows: Array<typeof designElements.$inferInsert> = [];

  for (const side of ["front", "back"] as const) {
    doc[side].elements.forEach((el, z) => {
      const fonts = new Set<string>();
      const colors: unknown[] = [];
      if (el.kind === "text") {
        fonts.add(el.fontFamily);
        colors.push(el.color, el.fill);
        for (const p of el.paragraphs) for (const r of p.runs) if (r.fontFamily) fonts.add(r.fontFamily);
      }
      if (el.kind === "bomList") {
        fonts.add(el.fontFamily);
        colors.push(el.color);
      }
      if (el.kind === "shape") colors.push(el.fill, el.stroke);
      if (el.kind === "barcode") colors.push(el.barColor, el.quietZoneFill);

      rows.push({
        id: nanoid(24),
        orgId,
        revisionId,
        elementId: el.id,
        side,
        kind: el.kind,
        name: el.name,
        zIndex: z,
        x: el.frame.x,
        y: el.frame.y,
        w: el.frame.w,
        h: el.frame.h,
        rotation: el.rotation,
        opacity: el.opacity,
        locked: el.locked,
        hidden: el.hidden,
        required: el.required,
        bindingPaths: collectBindingPaths(el),
        fontFamilies: [...fonts],
        assetId: el.kind === "image" ? el.assetId : null,
        colors,
        barcodeSymbology: el.kind === "barcode" ? el.symbology : null,
        barcodeValue: el.kind === "barcode" ? el.value.slice(0, 128) : null,
        barcodeMagnification: el.kind === "barcode" ? el.magnification : null,
        barcodeModuleWidth: null,
      });
    });
  }

  if (rows.length) await db.insert(designElements).values(rows);
}

export async function submitForReviewAction(designId: string, note: string) {
  const user = await requireCapability("design.submit");
  const [design] = await db.select().from(cardDesigns).where(eq(cardDesigns.id, designId)).limit(1);
  if (!design) return { ok: false as const, error: "Card not found." };
  assertSameOrg(user, design.orgId);
  if (!design.currentRevisionId) return { ok: false as const, error: "Nothing to submit." };

  await db
    .update(revisions)
    .set({ status: "in_review", notes: note })
    .where(eq(revisions.id, design.currentRevisionId));
  await db
    .update(cardDesigns)
    .set({ status: "in_review", updatedAt: new Date() })
    .where(eq(cardDesigns.id, designId));
  await db.insert(approvals).values({
    id: nanoid(24),
    orgId: design.orgId,
    revisionId: design.currentRevisionId,
    action: "submitted",
    actorId: user.id,
    note,
  });
  await audit({
    orgId: design.orgId,
    userId: user.id,
    action: "design.submit",
    entityType: "revision",
    entityId: design.currentRevisionId,
  });
  revalidatePath(`/designs/${designId}`);
  return { ok: true as const };
}

export async function decideApprovalAction(
  designId: string,
  decision: "approved" | "rejected",
  note: string,
) {
  const user = await requireCapability("design.approve");
  const [design] = await db.select().from(cardDesigns).where(eq(cardDesigns.id, designId)).limit(1);
  if (!design?.currentRevisionId) return { ok: false as const, error: "Card not found." };
  assertSameOrg(user, design.orgId);

  const [rev] = await db
    .select()
    .from(revisions)
    .where(eq(revisions.id, design.currentRevisionId))
    .limit(1);
  if (!rev) return { ok: false as const, error: "Revision not found." };
  if (rev.status !== "in_review") {
    return { ok: false as const, error: "Only a revision in review can be decided." };
  }

  if (decision === "approved") {
    // Freezing here is what makes approved artwork immutable: every later save
    // sees frozenAt and forks instead of writing.
    await db
      .update(revisions)
      .set({ status: "approved", frozenAt: new Date() })
      .where(eq(revisions.id, rev.id));
    await db
      .update(cardDesigns)
      .set({ status: "approved", approvedRevisionId: rev.id, updatedAt: new Date() })
      .where(eq(cardDesigns.id, designId));
  } else {
    await db.update(revisions).set({ status: "draft" }).where(eq(revisions.id, rev.id));
    await db
      .update(cardDesigns)
      .set({ status: "draft", updatedAt: new Date() })
      .where(eq(cardDesigns.id, designId));
  }

  await db.insert(approvals).values({
    id: nanoid(24),
    orgId: design.orgId,
    revisionId: rev.id,
    action: decision,
    actorId: user.id,
    note,
    preflightSnapshot: rev.preflight,
  });
  await audit({
    orgId: design.orgId,
    userId: user.id,
    action: `design.${decision}`,
    entityType: "revision",
    entityId: rev.id,
    detail: { note },
  });
  revalidatePath(`/designs/${designId}`);
  return { ok: true as const };
}

export async function listRevisionsAction(designId: string) {
  const user = await requireUser();
  const rows = await db
    .select({
      id: revisions.id,
      revisionNumber: revisions.revisionNumber,
      status: revisions.status,
      notes: revisions.notes,
      createdAt: revisions.createdAt,
      frozenAt: revisions.frozenAt,
    })
    .from(revisions)
    .where(and(eq(revisions.orgId, user.orgId), eq(revisions.designId, designId)))
    .orderBy(desc(revisions.revisionNumber));
  return rows;
}
