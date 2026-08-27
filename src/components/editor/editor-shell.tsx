"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, Save, Send } from "lucide-react";
import { nanoid } from "nanoid";
import { Button } from "@/components/ui/button";
import { BrandLogo } from "@/components/brand-logo";
import { EditorStore, useEditorSelector } from "@/lib/editor/store";
import { NUDGE_SHIFT_UPT, NUDGE_UPT } from "@/lib/editor/interaction";
import { planSide, type AssetInfo } from "@/lib/design/plan";
import type { DesignDoc, DesignElement } from "@/lib/design/schema";
import {
  BarcodeElementSchema, BomListElementSchema, ImageElementSchema,
  ShapeElementSchema, TextElementSchema,
} from "@/lib/design/schema";
import { TEXT_BLACK, grayPct, NONE } from "@/lib/color/types";
import type { ProductContext } from "@/lib/data/context";
import type { PreflightReport } from "@/lib/preflight/types";
import { saveDesignAction } from "@/server/designs";
import { Artboard } from "./artboard";
import { Toolbar } from "./toolbar";
import { LayersPanel } from "./layers";
import { Inspector } from "./inspector";
import { DataPanel } from "./data-panel";
import { PreflightStrip } from "./preflight-strip";
import { TextEditorOverlay } from "./text-editor-overlay";
import { cn } from "@/lib/cn";

/**
 * The editor screen. Layout follows spec §6: asset/data panel on the left,
 * artboard in the middle, inspector on the right, toolbar on top, preflight
 * status along the bottom.
 */
export function EditorShell({
  designId,
  designName,
  initialDoc,
  product,
  productLabel,
  assets,
  status,
  revisionNumber,
  canWrite,
  canSubmit,
}: {
  designId: string;
  designName: string;
  initialDoc: DesignDoc;
  product: ProductContext;
  productLabel: string;
  assets: Array<AssetInfo & { url: string; filename?: string }>;
  status: string;
  revisionNumber: number;
  canWrite: boolean;
  canSubmit: boolean;
}) {
  const storeRef = useRef<EditorStore>(null);
  if (!storeRef.current) storeRef.current = new EditorStore(initialDoc);
  const store = storeRef.current;

  const doc = useEditorSelector(store, (s) => s.doc);
  const side = useEditorSelector(store, (s) => s.side);
  const dirty = useEditorSelector(store, (s) => s.dirty);
  const saving = useEditorSelector(store, (s) => s.saving);
  const lastSavedAt = useEditorSelector(store, (s) => s.lastSavedAt);
  const editingTextId = useEditorSelector(store, (s) => s.editingTextId);
  const tool = useEditorSelector(store, (s) => s.tool);

  const [leftTab, setLeftTab] = useState<"data" | "layers">("data");
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Uploading from inside the editor has to add to this list immediately;
  // otherwise the asset the designer just chose renders as a missing placeholder
  // until the next full page load.
  const [extraAssets, setExtraAssets] = useState<
    Array<AssetInfo & { url: string; filename?: string }>
  >([]);
  const allAssets = useMemo(() => [...extraAssets, ...assets], [extraAssets, assets]);

  const assetMap = useMemo(() => {
    const m = new Map<string, AssetInfo>();
    for (const a of allAssets) m.set(a.id, a);
    return m;
  }, [allAssets]);
  const assetUrls = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of allAssets) m.set(a.id, a.url);
    return m;
  }, [allAssets]);
  const assetUrl = useCallback((id: string) => assetUrls.get(id) ?? null, [assetUrls]);

  const plan = useMemo(
    () => planSide({ doc, side, product, assets: assetMap }),
    [doc, side, product, assetMap],
  );

  /* ------------------------------------------------------------- autosave */

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = useCallback(async () => {
    if (!canWrite) return;
    store.set({ saving: true });
    const res = await saveDesignAction(designId, store.getState().doc);
    if (res.ok) {
      store.markSaved();
      setSaveError(null);
    } else {
      store.set({ saving: false });
      setSaveError(res.error);
    }
  }, [canWrite, designId, store]);

  useEffect(() => {
    if (!dirty || !canWrite) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // 1.2 s of quiet. Long enough that a drag does not fire a request per frame,
    // short enough that a designer who walks away has their work stored.
    saveTimer.current = setTimeout(() => void save(), 1200);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [dirty, doc, canWrite, save]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (store.getState().dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [store]);

  /* ------------------------------------------------------------ preflight */

  const runPreflight = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch(`/api/designs/${designId}/preflight`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: store.getState().doc }),
      });
      if (res.ok) setReport((await res.json()) as PreflightReport);
    } finally {
      setChecking(false);
    }
  }, [designId, store]);

  useEffect(() => {
    void runPreflight();
    // Re-run on a settled document rather than every keystroke.
    const t = setTimeout(() => void runPreflight(), 1500);
    return () => clearTimeout(t);
  }, [doc, runPreflight]);

  /* ------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const meta = e.metaKey || e.ctrlKey;

      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
        return;
      }
      if (meta && e.key === "1") {
        e.preventDefault();
        store.set({ zoom: 1 });
        return;
      }
      if (e.shiftKey && e.key === "!") {
        e.preventDefault();
        store.set({ zoom: 0 });
        return;
      }
      if (meta && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (meta && e.key.toLowerCase() === "a") {
        e.preventDefault();
        store.select(store.elements().filter((x) => !x.hidden).map((x) => x.id));
        return;
      }
      if (meta && e.key === "]") { e.preventDefault(); store.bringToFront(store.getState().selection); return; }
      if (meta && e.key === "[") { e.preventDefault(); store.sendToBack(store.getState().selection); return; }

      if (e.key === "Delete" || e.key === "Backspace") {
        if (store.getState().selection.length) {
          e.preventDefault();
          store.removeElements(store.getState().selection);
        }
        return;
      }
      if (e.key === "Escape") {
        store.clearSelection();
        return;
      }
      if (e.key.startsWith("Arrow")) {
        const sel = store.getState().selection;
        if (!sel.length) return;
        e.preventDefault();
        const d = e.shiftKey ? NUDGE_SHIFT_UPT : NUDGE_UPT;
        const dx = e.key === "ArrowRight" ? d : e.key === "ArrowLeft" ? -d : 0;
        const dy = e.key === "ArrowDown" ? d : e.key === "ArrowUp" ? -d : 0;
        store.updateElements(
          sel,
          (el) => ({ ...el, frame: { ...el.frame, x: el.frame.x + dx, y: el.frame.y + dy } }),
          { coalesceKey: "nudge" },
        );
        return;
      }

      const toolKeys: Record<string, string> = {
        v: "select", h: "hand", t: "text", r: "rect", o: "ellipse",
        l: "line", i: "image", b: "barcode", k: "bomList",
      };
      const t = toolKeys[e.key.toLowerCase()];
      if (t && !meta) store.set({ tool: t as never });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, save]);

  const duplicateSelection = useCallback(() => {
    const sel = store.selectedElements();
    if (!sel.length) return;
    const offset = 720_000; // 0.01 in, so the copy is visibly separate
    const copies = sel.map((el) => ({
      ...el,
      id: nanoid(12),
      name: el.name ? `${el.name} copy` : "",
      frame: { ...el.frame, x: el.frame.x + offset, y: el.frame.y + offset },
    }));
    const sideKey = store.getState().side;
    store.commit((d) => ({
      ...d,
      [sideKey]: { ...d[sideKey], elements: [...d[sideKey].elements, ...copies] },
    }));
    store.select(copies.map((c) => c.id));
  }, [store]);

  /* ------------------------------------------------------ create on click */

  const addForTool = useCallback(() => {
    const st = store.getState();
    const p = plan;
    const centreX = p.safe.x + Math.round(p.safe.w / 2);
    const centreY = p.safe.y + Math.round(p.safe.h / 2);
    const isBack = st.side === "back";
    const ink = isBack ? grayPct(100) : TEXT_BLACK;
    let el: DesignElement | null = null;

    switch (st.tool) {
      case "text":
        el = TextElementSchema.parse({
          id: nanoid(12), kind: "text",
          frame: { x: centreX - 72_000_000, y: centreY - 9_000_000, w: 144_000_000, h: 18_000_000 },
          fontFamily: "Inter", fontSize: 9_000_000, color: ink,
          paragraphs: [{ runs: [{ text: "New text", bold: false, italic: false }], spaceBefore: 0, spaceAfter: 0 }],
        });
        break;
      case "rect":
        el = ShapeElementSchema.parse({
          id: nanoid(12), kind: "shape", shape: "rect",
          frame: { x: centreX - 54_000_000, y: centreY - 18_000_000, w: 108_000_000, h: 36_000_000 },
          fill: ink, stroke: NONE,
        });
        break;
      case "ellipse":
        el = ShapeElementSchema.parse({
          id: nanoid(12), kind: "shape", shape: "ellipse",
          frame: { x: centreX - 36_000_000, y: centreY - 36_000_000, w: 72_000_000, h: 72_000_000 },
          fill: ink, stroke: NONE,
        });
        break;
      case "line":
        el = ShapeElementSchema.parse({
          id: nanoid(12), kind: "shape", shape: "line",
          frame: { x: p.safe.x, y: centreY, w: p.safe.w, h: 1_000_000 },
          fill: ink, stroke: ink, strokeWidth: 750_000,
        });
        break;
      case "image":
        el = ImageElementSchema.parse({
          id: nanoid(12), kind: "image",
          frame: { x: centreX - 72_000_000, y: centreY - 72_000_000, w: 144_000_000, h: 144_000_000 },
        });
        break;
      case "barcode":
        el = BarcodeElementSchema.parse({
          id: nanoid(12), kind: "barcode", symbology: "upca",
          frame: { x: centreX - 52_884_000, y: centreY - 43_000_000, w: 105_768_000, h: 86_000_000 },
          binding: {
            path: "identifiers.upc12", fallback: "", prefix: "", suffix: "",
            transform: "none", joiner: ", ", hideWhenEmpty: false,
          },
          barColor: TEXT_BLACK,
          required: true,
        });
        break;
      case "bomList":
        el = BomListElementSchema.parse({
          id: nanoid(12), kind: "bomList",
          frame: { x: p.safe.x, y: centreY - 54_000_000, w: p.safe.w, h: 108_000_000 },
          color: ink, fontFamily: "Barlow Condensed",
        });
        break;
      default:
        return;
    }
    if (el) {
      store.addElement(el);
      store.set({ tool: "select" });
    }
  }, [plan, store]);

  useEffect(() => {
    if (tool === "select" || tool === "hand") return;
    addForTool();
  }, [tool, addForTool]);

  const editingEl = editingTextId
    ? (store.element(editingTextId) as DesignElement | undefined)
    : undefined;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-ink-900">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-ink-800 bg-ink-950 px-3">
        <Link
          href={`/designs/${designId}`}
          className="flex h-8 w-8 items-center justify-center rounded text-ink-400 hover:bg-ink-800 hover:text-ink-100"
          aria-label="Back to card"
        >
          <ArrowLeft size={16} />
        </Link>
        <BrandLogo variant="mark-full-color" className="h-5 w-auto" alt="" />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-ink-100">{designName}</div>
          <div className="numeric truncate text-[11px] text-ink-500">
            {doc.presetCode} · rev {revisionNumber} · {status.replace("_", " ")}
          </div>
        </div>

        <div className="flex-1" />

        <span
          className={cn(
            "text-[11px]",
            saveError ? "text-flag-400" : dirty ? "text-sev-warning" : "text-ink-500",
          )}
          role="status"
        >
          {saveError
            ? saveError
            : saving
              ? "Saving…"
              : dirty
                ? "Unsaved changes"
                : lastSavedAt
                  ? `Saved ${new Date(lastSavedAt).toLocaleTimeString()}`
                  : "Up to date"}
        </span>

        {canWrite ? (
          <Button size="sm" variant="secondary" onClick={() => void save()} disabled={!dirty || saving}>
            <Save size={14} /> Save
          </Button>
        ) : null}
        {canSubmit ? (
          <Link href={`/designs/${designId}?submit=1`}>
            <Button size="sm" variant="secondary">
              <Send size={14} /> Submit
            </Button>
          </Link>
        ) : null}
        <Link href={`/designs/${designId}/export`}>
          <Button size="sm" variant="primary">
            <Download size={14} /> Export
          </Button>
        </Link>
      </header>

      <Toolbar store={store} />

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-ink-800 bg-ink-900">
          <div className="flex shrink-0 border-b border-ink-800" role="tablist">
            {(["data", "layers"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={leftTab === t}
                onClick={() => setLeftTab(t)}
                className={cn(
                  "h-8 flex-1 text-[11px] font-semibold uppercase tracking-wider transition-colors",
                  leftTab === t
                    ? "bg-ink-850 text-ink-100 shadow-[inset_0_-2px_0_var(--color-brand-500)]"
                    : "text-ink-500 hover:text-ink-300",
                )}
              >
                {t === "data" ? "Data" : "Layers"}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            {leftTab === "data" ? (
              <DataPanel store={store} product={product} productLabel={productLabel} />
            ) : (
              <LayersPanel store={store} />
            )}
          </div>
        </aside>

        <div className="relative min-w-0 flex-1">
          <Artboard
            store={store}
            plan={plan}
            assetUrl={assetUrl}
            onOpenText={(id) => store.set({ editingTextId: id })}
          />
          {editingEl && editingEl.kind === "text" ? (
            <TextEditorOverlay
              store={store}
              element={editingEl}
              onClose={() => store.set({ editingTextId: null })}
            />
          ) : null}
        </div>

        <aside className="w-64 shrink-0 border-l border-ink-800 bg-ink-900">
          <Inspector
            store={store}
            assets={allAssets.map((a) => ({
              id: a.id,
              url: a.url,
              filename: a.filename,
              pixelWidth: a.pixelWidth,
              pixelHeight: a.pixelHeight,
              colorSpace: a.colorSpace,
              contentType: a.contentType,
            }))}
            onAssetUploaded={(a) =>
              setExtraAssets((prev) => [
                {
                  id: a.id,
                  url: a.url,
                  filename: a.filename,
                  pixelWidth: a.pixelWidth,
                  pixelHeight: a.pixelHeight,
                  colorSpace: a.colorSpace,
                  contentType: a.contentType,
                  hasIccProfile: false,
                },
                ...prev,
              ])
            }
          />
        </aside>
      </div>

      <PreflightStrip store={store} report={report} running={checking} onRun={() => void runPreflight()} />
    </div>
  );
}
