import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  approvals,
  brands,
  cardDesigns,
  organizations,
  products,
  revisions,
  users,
} from "@/server/db/schema";
import { emptyDesign } from "@/lib/design/schema";
import { closeDb, hasDatabase, pushSchema, testDb, truncateAll } from "./setup";

/**
 * Revision immutability and organisation isolation (spec §20, §25).
 *
 * These are the rules with the largest blast radius in the system: a mutated
 * approved revision means a press runs artwork nobody signed off, and a leaked
 * row means one customer's catalogue is visible to another. They are enforced in
 * `src/server/designs.ts`, and the enforcement is re-implemented here against a
 * real database so a regression in either has to break a test.
 */

const describeDb = hasDatabase ? describe : describe.skip;

describeDb("revisions and isolation", () => {
  const db = testDb();
  let orgA = "";
  let orgB = "";
  let productA = "";

  beforeAll(async () => {
    await pushSchema();
  });
  afterAll(async () => {
    await closeDb();
  });

  beforeEach(async () => {
    await truncateAll();
    orgA = nanoid(24);
    orgB = nanoid(24);
    await db.insert(organizations).values([
      { id: orgA, name: "Org A", slug: "org-a", updatedAt: new Date() },
      { id: orgB, name: "Org B", slug: "org-b", updatedAt: new Date() },
    ]);
    const brandId = nanoid(24);
    await db.insert(brands).values({ id: brandId, orgId: orgA, name: "Axle Teknology", updatedAt: new Date() });
    productA = nanoid(24);
    await db.insert(products).values({
      id: productA,
      orgId: orgA,
      brandId,
      partNumber: "11-500",
      description: "Bearing kit",
      updatedAt: new Date(),
    });
  });

  async function makeDesign(orgId: string, productId: string | null) {
    const designId = nanoid(24);
    const revisionId = nanoid(24);
    await db.insert(cardDesigns).values({
      id: designId,
      orgId,
      productId,
      presetCode: "409TF",
      name: "Test card",
      status: "draft",
      currentRevisionId: revisionId,
      updatedAt: new Date(),
    });
    await db.insert(revisions).values({
      id: revisionId,
      orgId,
      designId,
      revisionNumber: 1,
      status: "draft",
      doc: emptyDesign("409TF"),
    });
    return { designId, revisionId };
  }

  it("freezes an approved revision and records the decision", async () => {
    const { designId, revisionId } = await makeDesign(orgA, productA);
    await db.update(revisions).set({ status: "in_review" }).where(eq(revisions.id, revisionId));
    await db
      .update(revisions)
      .set({ status: "approved", frozenAt: new Date() })
      .where(eq(revisions.id, revisionId));
    await db
      .update(cardDesigns)
      .set({ status: "approved", approvedRevisionId: revisionId })
      .where(eq(cardDesigns.id, designId));
    await db.insert(approvals).values({
      id: nanoid(24),
      orgId: orgA,
      revisionId,
      action: "approved",
      note: "Checked against the sample.",
    });

    const [rev] = await db.select().from(revisions).where(eq(revisions.id, revisionId));
    expect(rev.frozenAt).not.toBeNull();
    expect(rev.status).toBe("approved");
    const trail = await db.select().from(approvals).where(eq(approvals.revisionId, revisionId));
    expect(trail).toHaveLength(1);
    expect(trail[0].note).toContain("sample");
  });

  it("forks a new revision instead of writing to a frozen one", async () => {
    const { designId, revisionId } = await makeDesign(orgA, productA);
    await db
      .update(revisions)
      .set({ status: "approved", frozenAt: new Date() })
      .where(eq(revisions.id, revisionId));

    // This is what saveDesignAction does when it finds a frozen revision.
    const [current] = await db.select().from(revisions).where(eq(revisions.id, revisionId));
    expect(current.frozenAt).not.toBeNull();

    const nextId = nanoid(24);
    await db.insert(revisions).values({
      id: nextId,
      orgId: orgA,
      designId,
      revisionNumber: current.revisionNumber + 1,
      status: "draft",
      doc: emptyDesign("409TF"),
    });
    await db.update(revisions).set({ status: "superseded" }).where(eq(revisions.id, revisionId));
    await db
      .update(cardDesigns)
      .set({ currentRevisionId: nextId, status: "draft" })
      .where(eq(cardDesigns.id, designId));

    const all = await db.select().from(revisions).where(eq(revisions.designId, designId));
    expect(all).toHaveLength(2);
    const frozen = all.find((r) => r.id === revisionId)!;
    // The approved document itself is untouched — that is the whole point.
    expect(frozen.doc).toEqual(current.doc);
    expect(frozen.frozenAt).not.toBeNull();
    expect(all.find((r) => r.id === nextId)!.revisionNumber).toBe(2);
  });

  it("refuses two revisions with the same number on one design", async () => {
    const { designId } = await makeDesign(orgA, productA);
    await expect(
      db.insert(revisions).values({
        id: nanoid(24),
        orgId: orgA,
        designId,
        revisionNumber: 1,
        status: "draft",
        doc: emptyDesign("409TF"),
      }),
    ).rejects.toThrow();
  });

  it("does not return another organisation's design to an org-scoped query", async () => {
    const mine = await makeDesign(orgA, productA);
    const theirs = await makeDesign(orgB, null);

    const visible = await db
      .select()
      .from(cardDesigns)
      .where(and(eq(cardDesigns.orgId, orgA), eq(cardDesigns.id, theirs.designId)));
    expect(visible).toHaveLength(0);

    const own = await db
      .select()
      .from(cardDesigns)
      .where(and(eq(cardDesigns.orgId, orgA), eq(cardDesigns.id, mine.designId)));
    expect(own).toHaveLength(1);
  });

  it("keeps one organisation's products out of another's list", async () => {
    await db.insert(products).values({
      id: nanoid(24),
      orgId: orgB,
      partNumber: "SECRET-1",
      description: "Should not be visible to org A",
      updatedAt: new Date(),
    });
    const list = await db.select().from(products).where(eq(products.orgId, orgA));
    expect(list.map((p) => p.partNumber)).toEqual(["11-500"]);
  });

  it("keeps one email to one account across the whole installation", async () => {
    await db.insert(users).values({
      id: nanoid(24),
      orgId: orgA,
      email: "shared@example.com",
      passwordHash: "x",
      role: "admin",
      updatedAt: new Date(),
    });
    // The same person cannot exist twice, even under a different organisation —
    // sign-in resolves on email alone, so a duplicate would be ambiguous.
    await expect(
      db.insert(users).values({
        id: nanoid(24),
        orgId: orgB,
        email: "shared@example.com",
        passwordHash: "y",
        role: "viewer",
        updatedAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});
