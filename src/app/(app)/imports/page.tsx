import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, imports } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { PageHeader, Panel, EmptyState, Badge } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function ImportsPage() {
  const user = await requireUser();
  const rows = await db
    .select()
    .from(imports)
    .where(eq(imports.orgId, user.orgId))
    .orderBy(desc(imports.createdAt))
    .limit(50);

  return (
    <>
      <PageHeader
        title="Import"
        description="Load product, identifier and pack-contents data from a workbook. Nothing is written until you approve the preview."
        actions={
          <Link href="/imports/new">
            <Button variant="primary">New import</Button>
          </Link>
        }
      />
      <div className="p-8">
        <Panel>
          {rows.length === 0 ? (
            <EmptyState
              title="No imports yet"
              description="Upload an .xlsx workbook. Columns are matched automatically, you review every mapping, and you see exactly what would change before anything is committed."
              action={
                <Link href="/imports/new">
                  <Button variant="primary">Upload a workbook</Button>
                </Link>
              }
            />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                  <th className="px-4 py-2 font-medium">File</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="numeric px-4 py-2 text-right font-medium">Rows</th>
                  <th className="numeric px-4 py-2 text-right font-medium">Created</th>
                  <th className="numeric px-4 py-2 text-right font-medium">Updated</th>
                  <th className="px-4 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-ink-800/60 last:border-0 hover:bg-ink-800/30">
                    <td className="px-4 py-2.5">
                      <Link href={`/imports/${r.id}`} className="text-ink-100 hover:text-brand-300">
                        {r.filename}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge
                        tone={
                          r.status === "committed" ? "ok" : r.status === "cancelled" ? "neutral" : "info"
                        }
                      >
                        {r.status}
                      </Badge>
                    </td>
                    <td className="numeric px-4 py-2.5 text-right text-ink-300">{r.rowsTotal}</td>
                    <td className="numeric px-4 py-2.5 text-right text-ink-300">{r.rowsCreated}</td>
                    <td className="numeric px-4 py-2.5 text-right text-ink-300">{r.rowsUpdated}</td>
                    <td className="numeric px-4 py-2.5 text-ink-400">
                      {r.createdAt.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}
