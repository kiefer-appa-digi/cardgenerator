import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, sql } from "drizzle-orm";
import { cardDesigns, cardPresets, cardTemplates, db, packageTypes } from "@/server/db";
import { assertSameOrg, requireUser } from "@/server/auth/current";
import { PageHeader, Panel, Badge, EmptyState } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { DielineFigure } from "@/components/preset/dieline-figure";
import { DiscrepancyTable } from "@/components/preset/discrepancy-table";
import {
  DimensionTable,
  HeroDimension,
  insetSummary,
  type DimGroup,
} from "@/components/preset/dimensions";
import {
  CARD_PRESETS,
  PRESET_CODES,
  fullBleedHeight,
  fullBleedWidth,
  presetDiscrepancies,
  safeCornerRadius,
  safeRect,
  type CardPresetDef,
} from "@/lib/geometry/presets";
import { geometryMismatches, presetRecordMatches } from "@/components/preset/record-match";
import { formatLength, inToUpt } from "@/lib/units";

export const dynamic = "force-dynamic";

function isPresetCode(v: string): v is CardPresetDef["code"] {
  return (PRESET_CODES as readonly string[]).includes(v);
}

const PROVENANCE_LABEL: Record<CardPresetDef["cavity"]["provenance"], string> = {
  "measured-from-dieline": "Measured from the supplied dieline PDF",
  supplied: "Supplied by the packaging vendor",
  approximate: "Approximate",
};

export default async function PresetDetailPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const user = await requireUser();

  const upper = code.toUpperCase();
  if (!isPresetCode(upper)) notFound();
  const p = CARD_PRESETS[upper];
  const cad = p.cadReference;

  const [record] = await db
    .select()
    .from(cardPresets)
    .where(and(eq(cardPresets.orgId, user.orgId), eq(cardPresets.code, upper)))
    .limit(1);
  if (record) assertSameOrg(user, record.orgId);

  const [pkg] = record?.packageTypeId
    ? await db.select().from(packageTypes).where(eq(packageTypes.id, record.packageTypeId)).limit(1)
    : [];
  if (pkg) assertSameOrg(user, pkg.orgId);

  const templates = await db
    .select({
      id: cardTemplates.id,
      name: cardTemplates.name,
      isMaster: cardTemplates.isMaster,
      version: cardTemplates.version,
    })
    .from(cardTemplates)
    .where(
      and(
        eq(cardTemplates.orgId, user.orgId),
        eq(cardTemplates.presetCode, upper),
        eq(cardTemplates.archived, false),
      ),
    )
    .orderBy(asc(cardTemplates.name));

  const DESIGN_LIMIT = 12;
  const designs = await db
    .select({ id: cardDesigns.id, name: cardDesigns.name, status: cardDesigns.status })
    .from(cardDesigns)
    .where(and(eq(cardDesigns.orgId, user.orgId), eq(cardDesigns.presetCode, upper)))
    .orderBy(asc(cardDesigns.name))
    .limit(DESIGN_LIMIT);

  /** Counted separately so a truncated list can say so instead of implying it is all of them. */
  const [designTotal] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(cardDesigns)
    .where(and(eq(cardDesigns.orgId, user.orgId), eq(cardDesigns.presetCode, upper)));
  const designCount = designTotal?.n ?? designs.length;

  const conflicts = presetDiscrepancies().filter((d) => d.preset === upper);
  const safe = safeRect(p);
  const trimBox = { w: p.trimWidth, h: p.trimHeight };
  const cavityMarginRight = trimBox.w - p.cavity.rect.x - p.cavity.rect.w;
  const cavityMarginBottom = trimBox.h - p.cavity.rect.y - p.cavity.rect.h;

  /**
   * The database row must carry exactly the authoritative geometry. The same
   * comparison backs the badge on /presets, so the two screens cannot disagree.
   */
  const mismatches = geometryMismatches(record, p);
  const recordMatches = presetRecordMatches(record, p);

  const groups: DimGroup[] = [
    {
      title: "Trim — the card as it is cut",
      rows: [
        { label: "Trim width", value: p.trimWidth, source: "authoritative" },
        { label: "Trim height", value: p.trimHeight, source: "authoritative" },
        { label: "Corner radius", value: p.cornerRadius, source: "authoritative" },
      ],
    },
    {
      title: "Bleed — the page the production PDF actually is",
      rows: [
        { label: "Bleed top", value: p.bleed.top, source: "authoritative" },
        { label: "Bleed right", value: p.bleed.right, source: "authoritative" },
        { label: "Bleed bottom", value: p.bleed.bottom, source: "authoritative" },
        { label: "Bleed left", value: p.bleed.left, source: "authoritative" },
        {
          label: "Full-bleed page width",
          value: fullBleedWidth(p),
          source: "derived",
          note: "trim width + left bleed + right bleed",
        },
        {
          label: "Full-bleed page height",
          value: fullBleedHeight(p),
          source: "derived",
          note: "trim height + top bleed + bottom bleed",
        },
      ],
    },
    {
      title: "Safe area — measured in from trim",
      rows: [
        { label: "Safe inset top", value: p.safeArea.top, source: "authoritative" },
        { label: "Safe inset right", value: p.safeArea.right, source: "authoritative" },
        { label: "Safe inset bottom", value: p.safeArea.bottom, source: "authoritative" },
        { label: "Safe inset left", value: p.safeArea.left, source: "authoritative" },
        { label: "Safe area width", value: safe.w, source: "derived" },
        { label: "Safe area height", value: safe.h, source: "derived" },
        {
          label: "Safe corner radius",
          value: safeCornerRadius(p),
          source: "derived",
          note: "Trim radius minus the smallest inset. Insetting a rounded rectangle by d shrinks its radius by d — the arc centre does not move — so testing containment with the trim's radius would reject artwork that is comfortably on the card.",
        },
      ],
    },
    {
      title: "Cavity footprint — in trim space, origin at the trim top-left",
      rows: [
        { label: "Offset from trim left", value: p.cavity.rect.x, source: "measured" },
        { label: "Offset from trim top", value: p.cavity.rect.y, source: "measured" },
        { label: "Cavity width", value: p.cavity.rect.w, source: "measured" },
        { label: "Cavity height", value: p.cavity.rect.h, source: "measured" },
        {
          label: "Margin, cavity to trim right",
          value: cavityMarginRight,
          source: "derived",
          note: "trim width − offset − cavity width",
        },
        {
          label: "Margin, cavity to trim bottom",
          value: cavityMarginBottom,
          source: "derived",
          note: "trim height − offset − cavity height",
        },
        {
          label: "Cavity corner radius",
          value: p.cavity.cornerRadius,
          source: "measured",
          note: p.cavity.cornerRadiusIsApproximate
            ? "APPROXIMATE — recovered from a raster edge profile. Verify against a physical part before relying on it for artwork that runs into the corners."
            : undefined,
        },
      ],
    },
  ];

  const hasSharpCornerCallout = Object.keys(cad.callouts).some((k) => k.includes("*"));

  return (
    <>
      <PageHeader
        title={`${p.code} dieline`}
        description={p.description}
        actions={
          <>
            <Link href="/presets">
              <Button variant="outline">All dielines</Button>
            </Link>
            <Link href="/designs/new">
              <Button variant="primary">New card</Button>
            </Link>
          </>
        }
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="brand">authoritative · spec §2</Badge>
            <Badge tone="neutral">
              drawing {cad.drawingNumber} rev {cad.revision}
            </Badge>
            <Badge tone="neutral">{cad.material}</Badge>
            {pkg?.vendor ? <Badge tone="neutral">{pkg.vendor}</Badge> : null}
            <Badge tone={conflicts.length > 0 ? "warning" : "ok"}>
              {conflicts.length} CAD conflict{conflicts.length === 1 ? "" : "s"}
            </Badge>
          </div>
        }
      />

      <div className="space-y-6 p-8">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <HeroDimension
            label="Trim size — authoritative"
            width={p.trimWidth}
            height={p.trimHeight}
            size="lg"
            className="xl:col-span-2"
            hint="The card as it is cut. This is the number every other dimension on this page is measured from."
          />
          <HeroDimension
            label="Full-bleed page"
            width={fullBleedWidth(p)}
            height={fullBleedHeight(p)}
            hint={`Bleed ${insetSummary(p.bleed)}`}
          />
          <div className="grid gap-3">
            <HeroDimension label="Corner radius" width={p.cornerRadius} />
          </div>
        </div>

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,34rem)_1fr]">
          <Panel
            title="Dieline"
            description="Drawn to scale. The figure's user space is PDF points — the same coordinate system, and the same rounded-corner path, as the exported page."
          >
            <div className="p-4">
              <DielineFigure preset={p} />
            </div>
          </Panel>

          <Panel
            title="Every authoritative dimension"
            description="Inches, millimetres and PDF points, converted from the same integer micro-point value. Nothing here is rounded for display beyond the unit's own precision."
          >
            <DimensionTable groups={groups} />
          </Panel>
        </div>

        <div className="grid items-start gap-6 xl:grid-cols-2">
          <Panel
            title="CAD reference"
            description="Verbatim from the supplied Sinclair & Rush drawing. Reference metadata only — these values never change a production dimension."
          >
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 px-4 py-4 sm:grid-cols-2">
              <Field term="Drawing number" value={cad.drawingNumber} numeric />
              <Field term="Revision" value={cad.revision} numeric />
              <Field term="Drawn" value={cad.drawnDate} numeric />
              <Field term="Material" value={cad.material} />
              <Field
                term="Sheet thickness"
                value={`${formatLength(inToUpt(cad.sheetThicknessIn), "in")} in · ${formatLength(
                  inToUpt(cad.sheetThicknessIn),
                  "mm",
                )} mm`}
                numeric
              />
              <Field term="Colour" value={cad.color} />
              <Field
                term="Card size on the dieline sheet"
                value={`${formatLength(inToUpt(cad.dielineCardWidthIn), "in")} × ${formatLength(
                  inToUpt(cad.dielineCardLengthIn),
                  "in",
                )} in · R ${formatLength(inToUpt(cad.dielineCornerRadiusIn), "in")} in`}
                numeric
              />
              <Field term="Source file" value={cad.sourceFile} numeric />
            </dl>

            <div className="border-t border-ink-800">
              <table className="w-full text-sm">
                <caption className="px-4 pb-1 pt-3 text-left text-[11px] uppercase tracking-wider text-ink-400">
                  Drawing callouts, as printed
                </caption>
                <thead className="sr-only">
                  <tr>
                    <th scope="col">Callout</th>
                    <th scope="col">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(cad.callouts).map(([key, value]) => (
                    <tr key={key} className="border-t border-ink-800/60">
                      <th scope="row" className="px-4 py-2 text-left font-normal text-ink-300">
                        {key}
                      </th>
                      <td className="numeric px-4 py-2 text-right font-medium text-ink-100">
                        {value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {hasSharpCornerCallout ? (
                <p className="border-t border-ink-800 px-4 py-3 text-xs leading-relaxed text-ink-400">
                  An asterisk in a callout means the dimension is taken to theoretical sharp
                  corners, so it describes the cavity floor rather than the rounded flange opening
                  drawn on the dieline sheet.
                </p>
              ) : null}
            </div>
          </Panel>

          <div className="space-y-6">
            <Panel
              title="Cavity provenance"
              description="Where the cavity footprint came from and how far it can be trusted."
            >
              <div className="space-y-3 px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="warning">{PROVENANCE_LABEL[p.cavity.provenance]}</Badge>
                  {p.cavity.cornerRadiusIsApproximate ? (
                    <Badge tone="danger">corner radius approximate</Badge>
                  ) : null}
                </div>
                <p className="text-sm leading-relaxed text-ink-300">{p.cavity.notes}</p>
                {p.cavity.cornerRadiusIsApproximate ? (
                  <p className="rounded border border-amber-700/40 bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-sev-warning">
                    The cavity corner radius R{" "}
                    <span className="numeric">{formatLength(p.cavity.cornerRadius, "in")}</span> in
                    was recovered from a raster edge profile, not from a vector path or a vendor
                    callout. Treat it as approximate and verify it against a physical part before
                    relying on it for artwork that runs into the cavity corners.
                  </p>
                ) : null}
                <p className="text-xs leading-relaxed text-ink-400">
                  The cavity is an overlay only. It marks where the clamshell blister sits over the
                  printed card so artwork can be kept clear of it; it is never printed and never
                  clips the artwork.
                </p>
              </div>
            </Panel>

            <Panel
              title="Database record"
              description="The card_presets row this organisation carries for the dieline."
            >
              {record ? (
                <dl className="grid grid-cols-1 gap-x-6 gap-y-3 px-4 py-4 sm:grid-cols-2">
                  <Field term="Preset name" value={record.name} />
                  <Field term="Record id" value={record.id} numeric />
                  <Field term="Package type" value={pkg?.name ?? "not linked"} />
                  <Field term="Vendor" value={pkg?.vendor || "—"} />
                  <Field term="Material" value={pkg?.material || "—"} />
                  <Field term="Notes" value={pkg?.notes || "—"} />
                  <div className="sm:col-span-2">
                    <dt className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
                      Stored geometry
                    </dt>
                    <dd className="mt-1.5">
                      <Badge tone={recordMatches ? "ok" : "danger"}>
                        {recordMatches
                          ? "matches the authoritative preset"
                          : "differs from the authoritative preset"}
                      </Badge>
                      {!recordMatches ? (
                        <>
                          <p className="mt-1.5 text-xs leading-relaxed text-flag-300">
                            The stored geometry does not match the preset definition. Re-run the
                            seed so the record and the application agree before exporting
                            production artwork.
                          </p>
                          <ul className="mt-1.5 space-y-0.5">
                            {mismatches.map((m) => (
                              <li key={m.field} className="numeric text-[11px] text-ink-300">
                                {m.field}: stored {m.stored}, preset {m.expected}
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                    </dd>
                  </div>
                </dl>
              ) : (
                <EmptyState
                  title="No record for this organisation"
                  description="The geometry on this page comes from the application's preset definitions, but no card_presets row exists to bind it to a package type. Run the seed against DATABASE_URL, then reload."
                  action={
                    <Link href="/presets">
                      <Button variant="outline" size="sm">
                        Back to dielines
                      </Button>
                    </Link>
                  }
                />
              )}

              <div className="grid gap-4 border-t border-ink-800 px-4 py-4 sm:grid-cols-2">
                <div>
                  <h3 className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
                    Templates on this dieline
                  </h3>
                  {templates.length === 0 ? (
                    <p className="mt-1.5 text-xs text-ink-400">
                      None yet.{" "}
                      <Link href="/templates" className="text-brand-300 hover:text-brand-200">
                        Create one →
                      </Link>
                    </p>
                  ) : (
                    <ul className="mt-1.5 space-y-1">
                      {templates.map((t) => (
                        <li key={t.id} className="flex items-center gap-2 text-sm text-ink-200">
                          <span className="min-w-0 truncate">{t.name}</span>
                          {t.isMaster ? <Badge tone="brand">master</Badge> : null}
                          <span className="numeric text-[11px] text-ink-400">v{t.version}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h3 className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
                    Cards on this dieline
                  </h3>
                  {designs.length === 0 ? (
                    <p className="mt-1.5 text-xs text-ink-400">
                      None yet.{" "}
                      <Link href="/designs/new" className="text-brand-300 hover:text-brand-200">
                        Start one →
                      </Link>
                    </p>
                  ) : (
                    <>
                      <ul className="mt-1.5 space-y-1">
                        {designs.map((d) => (
                          <li key={d.id} className="flex items-center gap-2 text-sm">
                            <Link
                              href={`/designs/${d.id}`}
                              className="min-w-0 truncate text-ink-200 hover:text-brand-300"
                            >
                              {d.name}
                            </Link>
                            <Badge tone={d.status === "approved" ? "ok" : "neutral"}>
                              {d.status.replace("_", " ")}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                      {designCount > designs.length ? (
                        <p className="mt-1.5 text-xs text-ink-400">
                          <span className="numeric">
                            {designs.length} of {designCount}
                          </span>{" "}
                          shown.{" "}
                          <Link href="/designs" className="text-brand-300 hover:text-brand-200">
                            All cards →
                          </Link>
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            </Panel>
          </div>
        </div>

        <Panel
          title="Conflicts with the CAD drawing"
          description="The preset is authoritative for production (spec §2). Where the drawing disagrees, the CAD value is retained here as reference metadata and the difference is reported — it is never used to change a production dimension without approval."
        >
          {conflicts.length === 0 ? (
            <EmptyState
              title="No disagreements on this dieline"
              description="Every value on the supplied drawing agrees with the authoritative preset. The other dielines may still carry conflicts."
              action={
                <Link href="/presets">
                  <Button variant="outline" size="sm">
                    See all conflicts
                  </Button>
                </Link>
              }
            />
          ) : (
            <DiscrepancyTable rows={conflicts} showPreset={false} />
          )}
        </Panel>
      </div>
    </>
  );
}

function Field({
  term,
  value,
  numeric,
}: {
  term: string;
  value: string;
  numeric?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-ink-400">{term}</dt>
      <dd
        className={
          numeric
            ? "numeric mt-0.5 break-words text-sm text-ink-100"
            : "mt-0.5 break-words text-sm text-ink-100"
        }
      >
        {value}
      </dd>
    </div>
  );
}
