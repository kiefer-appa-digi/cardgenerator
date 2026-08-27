import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { assertSameOrg, requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { assets as assetsTable, cardDesigns, db, revisions } from "@/server/db";
import { buildProductContext, sampleProductContext } from "@/server/products";
import { DesignDocSchema } from "@/lib/design/schema";
import { EditorShell } from "@/components/editor/editor-shell";

export const dynamic = "force-dynamic";

export default async function EditPage({ params }: PageProps<"/designs/[id]/edit">) {
  const { id } = await params;
  const user = await requireUser();

  const [design] = await db.select().from(cardDesigns).where(eq(cardDesigns.id, id)).limit(1);
  if (!design) notFound();
  assertSameOrg(user, design.orgId);

  const [rev] = design.currentRevisionId
    ? await db.select().from(revisions).where(eq(revisions.id, design.currentRevisionId)).limit(1)
    : [];
  if (!rev) notFound();

  const parsed = DesignDocSchema.safeParse(rev.doc);
  if (!parsed.success) {
    throw new Error(
      `Revision ${rev.revisionNumber} does not validate against the current document schema: ${parsed.error.issues[0]?.message}`,
    );
  }

  const product = design.productId
    ? ((await buildProductContext(user.orgId, design.productId)) ?? sampleProductContext())
    : sampleProductContext();

  const orgAssets = await db
    .select()
    .from(assetsTable)
    .where(eq(assetsTable.orgId, user.orgId))
    .limit(500);

  return (
    <EditorShell
      designId={design.id}
      designName={design.name}
      initialDoc={parsed.data}
      product={product}
      productLabel={
        design.productId
          ? `${product.partNumber} — ${product.description || product.productName}`
          : "Sample product (no product linked)"
      }
      assets={orgAssets.map((a) => ({
        id: a.id,
        pixelWidth: a.pixelWidth,
        pixelHeight: a.pixelHeight,
        colorSpace: a.colorSpace,
        contentType: a.contentType,
        hasIccProfile: a.hasIccProfile,
        url: `/api/assets/${a.id}`,
      }))}
      status={design.status}
      revisionNumber={rev.revisionNumber}
      canWrite={can(user.role, "design.write") && !rev.frozenAt}
      canSubmit={can(user.role, "design.submit") && rev.status === "draft"}
    />
  );
}
