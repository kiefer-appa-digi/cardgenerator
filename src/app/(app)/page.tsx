import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  cardDesigns,
  cardPresets,
  db,
  imports,
  products,
  revisions,
} from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { PageHeader, Panel, Stat, Badge, EmptyState } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { CARD_PRESETS, PRESET_CODES, presetDiscrepancies } from "@/lib/geometry/presets";
import { formatLength } from "@/lib/units";

export default async function OverviewPage() {
  const user = await requireUser();
  const org = eq(products.orgId, user.orgId);

  const [productCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(products)
    .where(org);
  const [withGtin] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(products)
    .innerJoin(
      sql`product_identifiers pi`,
      sql`pi.product_id = ${products.id} and pi.kind = 'gtin14' and pi.value <> ''`,
    )
    .where(org);
  const [designCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(cardDesigns)
    .where(eq(cardDesigns.orgId, user.orgId));
  const [approvedCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(cardDesigns)
    .where(and(eq(cardDesigns.orgId, user.orgId), eq(cardDesigns.status, "approved")));

  const recentDesigns = await db
    .select({
      id: cardDesigns.id,
      name: cardDesigns.name,
      status: cardDesigns.status,
      presetCode: cardDesigns.presetCode,
      updatedAt: cardDesigns.updatedAt,
    })
    .from(cardDesigns)
    .where(eq(cardDesigns.orgId, user.orgId))
    .orderBy(desc(cardDesigns.updatedAt))
    .limit(6);

  const recentImports = await db
    .select({
      id: imports.id,
      filename: imports.filename,
      status: imports.status,
      rowsTotal: imports.rowsTotal,
      createdAt: imports.createdAt,
    })
    .from(imports)
    .where(eq(imports.orgId, user.orgId))
    .orderBy(desc(imports.createdAt))
    .limit(4);

  const presetRows = await db
    .select()
    .from(cardPresets)
    .where(eq(cardPresets.orgId, user.orgId));

  const discrepancies = presetDiscrepancies();
  const hardConflicts = discrepancies.filter((d) => d.severity === "warning" && d.deltaIn > 0);

  const empty = (productCount?.n ?? 0) === 0;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Card presets, product data and artwork state for Freedom Trailer Parts."
        actions={
          <>
            <Link href="/imports/new">
              <Button variant="outline">Import products</Button>
            </Link>
            <Link href="/designs/new">
              <Button variant="primary">New card</Button>
            </Link>
          </>
        }
      />

      <div className="space-y-6 p-8">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="Products"
            value={productCount?.n ?? 0}
            sub={`${withGtin?.n ?? 0} carry a GTIN`}
          />
          <Stat label="Cards" value={designCount?.n ?? 0} sub="front + back pairs" />
          <Stat
            label="Approved"
            value={approvedCount?.n ?? 0}
            tone={approvedCount?.n ? "ok" : "default"}
            sub="immutable revisions"
          />
          <Stat
            label="Dielines"
            value={presetRows.length}
            sub={PRESET_CODES.join(" · ")}
          />
        </div>

        {empty ? (
          <Panel title="Start here">
            <EmptyState
              title="No product data yet"
              description="Import the GS1 product export to populate part numbers, GTINs and brands. You can review every mapped column and cancel before anything is written."
              action={
                <Link href="/imports/new">
                  <Button variant="primary">Import a workbook</Button>
                </Link>
              }
            />
          </Panel>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
          <Panel
            title="Card presets"
            description="Trim is authoritative; CAD values are kept as reference."
            actions={
              <Link href="/presets" className="text-xs text-brand-300 hover:text-brand-200">
                All dielines →
              </Link>
            }
          >
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                  <th className="px-4 py-2 font-medium">Preset</th>
                  <th className="px-4 py-2 font-medium">Trim</th>
                  <th className="px-4 py-2 font-medium">Full bleed</th>
                  <th className="px-4 py-2 font-medium">Cavity</th>
                </tr>
              </thead>
              <tbody>
                {PRESET_CODES.map((code) => {
                  const p = CARD_PRESETS[code];
                  const fbw = p.trimWidth + p.bleed.left + p.bleed.right;
                  const fbh = p.trimHeight + p.bleed.top + p.bleed.bottom;
                  return (
                    <tr key={code} className="border-b border-ink-800/60 last:border-0">
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/presets/${code}`}
                          className="font-medium text-ink-100 hover:text-brand-300"
                        >
                          {code}
                        </Link>
                      </td>
                      <td className="numeric px-4 py-2.5 text-ink-300">
                        {formatLength(p.trimWidth, "in")} × {formatLength(p.trimHeight, "in")} in
                      </td>
                      <td className="numeric px-4 py-2.5 text-ink-300">
                        {formatLength(fbw, "in")} × {formatLength(fbh, "in")} in
                      </td>
                      <td className="numeric px-4 py-2.5 text-ink-400">
                        {formatLength(p.cavity.rect.w, "in")} × {formatLength(p.cavity.rect.h, "in")} in
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>

          <Panel title="Source conflicts" description="Reported, never silently reconciled.">
            {hardConflicts.length === 0 ? (
              <p className="px-4 py-6 text-sm text-ink-400">
                No conflicts between the authoritative presets and the supplied CAD.
              </p>
            ) : (
              <ul className="divide-y divide-ink-800/60">
                {hardConflicts.map((d, i) => (
                  <li key={i} className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Badge tone="warning">{d.preset}</Badge>
                      <span className="text-[13px] text-ink-200">{d.field}</span>
                    </div>
                    <p className="numeric mt-1 text-xs text-ink-400">
                      preset {d.authoritativeIn} in · CAD {d.cadIn} in · Δ +{d.deltaIn} in
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <div className="border-t border-ink-800 px-4 py-2.5">
              <Link href="/presets" className="text-xs text-brand-300 hover:text-brand-200">
                Full source audit →
              </Link>
            </div>
          </Panel>
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <Panel title="Recent cards">
            {recentDesigns.length === 0 ? (
              <EmptyState
                title="No cards yet"
                description="Create a card from a product and a preset, or start from a template."
                action={
                  <Link href="/designs/new">
                    <Button variant="primary" size="sm">New card</Button>
                  </Link>
                }
              />
            ) : (
              <ul className="divide-y divide-ink-800/60">
                {recentDesigns.map((d) => (
                  <li key={d.id}>
                    <Link
                      href={`/designs/${d.id}`}
                      className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-ink-800/40"
                    >
                      <span className="min-w-0 truncate text-sm text-ink-100">{d.name}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge tone="neutral">{d.presetCode}</Badge>
                        <StatusBadge status={d.status} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Recent imports">
            {recentImports.length === 0 ? (
              <EmptyState
                title="Nothing imported yet"
                description="Upload an .xlsx workbook to map columns onto product fields."
                action={
                  <Link href="/imports/new">
                    <Button variant="outline" size="sm">Import</Button>
                  </Link>
                }
              />
            ) : (
              <ul className="divide-y divide-ink-800/60">
                {recentImports.map((im) => (
                  <li key={im.id}>
                    <Link
                      href={`/imports/${im.id}`}
                      className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-ink-800/40"
                    >
                      <span className="min-w-0 truncate text-sm text-ink-100">{im.filename}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="numeric text-xs text-ink-400">{im.rowsTotal} rows</span>
                        <Badge tone={im.status === "committed" ? "ok" : "neutral"}>{im.status}</Badge>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, Parameters<typeof Badge>[0]["tone"]> = {
    draft: "neutral",
    in_review: "info",
    approved: "ok",
    superseded: "warning",
  };
  return <Badge tone={map[status] ?? "neutral"}>{status.replace("_", " ")}</Badge>;
}
