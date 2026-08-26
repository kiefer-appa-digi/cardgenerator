import { formatLength, type Upt } from "@/lib/units";
import type { Insets } from "@/lib/geometry/types";
import { Badge } from "@/components/ui/panel";
import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

/**
 * Dimension display for the dieline screens.
 *
 * Every length arrives as µpt and leaves through `formatLength`, in all three
 * units a prepress operator works in: inches (5 places, because the presets
 * carry 5 — 7.11175 in is not 7.1118), millimetres and PDF points. Nothing is
 * pre-rounded on the way in.
 */

/** Where a number came from — the reader must never have to guess. */
export type DimSource = "authoritative" | "derived" | "measured";

const SOURCE_TONE: Record<DimSource, "brand" | "neutral" | "warning"> = {
  authoritative: "brand",
  derived: "neutral",
  measured: "warning",
};

const SOURCE_LABEL: Record<DimSource, string> = {
  authoritative: "spec §2",
  derived: "derived",
  measured: "measured",
};

export type DimRow = {
  label: string;
  value: Upt;
  source: DimSource;
  note?: string;
};

export type DimGroup = {
  title: string;
  rows: DimRow[];
};

export function DimensionTable({ groups }: { groups: DimGroup[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">
          Every authoritative dimension of this preset in inches, millimetres and PDF points.
        </caption>
        <thead>
          <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
            <th scope="col" className="px-4 py-2 font-medium">
              Dimension
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              in
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              mm
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              pt
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Source
            </th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.title}>
            <tr className="bg-ink-900/60">
              <th
                scope="colgroup"
                colSpan={5}
                className="border-y border-ink-800 px-4 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-300"
              >
                {g.title}
              </th>
            </tr>
            {g.rows.map((r) => (
              <tr key={g.title + r.label} className="border-b border-ink-800/60 last:border-0">
                <th scope="row" className="px-4 py-2 text-left font-normal text-ink-200">
                  {r.label}
                  {r.note ? (
                    <span className="mt-0.5 block text-[11px] leading-snug text-ink-500">{r.note}</span>
                  ) : null}
                </th>
                <td className="numeric px-4 py-2 text-right font-medium text-ink-50">
                  {formatLength(r.value, "in")}
                </td>
                <td className="numeric px-4 py-2 text-right text-ink-300">
                  {formatLength(r.value, "mm")}
                </td>
                <td className="numeric px-4 py-2 text-right text-ink-300">
                  {formatLength(r.value, "pt")}
                </td>
                <td className="px-4 py-2">
                  <Badge tone={SOURCE_TONE[r.source]}>{SOURCE_LABEL[r.source]}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/**
 * A headline dimension. This is the number the prepress manager opened the
 * screen to read, so it is set large, in tabular figures, with the millimetre
 * and point equivalents directly beneath it rather than a click away.
 */
export function HeroDimension({
  label,
  width,
  height,
  hint,
  size = "md",
  className,
}: {
  label: string;
  width: Upt;
  /** Omit for a single scalar such as a corner radius. */
  height?: Upt;
  hint?: ReactNode;
  size?: "md" | "lg";
  className?: string;
}) {
  const pair = (unit: "in" | "mm" | "pt") =>
    height === undefined
      ? `${formatLength(width, unit)} ${unit}`
      : `${formatLength(width, unit)} × ${formatLength(height, unit)} ${unit}`;

  return (
    <div
      className={cn(
        "rounded-panel border border-ink-800 bg-ink-850/60 px-4 py-3.5",
        className,
      )}
    >
      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-400">{label}</div>
      <div
        className={cn(
          "numeric mt-1.5 font-display font-bold leading-none text-ink-50",
          size === "lg" ? "text-2xl sm:text-3xl" : "text-xl",
        )}
      >
        {pair("in")}
      </div>
      <div className="numeric mt-2 space-y-0.5 text-xs text-ink-400">
        <div>{pair("mm")}</div>
        <div>{pair("pt")}</div>
      </div>
      {hint ? <div className="mt-2 text-[11px] leading-snug text-ink-500">{hint}</div> : null}
    </div>
  );
}

/** Inline in/mm/pt triple for places a full table would be too heavy. */
export function TripleInline({ value }: { value: Upt }) {
  return (
    <span className="numeric">
      {formatLength(value, "in")} in
      <span className="text-ink-500">
        {" · "}
        {formatLength(value, "mm")} mm · {formatLength(value, "pt")} pt
      </span>
    </span>
  );
}

/**
 * Insets read as one phrase when they are uniform and as four when they are
 * not — a per-side bleed must never be summarised as "on every side".
 */
export function insetSummary(i: Insets): string {
  const uniform = i.top === i.right && i.right === i.bottom && i.bottom === i.left;
  if (uniform) return `${formatLength(i.top, "in")} in on every side`;
  return `T ${formatLength(i.top, "in")} · R ${formatLength(i.right, "in")} · B ${formatLength(
    i.bottom,
    "in",
  )} · L ${formatLength(i.left, "in")} in`;
}
