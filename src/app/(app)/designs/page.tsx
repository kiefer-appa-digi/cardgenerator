import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { cardDesigns, db, products } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { PageHeader, Panel, EmptyState, Badge } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "neutral" | "info" | "ok" | "warning"> = {
  draft: "neutral",
  in_review: "info",
  approved: "ok",
  superseded: "warning",
};

export default async function DesignsPage() {
  const user = await requireUser();
  const rows = await db
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
    .where(eq(cardDesigns.orgId, user.orgId))
    .orderBy(desc(cardDesigns.updatedAt))
    .limit(200);

  return (
    <>
      <PageHeader
        title="Cards"
        description="Every card is a front/back pair on one dieline, bound to a product and tracked through draft, review and approval."
        actions={
          <Link href="/designs/new">
            <Button variant="primary">New card</Button>
          </Link>
        }
      />
      <div className="p-8">
        <Panel>
          {rows.length === 0 ? (
            <EmptyState
              title="No cards yet"
              description="Start from the 11-500 master template and a product, and the front and back are populated from the product data straight away."
              action={
                <Link href="/designs/new">
                  <Button variant="primary">New card</Button>
                </Link>
              }
            />
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                  <th className="px-4 py-2 font-medium">Card</th>
                  <th className="px-4 py-2 font-medium">Product</th>
                  <th className="px-4 py-2 font-medium">Dieline</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Updated</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id} className="border-b border-ink-800/60 last:border-0 hover:bg-ink-800/30">
                    <td className="px-4 py-2.5">
                      <Link href={`/designs/${d.id}`} className="font-medium text-ink-100 hover:text-brand-300">
                        {d.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      {d.partNumber ? (
                        <span className="numeric text-ink-300">{d.partNumber}</span>
                      ) : (
                        <span className="text-ink-600">—</span>
                      )}
                      {d.description ? (
                        <span className="ml-2 text-[11px] text-ink-500">
                          {d.description.slice(0, 48)}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge>{d.presetCode}</Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={STATUS_TONE[d.status] ?? "neutral"}>
                        {d.status.replace("_", " ")}
                      </Badge>
                    </td>
                    <td className="numeric px-4 py-2.5 text-ink-400">
                      {d.updatedAt.toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <Link
                        href={`/designs/${d.id}/edit`}
                        className="text-xs text-brand-300 hover:text-brand-200"
                      >
                        Open editor →
                      </Link>
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
