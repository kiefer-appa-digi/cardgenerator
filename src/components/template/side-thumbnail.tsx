"use client";

import { previewCss } from "@/lib/color/types";
import { roundedRectPath, segsToSvgPath } from "@/lib/geometry/types";
import { uptToPt } from "@/lib/units";
import { PlanLayer } from "@/components/editor/artboard-render";
import type { SidePlan } from "@/lib/design/render";

/**
 * A static preview of one template side.
 *
 * It draws the same render plan the PDF writer consumes, through the same
 * PlanLayer the artboard uses, so a thumbnail can never show a layout the
 * exporter would not produce. Nothing here is interactive and no overlay is
 * drawn except the trim edge, which is what tells a reader where the card is
 * cut out of the full-bleed page.
 *
 * The client boundary exists only because PlanLayer is a client component; this
 * wrapper holds no state.
 */
export function SideThumbnail({
  plan,
  label,
}: {
  plan: SidePlan;
  /** Describes the whole image for assistive technology, e.g. "409TF front". */
  label: string;
}) {
  const w = uptToPt(plan.canvas.w);
  const h = uptToPt(plan.canvas.h);

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      role="img"
      aria-label={label}
      className="block h-auto w-full"
    >
      {/* Paper, rendered as the document declares it — never flattered. */}
      <rect x={0} y={0} width={w} height={h} fill={previewCss(plan.background)} />

      <PlanLayer plan={plan} assetUrl={(id) => `/api/assets/${id}`} />

      <path
        d={segsToSvgPath(roundedRectPath(plan.trim, plan.cornerRadius), 1 / 1_000_000)}
        fill="none"
        stroke="rgba(11,13,15,0.45)"
        strokeWidth={0.5}
        strokeDasharray="3 2"
      />
    </svg>
  );
}
