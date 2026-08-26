import Link from "next/link";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { brands, cardDesigns, cardTemplates, db } from "@/server/db";
import { requireCapability } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { PageHeader, Panel, EmptyState, Badge } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import {
  DuplicateTemplateButton,
  EnsureMasterTemplatesButton,
  StartCardButton,
} from "@/components/template/template-actions";
import { CARD_PRESETS, PRESET_CODES, type CardPresetDef } from "@/lib/geometry/presets";
import { formatLength } from "@/lib/units";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  const user = await requireCapability("template.read");
  const canWrite = can(user.role, "template.write");
  const canDesign = can(user.role, "design.write");

  // Element counts are taken in the database rather than by shipping every
  // document to the server: a library of a hundred templates is a hundred large
  // JSON blobs, and the list only needs two integers from each.
  const rows = await db
    .select({
      id: cardTemplates.id,
      name: cardTemplates.name,
      description: cardTemplates.description,
      presetCode: cardTemplates.presetCode,
      isMaster: cardTemplates.isMaster,
      version: cardTemplates.version,
      updatedAt: cardTemplates.updatedAt,
      brandName: brands.name,
      frontCount: sql<number>`coalesce(jsonb_array_length(${cardTemplates.doc} -> 'front' -> 'elements'), 0)::int`,
      backCount: sql<number>`coalesce(jsonb_array_length(${cardTemplates.doc} -> 'back' -> 'elements'), 0)::int`,
    })
    .from(cardTemplates)
    .leftJoin(brands, eq(brands.id, cardTemplates.brandId))
    .where(and(eq(cardTemplates.orgId, user.orgId), eq(cardTemplates.archived, false)))
    .orderBy(desc(cardTemplates.isMaster), asc(cardTemplates.presetCode), desc(cardTemplates.updatedAt))
    .limit(200);

  const usage = await db
    .select({ templateId: cardDesigns.templateId, cards: sql<number>`count(*)::int` })
    .from(cardDesigns)
    .where(eq(cardDesigns.orgId, user.orgId))
    .groupBy(cardDesigns.templateId);
  const cardsByTemplate = new Map(usage.map((u) => [u.templateId, u.cards]));

  const withMaster = new Set(rows.filter((r) => r.isMaster).map((r) => r.presetCode));
  const missingMasters = PRESET_CODES.filter((code) => !withMaster.has(code));

  return (
    <>
      <PageHeader
        title="Templates"
        description="A template supplies the layout and the bindings; the product supplies the words. One template drives every SKU that ships on its dieline."
        actions={
          <>
            {canWrite && missingMasters.length > 0 && rows.length > 0 ? (
              <EnsureMasterTemplatesButton missing={missingMasters} size="md" />
            ) : null}
            <Link href="/designs/new">
              <Button variant={missingMasters.length > 0 ? "outline" : "primary"}>New card</Button>
            </Link>
          </>
        }
      />

      <div className="space-y-6 p-8">
        <Panel>
          {rows.length === 0 ? (
            <EmptyState
              title="No templates yet"
              description="The three 11-500 master templates reproduce the structure of the supplied sample card — a full-colour front and a black-and-white back, with everything variable bound to the product and everything brand-critical locked. Create them, then start a card from one."
              action={
                canWrite ? (
                  <EnsureMasterTemplatesButton missing={missingMasters} size="md" />
                ) : (
                  <p className="text-[12px] text-ink-400">
                    Your role cannot create templates. Ask a designer or an administrator.
                  </p>
                )
              }
            />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                  <th scope="col" className="px-4 py-2 font-medium">
                    Template
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Dieline
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Brand
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Front
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Back
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Cards
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Updated
                  </th>
                  <th scope="col" className="px-4 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const preset = CARD_PRESETS[t.presetCode as CardPresetDef["code"]];
                  return (
                    <tr
                      key={t.id}
                      className="border-b border-ink-800/60 last:border-0 align-top hover:bg-ink-800/30"
                    >
                      <th scope="row" className="px-4 py-2.5 text-left font-normal">
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/templates/${t.id}`}
                            className="font-medium text-ink-100 hover:text-brand-300"
                          >
                            {t.name}
                          </Link>
                          {t.isMaster ? <Badge tone="brand">master</Badge> : null}
                          <span className="numeric text-[11px] text-ink-500">v{t.version}</span>
                        </div>
                        {t.description ? (
                          <p className="mt-0.5 line-clamp-1 max-w-xl text-[11px] text-ink-500">
                            {t.description}
                          </p>
                        ) : null}
                      </th>
                      <td className="px-4 py-2.5">
                        <Badge>{t.presetCode}</Badge>
                        {preset ? (
                          <div className="numeric mt-1 whitespace-nowrap text-[11px] text-ink-500">
                            {formatLength(preset.trimWidth, "in")} ×{" "}
                            {formatLength(preset.trimHeight, "in")} in
                          </div>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-ink-300">
                        {t.brandName ?? <span className="text-ink-600">Any brand</span>}
                      </td>
                      <td className="numeric px-4 py-2.5 text-right text-ink-300">
                        {t.frontCount}
                      </td>
                      <td className="numeric px-4 py-2.5 text-right text-ink-300">{t.backCount}</td>
                      <td className="numeric px-4 py-2.5 text-right text-ink-300">
                        {cardsByTemplate.get(t.id) ?? 0}
                      </td>
                      <td className="numeric px-4 py-2.5 text-ink-400">
                        {t.updatedAt.toLocaleDateString()}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {canWrite ? <DuplicateTemplateButton templateId={t.id} /> : null}
                          {canDesign ? (
                            <StartCardButton templateId={t.id} presetCode={t.presetCode} />
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>

        {rows.length > 0 && missingMasters.length > 0 ? (
          <Panel title="Missing master templates">
            <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5">
              <p className="max-w-2xl text-[12px] leading-relaxed text-ink-400">
                {missingMasters.join(", ")} {missingMasters.length === 1 ? "has" : "have"} no master
                template, so a card on{" "}
                {missingMasters.length === 1 ? "that dieline" : "those dielines"} can only start
                blank. Creating them leaves any template you already edited untouched.
              </p>
              {canWrite ? <EnsureMasterTemplatesButton missing={missingMasters} /> : null}
            </div>
          </Panel>
        ) : null}
      </div>
    </>
  );
}
