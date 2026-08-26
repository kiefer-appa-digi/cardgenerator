"use client";

import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical,
  AlignStartHorizontal, AlignStartVertical, Barcode, Circle, Hand, Image as ImageIcon,
  Layers, List, Lock, Magnet, Minus, MousePointer2, Redo2, Ruler, Square,
  Type, Undo2, Unlock, ZoomIn, ZoomOut,
} from "lucide-react";
import { uptToPt } from "@/lib/units";
import { cn } from "@/lib/cn";
import type { EditorStore, Tool } from "@/lib/editor/store";
import { useEditorSelector } from "@/lib/editor/store";
import { alignFrames, distributeFrames, unionFrames, type AlignMode } from "@/lib/editor/interaction";

const TOOLS: Array<{ tool: Tool; icon: typeof Square; label: string; key: string }> = [
  { tool: "select", icon: MousePointer2, label: "Select", key: "V" },
  { tool: "hand", icon: Hand, label: "Pan", key: "H" },
  { tool: "text", icon: Type, label: "Text", key: "T" },
  { tool: "rect", icon: Square, label: "Rectangle", key: "R" },
  { tool: "ellipse", icon: Circle, label: "Ellipse", key: "O" },
  { tool: "line", icon: Minus, label: "Line", key: "L" },
  { tool: "image", icon: ImageIcon, label: "Image", key: "I" },
  { tool: "barcode", icon: Barcode, label: "Barcode", key: "B" },
  { tool: "bomList", icon: List, label: "Pack contents", key: "K" },
];

const ALIGNS: Array<{ mode: AlignMode; icon: typeof Square; label: string }> = [
  { mode: "left", icon: AlignStartVertical, label: "Align left" },
  { mode: "hcenter", icon: AlignCenterVertical, label: "Align horizontal centres" },
  { mode: "right", icon: AlignEndVertical, label: "Align right" },
  { mode: "top", icon: AlignStartHorizontal, label: "Align top" },
  { mode: "vcenter", icon: AlignCenterHorizontal, label: "Align vertical centres" },
  { mode: "bottom", icon: AlignEndHorizontal, label: "Align bottom" },
];

export function Toolbar({ store }: { store: EditorStore }) {
  const tool = useEditorSelector(store, (s) => s.tool);
  const zoom = useEditorSelector(store, (s) => s.zoom);
  const snap = useEditorSelector(store, (s) => s.snap);
  const overlays = useEditorSelector(store, (s) => s.overlays);
  const selCount = useEditorSelector(store, (s) => s.selection.length);
  const doc = useEditorSelector(store, (s) => s.doc);
  const side = useEditorSelector(store, (s) => s.side);
  const unit = useEditorSelector(store, (s) => s.unit);

  const canvasW = 0;
  void canvasW;
  void doc;

  const applyAlign = (mode: AlignMode) => {
    const els = store.selectedElements().filter((e) => !e.locked && !e.templateLocked);
    if (els.length < 2) return;
    const bounds = unionFrames(els)!;
    const next = alignFrames(els.map((e) => e.frame), bounds, mode);
    const byId = new Map(els.map((e, i) => [e.id, next[i]]));
    store.updateElements([...byId.keys()], (el) => ({ ...el, frame: byId.get(el.id)! }));
  };

  const applyDistribute = (axis: "x" | "y") => {
    const els = store.selectedElements().filter((e) => !e.locked && !e.templateLocked);
    if (els.length < 3) return;
    const next = distributeFrames(els.map((e) => e.frame), axis);
    const byId = new Map(els.map((e, i) => [e.id, next[i]]));
    store.updateElements([...byId.keys()], (el) => ({ ...el, frame: byId.get(el.id)! }));
  };

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-ink-800 bg-ink-950 px-2">
      <div className="flex items-center gap-0.5">
        {TOOLS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.tool}
              type="button"
              onClick={() => store.set({ tool: t.tool })}
              title={`${t.label} (${t.key})`}
              aria-label={t.label}
              aria-pressed={tool === t.tool}
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded transition-colors",
                tool === t.tool
                  ? "bg-brand-600 text-white"
                  : "text-ink-300 hover:bg-ink-800 hover:text-ink-100",
              )}
            >
              <Icon size={16} strokeWidth={1.75} />
            </button>
          );
        })}
      </div>

      <Divider />

      <IconBtn
        icon={Undo2}
        label="Undo (⌘Z)"
        onClick={() => store.undo()}
        disabled={!store.canUndo()}
      />
      <IconBtn
        icon={Redo2}
        label="Redo (⇧⌘Z)"
        onClick={() => store.redo()}
        disabled={!store.canRedo()}
      />

      <Divider />

      <div className="flex items-center gap-0.5" role="group" aria-label="Align">
        {ALIGNS.map((a) => (
          <IconBtn
            key={a.mode}
            icon={a.icon}
            label={a.label}
            disabled={selCount < 2}
            onClick={() => applyAlign(a.mode)}
          />
        ))}
        <button
          type="button"
          disabled={selCount < 3}
          onClick={() => applyDistribute("x")}
          className="h-8 rounded px-2 text-[11px] text-ink-300 hover:bg-ink-800 hover:text-ink-100 disabled:text-ink-600"
          title="Distribute horizontally"
        >
          ⇿
        </button>
        <button
          type="button"
          disabled={selCount < 3}
          onClick={() => applyDistribute("y")}
          className="h-8 rounded px-2 text-[11px] text-ink-300 hover:bg-ink-800 hover:text-ink-100 disabled:text-ink-600"
          title="Distribute vertically"
        >
          ⇕
        </button>
      </div>

      <Divider />

      <IconBtn
        icon={snap ? Magnet : Magnet}
        label={snap ? "Snapping on" : "Snapping off"}
        active={snap}
        onClick={() => store.set({ snap: !snap })}
      />
      <IconBtn
        icon={Ruler}
        label="Rulers"
        active={overlays.rulers}
        onClick={() => store.set({ overlays: { ...overlays, rulers: !overlays.rulers } })}
      />
      <IconBtn
        icon={Layers}
        label="Show element outlines"
        active={overlays.outlines}
        onClick={() => store.set({ overlays: { ...overlays, outlines: !overlays.outlines } })}
      />
      <IconBtn
        icon={selCount > 0 && store.selectedElements().every((e) => e.locked) ? Lock : Unlock}
        label="Lock / unlock selection"
        disabled={selCount === 0}
        onClick={() => {
          const all = store.selectedElements().every((e) => e.locked);
          store.updateElements(
            store.getState().selection,
            (el) => ({ ...el, locked: !all }),
            { coalesceKey: "unlock" },
          );
        }}
      />

      <div className="flex-1" />

      <div className="flex items-center gap-0.5" role="group" aria-label="Side">
        {(["front", "back"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => store.setSide(s)}
            aria-pressed={side === s}
            className={cn(
              "h-7 rounded px-3 text-xs font-medium capitalize transition-colors",
              side === s ? "bg-ink-700 text-ink-50" : "text-ink-400 hover:text-ink-100",
            )}
          >
            {s}
            {s === "back" && doc.back.colorIntent === "grayscale" ? (
              <span className="ml-1.5 text-[9px] uppercase tracking-wide text-ink-500">B/W</span>
            ) : null}
          </button>
        ))}
      </div>

      <Divider />

      <select
        aria-label="Units"
        value={unit}
        onChange={(e) => store.set({ unit: e.target.value as "in" | "mm" | "pt" })}
        className="h-7 rounded border border-ink-700 bg-ink-850 px-1.5 text-xs text-ink-200"
      >
        <option value="in">in</option>
        <option value="mm">mm</option>
        <option value="pt">pt</option>
      </select>

      <div className="flex items-center gap-0.5">
        <IconBtn
          icon={ZoomOut}
          label="Zoom out"
          onClick={() => store.set({ zoom: Math.max(0.05, (zoom || 1) / 1.25) })}
        />
        <button
          type="button"
          onClick={() => store.set({ zoom: 0 })}
          className="numeric h-7 w-14 rounded text-xs text-ink-200 hover:bg-ink-800"
          title="Zoom to fit (⇧1)"
        >
          {Math.round((zoom || 1) * 100)}%
        </button>
        <IconBtn
          icon={ZoomIn}
          label="Zoom in"
          onClick={() => store.set({ zoom: Math.min(24, (zoom || 1) * 1.25) })}
        />
        <button
          type="button"
          onClick={() => {
            // 100 % means one CSS pixel per PDF point at the browser's own
            // scale, which is the closest honest "actual size" a web app can
            // offer without knowing the physical display DPI.
            store.set({ zoom: 1 });
          }}
          className="h-7 rounded px-2 text-[11px] text-ink-400 hover:bg-ink-800 hover:text-ink-100"
          title="100% (⌘1)"
        >
          1:1
        </button>
      </div>
    </div>
  );
}

function Divider() {
  return <div className="mx-1 h-5 w-px bg-ink-700" aria-hidden />;
}

function IconBtn({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
}: {
  icon: typeof Square;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded transition-colors",
        active ? "bg-ink-700 text-brand-200" : "text-ink-300 hover:bg-ink-800 hover:text-ink-100",
        disabled && "text-ink-600 hover:bg-transparent hover:text-ink-600",
      )}
    >
      <Icon size={16} strokeWidth={1.75} />
    </button>
  );
}

export { uptToPt };
