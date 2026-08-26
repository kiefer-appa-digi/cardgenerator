import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { cardDesigns, db, revisions } from "@/server/db";
import { getCurrentUser } from "@/server/auth/current";
import { DesignDocSchema } from "@/lib/design/schema";
import { buildProductContext, sampleProductContext } from "@/server/products";
import { loadOrgSettings, planForExport } from "@/server/render";
import { runPreflight } from "@/lib/preflight/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs preflight against a document the editor has in memory, so a designer sees
 * findings for the artwork on screen rather than for the last thing that was
 * saved. The result is only persisted on the revision when the caller asks for
 * it, which keeps a keystroke from writing to the database.
 */
export async function POST(
  req: Request,
  ctx: RouteContext<"/api/designs/[id]/preflight">,
) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await ctx.params;
  const [design] = await db.select().from(cardDesigns).where(eq(cardDesigns.id, id)).limit(1);
  if (!design || design.orgId !== user.orgId) {
    return new NextResponse("Not found", { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const parsed = DesignDocSchema.safeParse((body as { doc?: unknown })?.doc);
  if (!parsed.success) {
    return NextResponse.json(
      { error: `Document failed validation: ${parsed.error.issues[0]?.message}` },
      { status: 400 },
    );
  }
  const doc = parsed.data;

  const product = design.productId
    ? ((await buildProductContext(user.orgId, design.productId)) ?? sampleProductContext())
    : sampleProductContext();

  const [{ plans, assets }, settings] = await Promise.all([
    planForExport(doc, product, user.orgId),
    loadOrgSettings(user.orgId),
  ]);

  const report = runPreflight({
    doc,
    plans,
    product,
    profile: settings.profile,
    blackRules: settings.blackRules,
    outputIntent: settings.outputIntent,
    assets,
    designId: design.id,
    revisionId: design.currentRevisionId ?? undefined,
    productId: design.productId ?? undefined,
  });

  const persist = (body as { persist?: boolean })?.persist === true;
  if (persist && design.currentRevisionId) {
    await db
      .update(revisions)
      .set({ preflight: report })
      .where(eq(revisions.id, design.currentRevisionId));
  }

  return NextResponse.json(report);
}
