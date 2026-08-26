"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { nanoid } from "nanoid";
import { FIELD_CATALOG, FIELD_GROUPS, resolvePath, type ProductContext } from "@/lib/data/context";
import { TEXT_BLACK } from "@/lib/color/types";
import { TextElementSchema } from "@/lib/design/schema";
import type { EditorStore } from "@/lib/editor/store";
import { useEditorSelector } from "@/lib/editor/store";
import { cn } from "@/lib/cn";

/**
 * THE DATA PANEL
 *
 * The point of the whole variable-data feature is that a designer should be able
 * to see the real value for the real product while they lay out the card, so this
 * browser shows each field's RESOLVED value for the currently selected product,
 * not just the token name. An empty field is shown as empty — greyed and
 * labelled — rather than hidden, because a missing GTIN is exactly the thing a
 * packaging designer needs to notice before they export.
 */
export function DataPanel({
  store,
  product,
  onPickProduct,
  productLabel,
}: {
  store: EditorStore;
  product: ProductContext;
  onPickProduct?: () => void;
  productLabel: string;
}) {
  const [query, setQuery] = useState("");
  const selection = useEditorSelector(store, (s) => s.selection.join(","));
  const elements = useEditorSelector(store, (s) => s.doc[s.side].elements);
  const selectedId = selection ? selection.split(",")[0] : null;
  const selectedEl = elements.find((e) => e.id === selectedId);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return FIELD_GROUPS.map((g) => ({
      group: g,
      fields: FIELD_CATALOG.filter(
        (f) =>
          f.group === g &&
          (!q || f.label.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)),
      ),
    })).filter((g) => g.fields.length > 0);
  }, [query]);

  const insertField = (path: string, label: string) => {
    const st = store.getState();
    // Dropping a field onto a selected text element appends a bound run; with
    // nothing selected it becomes a new text block near the centre of the safe
    // area, which is where a designer will move it from anyway.
    if (selectedEl && selectedEl.kind === "text" && !selectedEl.locked) {
      store.updateElements([selectedEl.id], (el) => {
        if (el.kind !== "text") return el;
        const paras = el.paragraphs.length
          ? el.paragraphs
          : [{ runs: [], styleId: undefined, spaceBefore: 0, spaceAfter: 0, listBullet: undefined }];
        const last = paras[paras.length - 1];
        return {
          ...el,
          paragraphs: [
            ...paras.slice(0, -1),
            {
              ...last,
              runs: [
                ...last.runs,
                {
                  text: "",
                  binding: {
                    path,
                    fallback: "",
                    prefix: "",
                    suffix: "",
                    transform: "none" as const,
                    joiner: ", ",
                    hideWhenEmpty: false,
                  },
                  bold: false,
                  italic: false,
                },
              ],
            },
          ],
        };
      });
      return;
    }

    const el = TextElementSchema.parse({
      id: nanoid(12),
      kind: "text",
      name: label,
      frame: {
        x: st.doc.presetCode === "206TF" ? 27_000_000 : 36_000_000,
        y: 90_000_000,
        w: 120_000_000,
        h: 18_000_000,
      },
      fontFamily: "Archivo",
      fontWeight: 700,
      fontSize: 12_000_000,
      color: TEXT_BLACK,
      paragraphs: [
        {
          runs: [
            {
              text: "",
              binding: {
                path,
                fallback: "",
                prefix: "",
                suffix: "",
                transform: "none",
                joiner: ", ",
                hideWhenEmpty: false,
              },
              bold: false,
              italic: false,
            },
          ],
          spaceBefore: 0,
          spaceAfter: 0,
        },
      ],
    });
    store.addElement(el);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-ink-800 px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">
          Product data
        </span>
      </div>

      <button
        type="button"
        onClick={onPickProduct}
        className="flex shrink-0 items-center gap-2 border-b border-ink-800 px-3 py-2.5 text-left hover:bg-ink-800/50"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink-100">
            {productLabel || "No product linked"}
          </span>
          <span className="numeric block truncate text-[11px] text-ink-500">
            {product.identifiers.upc12 || "no UPC"} · {product.brand.name || "no brand"}
          </span>
        </span>
        <ChevronRight size={14} className="shrink-0 text-ink-500" />
      </button>

      <div className="shrink-0 border-b border-ink-800 p-2">
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a field"
            aria-label="Search product fields"
            className="h-7 w-full rounded border border-ink-700 bg-ink-850 pl-7 pr-2 text-xs text-ink-100 placeholder:text-ink-600 focus:border-brand-500"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {groups.map((g) => (
          <div key={g.group}>
            <div className="sticky top-0 z-10 bg-ink-900 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
              {g.group}
            </div>
            <ul>
              {g.fields.map((f) => {
                const raw = resolvePath(product, f.path);
                const value = formatPreview(raw);
                const empty = value === "";
                return (
                  <li key={f.path}>
                    <button
                      type="button"
                      onClick={() => insertField(f.path, f.label)}
                      title={f.description}
                      className="group flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-ink-800/60"
                    >
                      <span className="w-[42%] shrink-0 truncate text-xs text-ink-300 group-hover:text-ink-100">
                        {f.label}
                      </span>
                      <span
                        className={cn(
                          "numeric min-w-0 flex-1 truncate text-[11px]",
                          empty ? "italic text-ink-600" : "text-ink-100",
                        )}
                      >
                        {empty ? (f.type === "collection" ? "repeating block" : "empty") : value}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>

      <p className="shrink-0 border-t border-ink-800 px-3 py-2 text-[10px] leading-snug text-ink-500">
        Click a field to bind it. With a text block selected it is appended to
        that block; otherwise a new bound block is created.
      </p>
    </div>
  );
}

function formatPreview(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.length ? v.map(String).join(", ") : "";
  if (typeof v === "object") return "";
  return String(v);
}
