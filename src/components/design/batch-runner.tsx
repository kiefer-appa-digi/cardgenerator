"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, Stat, Badge } from "@/components/ui/panel";
import { advanceBatchAction, createBatchAction } from "@/server/batch";
import { cn } from "@/lib/cn";

type Template = {
  id: string;
  name: string;
  presetCode: string;
  brandName: string;
  isMaster: boolean;
};
type Product = {
  id: string;
  partNumber: string;
  description: string;
  brandName: string;
  status: string;
  upc: string;
};

export function BatchRunner({
  templates,
  products,
}: {
  templates: Template[];
  products: Product[];
}) {
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [requireUpc, setRequireUpc] = useState(true);
  const [continueOnBlocked, setContinueOnBlocked] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    jobId: string;
    completed: number;
    failed: number;
    total: number;
    done: boolean;
  } | null>(null);

  const brandNames = useMemo(
    () => Array.from(new Set(products.map((p) => p.brandName).filter(Boolean))).sort(),
    [products],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products
      .filter((p) => (brandFilter ? p.brandName === brandFilter : true))
      .filter((p) => (requireUpc ? Boolean(p.upc) : true))
      .filter(
        (p) =>
          !q ||
          p.partNumber.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.upc.includes(q),
      )
      .slice(0, 400);
  }, [products, query, brandFilter, requireUpc]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const run = () => {
    setError(null);
    start(async () => {
      const created = await createBatchAction({
        templateId,
        productIds: [...selected],
        continueOnBlocked,
      });
      if (!created.ok) {
        setError(created.error);
        return;
      }
      setProgress({ jobId: created.jobId, completed: 0, failed: 0, total: created.total, done: false });

      // The job advances in slices so a long run cannot exceed a single request's
      // budget, and an interrupted batch resumes exactly where it stopped.
      let done = false;
      while (!done) {
        const res = await advanceBatchAction(created.jobId);
        if (!res.ok) {
          setError(res.error);
          return;
        }
        done = res.done;
        setProgress({
          jobId: created.jobId,
          completed: res.completed,
          failed: res.failed,
          total: res.total,
          done: res.done,
        });
      }
    });
  };

  const selectedTemplate = templates.find((t) => t.id === templateId);
  const eligible = filtered.filter((p) => selected.has(p.id)).length;
  void eligible;

  return (
    <div className="grid max-w-6xl gap-6 xl:grid-cols-[1fr_340px]">
      <div className="space-y-6">
        <Panel title="Template" description="The layout every card in the run starts from.">
          <div className="space-y-2 p-3">
            {templates.length === 0 ? (
              <p className="px-1 py-3 text-sm text-ink-400">
                No templates yet.{" "}
                <Link href="/templates" className="text-brand-300 hover:text-brand-200">
                  Create the master templates
                </Link>{" "}
                first.
              </p>
            ) : (
              templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTemplateId(t.id)}
                  aria-pressed={templateId === t.id}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-panel border px-3 py-2.5 text-left transition-colors",
                    templateId === t.id
                      ? "border-brand-500 bg-brand-600/10"
                      : "border-ink-700 hover:border-ink-600",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-ink-100">{t.name}</span>
                  {t.isMaster ? <Badge tone="brand">master</Badge> : null}
                  <Badge>{t.presetCode}</Badge>
                </button>
              ))
            )}
          </div>
        </Panel>

        <Panel
          title={`Products — ${selected.size} selected`}
          actions={
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelected(new Set(filtered.map((p) => p.id)))}
              >
                Select all shown
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          }
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-ink-800 p-3">
            <div className="relative min-w-56 flex-1">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search part number, description or UPC"
                aria-label="Search products"
                className="h-8 w-full rounded border border-ink-700 bg-ink-850 pl-8 pr-2 text-sm text-ink-100 placeholder:text-ink-600 focus:border-brand-500"
              />
            </div>
            <select
              value={brandFilter}
              onChange={(e) => setBrandFilter(e.target.value)}
              aria-label="Filter by brand"
              className="h-8 rounded border border-ink-700 bg-ink-850 px-2 text-xs text-ink-200"
            >
              <option value="">All brands</option>
              {brandNames.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-ink-300">
              <input
                type="checkbox"
                checked={requireUpc}
                onChange={(e) => setRequireUpc(e.target.checked)}
                className="h-3.5 w-3.5 accent-brand-500"
              />
              Only products with a UPC
            </label>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {filtered.map((p) => (
              <label
                key={p.id}
                className={cn(
                  "flex cursor-pointer items-baseline gap-3 px-4 py-1.5",
                  selected.has(p.id) ? "bg-brand-600/10" : "hover:bg-ink-800/50",
                )}
              >
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                  className="h-3.5 w-3.5 shrink-0 accent-brand-500"
                />
                <span className="numeric w-20 shrink-0 text-[13px] text-ink-100">
                  {p.partNumber || "—"}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink-400">
                  {p.description}
                </span>
                <span className="numeric shrink-0 text-[11px] text-ink-500">{p.upc || "no UPC"}</span>
              </label>
            ))}
            {filtered.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-ink-500">
                No products match those filters.
              </p>
            ) : null}
          </div>
          {filtered.length === 400 ? (
            <p className="border-t border-ink-800 px-4 py-2 text-[11px] text-ink-500">
              Showing the first 400 matches. Narrow the search to reach the rest — nothing beyond
              this point is silently included in a run.
            </p>
          ) : null}
        </Panel>
      </div>

      <div className="space-y-4">
        <Panel title="Run">
          <div className="space-y-3 p-4">
            <Row label="Template" value={selectedTemplate?.name ?? "—"} />
            <Row label="Dieline" value={selectedTemplate?.presetCode ?? "—"} />
            <Row label="Cards" value={String(selected.size)} />

            <label className="flex items-start gap-2 pt-1">
              <input
                type="checkbox"
                checked={continueOnBlocked}
                onChange={(e) => setContinueOnBlocked(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-flag-500"
              />
              <span>
                <span className="block text-xs text-ink-200">
                  Generate cards that fail preflight
                </span>
                <span className="block text-[10px] leading-snug text-ink-500">
                  They are still produced, marked in the manifest with the blocking codes, and the
                  decision is recorded in the audit log.
                </span>
              </span>
            </label>

            {error ? (
              <p role="alert" className="rounded border border-flag-800 bg-flag-900/30 px-2 py-1.5 text-[12px] text-flag-200">
                {error}
              </p>
            ) : null}

            <Button
              variant="primary"
              className="w-full justify-center"
              disabled={pending || selected.size === 0 || !templateId}
              onClick={run}
            >
              {pending ? "Generating…" : `Generate ${selected.size} card${selected.size === 1 ? "" : "s"}`}
            </Button>
          </div>
        </Panel>

        {progress ? (
          <Panel title={progress.done ? "Batch complete" : "Generating"}>
            <div className="grid grid-cols-3 gap-2 p-3">
              <Stat label="Done" value={progress.completed} tone="ok" />
              <Stat
                label="Not produced"
                value={progress.failed}
                tone={progress.failed ? "warning" : "default"}
              />
              <Stat label="Total" value={progress.total} />
            </div>
            <div className="px-4 pb-3">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
                <div
                  className="h-full bg-brand-500 transition-[width]"
                  style={{
                    width: `${Math.round(((progress.completed + progress.failed) / Math.max(1, progress.total)) * 100)}%`,
                  }}
                />
              </div>
            </div>
            <div className="border-t border-ink-800 px-4 py-3">
              <Link
                href={`/exports/${progress.jobId}`}
                className="text-xs text-brand-300 hover:text-brand-200"
              >
                Open the manifest →
              </Link>
            </div>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-ink-800 pt-2 first:border-0 first:pt-0">
      <span className="text-[11px] uppercase tracking-wide text-ink-500">{label}</span>
      <span className="numeric min-w-0 truncate text-[13px] text-ink-200">{value}</span>
    </div>
  );
}
