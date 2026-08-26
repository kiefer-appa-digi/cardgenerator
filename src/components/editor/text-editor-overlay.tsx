"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { TextElement } from "@/lib/design/schema";
import type { EditorStore } from "@/lib/editor/store";

/**
 * Inline text editing.
 *
 * A contenteditable overlaid on the artboard would let the browser make layout
 * decisions the PDF cannot reproduce, so text is edited in a plain textarea and
 * the artboard re-lays it out through the shared engine on every keystroke. The
 * designer still sees live WYSIWYG on the card behind the panel; what they do
 * not get is a browser-shaped line break that the press would not honour.
 */
export function TextEditorOverlay({
  store,
  element,
  onClose,
}: {
  store: EditorStore;
  element: TextElement;
  onClose: () => void;
}) {
  const [value, setValue] = useState(() =>
    element.paragraphs
      .map((p) => p.runs.map((r) => (r.binding ? `{${r.binding.path}}` : r.text)).join(""))
      .join("\n"),
  );
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = (text: string) => {
    setValue(text);
    store.updateElements(
      [element.id],
      (el) => {
        if (el.kind !== "text") return el;
        return {
          ...el,
          paragraphs: text.split("\n").map((line) => ({
            runs: parseLine(line),
            styleId: undefined,
            spaceBefore: 0,
            spaceAfter: 0,
            listBullet: undefined,
          })),
        };
      },
      { coalesceKey: `text-${element.id}` },
    );
  };

  return (
    <div className="absolute bottom-3 left-1/2 z-30 w-[min(560px,90vw)] -translate-x-1/2 rounded-panel border border-ink-700 bg-ink-900 shadow-2xl">
      <div className="flex items-center justify-between border-b border-ink-800 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">
          Edit text
        </span>
        <span className="text-[10px] text-ink-500">
          {"{fieldPath}"} inserts product data · Esc to close
        </span>
      </div>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
          e.stopPropagation();
        }}
        rows={4}
        className="block w-full resize-y bg-transparent px-3 py-2.5 font-mono text-[13px] leading-relaxed text-ink-100 outline-none"
      />
      <div className="flex justify-end gap-2 border-t border-ink-800 px-3 py-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** Split "Part {partNumber}" into a literal run and a bound run. */
function parseLine(line: string) {
  const runs: TextElement["paragraphs"][number]["runs"] = [];
  const re = /\{([a-zA-Z0-9_.]+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) {
      runs.push({ text: line.slice(last, m.index), bold: false, italic: false });
    }
    runs.push({
      text: "",
      bold: false,
      italic: false,
      binding: {
        path: m[1],
        fallback: "",
        prefix: "",
        suffix: "",
        transform: "none",
        joiner: ", ",
        hideWhenEmpty: false,
      },
    });
    last = m.index + m[0].length;
  }
  if (last < line.length) runs.push({ text: line.slice(last), bold: false, italic: false });
  if (runs.length === 0) runs.push({ text: "", bold: false, italic: false });
  return runs;
}
