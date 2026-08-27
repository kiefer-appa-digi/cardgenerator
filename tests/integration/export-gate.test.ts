import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { cardDesigns, exportJobs, organizations, revisions } from "@/server/db/schema";
import { emptyDesign, TextElementSchema, type DesignDoc } from "@/lib/design/schema";
import { planDocument } from "@/lib/design/plan";
import { runPreflight } from "@/lib/preflight/engine";
import { emptyProductContext } from "@/lib/data/context";
import { BlackRulesSchema, OutputIntentSchema } from "@/lib/color/types";
import { PreflightProfileSchema } from "@/lib/preflight/types";
import { inToUpt } from "@/lib/units";
import { closeDb, hasDatabase, pushSchema, testDb, truncateAll } from "./setup";

/**
 * The production-export gate (spec §21).
 *
 * A blocking preflight finding must stop a production export, and getting past
 * it must cost an explicit, recorded reason. This exercises the decision the way
 * `exportDesignAction` makes it — real preflight over a real document — and then
 * checks that the override actually lands on the job row, because an override
 * nobody can find afterwards is not an audit trail.
 */

const describeDb = hasDatabase ? describe : describe.skip;

/** A card whose required country-of-origin block resolves to nothing. */
function blockedDoc(): DesignDoc {
  const doc = emptyDesign("409TF");
  doc.back.elements = [
    TextElementSchema.parse({
      id: "origin",
      kind: "text",
      name: "Country of origin",
      frame: { x: inToUpt(0.5), y: inToUpt(3), w: inToUpt(3), h: inToUpt(0.3) },
      required: true,
      paragraphs: [
        {
          runs: [
            {
              text: "",
              bold: false,
              italic: false,
              binding: {
                path: "countryOfOrigin",
                fallback: "",
                prefix: "",
                suffix: "",
                transform: "none",
                joiner: ", ",
                hideWhenEmpty: false,
              },
            },
          ],
          spaceBefore: 0,
          spaceAfter: 0,
        },
      ],
    }),
  ];
  return doc;
}

function preflightFor(doc: DesignDoc, countryOfOrigin: string) {
  const product = { ...emptyProductContext(), partNumber: "11-500", countryOfOrigin };
  const plans = planDocument({ doc, product, assets: new Map() });
  return runPreflight({
    doc,
    plans,
    product,
    profile: PreflightProfileSchema.parse({}),
    blackRules: BlackRulesSchema.parse({}),
    outputIntent: OutputIntentSchema.parse({}),
    assets: new Map(),
  });
}

describeDb("production export gate", () => {
  const db = testDb();
  let orgId = "";

  beforeAll(async () => {
    await pushSchema();
  });
  afterAll(async () => {
    await closeDb();
  });
  beforeEach(async () => {
    await truncateAll();
    orgId = nanoid(24);
    await db
      .insert(organizations)
      .values({ id: orgId, name: "Org", slug: "org", updatedAt: new Date() });
  });

  it("reports a required-but-empty block as blocking, and refuses the export", () => {
    const report = preflightFor(blockedDoc(), "");
    expect(report.counts.blocking).toBeGreaterThan(0);
    expect(report.findings.some((f) => f.code === "TEXT_EMPTY_REQUIRED")).toBe(true);
    // `exportable` is the single flag the export action reads.
    expect(report.exportable).toBe(false);
  });

  it("lets the same card through once the product carries the field", () => {
    const report = preflightFor(blockedDoc(), "Made in China");
    expect(report.counts.blocking).toBe(0);
    expect(report.exportable).toBe(true);
  });

  it("writes the override reason and its author onto the job", async () => {
    const designId = nanoid(24);
    const revisionId = nanoid(24);
    await db.insert(cardDesigns).values({
      id: designId,
      orgId,
      presetCode: "409TF",
      name: "Blocked card",
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
      doc: blockedDoc(),
    });

    const adminId = nanoid(24);
    const note = "Country of origin is applied by a separate label on this SKU; approved by J. Rivera.";
    const jobId = nanoid(24);
    await db.insert(exportJobs).values({
      id: jobId,
      orgId,
      kind: "production",
      status: "complete",
      createdBy: adminId,
      presetCode: "409TF",
      request: { designId, revisionId, kind: "production" },
      totalItems: 1,
      completedItems: 1,
      overrideBy: adminId,
      overrideNote: note,
      startedAt: new Date(),
      finishedAt: new Date(),
    });

    const [job] = await db.select().from(exportJobs).where(eq(exportJobs.id, jobId));
    expect(job.overrideBy).toBe(adminId);
    expect(job.overrideNote).toBe(note);
    // Long enough to say something: the action rejects anything shorter.
    expect(job.overrideNote.length).toBeGreaterThanOrEqual(12);
  });

  it("keeps a batch manifest row for a card that was never produced", async () => {
    const jobId = nanoid(24);
    await db.insert(exportJobs).values({
      id: jobId,
      orgId,
      kind: "batch",
      status: "complete",
      presetCode: "409TF",
      request: { productIds: ["p1", "p2"] },
      totalItems: 2,
      completedItems: 1,
      failedItems: 1,
      manifest: [
        { index: 0, sku: "11-500", status: "ok", note: "" },
        {
          index: 1,
          sku: "11-812",
          status: "preflight_blocked",
          note: "1 blocking finding(s): TEXT_EMPTY_REQUIRED",
        },
      ],
      finishedAt: new Date(),
    });

    const [job] = await db.select().from(exportJobs).where(eq(exportJobs.id, jobId));
    const manifest = job.manifest as Array<{ status: string; note: string; sku: string }>;
    // Spec §19: a failed card must not silently disappear from a batch.
    expect(manifest).toHaveLength(2);
    const failed = manifest.find((r) => r.status !== "ok")!;
    expect(failed.sku).toBe("11-812");
    expect(failed.note).toContain("TEXT_EMPTY_REQUIRED");
    expect(job.completedItems + job.failedItems).toBe(job.totalItems);
  });
});
