import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { approvals, brands, cardDesigns, db, products, revisions, users } from "@/server/db";
import { assertSameOrg, requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { PageHeader, Panel, Badge, Stat } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { CARD_PRESETS } from "@/lib/geometry/presets";
import { formatLength } from "@/lib/units";
import { ApprovalControls } from "@/components/design/approval-controls";
import type { PreflightReport } from "@/lib/preflight/types";

export const dynamic = "force-dynamic";

export default async function DesignPage({ params }: PageProps<"/designs/[id]">) {
  const { id } = await params;
  const user = await requireUser();

  const [design] = await db.select().from(cardDesigns).where(eq(cardDesigns.id, id)).limit(1);
  if (!design) notFound();
  assertSameOrg(user, design.orgId);

  const [product] = design.productId
    ? await db
        .select({
          partNumber: products.partNumber,
          description: products.description,
          brandName: brands.name,
        })
        .from(products)
        .leftJoin(brands, eq(brands.id, products.brandId))
        .where(eq(products.id, design.productId))
        .limit(1)
    : [];

  const revs = await db
    .select({
      id: revisions.id,
      revisionNumber: revisions.revisionNumber,
      status: revisions.status,
      notes: revisions.notes,
      createdAt: revisions.createdAt,
      frozenAt: revisions.frozenAt,
      preflight: revisions.preflight,
      author: users.name,
      authorEmail: users.email,
    })
    .from(revisions)
    .leftJoin(users, eq(users.id, revisions.createdBy))
    .where(eq(revisions.designId, design.id))
    .orderBy(desc(revisions.revisionNumber));

  const history = design.currentRevisionId
    ? await db
        .select({
          id: approvals.id,
          action: approvals.action,
          note: approvals.note,
          createdAt: approvals.createdAt,
          actor: users.name,
        })
        .from(approvals)
        .leftJoin(users, eq(users.id, approvals.actorId))
        .where(eq(approvals.revisionId, design.currentRevisionId))
        .orderBy(desc(approvals.createdAt))
    : [];

  const preset = CARD_PRESETS[design.presetCode as keyof typeof CARD_PRESETS];
  const current = revs.find((r) => r.id === design.currentRevisionId);
  const report = current?.preflight as PreflightReport | null;

  return (
    <>
      <PageHeader
        title={design.name}
        description={
          product
            ? `${product.partNumber} · ${product.brandName ?? ""} · ${product.description}`
            : "No product linked — this card renders with sample data."
        }
        actions={
          <>
            <Link href={`/designs/${design.id}/export`}>
              <Button variant="outline">Export</Button>
            </Link>
            <Link href={`/designs/${design.id}/edit`}>
              <Button variant="primary">Open editor</Button>
            </Link>
          </>
        }
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="brand">{design.presetCode}</Badge>
            <Badge
              tone={
                design.status === "approved"
                  ? "ok"
                  : design.status === "in_review"
                    ? "info"
                    : "neutral"
              }
            >
              {design.status.replace("_", " ")}
            </Badge>
            <span className="numeric text-xs text-ink-500">
              trim {formatLength(preset.trimWidth, "in")} × {formatLength(preset.trimHeight, "in")} in ·
              bleed {formatLength(preset.trimWidth + preset.bleed.left + preset.bleed.right, "in")} ×{" "}
              {formatLength(preset.trimHeight + preset.bleed.top + preset.bleed.bottom, "in")} in
            </span>
          </div>
        }
      />

      <div className="space-y-6 p-8">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Revision" value={current?.revisionNumber ?? "—"} sub={current?.status ?? ""} />
          <Stat
            label="Blocking"
            value={report?.counts.blocking ?? "—"}
            tone={report?.counts.blocking ? "danger" : "ok"}
          />
          <Stat
            label="Errors"
            value={report?.counts.error ?? "—"}
            tone={report?.counts.error ? "warning" : "ok"}
          />
          <Stat label="Revisions" value={revs.length} />
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.3fr_1fr]">
          <Panel title="Revisions" description="An approved revision is frozen; editing it creates a new one.">
            <ul className="divide-y divide-ink-800/60">
              {revs.map((r) => (
                <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="numeric text-[13px] font-medium text-ink-100">
                        Revision {r.revisionNumber}
                      </span>
                      <Badge
                        tone={
                          r.status === "approved"
                            ? "ok"
                            : r.status === "in_review"
                              ? "info"
                              : r.status === "superseded"
                                ? "warning"
                                : "neutral"
                        }
                      >
                        {r.status.replace("_", " ")}
                      </Badge>
                      {r.frozenAt ? (
                        <span className="text-[10px] uppercase tracking-wide text-sev-ok">frozen</span>
                      ) : null}
                    </div>
                    {r.notes ? (
                      <p className="mt-1 text-[12px] leading-relaxed text-ink-400">{r.notes}</p>
                    ) : null}
                    <p className="numeric mt-0.5 text-[11px] text-ink-500">
                      {r.author || r.authorEmail || "unknown"} · {r.createdAt.toLocaleString()}
                    </p>
                  </div>
                  {r.id === design.currentRevisionId ? (
                    <Badge tone="brand">current</Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          </Panel>

          <div className="space-y-6">
            <Panel title="Review">
              <ApprovalControls
                designId={design.id}
                status={current?.status ?? "draft"}
                canSubmit={can(user.role, "design.submit")}
                canApprove={can(user.role, "design.approve")}
                blocking={report?.counts.blocking ?? 0}
                errors={report?.counts.error ?? 0}
              />
            </Panel>

            {history.length ? (
              <Panel title="Approval history">
                <ul className="divide-y divide-ink-800/60">
                  {history.map((h) => (
                    <li key={h.id} className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <Badge
                          tone={
                            h.action === "approved"
                              ? "ok"
                              : h.action === "rejected"
                                ? "danger"
                                : "info"
                          }
                        >
                          {h.action}
                        </Badge>
                        <span className="text-[12px] text-ink-300">{h.actor ?? "unknown"}</span>
                        <span className="numeric ml-auto text-[11px] text-ink-500">
                          {h.createdAt.toLocaleString()}
                        </span>
                      </div>
                      {h.note ? (
                        <p className="mt-1 text-[12px] leading-relaxed text-ink-400">{h.note}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
