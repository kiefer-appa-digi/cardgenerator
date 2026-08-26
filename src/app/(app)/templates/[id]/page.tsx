import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { brands, cardDesigns, cardTemplates, db, products } from "@/server/db";
import { assertSameOrg, requireCapability } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { PageHeader, Panel, Badge, Stat } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import {
  DuplicateTemplateButton,
  StartCardButton,
} from "@/components/template/template-actions";
import { SideThumbnail } from "@/components/template/side-thumbnail";
import { loadAssetMap } from "@/server/render";
import { sampleProductContext } from "@/server/products";
import { planSide } from "@/lib/design/plan";
import { collectBindingPaths } from "@/lib/data/binding";
import {
  DesignDocSchema,
  SIDE_KEYS,
  defaultElementName,
  type DesignElement,
} from "@/lib/design/schema";
import { CARD_PRESETS, type CardPresetDef } from "@/lib/geometry/presets";
import { formatLength } from "@/lib/units";

export const dynamic = "force-dynamic";

const KIND_LABELS: Record<DesignElement["kind"], string> = {
  text: "Text",
  image: "Image",
  shape: "Shape",
  barcode: "Barcode",
  bomList: "BOM list",
  group: "Group",
};

const STATUS_TONE: Record<string, "neutral" | "info" | "ok" | "warning"> = {
  draft: "neutral",
  in_review: "info",
  approved: "ok",
  superseded: "warning",
};

export default async function TemplateDetailPage({ params }: PageProps<"/templates/[id]">) {
  const { id } = await params;
  const user = await requireCapability("template.read");
  const canWrite = can(user.role, "template.write");
  const canDesign = can(user.role, "design.write");

  const [tpl] = await db.select().from(cardTemplates).where(eq(cardTemplates.id, id)).limit(1);
  if (!tpl) notFound();
  assertSameOrg(user, tpl.orgId);

  const [brand] = tpl.brandId
    ? await db.select({ name: brands.name }).from(brands).where(eq(brands.id, tpl.brandId)).limit(1)
    : [];

  const cards = await db
    .select({
      id: cardDesigns.id,
      name: cardDesigns.name,
      status: cardDesigns.status,
      presetCode: cardDesigns.presetCode,
      updatedAt: cardDesigns.updatedAt,
      partNumber: products.partNumber,
      description: products.description,
    })
    .from(cardDesigns)
    .leftJoin(products, eq(products.id, cardDesigns.productId))
    .where(and(eq(cardDesigns.orgId, user.orgId), eq(cardDesigns.templateId, tpl.id)))
    .orderBy(desc(cardDesigns.updatedAt))
    .limit(100);

  const preset = CARD_PRESETS[tpl.presetCode as CardPresetDef["code"]];
  const parsed = DesignDocSchema.safeParse(tpl.doc);

  const header = (
    <PageHeader
      title={tpl.name}
      description={tpl.description || "No description recorded for this template."}
      actions={
        <>
          {canWrite ? (
            <DuplicateTemplateButton templateId={tpl.id} size="md" variant="outline" />
          ) : null}
          {canDesign ? (
            <StartCardButton
              templateId={tpl.id}
              presetCode={tpl.presetCode}
              size="md"
              variant="primary"
            />
          ) : null}
        </>
      }
      meta={
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="brand">{tpl.presetCode}</Badge>
          {tpl.isMaster ? <Badge tone="brand">master</Badge> : null}
          <Badge>{brand?.name ?? "Any brand"}</Badge>
          <span className="numeric text-xs text-ink-500">
            version {tpl.version} · updated {tpl.updatedAt.toLocaleString()}
          </span>
          {preset ? (
            <span className="numeric text-xs text-ink-500">
              trim {formatLength(preset.trimWidth, "in")} ×{" "}
              {formatLength(preset.trimHeight, "in")} in · page{" "}
              {formatLength(preset.trimWidth + preset.bleed.left + preset.bleed.right, "in")} ×{" "}
              {formatLength(preset.trimHeight + preset.bleed.top + preset.bleed.bottom, "in")} in
            </span>
          ) : null}
        </div>
      }
    />
  );

  if (!parsed.success) {
    return (
      <>
        {header}
        <div className="p-8">
          <Panel title="This template no longer validates">
            <div className="space-y-2 px-4 py-4">
              <p className="text-sm leading-relaxed text-flag-200" role="alert">
                The stored document does not parse against the current document schema, so it cannot
                be previewed and no card can be started from it.
              </p>
              <p className="text-[12px] leading-relaxed text-ink-400">
                First failure:{" "}
                <span className="font-mono text-ink-200">
                  {parsed.error.issues[0]?.path.join(".") || "(root)"}
                </span>{" "}
                — {parsed.error.issues[0]?.message}
              </p>
              <p className="text-[12px] leading-relaxed text-ink-400">
                Duplicate a master template for {tpl.presetCode} and re-apply the changes, rather
                than editing the invalid document in place.
              </p>
            </div>
          </Panel>
        </div>
      </>
    );
  }

  const doc = parsed.data;
  // A template has no product of its own, so it previews against the sample
  // context: real copy lengths, clearly labelled as sample data.
  const product = sampleProductContext();
  const assets = await loadAssetMap(user.orgId);
  const plans = {
    front: planSide({ doc, side: "front", product, assets }),
    back: planSide({ doc, side: "back", product, assets }),
  } as const;

  const inventory = SIDE_KEYS.flatMap((side) =>
    doc[side].elements.map((el, z) => ({
      side,
      z,
      el,
      paths: collectBindingPaths(el),
    })),
  );

  const boundCount = inventory.filter((r) => r.paths.length > 0).length;
  const lockedCount = inventory.filter((r) => r.el.locked || r.el.templateLocked).length;
  const requiredCount = inventory.filter((r) => r.el.required).length;

  return (
    <>
      {header}

      <div className="space-y-6 p-8">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="Elements"
            value={inventory.length}
            sub={`${doc.front.elements.length} front · ${doc.back.elements.length} back`}
          />
          <Stat label="Bound to product data" value={boundCount} />
          <Stat label="Locked" value={lockedCount} sub="Not movable on a generated card" />
          <Stat label="Required" value={requiredCount} sub="Blocking when they resolve empty" />
        </div>

        <Panel
          title="Preview"
          description={`Rendered from the sample product ${product.partNumber} — ${product.description}. A card started from this template resolves its own product instead.`}
        >
          <div className="grid gap-6 p-4 sm:grid-cols-2">
            {SIDE_KEYS.map((side) => (
              <figure key={side} className="min-w-0">
                <div className="rounded border border-ink-700 bg-ink-950 p-3">
                  <div className="mx-auto max-w-[260px] shadow-[0_6px_18px_rgba(0,0,0,0.5)]">
                    <SideThumbnail
                      plan={plans[side]}
                      label={`${tpl.name}, ${side} of the card`}
                    />
                  </div>
                </div>
                <figcaption className="mt-2 flex items-baseline justify-between gap-3">
                  <span className="text-[12px] font-medium capitalize text-ink-200">{side}</span>
                  <span className="numeric text-[11px] text-ink-500">
                    {doc[side].elements.length} elements ·{" "}
                    {plans[side].facesUsed.length} font faces
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
          <p className="border-t border-ink-800 px-4 py-3 text-[11px] leading-relaxed text-ink-500">
            The dashed line is the trim edge; everything outside it is bleed that the cutter removes.
            Colour is a CMYK to RGB approximation for screen — it is not colour-managed.
          </p>
        </Panel>

        <Panel
          title="Elements"
          description="Paint order, top of the list drawn first. Bound paths resolve against the product at render time."
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                  <th scope="col" className="px-4 py-2 font-medium">
                    Side
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Z
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Kind
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Name
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Bound fields
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Size (in)
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Flags
                  </th>
                </tr>
              </thead>
              <tbody>
                {inventory.map(({ side, z, el, paths }) => (
                  <tr
                    key={`${side}-${el.id}`}
                    className="border-b border-ink-800/60 align-top last:border-0 hover:bg-ink-800/30"
                  >
                    <td className="px-4 py-2 capitalize text-ink-400">{side}</td>
                    <td className="numeric px-4 py-2 text-right text-ink-500">{z}</td>
                    <td className="px-4 py-2">
                      <Badge>{KIND_LABELS[el.kind]}</Badge>
                    </td>
                    <th scope="row" className="px-4 py-2 text-left font-normal text-ink-100">
                      {defaultElementName(el)}
                      {el.kind === "group" ? (
                        <span className="numeric ml-2 text-[11px] text-ink-500">
                          {el.childIds.length} children
                        </span>
                      ) : null}
                      {el.kind === "barcode" ? (
                        <span className="ml-2 text-[11px] uppercase tracking-wide text-ink-500">
                          {el.symbology}
                        </span>
                      ) : null}
                    </th>
                    <td className="px-4 py-2">
                      {paths.length ? (
                        <span className="flex flex-wrap gap-1">
                          {paths.map((p) => (
                            <code
                              key={p}
                              className="rounded border border-ink-700 bg-ink-900 px-1 py-0.5 font-mono text-[11px] text-ink-300"
                            >
                              {p}
                            </code>
                          ))}
                        </span>
                      ) : (
                        <span className="text-[12px] text-ink-600">Static</span>
                      )}
                    </td>
                    <td className="numeric whitespace-nowrap px-4 py-2 text-right text-ink-400">
                      {formatLength(el.frame.w, "in")} × {formatLength(el.frame.h, "in")}
                    </td>
                    <td className="px-4 py-2">
                      <span className="flex flex-wrap gap-1">
                        {el.templateLocked ? <Badge tone="warning">template-locked</Badge> : null}
                        {el.locked && !el.templateLocked ? <Badge tone="warning">locked</Badge> : null}
                        {el.required ? <Badge tone="danger">required</Badge> : null}
                        {el.hidden ? <Badge>hidden</Badge> : null}
                        {/* Not a Badge: badges uppercase their text, and a
                            binding path is case-sensitive. */}
                        {el.visibleWhen ? (
                          <span className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-sky-700/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sev-info">
                            when
                            <code className="font-mono">{el.visibleWhen}</code>
                          </span>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-ink-800 px-4 py-3 text-[11px] leading-relaxed text-ink-500">
            A template-locked element is brand-critical: a designer working on a card generated from
            this template cannot move or edit it. A required element that resolves empty is a
            blocking preflight finding, not a warning.
          </p>
        </Panel>

        <Panel
          title="Cards from this template"
          description="Each card re-issued its own element ids at creation, so editing one never touches another."
        >
          {cards.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4">
              <p className="max-w-xl text-[13px] leading-relaxed text-ink-400">
                No card has been started from this template yet. Starting one here opens the editor
                on sample data; to bind a product at the same time, begin on the new card screen.
              </p>
              <Link href="/designs/new">
                <Button variant="outline">New card</Button>
              </Link>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                  <th scope="col" className="px-4 py-2 font-medium">
                    Card
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Product
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Updated
                  </th>
                </tr>
              </thead>
              <tbody>
                {cards.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-ink-800/60 last:border-0 hover:bg-ink-800/30"
                  >
                    <th scope="row" className="px-4 py-2.5 text-left font-normal">
                      <Link
                        href={`/designs/${c.id}`}
                        className="font-medium text-ink-100 hover:text-brand-300"
                      >
                        {c.name}
                      </Link>
                    </th>
                    <td className="px-4 py-2.5">
                      {c.partNumber ? (
                        <>
                          <span className="numeric text-ink-300">{c.partNumber}</span>
                          {c.description ? (
                            <span className="ml-2 text-[11px] text-ink-500">
                              {c.description.slice(0, 48)}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-ink-600">Sample data — no product linked</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={STATUS_TONE[c.status] ?? "neutral"}>
                        {c.status.replace("_", " ")}
                      </Badge>
                    </td>
                    <td className="numeric px-4 py-2.5 text-ink-400">
                      {c.updatedAt.toLocaleDateString()}
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
