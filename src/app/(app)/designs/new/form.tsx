"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, Badge } from "@/components/ui/panel";
import { createDesignAction, ensureMasterTemplatesAction } from "@/server/templates";
import { cn } from "@/lib/cn";

type Preset = { code: string; name: string; trim: string; bleed: string };
type Product = {
  id: string;
  partNumber: string;
  description: string;
  brandName: string;
  upc: string;
  status: string;
};
type Template = {
  id: string;
  name: string;
  presetCode: string;
  description: string;
  isMaster: boolean;
};

export function NewCardForm({
  presets,
  products,
  templates,
}: {
  presets: Preset[];
  products: Product[];
  templates: Template[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [preset, setPreset] = useState(presets[0]?.code ?? "");
  const [productId, setProductId] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const available = templates.filter((t) => t.presetCode === preset);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? products.filter(
          (p) =>
            p.partNumber.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            p.upc.includes(q) ||
            p.brandName.toLowerCase().includes(q),
        )
      : products;
    return base.slice(0, 200);
  }, [products, query]);

  const selectedProduct = products.find((p) => p.id === productId) ?? null;

  const submit = () => {
    setError(null);
    start(async () => {
      const res = await createDesignAction({
        name:
          name.trim() ||
          (selectedProduct
            ? `${selectedProduct.partNumber} — ${preset}`
            : `${preset} card`),
        presetCode: preset,
        productId,
        templateId,
      });
      if (res.ok) router.push(`/designs/${res.designId}/edit`);
      else setError(res.error);
    });
  };

  const seed = () => {
    start(async () => {
      await ensureMasterTemplatesAction();
      router.refresh();
    });
  };

  return (
    <div className="grid max-w-6xl gap-6 xl:grid-cols-[1fr_360px]">
      <div className="space-y-6">
        <Panel title="Dieline" description="Trim is authoritative; the page exported is the full-bleed canvas.">
          <div className="grid gap-2 p-3 sm:grid-cols-3">
            {presets.map((p) => (
              <button
                key={p.code}
                type="button"
                onClick={() => { setPreset(p.code); setTemplateId(null); }}
                aria-pressed={preset === p.code}
                className={cn(
                  "rounded-panel border p-3 text-left transition-colors",
                  preset === p.code
                    ? "border-brand-500 bg-brand-600/10"
                    : "border-ink-700 hover:border-ink-600",
                )}
              >
                <div className="font-display text-sm font-bold text-ink-50">{p.code}</div>
                <div className="numeric mt-1 text-[11px] text-ink-300">{p.trim} trim</div>
                <div className="numeric text-[11px] text-ink-500">{p.bleed} bleed</div>
              </button>
            ))}
          </div>
        </Panel>

        <Panel
          title="Template"
          description="A template supplies the layout; the product supplies the words."
          actions={
            available.length === 0 ? (
              <Button size="sm" variant="outline" onClick={seed} disabled={pending}>
                <Sparkles size={13} /> Create master templates
              </Button>
            ) : null
          }
        >
          <div className="space-y-2 p-3">
            <button
              type="button"
              onClick={() => setTemplateId(null)}
              aria-pressed={templateId === null}
              className={cn(
                "block w-full rounded-panel border p-3 text-left transition-colors",
                templateId === null ? "border-brand-500 bg-brand-600/10" : "border-ink-700 hover:border-ink-600",
              )}
            >
              <div className="text-sm font-medium text-ink-100">Blank card</div>
              <div className="mt-0.5 text-[11px] text-ink-500">
                An empty front and back on the {preset} dieline, with the standard
                black-and-white intent on the back.
              </div>
            </button>
            {available.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTemplateId(t.id)}
                aria-pressed={templateId === t.id}
                className={cn(
                  "block w-full rounded-panel border p-3 text-left transition-colors",
                  templateId === t.id ? "border-brand-500 bg-brand-600/10" : "border-ink-700 hover:border-ink-600",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-ink-100">{t.name}</span>
                  {t.isMaster ? <Badge tone="brand">master</Badge> : null}
                </div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-ink-500">
                  {t.description}
                </div>
              </button>
            ))}
            {available.length === 0 ? (
              <p className="px-1 py-2 text-xs text-ink-500">
                No templates exist for {preset} yet. Create the master templates to
                start from the 11-500 structure, or begin from a blank card.
              </p>
            ) : null}
          </div>
        </Panel>

        <Panel title="Product" description="The card's variable data resolves from this product.">
          <div className="border-b border-ink-800 p-3">
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search part number, description, UPC or brand"
                aria-label="Search products"
                className="h-8 w-full rounded border border-ink-700 bg-ink-850 pl-8 pr-2 text-sm text-ink-100 placeholder:text-ink-600 focus:border-brand-500"
              />
            </div>
          </div>
          <div className="max-h-80 overflow-y-auto">
            <button
              type="button"
              onClick={() => setProductId(null)}
              className={cn(
                "flex w-full items-center gap-3 px-4 py-2 text-left text-sm",
                productId === null ? "bg-brand-600/15 text-brand-100" : "text-ink-300 hover:bg-ink-800/50",
              )}
            >
              No product — design a template with sample data
            </button>
            {filtered.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setProductId(p.id)}
                className={cn(
                  "flex w-full items-baseline gap-3 px-4 py-1.5 text-left",
                  productId === p.id ? "bg-brand-600/15" : "hover:bg-ink-800/50",
                )}
              >
                <span className="numeric w-20 shrink-0 text-[13px] text-ink-100">
                  {p.partNumber || "—"}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink-400">
                  {p.description}
                </span>
                <span className="numeric shrink-0 text-[11px] text-ink-500">{p.upc}</span>
              </button>
            ))}
            {filtered.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-500">
                No products match “{query}”.
              </p>
            ) : null}
          </div>
        </Panel>
      </div>

      <div className="space-y-4">
        <Panel title="Summary">
          <div className="space-y-3 p-4 text-sm">
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-wide text-ink-500">
                Card name
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={
                  selectedProduct ? `${selectedProduct.partNumber} — ${preset}` : `${preset} card`
                }
                className="h-8 w-full rounded border border-ink-700 bg-ink-850 px-2 text-sm text-ink-100 placeholder:text-ink-600 focus:border-brand-500"
              />
            </label>
            <Row label="Dieline" value={preset} />
            <Row
              label="Template"
              value={available.find((t) => t.id === templateId)?.name ?? "Blank card"}
            />
            <Row
              label="Product"
              value={
                selectedProduct
                  ? `${selectedProduct.partNumber} · ${selectedProduct.brandName}`
                  : "Sample data"
              }
            />
            {selectedProduct && !selectedProduct.upc ? (
              <p className="rounded border border-amber-800/50 bg-amber-500/10 px-2 py-1.5 text-[11px] text-sev-warning">
                This product has no UPC. A UPC-A barcode on the card will fail
                preflight until one is recorded.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="rounded border border-flag-800 bg-flag-900/30 px-2 py-1.5 text-[11px] text-flag-200">
                {error}
              </p>
            ) : null}
            <Button variant="primary" className="w-full justify-center" onClick={submit} disabled={pending}>
              {pending ? "Creating…" : "Create and open editor"}
            </Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-ink-800 pt-2 first:border-0 first:pt-0">
      <span className="text-[11px] uppercase tracking-wide text-ink-500">{label}</span>
      <span className="min-w-0 truncate text-[13px] text-ink-200">{value}</span>
    </div>
  );
}
