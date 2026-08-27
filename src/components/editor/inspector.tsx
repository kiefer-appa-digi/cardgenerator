"use client";

import { useEffect, useMemo, useState } from "react";
import { formatLength, parseLength, type LengthUnit, type Upt } from "@/lib/units";
import { FONT_FAMILIES } from "@/lib/text/fonts";
import {
  BRAND_SWATCHES, TINT_MAX, cmyk, formatColor, grayPct, isGrayscale, previewHex,
  totalAreaCoverage, type PrintColor,
} from "@/lib/color/types";
import { FIELD_CATALOG, FIELD_GROUPS } from "@/lib/data/context";
import type { DesignElement } from "@/lib/design/schema";
import type { EditorStore } from "@/lib/editor/store";
import { useEditorSelector } from "@/lib/editor/store";
import { cn } from "@/lib/cn";
import { AssetPicker, type EditorAsset } from "./asset-picker";

/**
 * THE INSPECTOR
 *
 * Exposes the exact physical properties the spec requires (§6): X, Y, W, H,
 * rotation, corner radius, opacity, stroke and fill. Every length field parses
 * user input through `parseLength`, so "4 3/8" and "110.31mm" both work and both
 * land on an exact µpt integer. Colour is authored in CMYK tints, never in hex.
 */

export function Inspector({
  store,
  assets,
  onAssetUploaded,
}: {
  store: EditorStore;
  assets: EditorAsset[];
  onAssetUploaded?: (asset: EditorAsset) => void;
}) {
  const selection = useEditorSelector(store, (s) => s.selection.join(","));
  const elements = useEditorSelector(store, (s) => s.doc[s.side].elements);
  const unit = useEditorSelector(store, (s) => s.unit);
  const side = useEditorSelector(store, (s) => s.side);
  const colorIntent = useEditorSelector(store, (s) => s.doc[s.side].colorIntent);

  const ids = selection ? selection.split(",") : [];
  const selected = elements.filter((e) => ids.includes(e.id));

  if (selected.length === 0) {
    return <SideProperties store={store} />;
  }

  const el = selected[0];
  const multi = selected.length > 1;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-ink-800 px-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">
          {multi ? `${selected.length} selected` : el.kind}
        </h2>
        {(el.locked || el.templateLocked) && !multi ? (
          <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-sev-warning">
            {el.templateLocked ? "brand locked" : "locked"}
          </span>
        ) : null}
      </div>

      <Section title="Geometry">
        <div className="grid grid-cols-2 gap-2">
          <LengthField
            label="X"
            value={el.frame.x}
            unit={unit}
            disabled={el.locked}
            onChange={(v) =>
              store.updateElements(ids, (e) => ({ ...e, frame: { ...e.frame, x: v } }), {
                coalesceKey: "geom-x",
              })
            }
          />
          <LengthField
            label="Y"
            value={el.frame.y}
            unit={unit}
            disabled={el.locked}
            onChange={(v) =>
              store.updateElements(ids, (e) => ({ ...e, frame: { ...e.frame, y: v } }), {
                coalesceKey: "geom-y",
              })
            }
          />
          <LengthField
            label="W"
            value={el.frame.w}
            unit={unit}
            disabled={el.locked}
            onChange={(v) =>
              store.updateElements(ids, (e) => ({ ...e, frame: { ...e.frame, w: Math.max(1, v) } }), {
                coalesceKey: "geom-w",
              })
            }
          />
          <LengthField
            label="H"
            value={el.frame.h}
            unit={unit}
            disabled={el.locked}
            onChange={(v) =>
              store.updateElements(ids, (e) => ({ ...e, frame: { ...e.frame, h: Math.max(1, v) } }), {
                coalesceKey: "geom-h",
              })
            }
          />
          <NumberField
            label="Rotation"
            suffix="°"
            value={el.rotation / 1000}
            step={0.5}
            disabled={el.locked}
            onChange={(v) =>
              store.updateElements(ids, (e) => ({ ...e, rotation: Math.round(v * 1000) }), {
                coalesceKey: "geom-rot",
              })
            }
          />
          <NumberField
            label="Opacity"
            suffix="%"
            value={el.opacity / 100}
            min={0}
            max={100}
            step={1}
            disabled={el.locked}
            onChange={(v) =>
              store.updateElements(ids, (e) => ({
                ...e,
                opacity: Math.max(0, Math.min(10_000, Math.round(v * 100))),
              }), { coalesceKey: "geom-op" })
            }
          />
        </div>
      </Section>

      {!multi ? (
        <KindProperties
          store={store}
          el={el}
          unit={unit}
          assets={assets}
          onAssetUploaded={onAssetUploaded}
        />
      ) : null}

      <Section title="Production">
        <Toggle
          label="Required on every card"
          hint="Preflight blocks an export when this resolves empty."
          checked={el.required}
          onChange={(v) => store.updateElements(ids, (e) => ({ ...e, required: v }))}
        />
        <Toggle
          label="Brand-locked"
          hint="Designers cannot move or edit this in a generated card."
          checked={el.templateLocked}
          onChange={(v) => store.updateElements(ids, (e) => ({ ...e, templateLocked: v }), { coalesceKey: "unlock-tpl" })}
        />
        <Toggle
          label="Editable region"
          hint="Marks a slot a designer is expected to fill in."
          checked={el.editableRegion}
          onChange={(v) => store.updateElements(ids, (e) => ({ ...e, editableRegion: v }))}
        />
        <TextField
          label="Show only when"
          placeholder="e.g. identifiers.upc12"
          hint="A field path, or path = value. Blank means always."
          value={el.visibleWhen ?? ""}
          onChange={(v) =>
            store.updateElements(ids, (e) => ({ ...e, visibleWhen: v || undefined }), {
              coalesceKey: "vis-when",
            })
          }
        />
      </Section>

      {side === "back" && colorIntent === "grayscale" ? (
        <p className="border-t border-ink-800 px-3 py-3 text-[11px] leading-relaxed text-ink-500">
          This side is set to grayscale. Any non-grayscale colour here is reported
          by preflight before export.
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------ per-kind properties */

function KindProperties({
  store,
  el,
  unit,
  assets,
  onAssetUploaded,
}: {
  store: EditorStore;
  el: DesignElement;
  unit: LengthUnit;
  assets: EditorAsset[];
  onAssetUploaded?: (asset: EditorAsset) => void;
}) {
  const ids = [el.id];

  if (el.kind === "text") {
    return (
      <>
        <Section title="Type">
          <div className="grid grid-cols-2 gap-2">
            <SelectField
              label="Family"
              value={el.fontFamily}
              options={FONT_FAMILIES.map((f) => ({ value: f.family, label: f.label }))}
              onChange={(v) => store.updateElements(ids, (e) => ({ ...e, fontFamily: v }))}
              className="col-span-2"
            />
            <SelectField
              label="Weight"
              value={String(el.fontWeight)}
              options={(FONT_FAMILIES.find((f) => f.family === el.fontFamily)?.faces ?? [])
                .filter((f) => !f.italic)
                .map((f) => ({ value: String(f.weight), label: String(f.weight) }))}
              onChange={(v) => store.updateElements(ids, (e) => ({ ...e, fontWeight: Number(v) }))}
            />
            <PointField
              label="Size"
              value={el.fontSize}
              onChange={(v) =>
                store.updateElements(ids, (e) => ({ ...e, fontSize: Math.max(1_000_000, v) }), {
                  coalesceKey: "type-size",
                })
              }
            />
            <NumberField
              label="Leading"
              suffix="×"
              value={el.lineHeight / 10_000}
              step={0.05}
              onChange={(v) =>
                store.updateElements(ids, (e) => ({ ...e, lineHeight: Math.round(v * 10_000) }), {
                  coalesceKey: "type-lh",
                })
              }
            />
            <NumberField
              label="Tracking"
              suffix="/1000em"
              value={Math.round((el.tracking / el.fontSize) * 1000)}
              step={1}
              onChange={(v) =>
                store.updateElements(ids, (e) => {
                  const t = e.kind === "text" ? e : null;
                  if (!t) return e;
                  return { ...t, tracking: Math.round((v / 1000) * t.fontSize) };
                }, { coalesceKey: "type-tr" })
              }
            />
            <SelectField
              label="Align"
              value={el.align}
              options={[
                { value: "left", label: "Left" },
                { value: "center", label: "Centre" },
                { value: "right", label: "Right" },
                { value: "justify", label: "Justify" },
              ]}
              onChange={(v) =>
                store.updateElements(ids, (e) => ({ ...e, align: v as typeof el.align }))
              }
            />
            <SelectField
              label="Vertical"
              value={el.verticalAlign}
              options={[
                { value: "top", label: "Top" },
                { value: "middle", label: "Middle" },
                { value: "bottom", label: "Bottom" },
              ]}
              onChange={(v) =>
                store.updateElements(ids, (e) => ({
                  ...e,
                  verticalAlign: v as typeof el.verticalAlign,
                }))
              }
            />
            <SelectField
              label="Case"
              value={el.transform}
              options={[
                { value: "none", label: "As typed" },
                { value: "uppercase", label: "UPPERCASE" },
                { value: "lowercase", label: "lowercase" },
                { value: "titlecase", label: "Title Case" },
              ]}
              onChange={(v) =>
                store.updateElements(ids, (e) => ({ ...e, transform: v as typeof el.transform }))
              }
            />
          </div>
        </Section>

        <Section title="Fitting">
          <SelectField
            label="Overflow"
            value={el.autoFit.mode}
            options={[
              { value: "none", label: "Report overflow" },
              { value: "shrink", label: "Shrink to fit (bounded)" },
            ]}
            onChange={(v) =>
              store.updateElements(ids, (e) => ({
                ...e,
                autoFit: { ...(e as typeof el).autoFit, mode: v as "none" | "shrink" },
              }))
            }
          />
          {el.autoFit.mode === "shrink" ? (
            <PointField
              label="Never below"
              value={el.autoFit.minFontSize}
              onChange={(v) =>
                store.updateElements(ids, (e) => ({
                  ...e,
                  autoFit: { ...(e as typeof el).autoFit, minFontSize: Math.max(1_000_000, v) },
                }), { coalesceKey: "fit-min" })
              }
            />
          ) : null}
          <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
            Copy is never clipped. If it still does not fit at the smallest
            allowed size, preflight raises a blocking error.
          </p>
        </Section>

        <Section title="Colour">
          <ColorControl
            label="Text"
            color={el.color}
            onChange={(c) => store.updateElements(ids, (e) => ({ ...e, color: c }), { coalesceKey: "col-text" })}
          />
          <ColorControl
            label="Box fill"
            color={el.fill}
            allowNone
            onChange={(c) => store.updateElements(ids, (e) => ({ ...e, fill: c }), { coalesceKey: "col-fill" })}
          />
        </Section>
      </>
    );
  }

  if (el.kind === "shape") {
    return (
      <Section title="Appearance">
        <ColorControl
          label="Fill"
          color={el.fill}
          allowNone
          onChange={(c) => store.updateElements(ids, (e) => ({ ...e, fill: c }), { coalesceKey: "shp-fill" })}
        />
        <ColorControl
          label="Stroke"
          color={el.stroke}
          allowNone
          onChange={(c) => store.updateElements(ids, (e) => ({ ...e, stroke: c }), { coalesceKey: "shp-stroke" })}
        />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <PointField
            label="Stroke width"
            value={el.strokeWidth}
            onChange={(v) =>
              store.updateElements(ids, (e) => ({ ...e, strokeWidth: Math.max(0, v) }), {
                coalesceKey: "shp-sw",
              })
            }
          />
          {el.shape === "rect" ? (
            <LengthField
              label="Corner"
              value={el.cornerRadius}
              unit={unit}
              onChange={(v) =>
                store.updateElements(ids, (e) => ({ ...e, cornerRadius: Math.max(0, v) }), {
                  coalesceKey: "shp-r",
                })
              }
            />
          ) : null}
        </div>
      </Section>
    );
  }

  if (el.kind === "barcode") {
    const magPct = el.magnification / 100;
    return (
      <>
        <Section title="Symbol">
          <SelectField
            label="Symbology"
            value={el.symbology}
            options={[
              { value: "upca", label: "UPC-A" },
              { value: "ean13", label: "EAN-13" },
              { value: "gs1-128", label: "GS1-128" },
              { value: "qr", label: "QR" },
              { value: "gs1-digital-link", label: "GS1 Digital Link (QR)" },
            ]}
            onChange={(v) =>
              store.updateElements(ids, (e) => ({ ...e, symbology: v as typeof el.symbology }))
            }
          />
          <BindingField
            store={store}
            elementId={el.id}
            label="Value"
            path={el.binding?.path ?? ""}
            staticValue={el.value}
            onStatic={(v) => store.updateElements(ids, (e) => ({ ...e, value: v }), { coalesceKey: "bc-val" })}
            onPath={(p) =>
              store.updateElements(ids, (e) => ({
                ...e,
                binding: p
                  ? { path: p, fallback: "", prefix: "", suffix: "", transform: "none", joiner: ", ", hideWhenEmpty: false }
                  : undefined,
              }))
            }
          />
          <div className="mt-2 grid grid-cols-2 gap-2">
            <NumberField
              label="Magnification"
              suffix="%"
              value={magPct}
              min={80}
              max={200}
              step={1}
              onChange={(v) =>
                store.updateElements(ids, (e) => ({
                  ...e,
                  magnification: Math.round(Math.max(80, Math.min(200, v)) * 100),
                }), { coalesceKey: "bc-mag" })
              }
            />
            <LengthField
              label="Bar height"
              value={el.barHeight}
              unit={unit}
              onChange={(v) =>
                store.updateElements(ids, (e) => ({ ...e, barHeight: Math.max(1, v) }), {
                  coalesceKey: "bc-h",
                })
              }
            />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
            GS1 permits 80–200 % for retail point of sale. The symbol width is a
            function of magnification only — it can never be stretched
            independently.
          </p>
        </Section>
        <Section title="Presentation">
          <Toggle
            label="Human-readable digits"
            checked={el.showHumanReadable}
            onChange={(v) => store.updateElements(ids, (e) => ({ ...e, showHumanReadable: v }))}
          />
          <Toggle
            label="Light-margin indicator"
            hint="The › mark that protects the right quiet zone."
            checked={el.showLightMarginIndicator}
            onChange={(v) =>
              store.updateElements(ids, (e) => ({ ...e, showLightMarginIndicator: v }))
            }
          />
          <ColorControl
            label="Bars"
            color={el.barColor}
            onChange={(c) => store.updateElements(ids, (e) => ({ ...e, barColor: c }), { coalesceKey: "bc-col" })}
          />
          <ColorControl
            label="Quiet zone"
            color={el.quietZoneFill}
            allowNone
            onChange={(c) => store.updateElements(ids, (e) => ({ ...e, quietZoneFill: c }), { coalesceKey: "bc-qz" })}
          />
        </Section>
      </>
    );
  }

  if (el.kind === "bomList") {
    return (
      <>
        <Section title="Pack contents">
          <TextField
            label="Heading"
            value={el.heading}
            onChange={(v) => store.updateElements(ids, (e) => ({ ...e, heading: v }), { coalesceKey: "bom-head" })}
          />
          <TextField
            label="Line template"
            value={el.itemTemplate}
            hint="Tokens: {quantity} {name} {partNumber} {description} {position}"
            onChange={(v) => store.updateElements(ids, (e) => ({ ...e, itemTemplate: v }), { coalesceKey: "bom-tpl" })}
          />
          <div className="mt-2 grid grid-cols-2 gap-2">
            <PointField
              label="Size"
              value={el.fontSize}
              onChange={(v) =>
                store.updateElements(ids, (e) => ({ ...e, fontSize: Math.max(1_000_000, v) }), {
                  coalesceKey: "bom-size",
                })
              }
            />
            <NumberField
              label="Columns"
              value={el.columns}
              min={1}
              max={3}
              step={1}
              onChange={(v) =>
                store.updateElements(ids, (e) => ({ ...e, columns: Math.max(1, Math.min(3, Math.round(v))) }))
              }
            />
          </div>
          <TextField
            label="When empty, print"
            value={el.emptyText}
            onChange={(v) => store.updateElements(ids, (e) => ({ ...e, emptyText: v }), { coalesceKey: "bom-empty" })}
          />
        </Section>
        <Section title="Colour">
          <ColorControl
            label="Text"
            color={el.color}
            onChange={(c) => store.updateElements(ids, (e) => ({ ...e, color: c }), { coalesceKey: "bom-col" })}
          />
        </Section>
      </>
    );
  }

  if (el.kind === "image") {
    const asset = assets.find((a) => a.id === el.assetId) ?? null;
    // Effective resolution at the placed size, which is the number a press cares
    // about — not whatever DPI the file claims in its header.
    const effectiveDpi =
      asset?.pixelWidth && el.frame.w > 0
        ? Math.round((asset.pixelWidth * (el.crop.w / 10_000)) / (el.frame.w / 72_000_000))
        : null;
    return (
      <Section title="Image">
        <AssetPicker
          assets={assets}
          selectedId={el.assetId}
          onSelect={(assetId) =>
            store.updateElements(ids, (e) => ({ ...e, assetId }), { coalesceKey: "img-asset" })
          }
          onUploaded={onAssetUploaded}
        />
        {effectiveDpi !== null ? (
          <p
            className={cn(
              "numeric mt-1.5 text-[10px] leading-snug",
              effectiveDpi < 200
                ? "text-sev-error"
                : effectiveDpi < 300
                  ? "text-sev-warning"
                  : "text-ink-500",
            )}
          >
            {effectiveDpi} dpi at this size
            {effectiveDpi < 300 ? " — below the 300 dpi the preflight profile asks for" : ""}
          </p>
        ) : null}
        <SelectField
          label="Fit"
          value={el.fit}
          options={[
            { value: "fill", label: "Fill frame (crop)" },
            { value: "fit", label: "Fit inside frame" },
            { value: "stretch", label: "Stretch (distorts)" },
            { value: "crop", label: "Crop" },
          ]}
          onChange={(v) => store.updateElements(ids, (e) => ({ ...e, fit: v as typeof el.fit }))}
        />
        <Toggle
          label="Use as background"
          hint="Must cover the full bleed box; preflight checks it."
          checked={el.isBackground}
          onChange={(v) => store.updateElements(ids, (e) => ({ ...e, isBackground: v }))}
        />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <NumberField
            label="Focal X"
            suffix="%"
            value={el.focalX / 100}
            min={0}
            max={100}
            onChange={(v) =>
              store.updateElements(ids, (e) => ({ ...e, focalX: Math.round(v * 100) }), {
                coalesceKey: "img-fx",
              })
            }
          />
          <NumberField
            label="Focal Y"
            suffix="%"
            value={el.focalY / 100}
            min={0}
            max={100}
            onChange={(v) =>
              store.updateElements(ids, (e) => ({ ...e, focalY: Math.round(v * 100) }), {
                coalesceKey: "img-fy",
              })
            }
          />
        </div>
      </Section>
    );
  }

  return null;
}

/* --------------------------------------------------------- side properties */

function SideProperties({ store }: { store: EditorStore }) {
  const doc = useEditorSelector(store, (s) => s.doc);
  const side = useEditorSelector(store, (s) => s.side);
  const overlays = useEditorSelector(store, (s) => s.overlays);
  const cardSide = doc[side];

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex h-8 shrink-0 items-center border-b border-ink-800 px-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">
          {side} side
        </h2>
      </div>

      <Section title="Colour intent">
        <SelectField
          label="Intent"
          value={cardSide.colorIntent}
          options={[
            { value: "process", label: "Full colour (CMYK)" },
            { value: "grayscale", label: "Black & white" },
          ]}
          onChange={(v) =>
            store.commit((d) => ({
              ...d,
              [side]: { ...d[side], colorIntent: v as "process" | "grayscale" },
            }))
          }
        />
        {cardSide.colorIntent === "grayscale" ? (
          <Toggle
            label="Allow authorised colour"
            hint="Downgrades the grayscale check from error to warning."
            checked={cardSide.allowColorOverride}
            onChange={(v) =>
              store.commit((d) => ({
                ...d,
                [side]: { ...d[side], allowColorOverride: v },
              }))
            }
          />
        ) : null}
      </Section>

      <Section title="Overlays">
        {(
          [
            ["bleed", "Bleed boundary"],
            ["trim", "Trim (card edge)"],
            ["safe", "Safe area"],
            ["cavity", "Clamshell cavity"],
            ["centerLines", "Centre lines"],
            ["guides", "Guides"],
            ["rulers", "Rulers"],
            ["outlines", "Element outlines"],
          ] as const
        ).map(([key, label]) => (
          <Toggle
            key={key}
            label={label}
            checked={overlays[key]}
            onChange={(v) => store.set({ overlays: { ...overlays, [key]: v } })}
          />
        ))}
        <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
          Overlays are drawn in a separate non-printing layer. They cannot reach a
          production PDF.
        </p>
      </Section>
    </div>
  );
}

/* -------------------------------------------------------------- primitives */

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-ink-800 px-3 py-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function LengthField({
  label,
  value,
  unit,
  onChange,
  disabled,
}: {
  label: string;
  value: Upt;
  unit: LengthUnit;
  onChange: (v: Upt) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(() => formatLength(value, unit));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(formatLength(value, unit));
    setInvalid(false);
  }, [value, unit]);

  const commit = () => {
    const parsed = parseLength(draft, unit);
    if (parsed === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onChange(parsed);
  };

  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-wide text-ink-500">{label}</span>
      <div className="relative">
        <input
          // Named explicitly: the unit suffix sits inside the same <label>, so
          // without this the field announces as "X in" and a screen-reader user
          // hears the unit as part of the field's name.
          aria-label={label}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") { commit(); (e.target as HTMLInputElement).blur(); }
            if (e.key === "Escape") { setDraft(formatLength(value, unit)); setInvalid(false); }
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const step = e.shiftKey ? 10 : 1;
              const base = parseLength(draft, unit) ?? value;
              const delta = unit === "in" ? 72_000 * step : unit === "mm" ? 28_346 * step : 1_000_000 * step;
              onChange(base + (e.key === "ArrowUp" ? delta : -delta));
            }
          }}
          className={cn(
            "numeric h-7 w-full rounded border bg-ink-850 px-2 pr-7 text-xs text-ink-100 disabled:opacity-50",
            invalid ? "border-flag-600" : "border-ink-700 focus:border-brand-500",
          )}
          aria-invalid={invalid}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-ink-500"
        >
          {unit}
        </span>
      </div>
    </label>
  );
}

function PointField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Upt;
  onChange: (v: Upt) => void;
}) {
  return (
    <NumberField
      label={label}
      suffix="pt"
      value={value / 1_000_000}
      step={0.25}
      min={0}
      onChange={(v) => onChange(Math.round(v * 1_000_000))}
    />
  );
}

export function NumberField({
  label,
  value,
  onChange,
  suffix,
  min,
  max,
  step = 1,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(() => String(round4(value)));
  useEffect(() => setDraft(String(round4(value))), [value]);
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-wide text-ink-500">{label}</span>
      <div className="relative">
        <input
          type="number"
          aria-label={label}
          value={draft}
          disabled={disabled}
          min={min}
          max={max}
          step={step}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const n = Number(draft);
            if (Number.isFinite(n)) onChange(n);
            else setDraft(String(round4(value)));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="numeric h-7 w-full rounded border border-ink-700 bg-ink-850 px-2 text-xs text-ink-100 focus:border-brand-500 disabled:opacity-50 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        />
        {suffix ? (
          <span
            aria-hidden
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-ink-500"
          >
            {suffix}
          </span>
        ) : null}
      </div>
    </label>
  );
}

function round4(n: number) {
  return Math.round(n * 10_000) / 10_000;
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="mt-2 block first:mt-0">
      <span className="mb-1 block text-[10px] uppercase tracking-wide text-ink-500">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-full rounded border border-ink-700 bg-ink-850 px-2 text-xs text-ink-100 placeholder:text-ink-600 focus:border-brand-500"
      />
      {hint ? <span className="mt-1 block text-[10px] leading-snug text-ink-500">{hint}</span> : null}
    </label>
  );
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <label className={cn("mt-2 block first:mt-0", className)}>
      <span className="mb-1 block text-[10px] uppercase tracking-wide text-ink-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-full rounded border border-ink-700 bg-ink-850 px-1.5 text-xs text-ink-100 focus:border-brand-500"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="mt-2 flex cursor-pointer items-start gap-2 first:mt-0">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-brand-500"
      />
      <span className="min-w-0">
        <span className="block text-xs leading-snug text-ink-200">{label}</span>
        {hint ? <span className="block text-[10px] leading-snug text-ink-500">{hint}</span> : null}
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------ colour */

export function ColorControl({
  label,
  color,
  onChange,
  allowNone,
}: {
  label: string;
  color: PrintColor;
  onChange: (c: PrintColor) => void;
  allowNone?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tac = totalAreaCoverage(color);

  return (
    <div className="mt-2 first:mt-0">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex h-7 flex-1 items-center gap-2 rounded border border-ink-700 bg-ink-850 px-1.5 text-left hover:border-ink-600"
        >
          <span
            className="h-4 w-4 shrink-0 rounded-sm border border-ink-600"
            style={{
              background:
                color.space === "none"
                  ? "linear-gradient(135deg, transparent 45%, #e82627 45%, #e82627 55%, transparent 55%)"
                  : previewHex(color),
            }}
          />
          <span className="min-w-0 flex-1 truncate text-[10px] uppercase tracking-wide text-ink-500">
            {label}
          </span>
          <span className="numeric shrink-0 text-[10px] text-ink-300">{formatColor(color)}</span>
        </button>
      </div>

      {open ? (
        <div className="mt-1.5 rounded border border-ink-700 bg-ink-900 p-2">
          <div className="flex gap-1">
            <ModeBtn active={color.space === "cmyk"} onClick={() => onChange(cmyk(0, 0, 0, TINT_MAX))}>
              CMYK
            </ModeBtn>
            <ModeBtn active={color.space === "gray"} onClick={() => onChange(grayPct(100))}>
              Gray
            </ModeBtn>
            {allowNone ? (
              <ModeBtn active={color.space === "none"} onClick={() => onChange({ space: "none" })}>
                None
              </ModeBtn>
            ) : null}
          </div>

          {color.space === "cmyk" ? (
            <div className="mt-2 space-y-1.5">
              {(["c", "m", "y", "k"] as const).map((ch) => (
                <TintSlider
                  key={ch}
                  label={ch.toUpperCase()}
                  value={color[ch]}
                  onChange={(v) => onChange({ ...color, [ch]: v })}
                />
              ))}
              <div className="numeric flex justify-between pt-1 text-[10px] text-ink-500">
                <span>Total ink</span>
                <span className={tac > 3000 ? "text-sev-warning" : ""}>{(tac / 10).toFixed(0)}%</span>
              </div>
            </div>
          ) : null}

          {color.space === "gray" ? (
            <div className="mt-2">
              <TintSlider label="K" value={color.k} onChange={(v) => onChange({ ...color, k: v })} />
            </div>
          ) : null}

          <div className="mt-2 border-t border-ink-800 pt-2">
            <span className="mb-1.5 block text-[10px] uppercase tracking-wide text-ink-500">
              Brand swatches
            </span>
            <div className="flex flex-wrap gap-1">
              {BRAND_SWATCHES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  title={`${s.name} — ${formatColor(s.color)}${s.derivedFromRgb ? " (derived from " + s.sourceRgbHex + ")" : ""}`}
                  onClick={() => onChange(s.color)}
                  className="h-5 w-5 rounded-sm border border-ink-600 transition-transform hover:scale-110"
                  style={{ background: previewHex(s.color) }}
                >
                  <span className="sr-only">{s.name}</span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10px] leading-snug text-ink-500">
              The swatch you see is an RGB approximation of the CMYK recipe. The
              stored value is the ink, not the pixel.
            </p>
          </div>
        </div>
      ) : null}

      {!isGrayscale(color) ? null : null}
    </div>
  );
}

function ModeBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-6 flex-1 rounded text-[10px] font-medium uppercase tracking-wide",
        active ? "bg-brand-600 text-white" : "bg-ink-800 text-ink-300 hover:text-ink-100",
      )}
    >
      {children}
    </button>
  );
}

function TintSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-3 text-[10px] font-medium text-ink-400">{label}</span>
      <input
        type="range"
        min={0}
        max={1000}
        step={5}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={`${label} tint`}
        className="h-1 flex-1 accent-brand-500"
      />
      <input
        type="number"
        min={0}
        max={100}
        step={0.1}
        value={Number((value / 10).toFixed(1))}
        onChange={(e) => onChange(Math.max(0, Math.min(1000, Math.round(Number(e.target.value) * 10))))}
        aria-label={`${label} percent`}
        className="numeric h-5 w-12 rounded border border-ink-700 bg-ink-850 px-1 text-[10px] text-ink-200 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
    </div>
  );
}

/* ----------------------------------------------------------------- binding */

function BindingField({
  label,
  path,
  staticValue,
  onStatic,
  onPath,
}: {
  store: EditorStore;
  elementId: string;
  label: string;
  path: string;
  staticValue: string;
  onStatic: (v: string) => void;
  onPath: (p: string) => void;
}) {
  const grouped = useMemo(
    () =>
      FIELD_GROUPS.map((g) => ({
        group: g,
        fields: FIELD_CATALOG.filter((f) => f.group === g && f.type !== "collection"),
      })),
    [],
  );

  return (
    <div className="mt-2">
      <span className="mb-1 block text-[10px] uppercase tracking-wide text-ink-500">{label}</span>
      <select
        value={path}
        onChange={(e) => onPath(e.target.value)}
        className="h-7 w-full rounded border border-ink-700 bg-ink-850 px-1.5 text-xs text-ink-100 focus:border-brand-500"
      >
        <option value="">Fixed value…</option>
        {grouped.map((g) => (
          <optgroup key={g.group} label={g.group}>
            {g.fields.map((f) => (
              <option key={f.path} value={f.path}>
                {f.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {!path ? (
        <input
          value={staticValue}
          onChange={(e) => onStatic(e.target.value)}
          placeholder="e.g. 810797030124"
          className="numeric mt-1.5 h-7 w-full rounded border border-ink-700 bg-ink-850 px-2 text-xs text-ink-100 placeholder:text-ink-600 focus:border-brand-500"
        />
      ) : (
        <p className="mt-1 text-[10px] text-ink-500">
          Resolves from the selected product on every generated card.
        </p>
      )}
    </div>
  );
}
