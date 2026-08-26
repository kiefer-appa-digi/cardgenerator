import Link from "next/link";
import { and, eq, sql } from "drizzle-orm";
import { cardDesigns, cardPresets, cardTemplates, db, packageTypes } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { PageHeader, Panel, EmptyState, Stat, Badge } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { DielineFigure } from "@/components/preset/dieline-figure";
import { insetSummary } from "@/components/preset/dimensions";
import { DiscrepancyTable } from "@/components/preset/discrepancy-table";
import {
  CARD_PRESETS,
  PRESET_CODES,
  fullBleedHeight,
  fullBleedWidth,
  presetDiscrepancies,
  safeCornerRadius,
} from "@/lib/geometry/presets";
import { formatLength, uptToIn } from "@/lib/units";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

/**
 * All three thumbnails are drawn at ONE scale, so their relative sizes on the
 * page are their relative sizes on the press sheet. Sizing each figure to fill
 * its panel would make a 3.1 in card look like a 4.4 in card.
 */
const THUMB_PX_PER_IN = 38;

export default async function PresetsPage() {
  const user = await requireUser();

  const presetRows = await db
    .select({
      id: cardPresets.id,
      code: cardPresets.code,
      trimWidth: cardPresets.trimWidth,
      trimHeight: cardPresets.trimHeight,
      cornerRadius: cardPresets.cornerRadius,
      vendor: packageTypes.vendor,
      material: packageTypes.material,
    })
    .from(cardPresets)
    .leftJoin(packageTypes, eq(packageTypes.id, cardPresets.packageTypeId))
    .where(eq(cardPresets.orgId, user.orgId));

  const templateCounts = await db
    .select({ code: cardTemplates.presetCode, n: sql<number>`count(*)::int` })
    .from(cardTemplates)
    .where(and(eq(cardTemplates.orgId, user.orgId), eq(cardTemplates.archived, false)))
    .groupBy(cardTemplates.presetCode);

  const designCounts = await db
    .select({ code: cardDesigns.presetCode, n: sql<number>`count(*)::int` })
    .from(cardDesigns)
    .where(eq(cardDesigns.orgId, user.orgId))
    .groupBy(cardDesigns.presetCode);

  const dbByCode = new Map(presetRows.map((r) => [r.code, r]));
  const templatesByCode = new Map(templateCounts.map((r) => [r.code, r.n]));
  const designsByCode = new Map(designCounts.map((r) => [r.code, r.n]));

  const discrepancies = presetDiscrepancies();
  const oversize = discrepancies.filter((d) => d.deltaIn > 0);

  return (
    <>
      <PageHeader
        title="Dielines"
        description="The three authoritative card presets. Trim, bleed, corner radius and safe area are the production dimensions from specification §2; the Sinclair & Rush CAD drawings are kept beside them as reference and every disagreement is listed, never reconciled."
        actions={
          <Link href="/designs/new">
            <Button variant="primary">New card</Button>
          </Link>
        }
      />

      <div className="space-y-6 p-8">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Presets" value={PRESET_CODES.length} sub={PRESET_CODES.join(" · ")} />
          <Stat
            label="Templates"
            value={templateCounts.reduce((s, r) => s + r.n, 0)}
            sub="master and derived"
          />
          <Stat
            label="Cards"
            value={designCounts.reduce((s, r) => s + r.n, 0)}
            sub="drawn on these dielines"
          />
          <Stat
            label="Source conflicts"
            value={discrepancies.length}
            tone={oversize.length > 0 ? "warning" : "default"}
            sub={`${oversize.length} where the card is larger than the CAD allows`}
          />
        </div>

        {presetRows.length === 0 ? (
          <Panel title="No preset records in this organisation">
            <EmptyState
              title="The dielines are defined but not seeded"
              description="The geometry below comes from the application's preset definitions. The matching card_presets rows are missing for this organisation, so nothing can be bound to a package type yet. Run npm run db:seed against DATABASE_URL, then reload."
              action={
                <Link href="/settings">
                  <Button variant="outline">Check org settings</Button>
                </Link>
              }
            />
          </Panel>
        ) : null}

        <div className="grid items-start gap-6 xl:grid-cols-3">
          {PRESET_CODES.map((code) => {
            const p = CARD_PRESETS[code];
            const row = dbByCode.get(code);
            const seededMatches =
              !!row &&
              row.trimWidth === p.trimWidth &&
              row.trimHeight === p.trimHeight &&
              row.cornerRadius === p.cornerRadius;
            const conflicts = discrepancies.filter((d) => d.preset === code);
            const widthPx = Math.round(uptToIn(fullBleedWidth(p)) * THUMB_PX_PER_IN);

            return (
              <Panel
                key={code}
                title={code}
                description={p.name}
                actions={
                  <Link
                    href={`/presets/${code}`}
                    className="shrink-0 text-xs text-brand-300 hover:text-brand-200"
                  >
                    Inspect →
                  </Link>
                }
              >
                <div className="flex gap-5 p-4">
                  <div style={{ width: widthPx }} className="shrink-0">
                    <DielineFigure preset={p} variant="thumb" />
                  </div>

                  <dl className="min-w-0 flex-1 space-y-2 text-xs">
                    <SpecRow term="Trim">
                      {formatLength(p.trimWidth, "in")} × {formatLength(p.trimHeight, "in")} in
                      <Sub>
                        {formatLength(p.trimWidth, "mm")} × {formatLength(p.trimHeight, "mm")} mm
                      </Sub>
                    </SpecRow>
                    <SpecRow term="Full bleed">
                      {formatLength(fullBleedWidth(p), "in")} × {formatLength(fullBleedHeight(p), "in")} in
                      <Sub>bleed {insetSummary(p.bleed)}</Sub>
                    </SpecRow>
                    <SpecRow term="Corner radius">
                      R {formatLength(p.cornerRadius, "in")} in
                      <Sub>{formatLength(p.cornerRadius, "mm")} mm</Sub>
                    </SpecRow>
                    <SpecRow term="Safe inset">
                      {insetSummary(p.safeArea)}
                      <Sub>
                        measured in from trim · safe corner R{" "}
                        {formatLength(safeCornerRadius(p), "in")} in
                      </Sub>
                    </SpecRow>
                    <SpecRow term="Cavity">
                      {formatLength(p.cavity.rect.w, "in")} × {formatLength(p.cavity.rect.h, "in")} in
                      <Sub>R ≈ {formatLength(p.cavity.cornerRadius, "in")} in, approximate</Sub>
                    </SpecRow>
                  </dl>
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t border-ink-800 px-4 py-2.5">
                  {row ? (
                    <Badge tone={seededMatches ? "ok" : "danger"}>
                      {seededMatches ? "record matches" : "record differs"}
                    </Badge>
                  ) : (
                    <Badge tone="danger">not seeded</Badge>
                  )}
                  <Badge tone={conflicts.length > 0 ? "warning" : "neutral"}>
                    {conflicts.length} CAD conflict{conflicts.length === 1 ? "" : "s"}
                  </Badge>
                  <span className="numeric ml-auto text-[11px] text-ink-500">
                    {count(templatesByCode.get(code) ?? 0, "template")} ·{" "}
                    {count(designsByCode.get(code) ?? 0, "card")}
                  </span>
                </div>
              </Panel>
            );
          })}
        </div>

        <p className="-mt-2 text-xs text-ink-500">
          The three figures above are drawn at one common scale, so their relative sizes on this
          page are their relative sizes on the press sheet.
        </p>

        <Panel
          title="Source conflicts"
          description="Reported, never silently reconciled. The preset is authoritative for production (spec §2); the CAD values are retained as reference metadata and a positive delta means the card we would print is larger than the drawing allows."
        >
          {discrepancies.length === 0 ? (
            <EmptyState
              title="No disagreements"
              description="Every supplied CAD value agrees with the authoritative preset. Open a dieline to read the drawing callouts it was checked against."
              action={
                <Link href={`/presets/${PRESET_CODES[0]}`}>
                  <Button variant="outline" size="sm">
                    Open {PRESET_CODES[0]}
                  </Button>
                </Link>
              }
            />
          ) : (
            <DiscrepancyTable rows={discrepancies} />
          )}
        </Panel>
      </div>
    </>
  );
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function SpecRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-2 border-b border-ink-800/50 pb-2 last:border-0 last:pb-0">
      <dt className="text-ink-400">{term}</dt>
      <dd className="numeric min-w-0 text-ink-100">{children}</dd>
    </div>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return <span className="mt-0.5 block text-[11px] text-ink-500">{children}</span>;
}
