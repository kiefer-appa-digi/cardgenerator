"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ProductFilterState = {
  q: string;
  brand: string;
  status: string;
  card: string;
};

export type FilterOption = { value: string; label: string; count: number };

const SELECT_CLASS =
  "h-8 rounded border border-ink-700 bg-ink-850 px-2 text-[13px] text-ink-100 focus:border-brand-500";

/**
 * The list filters live in the URL, so a filtered view is a link a buyer can
 * send to a designer. This component only writes to the URL; the page reads it
 * and does the querying.
 *
 * The text box is debounced and the selects apply at once, which is the split
 * that keeps typing from queuing eight round trips while a two-click filter
 * still feels immediate.
 */
export function ProductFilters({
  initial,
  brands,
  statuses,
  resultCount,
  totalCount,
}: {
  initial: ProductFilterState;
  brands: FilterOption[];
  statuses: FilterOption[];
  resultCount: number;
  totalCount: number;
}) {
  const router = useRouter();
  const [pending, startNavigation] = useTransition();
  const [q, setQ] = useState(initial.q);
  // The search term currently IN THE URL, always trimmed, because that is the
  // form the page puts there. Held so that an incoming value we did not cause
  // (Clear, back button) overwrites the box and one we did cause does not fight
  // the cursor. Comparing trimmed-to-trimmed matters: a half-typed "brake " is
  // the same query as "brake", so it must neither re-navigate nor let the URL's
  // trimmed value be written back over the space the operator just typed.
  const pushed = useRef(initial.q);

  const push = useCallback(
    (next: ProductFilterState) => {
      pushed.current = next.q.trim();
      const params = new URLSearchParams();
      if (next.q.trim()) params.set("q", next.q.trim());
      if (next.brand) params.set("brand", next.brand);
      if (next.status) params.set("status", next.status);
      if (next.card) params.set("card", next.card);
      const qs = params.toString();
      startNavigation(() => router.push(qs ? `/products?${qs}` : "/products"));
    },
    [router],
  );

  useEffect(() => {
    if (initial.q === pushed.current) return;
    pushed.current = initial.q;
    setQ(initial.q);
  }, [initial.q]);

  useEffect(() => {
    if (q.trim() === pushed.current) return;
    const timer = setTimeout(() => push({ ...initial, q }), 250);
    return () => clearTimeout(timer);
    // `initial` is re-read on every navigation; the select values it carries are
    // the current ones, which is what a debounced search must be combined with.
  }, [q, initial, push]);

  const filtered =
    initial.q !== "" || initial.brand !== "" || initial.status !== "" || initial.card !== "";

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-64 flex-1">
        <label htmlFor="product-search" className="mb-1 block text-[10px] uppercase tracking-wide text-ink-500">
          Search
        </label>
        <div className="relative">
          <Search
            size={14}
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500"
          />
          <input
            id="product-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                push({ ...initial, q });
              }
            }}
            placeholder="Part number, description, UPC, GTIN or brand"
            className="h-8 w-full rounded border border-ink-700 bg-ink-850 pl-8 pr-2 text-[13px] text-ink-100 placeholder:text-ink-600 focus:border-brand-500"
          />
        </div>
      </div>

      <div>
        <label htmlFor="product-brand" className="mb-1 block text-[10px] uppercase tracking-wide text-ink-500">
          Brand
        </label>
        <select
          id="product-brand"
          value={initial.brand}
          onChange={(e) => push({ ...initial, q, brand: e.target.value })}
          className={SELECT_CLASS}
        >
          <option value="">All brands</option>
          {brands.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label} ({b.count})
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="product-status" className="mb-1 block text-[10px] uppercase tracking-wide text-ink-500">
          Status
        </label>
        <select
          id="product-status"
          value={initial.status}
          onChange={(e) => push({ ...initial, q, status: e.target.value })}
          className={SELECT_CLASS}
        >
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label} ({s.count})
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="product-card" className="mb-1 block text-[10px] uppercase tracking-wide text-ink-500">
          Card
        </label>
        <select
          id="product-card"
          value={initial.card}
          onChange={(e) => push({ ...initial, q, card: e.target.value })}
          className={SELECT_CLASS}
        >
          <option value="">Any</option>
          <option value="yes">Has a card</option>
          <option value="no">No card yet</option>
        </select>
      </div>

      {filtered ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setQ("");
            push({ q: "", brand: "", status: "", card: "" });
          }}
        >
          <X size={13} aria-hidden /> Clear
        </Button>
      ) : null}

      <p aria-live="polite" className="numeric ml-auto pb-1 text-xs text-ink-400">
        {pending
          ? "Searching…"
          : filtered
            ? `${resultCount} of ${totalCount} products`
            : `${totalCount} products`}
      </p>
    </div>
  );
}
