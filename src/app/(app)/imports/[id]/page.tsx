import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db, imports } from "@/server/db";
import { assertSameOrg, requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { PageHeader } from "@/components/ui/panel";
import { ImportWizard } from "@/components/import/wizard";
import { SheetMappingSchema } from "@/lib/import/types";
import { TARGET_FIELDS } from "@/lib/import/mapping";

export const dynamic = "force-dynamic";

export default async function ImportDetailPage({ params }: PageProps<"/imports/[id]">) {
  const { id } = await params;
  const user = await requireUser();
  const [row] = await db.select().from(imports).where(eq(imports.id, id)).limit(1);
  if (!row) notFound();
  assertSameOrg(user, row.orgId);

  const mapping = SheetMappingSchema.safeParse(row.mapping);
  const stash = row.preview as { headers?: string[]; report?: unknown } | null;

  return (
    <>
      <PageHeader
        title={row.filename}
        description={`${row.rowsTotal} data rows · ${row.status}`}
      />
      <div className="p-8">
        <ImportWizard
          importId={row.id}
          status={row.status}
          initialMapping={mapping.success ? mapping.data : null}
          headers={stash?.headers ?? []}
          initialPreview={(stash?.report as never) ?? null}
          report={row.report as Record<string, unknown>}
          targetFields={TARGET_FIELDS.map((f) => ({
            key: f.key,
            label: f.label,
            group: f.group,
            multi: f.multiple,
          }))}
          canCommit={can(user.role, "product.import")}
        />
      </div>
    </>
  );
}
