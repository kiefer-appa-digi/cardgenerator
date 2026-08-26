"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { uptToPt, uptToIn, formatLength } from "@/lib/units";
import { rectBottom, rectRight, roundedRectPath, segsToSvgPath, type Rect } from "@/lib/geometry/types";
import { previewCss } from "@/lib/color/types";
import type { SidePlan } from "@/lib/design/render";
import type { DesignElement } from "@/lib/design/schema";
import {
  RESIZE_HANDLES,
  buildSnapCandidates,
  resizeRect,
  snapRect,
  unionFrames,
  type Handle,
  type SnapLine,
} from "@/lib/editor/interaction";
import type { EditorStore } from "@/lib/editor/store";
import { useEditorSelector } from "@/lib/editor/store";
import { PlanLayer } from "./artboard-render";

/**
 * THE ARTBOARD
 *
 * SVG user space is PDF points, one-to-one with the exported page. Zoom lives in
 * the viewBox; nothing rescales coordinates. Pointer maths converts screen px to
 * µpt once, at the top of a gesture, and everything after that is integer µpt.
 *
 * Overlays (bleed/trim/safe/cavity/centre/guides) are drawn in a sibling layer
 * that the PDF writer never sees, which is how they stay guaranteed
 * non-printing (spec §6, §17).
 */

const pt = (u: number) => uptToPt(u);

export function Artboard({
  store,
  plan,
  assetUrl,
  onOpenText,
}: {
  store: EditorStore;
  plan: SidePlan;
  assetUrl: (id: string) => string | null;
  onOpenText?: (id: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const zoom = useEditorSelector(store, (s) => s.zoom);
  const panX = useEditorSelector(store, (s) => s.panX);
  const panY = useEditorSelector(store, (s) => s.panY);
  const overlays = useEditorSelector(store, (s) => s.overlays);
  const unit = useEditorSelector(store, (s) => s.unit);
  const snapOn = useEditorSelector(store, (s) => s.snap);
  const tolerance = useEditorSelector(store, (s) => s.snapToleranceUpt);
  const tool = useEditorSelector(store, (s) => s.tool);
  const selection = useEditorSelector(
    store,
    (s) => s.selection.join(","),
  );
  const elements = useEditorSelector(store, (s) => s.doc[s.side].elements);
  const guides = useEditorSelector(store, (s) => s.doc[s.side].guides);

  const selectedIds = useMemo(() => (selection ? selection.split(",") : []), [selection]);
  const selectedEls = useMemo(
    () => elements.filter((e) => selectedIds.includes(e.id)),
    [elements, selectedIds],
  );
  const selectionBounds = useMemo(() => unionFrames(selectedEls), [selectedEls]);

  const [preview, setPreview] = useState<Map<string, Rect> | null>(null);
  const [snapLines, setSnapLines] = useState<SnapLine[]>([]);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const canvas = plan.canvas;

  /* -------------------------------------------------- zoom-to-fit on mount */

  const fit = useCallback(() => {
    const host = hostRef.current;
    if (!host) return;
    const pad = 72;
    const availW = host.clientWidth - pad * 2;
    const availH = host.clientHeight - pad * 2;
    const z = Math.min(availW / pt(canvas.w), availH / pt(canvas.h));
    store.set({
      zoom: z,
      panX: (host.clientWidth - pt(canvas.w) * z) / 2,
      panY: (host.clientHeight - pt(canvas.h) * z) / 2,
    });
  }, [canvas.w, canvas.h, store]);

  useEffect(() => {
    if (zoom === 0) fit();
  }, [zoom, fit]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      if (store.getState().zoom === 0) fit();
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [fit, store]);

  /* ----------------------------------------------------- pointer geometry */

  const toCard = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return { x: 0, y: 0 };
      const r = svg.getBoundingClientRect();
      const z = store.getState().zoom || 1;
      return {
        x: Math.round(((clientX - r.left) / z) * 1_000_000),
        y: Math.round(((clientY - r.top) / z) * 1_000_000),
      };
    },
    [store],
  );

  /* ------------------------------------------------------------ wheel zoom */

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) {
        // Plain wheel pans, which is what a trackpad user expects on a canvas.
        const s = store.getState();
        store.set({ panX: s.panX - e.deltaX, panY: s.panY - e.deltaY });
        e.preventDefault();
        return;
      }
      e.preventDefault();
      const s = store.getState();
      const rect = host.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.max(0.05, Math.min(24, s.zoom * factor));
      // Keep the point under the cursor fixed.
      store.set({
        zoom: next,
        panX: px - ((px - s.panX) * next) / s.zoom,
        panY: py - ((py - s.panY) * next) / s.zoom,
      });
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [store]);

  /* --------------------------------------------------------- drag element */

  const beginDrag = useCallback(
    (id: string, e: React.PointerEvent) => {
      if (tool === "hand") return;
      e.stopPropagation();
      const st = store.getState();
      const el = st.doc[st.side].elements.find((x) => x.id === id);
      if (!el) return;

      const additive = e.shiftKey || e.metaKey;
      let ids = st.selection;
      if (!ids.includes(id)) {
        ids = additive ? [...ids, id] : [id];
        store.select(ids);
      } else if (additive) {
        store.toggleSelect(id);
        return;
      }

      const movable = st.doc[st.side].elements.filter(
        (x) => ids.includes(x.id) && !x.locked && !x.templateLocked,
      );
      if (movable.length === 0) return;

      const start = toCard(e.clientX, e.clientY);
      const originals = new Map(movable.map((m) => [m.id, m.frame]));
      const bounds = unionFrames(movable)!;
      const others = st.doc[st.side].elements
        .filter((x) => !ids.includes(x.id) && !x.hidden)
        .map((x) => x.frame);
      const cand = buildSnapCandidates({
        bleed: plan.canvas,
        trim: plan.trim,
        safe: plan.safe,
        cavity: plan.cavity,
        guides: st.doc[st.side].guides.map((g) => ({ axis: g.axis, pos: g.pos })),
        others,
        includeCavity: st.overlays.cavity,
      });

      (e.target as Element).setPointerCapture?.(e.pointerId);
      let moved = false;

      const onMove = (ev: PointerEvent) => {
        const now = toCard(ev.clientX, ev.clientY);
        let dx = now.x - start.x;
        let dy = now.y - start.y;
        if (ev.shiftKey) {
          // Shift constrains to the dominant axis.
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        let lines: SnapLine[] = [];
        if (store.getState().snap && !ev.altKey) {
          const s = snapRect(
            { x: bounds.x + dx, y: bounds.y + dy, w: bounds.w, h: bounds.h },
            cand.x,
            cand.y,
            store.getState().snapToleranceUpt,
          );
          dx += s.dx;
          dy += s.dy;
          lines = s.lines;
        }
        if (dx !== 0 || dy !== 0) moved = true;
        const next = new Map<string, Rect>();
        for (const [mid, f] of originals) next.set(mid, { ...f, x: f.x + dx, y: f.y + dy });
        setPreview(next);
        setSnapLines(lines);
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const p = previewRef.current;
        setSnapLines([]);
        setPreview(null);
        if (!moved || !p) return;
        store.updateElements(
          [...p.keys()],
          (el2) => {
            const f = p.get(el2.id);
            return f ? { ...el2, frame: f } : el2;
          },
        );
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [store, toCard, tool, plan],
  );

  // The drag handlers close over state at gesture start; the latest preview has
  // to be read from a ref on pointerup or the commit uses a stale map.
  const previewRef = useRef<Map<string, Rect> | null>(null);
  previewRef.current = preview;

  /* --------------------------------------------------------- drag handles */

  const beginResize = useCallback(
    (handle: Handle, e: React.PointerEvent) => {
      e.stopPropagation();
      const st = store.getState();
      const els = st.doc[st.side].elements.filter(
        (x) => st.selection.includes(x.id) && !x.locked && !x.templateLocked,
      );
      if (els.length === 0) return;
      const bounds = unionFrames(els)!;
      const start = toCard(e.clientX, e.clientY);
      const originals = new Map(els.map((m) => [m.id, m.frame]));

      const onMove = (ev: PointerEvent) => {
        const now = toCard(ev.clientX, ev.clientY);
        const nb = resizeRect(bounds, handle, now.x - start.x, now.y - start.y, {
          constrain: ev.shiftKey,
          fromCenter: ev.altKey,
        });
        const sx = bounds.w ? nb.w / bounds.w : 1;
        const sy = bounds.h ? nb.h / bounds.h : 1;
        const next = new Map<string, Rect>();
        for (const [mid, f] of originals) {
          next.set(mid, {
            x: Math.round(nb.x + (f.x - bounds.x) * sx),
            y: Math.round(nb.y + (f.y - bounds.y) * sy),
            w: Math.max(1, Math.round(f.w * sx)),
            h: Math.max(1, Math.round(f.h * sy)),
          });
        }
        setPreview(next);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const p = previewRef.current;
        setPreview(null);
        if (!p) return;
        store.updateElements([...p.keys()], (el2) => {
          const f = p.get(el2.id);
          return f ? { ...el2, frame: f } : el2;
        });
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [store, toCard],
  );

  /* ------------------------------------------------------ marquee + pan */

  const onCanvasPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const st = store.getState();
      if (st.tool === "hand" || e.button === 1 || e.altKey) {
        const sx = e.clientX;
        const sy = e.clientY;
        const p0 = { x: st.panX, y: st.panY };
        const onMove = (ev: PointerEvent) =>
          store.set({ panX: p0.x + (ev.clientX - sx), panY: p0.y + (ev.clientY - sy) });
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        return;
      }

      if (e.button !== 0) return;
      const start = toCard(e.clientX, e.clientY);
      if (!e.shiftKey) store.clearSelection();
      let dragged = false;

      const onMove = (ev: PointerEvent) => {
        const now = toCard(ev.clientX, ev.clientY);
        dragged = true;
        setMarquee({
          x: Math.min(start.x, now.x),
          y: Math.min(start.y, now.y),
          w: Math.abs(now.x - start.x),
          h: Math.abs(now.y - start.y),
        });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const m = marqueeRef.current;
        setMarquee(null);
        if (!dragged || !m || m.w < 2_000_000) return;
        const hit = store
          .getState()
          .doc[store.getState().side].elements.filter(
            (el) =>
              !el.hidden &&
              el.frame.x < rectRight(m) &&
              rectRight(el.frame) > m.x &&
              el.frame.y < rectBottom(m) &&
              rectBottom(el.frame) > m.y,
          )
          .map((el) => el.id);
        store.select(hit, e.shiftKey);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [store, toCard],
  );

  const marqueeRef = useRef<Rect | null>(null);
  marqueeRef.current = marquee;

  /* --------------------------------------------------------------- render */

  const z = zoom || 1;
  const showHandles = selectionBounds && !preview;
  const overlayStroke = 1 / z; // hairlines that stay 1 device px at any zoom

  return (
    <div
      ref={hostRef}
      className="relative h-full w-full overflow-hidden bg-canvas"
      style={{ touchAction: "none" }}
      data-testid="artboard-host"
    >
      {overlays.rulers ? (
        <Rulers canvas={canvas} zoom={z} panX={panX} panY={panY} unit={unit} />
      ) : null}

      <div
        className="absolute"
        style={{
          left: panX,
          top: panY,
          width: pt(canvas.w) * z,
          height: pt(canvas.h) * z,
          filter: "drop-shadow(0 12px 32px rgba(0,0,0,0.55))",
        }}
      >
        <svg
          ref={svgRef}
          width={pt(canvas.w) * z}
          height={pt(canvas.h) * z}
          viewBox={`0 0 ${pt(canvas.w)} ${pt(canvas.h)}`}
          onPointerDown={onCanvasPointerDown}
          className="block"
          data-testid="artboard-svg"
        >
          <defs>
            <clipPath id="trim-clip">
              <path d={segsToSvgPath(roundedRectPath(plan.trim, plan.cornerRadius), 1 / 1_000_000)} />
            </clipPath>
          </defs>

          {/* Paper. Rendered as true white so a light design is not flattered. */}
          <rect
            x={0}
            y={0}
            width={pt(canvas.w)}
            height={pt(canvas.h)}
            fill={previewCss(plan.background)}
          />

          <PlanLayer
            plan={plan}
            overrides={preview}
            assetUrl={assetUrl}
            interactive
            onPointerDownElement={beginDrag}
          />

          {/* ------------------------------------------------ non-printing */}
          <g pointerEvents="none" data-nonprinting="true">
            {overlays.bleed ? (
              <rect
                x={0}
                y={0}
                width={pt(canvas.w)}
                height={pt(canvas.h)}
                fill="none"
                stroke="#e0a33a"
                strokeWidth={overlayStroke}
                strokeDasharray={`${4 / z} ${3 / z}`}
              />
            ) : null}

            {overlays.trim ? (
              <path
                d={segsToSvgPath(roundedRectPath(plan.trim, plan.cornerRadius), 1 / 1_000_000)}
                fill="none"
                stroke="#1d9ed9"
                strokeWidth={overlayStroke * 1.4}
              />
            ) : null}

            {overlays.safe ? (
              <rect
                x={pt(plan.safe.x)}
                y={pt(plan.safe.y)}
                width={pt(plan.safe.w)}
                height={pt(plan.safe.h)}
                fill="none"
                stroke="#3fae72"
                strokeWidth={overlayStroke}
                strokeDasharray={`${3 / z} ${3 / z}`}
              />
            ) : null}

            {overlays.cavity ? (
              <g>
                <rect
                  x={pt(plan.cavity.x)}
                  y={pt(plan.cavity.y)}
                  width={pt(plan.cavity.w)}
                  height={pt(plan.cavity.h)}
                  rx={pt(Math.min(plan.cavity.w, plan.cavity.h) / 6)}
                  // Outline only. A tint over the cavity footprint would cover
                  // most of the card and quietly bias every colour judgement the
                  // designer makes on it.
                  fill="none"
                  stroke="#e82627"
                  strokeWidth={overlayStroke}
                  strokeDasharray={`${5 / z} ${3 / z}`}
                />
                <text
                  x={pt(plan.cavity.x + plan.cavity.w / 2)}
                  y={pt(plan.cavity.y) + 9 / z}
                  textAnchor="middle"
                  fill="#e82627"
                  opacity={0.9}
                  style={{ fontSize: `${7 / z}px`, fontFamily: "Inter", letterSpacing: `${0.4 / z}px` }}
                >
                  CAVITY
                </text>
              </g>
            ) : null}

            {overlays.centerLines ? (
              <>
                <line
                  x1={pt(plan.trim.x + plan.trim.w / 2)}
                  y1={0}
                  x2={pt(plan.trim.x + plan.trim.w / 2)}
                  y2={pt(canvas.h)}
                  stroke="#6b7684"
                  strokeWidth={overlayStroke}
                  strokeDasharray={`${8 / z} ${4 / z}`}
                />
                <line
                  x1={0}
                  y1={pt(plan.trim.y + plan.trim.h / 2)}
                  x2={pt(canvas.w)}
                  y2={pt(plan.trim.y + plan.trim.h / 2)}
                  stroke="#6b7684"
                  strokeWidth={overlayStroke}
                  strokeDasharray={`${8 / z} ${4 / z}`}
                />
              </>
            ) : null}

            {overlays.guides
              ? guides.map((g) =>
                  g.axis === "x" ? (
                    <line
                      key={g.id}
                      x1={pt(g.pos)}
                      y1={0}
                      x2={pt(g.pos)}
                      y2={pt(canvas.h)}
                      stroke="#3fb1e3"
                      strokeWidth={overlayStroke}
                      opacity={0.8}
                    />
                  ) : (
                    <line
                      key={g.id}
                      x1={0}
                      y1={pt(g.pos)}
                      x2={pt(canvas.w)}
                      y2={pt(g.pos)}
                      stroke="#3fb1e3"
                      strokeWidth={overlayStroke}
                      opacity={0.8}
                    />
                  ),
                )
              : null}

            {overlays.outlines
              ? elements
                  .filter((e) => !e.hidden)
                  .map((e) => (
                    <rect
                      key={e.id}
                      x={pt(e.frame.x)}
                      y={pt(e.frame.y)}
                      width={pt(e.frame.w)}
                      height={pt(e.frame.h)}
                      fill="none"
                      stroke="#6b7684"
                      strokeWidth={overlayStroke}
                      opacity={0.55}
                    />
                  ))
              : null}

            {snapLines.map((l, i) => (
              <line
                key={i}
                x1={l.axis === "x" ? pt(l.pos) : 0}
                y1={l.axis === "x" ? 0 : pt(l.pos)}
                x2={l.axis === "x" ? pt(l.pos) : pt(canvas.w)}
                y2={l.axis === "x" ? pt(canvas.h) : pt(l.pos)}
                stroke="#e82627"
                strokeWidth={overlayStroke * 1.5}
              />
            ))}

            {marquee ? (
              <rect
                x={pt(marquee.x)}
                y={pt(marquee.y)}
                width={pt(marquee.w)}
                height={pt(marquee.h)}
                fill="rgba(29,158,217,0.12)"
                stroke="#1d9ed9"
                strokeWidth={overlayStroke}
              />
            ) : null}
          </g>

          {/* ------------------------------------------------- selection UI */}
          {(preview ? unionFrames(mapToEls(elements, preview)) : selectionBounds) ? (
            <SelectionChrome
              bounds={(preview ? unionFrames(mapToEls(elements, preview)) : selectionBounds)!}
              zoom={z}
              showHandles={Boolean(showHandles)}
              onHandle={beginResize}
              locked={selectedEls.some((e) => e.locked || e.templateLocked)}
            />
          ) : null}

          {hoverId && !selectedIds.includes(hoverId)
            ? (() => {
                const el = elements.find((e) => e.id === hoverId);
                if (!el) return null;
                return (
                  <rect
                    pointerEvents="none"
                    x={pt(el.frame.x)}
                    y={pt(el.frame.y)}
                    width={pt(el.frame.w)}
                    height={pt(el.frame.h)}
                    fill="none"
                    stroke="#1d9ed9"
                    strokeWidth={overlayStroke * 1.2}
                    opacity={0.6}
                  />
                );
              })()
            : null}
        </svg>
      </div>

      <HoverProbe elements={elements} onHover={setHoverId} store={store} onOpenText={onOpenText} />

      {selectionBounds ? (
        <SelectionReadout bounds={selectionBounds} unit={unit} zoom={z} panX={panX} panY={panY} />
      ) : null}
    </div>
  );
}

function mapToEls(elements: DesignElement[], preview: Map<string, Rect>): DesignElement[] {
  return elements
    .filter((e) => preview.has(e.id))
    .map((e) => ({ ...e, frame: preview.get(e.id)! }));
}

function SelectionChrome({
  bounds,
  zoom,
  showHandles,
  onHandle,
  locked,
}: {
  bounds: Rect;
  zoom: number;
  showHandles: boolean;
  onHandle: (h: Handle, e: React.PointerEvent) => void;
  locked: boolean;
}) {
  const s = 7 / zoom;
  const stroke = 1.2 / zoom;
  const positions: Record<Handle, [number, number]> = {
    nw: [bounds.x, bounds.y],
    n: [bounds.x + bounds.w / 2, bounds.y],
    ne: [rectRight(bounds), bounds.y],
    e: [rectRight(bounds), bounds.y + bounds.h / 2],
    se: [rectRight(bounds), rectBottom(bounds)],
    s: [bounds.x + bounds.w / 2, rectBottom(bounds)],
    sw: [bounds.x, rectBottom(bounds)],
    w: [bounds.x, bounds.y + bounds.h / 2],
    rotate: [bounds.x + bounds.w / 2, bounds.y],
  };
  const cursors: Record<string, string> = {
    nw: "nwse-resize", se: "nwse-resize",
    ne: "nesw-resize", sw: "nesw-resize",
    n: "ns-resize", s: "ns-resize",
    e: "ew-resize", w: "ew-resize",
  };
  return (
    <g>
      <rect
        pointerEvents="none"
        x={pt(bounds.x)}
        y={pt(bounds.y)}
        width={pt(bounds.w)}
        height={pt(bounds.h)}
        fill="none"
        stroke={locked ? "#e0a33a" : "#1d9ed9"}
        strokeWidth={stroke}
        strokeDasharray={locked ? `${4 / zoom} ${3 / zoom}` : undefined}
      />
      {showHandles && !locked
        ? RESIZE_HANDLES.map((h) => {
            const [hx, hy] = positions[h];
            return (
              <rect
                key={h}
                x={pt(hx) - s / 2}
                y={pt(hy) - s / 2}
                width={s}
                height={s}
                fill="#ffffff"
                stroke="#1d9ed9"
                strokeWidth={stroke}
                style={{ cursor: cursors[h] }}
                onPointerDown={(e) => onHandle(h, e)}
                data-handle={h}
              />
            );
          })
        : null}
    </g>
  );
}

/**
 * Hover highlighting is done on a transparent probe rather than by attaching
 * mouseenter to every op, so a card with hundreds of elements does not pay for
 * hundreds of listeners.
 */
function HoverProbe({
  elements,
  onHover,
  store,
  onOpenText,
}: {
  elements: DesignElement[];
  onHover: (id: string | null) => void;
  store: EditorStore;
  onOpenText?: (id: string) => void;
}) {
  useEffect(() => {
    const svg = document.querySelector<SVGSVGElement>('[data-testid="artboard-svg"]');
    if (!svg) return;
    const move = (e: MouseEvent) => {
      const r = svg.getBoundingClientRect();
      const z = store.getState().zoom || 1;
      const x = Math.round(((e.clientX - r.left) / z) * 1_000_000);
      const y = Math.round(((e.clientY - r.top) / z) * 1_000_000);
      const hit = [...elements]
        .reverse()
        .find(
          (el) =>
            !el.hidden &&
            x >= el.frame.x &&
            x <= rectRight(el.frame) &&
            y >= el.frame.y &&
            y <= rectBottom(el.frame),
        );
      onHover(hit?.id ?? null);
    };
    const leave = () => onHover(null);
    const dbl = (e: MouseEvent) => {
      const r = svg.getBoundingClientRect();
      const z = store.getState().zoom || 1;
      const x = Math.round(((e.clientX - r.left) / z) * 1_000_000);
      const y = Math.round(((e.clientY - r.top) / z) * 1_000_000);
      const hit = [...elements]
        .reverse()
        .find(
          (el) =>
            el.kind === "text" &&
            !el.hidden &&
            !el.locked &&
            x >= el.frame.x &&
            x <= rectRight(el.frame) &&
            y >= el.frame.y &&
            y <= rectBottom(el.frame),
        );
      if (hit) onOpenText?.(hit.id);
    };
    svg.addEventListener("mousemove", move);
    svg.addEventListener("mouseleave", leave);
    svg.addEventListener("dblclick", dbl);
    return () => {
      svg.removeEventListener("mousemove", move);
      svg.removeEventListener("mouseleave", leave);
      svg.removeEventListener("dblclick", dbl);
    };
  }, [elements, onHover, store, onOpenText]);
  return null;
}

function SelectionReadout({
  bounds,
  unit,
  zoom,
  panX,
  panY,
}: {
  bounds: Rect;
  unit: "in" | "mm" | "pt";
  zoom: number;
  panX: number;
  panY: number;
}) {
  const left = panX + pt(bounds.x) * zoom;
  const top = panY + pt(bounds.y) * zoom - 22;
  return (
    <div
      className="numeric pointer-events-none absolute rounded bg-brand-600 px-1.5 py-0.5 text-[10px] font-medium text-white shadow"
      style={{ left, top }}
    >
      {formatLength(bounds.w, unit)} × {formatLength(bounds.h, unit)} {unit}
    </div>
  );
}

/** Rulers in the active unit, with tick density chosen from the zoom level. */
function Rulers({
  canvas,
  zoom,
  panX,
  panY,
  unit,
}: {
  canvas: Rect;
  zoom: number;
  panX: number;
  panY: number;
  unit: "in" | "mm" | "pt";
}) {
  const majorIn = pickMajor(zoom, unit);
  const ticks: number[] = [];
  const spanIn = uptToIn(canvas.w) + 2;
  for (let v = -1; v <= spanIn; v += majorIn) ticks.push(Number(v.toFixed(6)));
  const ticksY: number[] = [];
  const spanH = uptToIn(canvas.h) + 2;
  for (let v = -1; v <= spanH; v += majorIn) ticksY.push(Number(v.toFixed(6)));

  const ppi = 72 * zoom;
  const label = (v: number) =>
    unit === "mm" ? (v * 25.4).toFixed(0) : unit === "pt" ? (v * 72).toFixed(0) : String(Number(v.toFixed(3)));

  return (
    <>
      <div className="pointer-events-none absolute left-0 top-0 z-10 h-5 w-full overflow-hidden border-b border-ink-700 bg-ink-900/95">
        {ticks.map((v) => (
          <div
            key={v}
            className="numeric absolute top-0 h-full border-l border-ink-600 pl-1 text-[9px] leading-5 text-ink-400"
            style={{ left: panX + v * ppi }}
          >
            {label(v)}
          </div>
        ))}
      </div>
      <div className="pointer-events-none absolute left-0 top-0 z-10 h-full w-5 overflow-hidden border-r border-ink-700 bg-ink-900/95">
        {ticksY.map((v) => (
          <div
            key={v}
            className="numeric absolute left-0 w-full border-t border-ink-600 text-[9px] leading-none text-ink-400"
            style={{ top: panY + v * ppi }}
          >
            <span className="block origin-top-left translate-x-[3px] translate-y-[11px] -rotate-90">
              {label(v)}
            </span>
          </div>
        ))}
      </div>
      <div className="pointer-events-none absolute left-0 top-0 z-20 h-5 w-5 border-b border-r border-ink-700 bg-ink-900" />
    </>
  );
}

function pickMajor(zoom: number, unit: "in" | "mm" | "pt"): number {
  const ppi = 72 * zoom;
  const targets = unit === "mm" ? [10 / 25.4, 5 / 25.4, 1 / 25.4] : [1, 0.5, 0.25, 0.125, 0.0625];
  for (const t of targets) if (t * ppi >= 44) return t;
  return targets[targets.length - 1];
}
