"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { Rect } from "@/lib/geometry/types";
import type { LengthUnit, Upt } from "@/lib/units";
import type { DesignDoc, DesignElement, SideKey } from "@/lib/design/schema";

/**
 * EDITOR STORE
 *
 * A hand-rolled external store rather than component state, for one reason:
 * spec §26 forbids re-rendering the whole React tree on every pointer movement.
 * Components subscribe with a selector and only re-render when *their* slice
 * changes, so dragging an element repaints the artboard and the X/Y fields and
 * nothing else.
 *
 * History is a bounded stack of whole documents. A card document is a few tens
 * of kilobytes, so snapshotting is far cheaper than maintaining inverse patches
 * and impossible to get subtly wrong. Rapid property edits (dragging a slider)
 * coalesce into one entry via `commit({ coalesceKey })`.
 */

export type Tool =
  | "select"
  | "text"
  | "rect"
  | "ellipse"
  | "line"
  | "image"
  | "barcode"
  | "bomList"
  | "hand";

export type Overlays = {
  bleed: boolean;
  trim: boolean;
  safe: boolean;
  cavity: boolean;
  centerLines: boolean;
  guides: boolean;
  rulers: boolean;
  grid: boolean;
  outlines: boolean;
};

export type EditorState = {
  doc: DesignDoc;
  side: SideKey;
  selection: string[];
  tool: Tool;
  /** Screen pixels per µpt. */
  zoom: number;
  /** Pan offset in screen pixels. */
  panX: number;
  panY: number;
  unit: LengthUnit;
  overlays: Overlays;
  snap: boolean;
  snapToleranceUpt: Upt;
  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  /** Transient drag preview: element id -> frame override. Not in history. */
  dragPreview: Map<string, Rect> | null;
  /** Element currently being text-edited inline. */
  editingTextId: string | null;
};

export const DEFAULT_OVERLAYS: Overlays = {
  bleed: true,
  trim: true,
  safe: true,
  cavity: true,
  centerLines: false,
  guides: true,
  rulers: true,
  grid: false,
  outlines: false,
};

type Listener = () => void;

const HISTORY_LIMIT = 120;

export class EditorStore {
  private state: EditorState;
  private listeners = new Set<Listener>();
  private past: DesignDoc[] = [];
  private future: DesignDoc[] = [];
  private lastCoalesceKey: string | null = null;
  private lastCoalesceAt = 0;

  constructor(doc: DesignDoc, unit: LengthUnit = "in") {
    this.state = {
      doc,
      side: "front",
      selection: [],
      tool: "select",
      zoom: 0,
      panX: 0,
      panY: 0,
      unit,
      overlays: { ...DEFAULT_OVERLAYS },
      snap: true,
      snapToleranceUpt: 216_000, // 0.003 in — tight enough not to fight precision work
      dirty: false,
      saving: false,
      lastSavedAt: null,
      dragPreview: null,
      editingTextId: null,
    };
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getState = (): EditorState => this.state;

  private emit() {
    for (const l of this.listeners) l();
  }

  /** Replace transient UI state. Never touches history. */
  set(partial: Partial<EditorState>): void {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  /**
   * Apply a document change and record it for undo.
   * `coalesceKey` merges consecutive edits of the same thing within 600 ms —
   * dragging a size field produces one undo step, not forty.
   */
  commit(
    mutate: (draft: DesignDoc) => DesignDoc,
    opts: { coalesceKey?: string } = {},
  ): void {
    const prev = this.state.doc;
    const next = mutate(prev);
    if (next === prev) return;

    const now = Date.now();
    const canCoalesce =
      opts.coalesceKey !== undefined &&
      opts.coalesceKey === this.lastCoalesceKey &&
      now - this.lastCoalesceAt < 600 &&
      this.past.length > 0;

    if (!canCoalesce) {
      this.past.push(prev);
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
    }
    this.lastCoalesceKey = opts.coalesceKey ?? null;
    this.lastCoalesceAt = now;
    this.future = [];

    this.state = { ...this.state, doc: next, dirty: true };
    this.emit();
  }

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.state.doc);
    this.lastCoalesceKey = null;
    this.state = { ...this.state, doc: prev, dirty: true, dragPreview: null };
    this.emit();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.state.doc);
    this.lastCoalesceKey = null;
    this.state = { ...this.state, doc: next, dirty: true, dragPreview: null };
    this.emit();
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }
  canRedo(): boolean {
    return this.future.length > 0;
  }

  markSaved(): void {
    this.state = { ...this.state, dirty: false, saving: false, lastSavedAt: Date.now() };
    this.emit();
  }

  /* ------------------------------------------------------------ selection */

  select(ids: string[], additive = false): void {
    const next = additive
      ? Array.from(new Set([...this.state.selection, ...ids]))
      : ids;
    if (
      next.length === this.state.selection.length &&
      next.every((id, i) => this.state.selection[i] === id)
    ) {
      return;
    }
    this.set({ selection: next });
  }

  toggleSelect(id: string): void {
    const has = this.state.selection.includes(id);
    this.set({
      selection: has
        ? this.state.selection.filter((s) => s !== id)
        : [...this.state.selection, id],
    });
  }

  clearSelection(): void {
    if (this.state.selection.length) this.set({ selection: [], editingTextId: null });
  }

  /* ------------------------------------------------------------- elements */

  get currentSide() {
    return this.state.doc[this.state.side];
  }

  elements(): DesignElement[] {
    return this.state.doc[this.state.side].elements;
  }

  element(id: string): DesignElement | undefined {
    return this.elements().find((e) => e.id === id);
  }

  selectedElements(): DesignElement[] {
    const set = new Set(this.state.selection);
    return this.elements().filter((e) => set.has(e.id));
  }

  updateElements(
    ids: string[],
    updater: (el: DesignElement) => DesignElement,
    opts: { coalesceKey?: string } = {},
  ): void {
    const set = new Set(ids);
    const side = this.state.side;
    this.commit((doc) => {
      const els = doc[side].elements;
      let changed = false;
      const next = els.map((el) => {
        if (!set.has(el.id)) return el;
        if (el.locked && !opts.coalesceKey?.startsWith("unlock")) return el;
        const updated = updater(el);
        if (updated !== el) changed = true;
        return updated;
      });
      if (!changed) return doc;
      return { ...doc, [side]: { ...doc[side], elements: next } };
    }, opts);
  }

  addElement(el: DesignElement): void {
    const side = this.state.side;
    this.commit((doc) => ({
      ...doc,
      [side]: { ...doc[side], elements: [...doc[side].elements, el] },
    }));
    this.select([el.id]);
  }

  removeElements(ids: string[]): void {
    const set = new Set(ids);
    const side = this.state.side;
    this.commit((doc) => {
      const keep = doc[side].elements.filter((e) => !set.has(e.id) || e.locked);
      if (keep.length === doc[side].elements.length) return doc;
      return { ...doc, [side]: { ...doc[side], elements: keep } };
    });
    this.set({ selection: this.state.selection.filter((id) => !set.has(id)) });
  }

  reorder(id: string, toIndex: number): void {
    const side = this.state.side;
    this.commit((doc) => {
      const els = [...doc[side].elements];
      const from = els.findIndex((e) => e.id === id);
      if (from < 0) return doc;
      const clamped = Math.max(0, Math.min(els.length - 1, toIndex));
      if (from === clamped) return doc;
      const [moved] = els.splice(from, 1);
      els.splice(clamped, 0, moved);
      return { ...doc, [side]: { ...doc[side], elements: els } };
    });
  }

  bringToFront(ids: string[]): void {
    const side = this.state.side;
    const set = new Set(ids);
    this.commit((doc) => {
      const els = doc[side].elements;
      const moved = els.filter((e) => set.has(e.id));
      if (moved.length === 0) return doc;
      return {
        ...doc,
        [side]: { ...doc[side], elements: [...els.filter((e) => !set.has(e.id)), ...moved] },
      };
    });
  }

  sendToBack(ids: string[]): void {
    const side = this.state.side;
    const set = new Set(ids);
    this.commit((doc) => {
      const els = doc[side].elements;
      const moved = els.filter((e) => set.has(e.id));
      if (moved.length === 0) return doc;
      return {
        ...doc,
        [side]: { ...doc[side], elements: [...moved, ...els.filter((e) => !set.has(e.id))] },
      };
    });
  }

  setSide(side: SideKey): void {
    if (side === this.state.side) return;
    this.set({ side, selection: [], editingTextId: null, dragPreview: null });
  }
}

/* ------------------------------------------------------------------ hooks */

export function useEditorSelector<T>(
  store: EditorStore,
  selector: (s: EditorState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  // The cache lives in a ref, not the render body: useSyncExternalStore calls
  // getSnapshot repeatedly and will loop forever if a selector that derives a
  // new object returns a new identity each call. Holding the last accepted value
  // makes a derived selector safe.
  const cache = useRef<{ value: T } | null>(null);
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const equalRef = useRef(isEqual);
  equalRef.current = isEqual;

  const getSnapshot = useCallback(() => {
    const next = selectorRef.current(store.getState());
    const prev = cache.current;
    if (prev && equalRef.current(prev.value, next)) return prev.value;
    cache.current = { value: next };
    return next;
  }, [store]);

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}
