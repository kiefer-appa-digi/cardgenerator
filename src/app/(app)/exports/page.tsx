import { Fragment } from "react";
import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, exportArtifacts, exportJobs, users } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { PageHeader, Panel, EmptyState, Badge, Stat } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

const KIND_TONE: Record<string, "brand" | "info" | "neutral"> = {
  production: "brand",
  proof: "info",
  batch: "neutral",
};

const STATUS_TONE: Record<string, "ok" | "danger" | "info" | "neutral"> = {
  complete: "ok",
  failed: "danger",
  running: "info",
  queued: "neutral",
};

/** Byte sizes are a count, not a physical length, so they are not formatLength's job. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function ExportsPage() {
  const user = await requireUser();

  const jobs = await db
    .select({
      id: exportJobs.id,
      kind: exportJobs.kind,
      status: exportJobs.status,
      presetCode: exportJobs.presetCode,
      totalItems: exportJobs.totalItems,
      completedItems: exportJobs.completedItems,
      failedItems: exportJobs.failedItems,
      overrideNote: exportJobs.overrideNote,
      error: exportJobs.error,
      createdAt: exportJobs.createdAt,
      authorName: users.name,
      authorEmail: users.email,
    })
    .from(exportJobs)
    .leftJoin(users, eq(users.id, exportJobs.createdBy))
    .where(eq(exportJobs.orgId, user.orgId))
    .orderBy(desc(exportJobs.createdAt))
    .limit(100);

  const artifacts = jobs.length
    ? await db
        .select({
          id: exportArtifacts.id,
          jobId: exportArtifacts.jobId,
          filename: exportArtifacts.filename,
          byteSize: exportArtifacts.byteSize,
          status: exportArtifacts.status,
        })
        .from(exportArtifacts)
        .where(
          and(
            eq(exportArtifacts.orgId, user.orgId),
            inArray(
              exportArtifacts.jobId,
              jobs.map((j) => j.id),
            ),
          ),
        )
    : [];

  const byJob = new Map<string, typeof artifacts>();
  for (const a of artifacts) {
    const list = byJob.get(a.jobId);
    if (list) list.push(a);
    else byJob.set(a.jobId, [a]);
  }

  const productionCount = jobs.filter((j) => j.kind === "production").length;
  const failedCount = jobs.filter((j) => j.status === "failed").length;
  const overrideCount = jobs.filter((j) => j.overrideNote).length;

  return (
    <>
      <PageHeader
        title="Exports"
        description="Every proof and every production run, with the manifest it wrote and the checks the file was put through after it was written."
        actions={
          <Link href="/designs">
            <Button variant="primary">Go to cards</Button>
          </Link>
        }
      />

      <div className="space-y-6 p-8">
        {jobs.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Jobs" value={jobs.length} sub="Most recent 100" />
            <Stat label="Production runs" value={productionCount} />
            <Stat
              label="Failed"
              value={failedCount}
              tone={failedCount ? "danger" : "ok"}
            />
            <Stat
              label="Blocking overrides"
              value={overrideCount}
              tone={overrideCount ? "warning" : "ok"}
              sub="Forced past a blocking finding"
            />
          </div>
        ) : null}

        <Panel>
          {jobs.length === 0 ? (
            <EmptyState
              title="Nothing has been exported yet"
              description="Open a card and run a proof to see the artwork with its trim, bleed, safe area and cavity marked, or a production PDF once preflight is clean. Both are recorded here with their manifest and their post-export checks."
              action={
                <Link href="/designs">
                  <Button variant="primary">Go to cards</Button>
                </Link>
              }
            />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                  <th scope="col" className="px-4 py-2 font-medium">
                    Job
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Dieline
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Items
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Files
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    By
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    When
                  </th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const files = byJob.get(j.id) ?? [];
                  return (
                    <Fragment key={j.id}>
                    <tr
                      className="border-b border-ink-800/60 align-top hover:bg-ink-800/30"
                    >
                      <th scope="row" className="px-4 py-2.5 text-left font-normal">
                        <Link
                          href={`/exports/${j.id}`}
                          className="inline-flex items-center gap-2 font-medium text-ink-100 hover:text-brand-300"
                        >
                          <Badge tone={KIND_TONE[j.kind] ?? "neutral"}>{j.kind}</Badge>
                          {files[0]?.filename ?? "No file produced"}
                        </Link>
                      </th>
                      <td className="px-4 py-2.5">
                        {j.presetCode ? (
                          <Badge>{j.presetCode}</Badge>
                        ) : (
                          <span className="text-ink-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={STATUS_TONE[j.status] ?? "neutral"}>{j.status}</Badge>
                        {files.some((f) => f.status === "invalid") ? (
                          <span className="ml-1.5">
                            <Badge tone="danger">check failed</Badge>
                          </span>
                        ) : null}
                      </td>
                      <td className="numeric px-4 py-2.5 text-right text-ink-300">
                        {j.completedItems} / {j.totalItems}
                        {j.failedItems ? (
                          <span className="ml-1.5 text-sev-blocking">+{j.failedItems} failed</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5">
                        {files.length === 0 ? (
                          <span className="text-ink-600">—</span>
                        ) : (
                          <ul className="space-y-0.5">
                            {files.map((f) => (
                              <li key={f.id}>
                                <a
                                  href={`/api/artifacts/${f.id}`}
                                  download
                                  className="text-[12px] text-brand-300 hover:text-brand-200"
                                >
                                  {f.filename}
                                </a>
                                <span className="numeric ml-2 text-[11px] text-ink-500">
                                  {formatBytes(f.byteSize)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-ink-300">
                        {j.authorName || j.authorEmail || "unknown"}
                      </td>
                      <td className="numeric px-4 py-2.5 text-ink-400">
                        {j.createdAt.toLocaleString()}
                      </td>
                    </tr>
                    {j.overrideNote || (j.status === "failed" && j.error) ? (
                      <tr className="border-b border-ink-800/60 bg-ink-900/40">
                        <td colSpan={7} className="px-4 pb-3 pt-0">
                          {j.overrideNote ? (
                            <p className="text-[12px] leading-relaxed text-sev-warning">
                              <Badge tone="warning">override</Badge>{" "}
                              <span className="text-ink-300">{j.overrideNote}</span>
                            </p>
                          ) : null}
                          {j.status === "failed" && j.error ? (
                            <p className="mt-1 max-w-5xl text-[12px] leading-relaxed text-flag-200">
                              {/* A driver failure can be thousands of characters
                                  of SQL; the full text is on the job page. */}
                              <span className="line-clamp-2 break-words">{j.error}</span>
                              <Link
                                href={`/exports/${j.id}`}
                                className="mt-0.5 inline-block text-[11px] text-brand-300 hover:text-brand-200"
                              >
                                Full failure →
                              </Link>
                            </p>
                          ) : null}
                        </td>
                      </tr>
                    ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}
