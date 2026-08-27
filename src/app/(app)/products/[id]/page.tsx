import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  alternatePartNumbers,
  bomItems,
  boms,
  brands,
  cardDesigns,
  db,
  fitments,
  imports,
  productIdentifiers,
  productTranslations,
  products,
  warnings,
} from "@/server/db";
import { assertSameOrg, requireCapability } from "@/server/auth/current";
import { PageHeader, Panel, Badge, EmptyState } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Field, FieldGrid } from "@/components/product/fields";
import { IdentifiersPanel } from "@/components/product/identifiers-panel";
import { ReadinessPanel } from "@/components/product/readiness-panel";
import { SourceRow } from "@/components/product/source-row";
import { canonicalGtin14, canonicalUpcA } from "@/components/product/identifier-check";
import { evaluateReadiness } from "@/components/product/readiness";
import { CARD_PRESETS } from "@/lib/geometry/presets";
import { formatLength } from "@/lib/units";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "neutral" | "ok" | "info" | "warning"> = {
  "In Use": "ok",
  PreMarket: "info",
  Draft: "neutral",
  Archived: "warning",
};

const DESIGN_STATUS_TONE: Record<string, "neutral" | "info" | "ok" | "warning"> = {
  draft: "neutral",
  in_review: "info",
  approved: "ok",
  superseded: "warning",
};

export default async function ProductPage({ params }: PageProps<"/products/[id]">) {
  const { id } = await params;
  const user = await requireCapability("product.read");

  const [product] = await db.select().from(products).where(eq(products.id, id)).limit(1);
  if (!product) notFound();
  assertSameOrg(user, product.orgId);

  const component = alias(products, "component");

  const [brandRows, identifiers, alternates, fits, warns, translations, bomRows, designs] =
    await Promise.all([
      product.brandId
        ? db.select().from(brands).where(eq(brands.id, product.brandId)).limit(1)
        : Promise.resolve([]),
      db
        .select()
        .from(productIdentifiers)
        .where(eq(productIdentifiers.productId, product.id)),
      db
        .select()
        .from(alternatePartNumbers)
        .where(eq(alternatePartNumbers.productId, product.id))
        .orderBy(asc(alternatePartNumbers.position)),
      db
        .select()
        .from(fitments)
        .where(eq(fitments.productId, product.id))
        .orderBy(asc(fitments.position)),
      // A warning with a null productId belongs to the whole organisation and is
      // available to any template, so it is part of this product's copy too.
      db
        .select()
        .from(warnings)
        .where(
          and(
            eq(warnings.orgId, user.orgId),
            or(eq(warnings.productId, product.id), isNull(warnings.productId)),
          ),
        )
        .orderBy(asc(warnings.position)),
      db
        .select()
        .from(productTranslations)
        .where(eq(productTranslations.productId, product.id))
        .orderBy(asc(productTranslations.locale), asc(productTranslations.field)),
      // Ordered so the pack-contents blocks do not swap places between views.
      db
        .select()
        .from(boms)
        .where(eq(boms.productId, product.id))
        .orderBy(asc(boms.name), asc(boms.id)),
      db
        .select({
          id: cardDesigns.id,
          name: cardDesigns.name,
          status: cardDesigns.status,
          presetCode: cardDesigns.presetCode,
          updatedAt: cardDesigns.updatedAt,
        })
        .from(cardDesigns)
        .where(and(eq(cardDesigns.orgId, user.orgId), eq(cardDesigns.productId, product.id)))
        .orderBy(desc(cardDesigns.updatedAt)),
    ]);

  const items = bomRows.length
    ? await db
        .select({
          id: bomItems.id,
          bomId: bomItems.bomId,
          position: bomItems.position,
          quantity: bomItems.quantity,
          unitOfMeasure: bomItems.unitOfMeasure,
          name: bomItems.name,
          partNumber: bomItems.partNumber,
          description: bomItems.description,
          componentId: component.id,
          componentPartNumber: component.partNumber,
        })
        .from(bomItems)
        // Org-scoped on the join, not only on the id: a component reference is
        // written by the importer, and a link out of this organisation must
        // resolve to nothing rather than to another tenant's part number.
        .leftJoin(
          component,
          and(
            eq(component.id, bomItems.componentProductId),
            eq(component.orgId, user.orgId),
          ),
        )
        .where(
          inArray(
            bomItems.bomId,
            bomRows.map((b) => b.id),
          ),
        )
        .orderBy(asc(bomItems.position))
    : [];

  const [sourceImport] = product.sourceImportId
    ? await db.select().from(imports).where(eq(imports.id, product.sourceImportId)).limit(1)
    : [];

  const brand = brandRows[0] ?? null;
  const valueOf = (kind: string) => identifiers.find((i) => i.kind === kind)?.value ?? "";
  const upc = valueOf("gtin12");
  const gtin14 = valueOf("gtin14");
  const gtin13 = valueOf("gtin13");

  const checks = evaluateReadiness({
    upc,
    gtin14,
    countryOfOrigin: product.countryOfOrigin,
    bomCount: bomRows.length,
    bomItemCount: items.length,
    description: product.description,
    productName: product.productName,
    brandName: brand?.name ?? "",
    status: product.status,
  });

  const productWarnings = warns.filter((w) => w.productId === product.id);
  const orgWarnings = warns.filter((w) => w.productId === null);

  const locales = Array.from(new Set(translations.map((t) => t.locale)));

  const preset = product.defaultPresetCode
    ? CARD_PRESETS[product.defaultPresetCode as keyof typeof CARD_PRESETS]
    : undefined;

  const sourceRow = (product.sourceRow ?? {}) as Record<string, unknown>;
  const custom = (product.custom ?? {}) as Record<string, unknown>;

  const title = product.partNumber || product.productName || "Product without a part number";

  return (
    <>
      <PageHeader
        title={title}
        description={product.description || product.productName || "No description is recorded."}
        actions={
          <>
            <Link href="/products">
              <Button variant="ghost">All products</Button>
            </Link>
            {/* Not "from this product": /designs/new takes no product
                parameter, so the product is chosen there. Labelling the button
                as though the choice were already made would be a promise the
                next screen does not keep. */}
            <Link href="/designs/new">
              <Button variant="primary">New card</Button>
            </Link>
          </>
        }
        meta={
          <div className="flex flex-wrap items-center gap-2">
            {brand ? <Badge tone="brand">{brand.name}</Badge> : <Badge>no brand</Badge>}
            <Badge tone={STATUS_TONE[product.status] ?? "neutral"}>{product.status}</Badge>
            {product.recordType !== "product" ? (
              <Badge tone="warning">{product.recordType.replace("_", " ")}</Badge>
            ) : null}
            <Badge>{product.packagingLevel}</Badge>
            {product.isVariable ? <Badge tone="info">variable measure</Badge> : null}
            {!product.isPurchasable ? <Badge tone="warning">not purchasable</Badge> : null}
            <span className="numeric text-xs text-ink-500">
              {designs.length} {designs.length === 1 ? "card" : "cards"} ·{" "}
              {identifiers.length} {identifiers.length === 1 ? "identifier" : "identifiers"} ·{" "}
              {items.length} pack {items.length === 1 ? "line" : "lines"}
            </span>
          </div>
        }
      />

      <div className="space-y-6 p-8">
        <ReadinessPanel checks={checks} />

        <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
          <div className="space-y-6">
            <Panel title="Identity" description="The copy a template draws the front and back from.">
              <FieldGrid columns={3}>
                <Field label="Part number" value={product.partNumber} numeric />
                <Field label="Product name" value={product.productName} />
                <Field label="Subtitle / spec line" value={product.subtitle} />
                <Field label="Description" value={product.description} wide />
                <Field label="Short description" value={product.descriptionShort} />
                <Field label="Label description" value={product.labelDescription} />
                <Field
                  label="Net content"
                  value={[product.netContentCount, product.netContentUom].filter(Boolean).join(" ")}
                  numeric
                />
                <Field label="Country of origin" value={product.countryOfOrigin} />
                <Field label="Packaging level" value={product.packagingLevel} />
                <Field label="Target markets" value={product.targetMarkets} />
                <Field label="GPC brick" value={product.gpcBrick} />
                <Field label="Record type" value={product.recordType.replace("_", " ")} />
                <Field
                  label="Default dieline"
                  value={product.defaultPresetCode ?? ""}
                  hint={
                    preset
                      ? `trim ${formatLength(preset.trimWidth, "in")} × ${formatLength(preset.trimHeight, "in")} in`
                      : undefined
                  }
                  numeric
                />
                <Field
                  label="Brand"
                  value={brand?.name ?? ""}
                  // Only when it says something the name does not: most brands
                  // record the trading name in both columns, and printing it
                  // twice reads as a rendering fault rather than as provenance.
                  hint={brand && brand.legalName && brand.legalName !== brand.name
                    ? brand.legalName
                    : undefined}
                />
                <Field label="Source last modified" value={product.lastModifiedSource} numeric />
              </FieldGrid>
              {brand?.statement ? (
                <div className="border-t border-ink-800 px-4 py-3">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-ink-500">
                    Genuine-parts statement
                  </div>
                  <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-ink-300">
                    {brand.statement}
                  </p>
                </div>
              ) : null}
            </Panel>

            <IdentifiersPanel
              identifiers={identifiers.map((i) => ({
                id: i.id,
                kind: i.kind,
                value: i.value,
                isPrimary: i.isPrimary,
                valid: i.valid,
                validationNote: i.validationNote,
              }))}
              gtin14ForCard={canonicalGtin14([gtin14, gtin13, upc])}
              upcaForCard={canonicalUpcA([upc, gtin13, gtin14])}
            />

            <Panel
              title="Pack contents"
              description="The repeating block on the back of a kit card."
            >
              {/* On bomRows, not on items: a BOM that exists with no lines is a
                  different fact from no BOM at all, and it is reported below
                  rather than hidden behind "nothing is recorded". */}
              {bomRows.length === 0 ? (
                <EmptyState
                  title="No bill of materials"
                  description="Nothing is recorded for what is inside the pack, so the pack-contents block collapses to nothing. A single-item pack legitimately has none; a kit needs its lines mapped from the pack-contents sheet at import."
                  action={
                    <Link href="/imports/new">
                      <Button variant="outline" size="sm">
                        Import pack contents
                      </Button>
                    </Link>
                  }
                />
              ) : (
                // One table per bill of materials, rather than every line in a
                // single run under a stack of headings: a product may carry more
                // than one, they are ordered by line position independently, and
                // a merged table would number the second BOM's first line 6 and
                // give no way to tell which pack a line belongs to.
                bomRows.map((b) => {
                  const lines = items.filter((i) => i.bomId === b.id);
                  return (
                    <div key={b.id} className="border-b border-ink-800 last:border-0">
                      <div className="flex flex-wrap items-baseline gap-2 border-b border-ink-800 px-4 py-2">
                        <span className="text-[13px] text-ink-200">{b.name}</span>
                        {b.revision ? (
                          <span className="numeric text-[11px] text-ink-500">
                            revision {b.revision}
                          </span>
                        ) : null}
                        <span className="numeric ml-auto text-[11px] text-ink-500">
                          {lines.length} {lines.length === 1 ? "line" : "lines"}
                        </span>
                      </div>
                      {lines.length === 0 ? (
                        <p className="px-4 py-3 text-[13px] leading-relaxed text-ink-400">
                          This bill of materials exists but holds no lines, so the pack-contents
                          block on the back still resolves to nothing.
                        </p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                                <th scope="col" className="px-4 py-2 font-medium">
                                  #
                                </th>
                                <th scope="col" className="px-4 py-2 text-right font-medium">
                                  Qty
                                </th>
                                <th scope="col" className="px-4 py-2 font-medium">
                                  UoM
                                </th>
                                <th scope="col" className="px-4 py-2 font-medium">
                                  Component
                                </th>
                                <th scope="col" className="px-4 py-2 font-medium">
                                  Part number
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {lines.map((i, index) => (
                                <tr key={i.id} className="border-b border-ink-800/60 last:border-0">
                                  <td className="numeric px-4 py-2 text-ink-500">{index + 1}</td>
                                  <td className="numeric px-4 py-2 text-right text-ink-100">
                                    {i.quantity}
                                  </td>
                                  <td className="px-4 py-2 text-ink-400">{i.unitOfMeasure}</td>
                                  <td className="px-4 py-2 text-ink-200">
                                    {i.name || <span className="text-ink-600">unnamed</span>}
                                    {i.description ? (
                                      <span className="ml-2 text-[11px] text-ink-500">
                                        {i.description}
                                      </span>
                                    ) : null}
                                  </td>
                                  <td className="numeric px-4 py-2 whitespace-nowrap">
                                    {i.componentId ? (
                                      <Link
                                        href={`/products/${i.componentId}`}
                                        className="text-brand-300 hover:text-brand-200"
                                      >
                                        {i.componentPartNumber || i.partNumber}
                                      </Link>
                                    ) : i.partNumber ? (
                                      <span className="text-ink-300">{i.partNumber}</span>
                                    ) : (
                                      <span className="text-ink-600">—</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </Panel>

            <Panel
              title="Fitment"
              description="The “Fits” and “Replaces” lines, in the order they print."
            >
              {fits.length === 0 ? (
                <EmptyState
                  title="No fitment statements"
                  description="Nothing states what this part fits or replaces, so the fitment block on the back has no copy. Fitment arrives with the product import."
                  action={
                    <Link href="/imports/new">
                      <Button variant="outline" size="sm">
                        Import product data
                      </Button>
                    </Link>
                  }
                />
              ) : (
                <ul className="divide-y divide-ink-800/60">
                  {fits.map((f) => (
                    <li key={f.id} className="flex items-start gap-3 px-4 py-2.5">
                      <Badge className="mt-0.5 shrink-0">{f.kind}</Badge>
                      <span className="text-[13px] leading-relaxed text-ink-200">{f.text}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="space-y-6">
            <Panel title="Cards" description="Every card design bound to this product.">
              {designs.length === 0 ? (
                <EmptyState
                  title="No card yet"
                  description={
                    // The new-card screen lists only record_type = "product",
                    // so for anything else the button would lead to a list this
                    // record is not in. Say that here rather than let the
                    // operator hunt for it.
                    product.recordType === "product"
                      ? "Nothing has been designed for this product. A new card starts from a dieline and a master template; choose this product on the new-card screen and its data binds to the template."
                      : `Nothing has been designed for this record, and the new-card screen offers only records of type “product” — this one is “${product.recordType.replace("_", " ")}”, a component of other packs rather than something that ships in a card of its own.`
                  }
                  action={
                    product.recordType === "product" ? (
                      <Link href="/designs/new">
                        <Button variant="primary" size="sm">
                          New card
                        </Button>
                      </Link>
                    ) : undefined
                  }
                />
              ) : (
                <ul className="divide-y divide-ink-800/60">
                  {designs.map((d) => (
                    <li key={d.id}>
                      <Link
                        href={`/designs/${d.id}`}
                        className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-ink-800/40"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] text-ink-100">{d.name}</span>
                          {/* With the time, not just the date: designs are
                              ordered by this and several revisions of the same
                              card are routinely made in one sitting, which a
                              date alone renders as identical rows. */}
                          <span className="numeric text-[11px] text-ink-500">
                            updated{" "}
                            {d.updatedAt.toLocaleString(undefined, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <Badge>{d.presetCode}</Badge>
                          <Badge tone={DESIGN_STATUS_TONE[d.status] ?? "neutral"}>
                            {d.status.replace("_", " ")}
                          </Badge>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title="Alternate part numbers"
              description="Competitor, superseded and interchange numbers."
            >
              {alternates.length === 0 ? (
                <p className="px-4 py-5 text-[13px] leading-relaxed text-ink-400">
                  None recorded. Cross-reference numbers are optional; they print on the back only
                  when a template asks for them.
                </p>
              ) : (
                <ul className="divide-y divide-ink-800/60">
                  {alternates.map((a) => (
                    <li key={a.id} className="flex items-center gap-3 px-4 py-2">
                      <span className="numeric text-[13px] text-ink-100">{a.value}</span>
                      <Badge className="ml-auto">{a.relation}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Warnings" description="Regulatory copy that must survive to the plate.">
              {warns.length === 0 ? (
                <p className="px-4 py-5 text-[13px] leading-relaxed text-ink-400">
                  No warning is recorded for this product and none is set organisation-wide. If this
                  part needs a Proposition 65 or similar statement, it has to be imported before the
                  card is approved.
                </p>
              ) : (
                <ul className="divide-y divide-ink-800/60">
                  {[...productWarnings, ...orgWarnings].map((w) => (
                    <li key={w.id} className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        {w.code ? <Badge tone="warning">{w.code}</Badge> : null}
                        {w.productId === null ? (
                          <span className="text-[10px] uppercase tracking-wider text-ink-500">
                            organisation-wide
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-[12px] leading-relaxed text-ink-300">{w.text}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title="Translations"
              description="Alternate-language copy, per field, used by localised templates."
            >
              {locales.length === 0 ? (
                <p className="px-4 py-5 text-[13px] leading-relaxed text-ink-400">
                  Only the source language is recorded. A localised card falls back to the source
                  copy for every field, which is rarely what a Spanish or French pack should say.
                </p>
              ) : (
                <ul className="divide-y divide-ink-800/60">
                  {locales.map((locale) => (
                    <li key={locale} className="px-4 py-2.5">
                      <div className="text-[10px] font-medium uppercase tracking-wider text-ink-500">
                        {locale}
                      </div>
                      <dl className="mt-1 space-y-1">
                        {translations
                          .filter((t) => t.locale === locale)
                          .map((t) => (
                            <div key={t.id} className="flex items-baseline gap-3">
                              <dt className="w-28 shrink-0 text-[11px] text-ink-500">{t.field}</dt>
                              <dd className="min-w-0 text-[12px] leading-relaxed text-ink-200">
                                {t.value}
                              </dd>
                            </div>
                          ))}
                      </dl>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Provenance" description="Where this record came from.">
              <FieldGrid columns={1}>
                <Field label="Product id" value={product.id} numeric />
                <Field label="Created" value={product.createdAt.toLocaleString()} numeric />
                <Field label="Updated" value={product.updatedAt.toLocaleString()} numeric />
              </FieldGrid>
              <div className="border-t border-ink-800 px-4 py-3">
                {sourceImport ? (
                  <>
                    <div className="text-[10px] font-medium uppercase tracking-wider text-ink-500">
                      Created by import
                    </div>
                    <Link
                      href={`/imports/${sourceImport.id}`}
                      className="mt-1 block truncate text-[13px] text-brand-300 hover:text-brand-200"
                    >
                      {sourceImport.filename}
                    </Link>
                    <p className="numeric mt-0.5 text-[11px] text-ink-500">
                      {sourceImport.rowsTotal} rows · {sourceImport.status} ·{" "}
                      {(sourceImport.committedAt ?? sourceImport.createdAt).toLocaleString()}
                    </p>
                  </>
                ) : (
                  <p className="text-[13px] leading-relaxed text-ink-400">
                    No import is recorded against this product, so it was created directly rather
                    than loaded from a workbook.
                  </p>
                )}
              </div>
            </Panel>
          </div>
        </div>

        <SourceRow
          title="Source row (verbatim)"
          description="Exactly what the import read for this record, before any mapping or normalisation. Compare it with the fields above when a value on the card looks wrong."
          row={sourceRow}
        />

        {Object.keys(custom).length > 0 ? (
          <SourceRow
            title="Unmapped columns retained"
            description="Columns the import kept but no card field consumes. They are available to a template as custom fields."
            row={custom}
          />
        ) : null}
      </div>
    </>
  );
}
