"use client";

import {
  Barcode, ChevronDown, ChevronUp, Circle, Eye, EyeOff, Image as ImageIcon,
  List, Lock, Minus, Square, Trash2, Type, Unlock,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { defaultElementName, type DesignElement } from "@/lib/design/schema";
import type { EditorStore } from "@/lib/editor/store";
import { useEditorSelector } from "@/lib/editor/store";

const ICONS = {
  text: Type,
  image: ImageIcon,
  barcode: Barcode,
  bomList: List,
  group: Square,
} as const;

function iconFor(el: DesignElement) {
  if (el.kind === "shape") {
    return el.shape === "ellipse" ? Circle : el.shape === "line" ? Minus : Square;
  }
  return ICONS[el.kind as keyof typeof ICONS] ?? Square;
}

/**
 * Layers are listed top-of-stack first, which is how every design tool presents
 * them and the opposite of the paint order stored in the document.
 */
export function LayersPanel({ store }: { store: EditorStore }) {
  const elements = useEditorSelector(store, (s) => s.doc[s.side].elements);
  const selection = useEditorSelector(store, (s) => s.selection.join(","));
  const selected = new Set(selection ? selection.split(",") : []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-ink-800 px-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">
          Layers
        </h2>
        <span className="numeric text-[11px] text-ink-500">{elements.length}</span>
      </div>

      {elements.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs leading-relaxed text-ink-500">
          Nothing on this side yet. Pick a tool and drag on the artboard, or start
          from a template.
        </p>
      ) : (
        <ul className="flex-1 overflow-y-auto py-1">
          {[...elements].reverse().map((el, revIndex) => {
            const index = elements.length - 1 - revIndex;
            const Icon = iconFor(el);
            const isSelected = selected.has(el.id);
            return (
              <li key={el.id}>
                <div
                  className={cn(
                    "group flex items-center gap-1.5 px-2 py-1.5 text-[13px]",
                    isSelected ? "bg-brand-600/20 text-brand-100" : "text-ink-300 hover:bg-ink-800/60",
                  )}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      if (e.shiftKey || e.metaKey) store.toggleSelect(el.id);
                      else store.select([el.id]);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  >
                    <Icon size={13} strokeWidth={1.75} className="shrink-0 opacity-70" />
                    <span className={cn("truncate", el.hidden && "opacity-40 line-through")}>
                      {defaultElementName(el)}
                    </span>
                    {el.templateLocked ? (
                      <span className="shrink-0 rounded bg-ink-700 px-1 text-[9px] uppercase text-ink-300">
                        brand
                      </span>
                    ) : null}
                    {el.required ? (
                      <span className="shrink-0 text-[9px] uppercase text-sev-warning">req</span>
                    ) : null}
                  </button>

                  <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      type="button"
                      title="Move up"
                      aria-label={`Move ${defaultElementName(el)} up`}
                      onClick={() => store.reorder(el.id, index + 1)}
                      className="p-1 text-ink-400 hover:text-ink-100"
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      type="button"
                      title="Move down"
                      aria-label={`Move ${defaultElementName(el)} down`}
                      onClick={() => store.reorder(el.id, index - 1)}
                      className="p-1 text-ink-400 hover:text-ink-100"
                    >
                      <ChevronDown size={12} />
                    </button>
                  </div>

                  <button
                    type="button"
                    title={el.hidden ? "Show" : "Hide"}
                    aria-label={el.hidden ? `Show ${defaultElementName(el)}` : `Hide ${defaultElementName(el)}`}
                    onClick={() =>
                      store.updateElements([el.id], (e) => ({ ...e, hidden: !e.hidden }), {
                        coalesceKey: "unlock-vis",
                      })
                    }
                    className="shrink-0 p-1 text-ink-400 hover:text-ink-100"
                  >
                    {el.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                  <button
                    type="button"
                    title={el.locked ? "Unlock" : "Lock"}
                    aria-label={el.locked ? `Unlock ${defaultElementName(el)}` : `Lock ${defaultElementName(el)}`}
                    onClick={() =>
                      store.updateElements([el.id], (e) => ({ ...e, locked: !e.locked }), {
                        coalesceKey: "unlock-lock",
                      })
                    }
                    className={cn(
                      "shrink-0 p-1 hover:text-ink-100",
                      el.locked ? "text-sev-warning" : "text-ink-400",
                    )}
                  >
                    {el.locked ? <Lock size={13} /> : <Unlock size={13} />}
                  </button>
                  <button
                    type="button"
                    title="Delete"
                    aria-label={`Delete ${defaultElementName(el)}`}
                    disabled={el.locked || el.templateLocked}
                    onClick={() => store.removeElements([el.id])}
                    className="shrink-0 p-1 text-ink-400 hover:text-flag-400 disabled:opacity-30"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
