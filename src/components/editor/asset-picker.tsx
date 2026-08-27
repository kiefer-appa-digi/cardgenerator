"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ImagePlus, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uploadAssetAction } from "@/server/assets";
import { cn } from "@/lib/cn";

export type EditorAsset = {
  id: string;
  url: string;
  filename?: string;
  pixelWidth: number | null;
  pixelHeight: number | null;
  colorSpace: string;
  contentType: string;
};

/**
 * Choose or upload the artwork for an image element.
 *
 * Uploading from inside the editor matters more than it looks: the alternative
 * is leaving the card, going to the asset library, coming back and losing the
 * selection. The measurements shown next to each thumbnail are the ones
 * preflight will use — pixel dimensions and colour space — so a designer can see
 * before placing an asset whether it is going to survive the resolution check.
 */
export function AssetPicker({
  assets,
  selectedId,
  onSelect,
  onUploaded,
  label = "Artwork",
}: {
  assets: EditorAsset[];
  selectedId: string | null;
  onSelect: (assetId: string | null) => void;
  onUploaded?: (asset: EditorAsset) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selected = assets.find((a) => a.id === selectedId) ?? null;

  const upload = (file: File) => {
    setError(null);
    const fd = new FormData();
    fd.set("file", file);
    start(async () => {
      const res = await uploadAssetAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const asset: EditorAsset = {
        id: res.asset.id,
        url: `/api/assets/${res.asset.id}`,
        filename: res.asset.filename,
        pixelWidth: res.asset.pixelWidth,
        pixelHeight: res.asset.pixelHeight,
        colorSpace: res.asset.colorSpace,
        contentType: res.asset.contentType,
      };
      onUploaded?.(asset);
      onSelect(asset.id);
      setOpen(false);
    });
  };

  const filtered = query.trim()
    ? assets.filter((a) => (a.filename ?? "").toLowerCase().includes(query.trim().toLowerCase()))
    : assets;

  return (
    <div className="relative mt-2 first:mt-0">
      <span className="mb-1 block text-[10px] uppercase tracking-wide text-ink-500">{label}</span>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded border border-ink-700 bg-ink-850 px-1.5 text-left hover:border-ink-600"
        >
          {selected ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={selected.url}
              alt=""
              className="h-6 w-6 shrink-0 rounded-sm bg-ink-700 object-contain"
            />
          ) : (
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-ink-800">
              <ImagePlus size={13} className="text-ink-500" />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] text-ink-100">
              {selected ? (selected.filename ?? selected.id) : "Choose artwork…"}
            </span>
            {selected ? (
              <span className="numeric block truncate text-[10px] text-ink-500">
                {selected.pixelWidth && selected.pixelHeight
                  ? `${selected.pixelWidth} × ${selected.pixelHeight} px · ${selected.colorSpace}`
                  : selected.contentType}
              </span>
            ) : null}
          </span>
        </button>
        {selected ? (
          <button
            type="button"
            onClick={() => onSelect(null)}
            title="Remove artwork"
            aria-label="Remove artwork"
            className="flex h-9 w-7 shrink-0 items-center justify-center rounded border border-ink-700 text-ink-400 hover:border-ink-600 hover:text-ink-100"
          >
            <X size={13} />
          </button>
        ) : null}
      </div>

      {open ? (
        <div
          ref={popRef}
          className="absolute right-0 z-40 mt-1.5 w-full min-w-0 rounded-panel border border-ink-700 bg-ink-900 shadow-2xl"
        >
          <div className="border-b border-ink-800 p-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find artwork"
              aria-label="Find artwork"
              className="h-7 w-full rounded border border-ink-700 bg-ink-850 px-2 text-xs text-ink-100 placeholder:text-ink-600 focus:border-brand-500"
            />
          </div>

          <div className="max-h-64 overflow-y-auto p-2">
            {filtered.length === 0 ? (
              <p className="px-1 py-6 text-center text-xs leading-relaxed text-ink-500">
                {assets.length === 0
                  ? "No artwork uploaded yet. Add a file below — PNG, JPEG, TIFF, SVG or PDF."
                  : `Nothing matches “${query}”.`}
              </p>
            ) : (
              <ul className="grid grid-cols-2 gap-1.5">
                {filtered.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(a.id);
                        setOpen(false);
                      }}
                      title={`${a.filename ?? a.id}${a.pixelWidth ? ` · ${a.pixelWidth}×${a.pixelHeight} ${a.colorSpace}` : ""}`}
                      className={cn(
                        "flex aspect-square w-full items-center justify-center rounded border p-1 transition-colors",
                        a.id === selectedId
                          ? "border-brand-500 bg-brand-600/15"
                          : "border-ink-700 hover:border-ink-500",
                      )}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={a.url} alt={a.filename ?? ""} className="max-h-full max-w-full object-contain" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {error ? (
            <p role="alert" className="border-t border-ink-800 px-2 py-1.5 text-[11px] text-flag-300">
              {error}
            </p>
          ) : null}

          <div className="border-t border-ink-800 p-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/tiff,image/svg+xml,application/pdf"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
                e.target.value = "";
              }}
            />
            <Button
              size="sm"
              variant="outline"
              className="w-full justify-center"
              disabled={pending}
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={13} /> {pending ? "Uploading…" : "Upload artwork"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
