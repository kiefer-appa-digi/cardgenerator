import {
  bleedRect,
  cavityRect,
  fullBleedHeight,
  fullBleedWidth,
  safeCornerRadius,
  safeRect,
  trimRect,
  type CardPresetDef,
} from "@/lib/geometry/presets";
import { roundedRectPath, segsToSvgPath, type Rect } from "@/lib/geometry/types";
import { PT_PER_IN, formatLength, uptToIn, uptToPt } from "@/lib/units";
import { insetSummary } from "@/components/preset/dimensions";
import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

/**
 * THE DIELINE FIGURE
 *
 * A to-scale drawing of one preset: the full-bleed page, the trim with its real
 * corner radius, the safe area with ITS own (smaller) radius, the measured
 * cavity footprint, the centre lines and dimension leaders.
 *
 * SVG user space is PDF points, the same coordinate system as the exported
 * page, exactly as the editor artboard does it. The figure is fitted to its
 * container, so it is not printed at physical size — but every proportion, and
 * every corner, is the press sheet's. Nothing here is redrawn by hand: every
 * rectangle comes from the same helpers the exporter uses, and the trim outline
 * is the same `roundedRectPath` the production clipping path is cut from. The
 * overlay colours are the artboard's, so the figure and the editor speak one
 * language.
 */

const PT = (u: number) => uptToPt(u);
const n = (v: number) => Number(v.toFixed(3));

/** Line colours are the artboard's; text uses the lighter tint of the same hue
 *  because the saturated red and blue fall below 4.5:1 on the console black.
 *  Exported so a screen that shows a figure without its legend can still key
 *  the colours — an unlabelled four-colour drawing is a puzzle, not a spec. */
export const DIELINE_TONES = {
  bleed: { line: "#e0a33a", text: "#e8bd6d" },
  trim: { line: "#1d9ed9", text: "#6ec8ee" },
  safe: { line: "#3fae72", text: "#6fc79a" },
  cavity: { line: "#e82627", text: "#f37b79" },
} as const;
const TONES = DIELINE_TONES;
export type Tone = keyof typeof DIELINE_TONES;

const BG = "#0b0d0f";
const FONT = 9;
const TICK = 3;
/** Offsets of the first and second dimension line from the card edge, in pt. */
const D1 = 15;
const D2 = 33;
/** Gutter around the bleed page, in pt: room for the leaders, or a hairline. */
const GUTTER: Record<"detail" | "thumb", number> = { detail: 46, thumb: 5 };

/**
 * Width of the whole figure box — bleed page plus gutter — in inches.
 *
 * A caller that sizes the figure's container needs this rather than the card
 * width: the SVG fits its viewBox to the container, so a container sized to the
 * card alone renders every preset at a slightly different scale.
 */
export function figureBoxWidthIn(
  preset: CardPresetDef,
  variant: "detail" | "thumb" = "detail",
): number {
  return uptToIn(fullBleedWidth(preset)) + (GUTTER[variant] * 2) / PT_PER_IN;
}

const toPt = (r: Rect) => ({ x: PT(r.x), y: PT(r.y), w: PT(r.w), h: PT(r.h) });
const chipW = (label: string) => label.length * FONT * 0.54 + 6;

/** Dimension text sits in a chip that breaks the leader line, as on a drawing. */
function DimLabel({ label, tone }: { label: string; tone: Tone }) {
  const w = chipW(label);
  return (
    <>
      <rect x={-w / 2} y={-FONT * 0.78} width={w} height={FONT * 1.5} fill={BG} />
      <text
        className="numeric"
        x={0}
        y={FONT * 0.36}
        textAnchor="middle"
        fill={TONES[tone].text}
        style={{ fontSize: FONT, letterSpacing: 0.2 }}
      >
        {label}
      </text>
    </>
  );
}

function HDim({
  x1,
  x2,
  y,
  from,
  label,
  tone,
}: {
  x1: number;
  x2: number;
  y: number;
  /** y of the feature edge being measured; the extension lines start there. */
  from: number;
  label: string;
  tone: Tone;
}) {
  const t = TONES[tone];
  return (
    <g>
      <line x1={n(x1)} y1={n(from)} x2={n(x1)} y2={n(y)} stroke={t.line} strokeWidth={0.4} strokeDasharray="2 2" opacity={0.55} />
      <line x1={n(x2)} y1={n(from)} x2={n(x2)} y2={n(y)} stroke={t.line} strokeWidth={0.4} strokeDasharray="2 2" opacity={0.55} />
      <line x1={n(x1)} y1={n(y)} x2={n(x2)} y2={n(y)} stroke={t.line} strokeWidth={0.6} />
      <line x1={n(x1)} y1={n(y - TICK)} x2={n(x1)} y2={n(y + TICK)} stroke={t.line} strokeWidth={0.9} />
      <line x1={n(x2)} y1={n(y - TICK)} x2={n(x2)} y2={n(y + TICK)} stroke={t.line} strokeWidth={0.9} />
      <g transform={`translate(${n((x1 + x2) / 2)} ${n(y)})`}>
        <DimLabel label={label} tone={tone} />
      </g>
    </g>
  );
}

function VDim({
  y1,
  y2,
  x,
  from,
  label,
  tone,
}: {
  y1: number;
  y2: number;
  x: number;
  from: number;
  label: string;
  tone: Tone;
}) {
  const t = TONES[tone];
  return (
    <g>
      <line x1={n(from)} y1={n(y1)} x2={n(x)} y2={n(y1)} stroke={t.line} strokeWidth={0.4} strokeDasharray="2 2" opacity={0.55} />
      <line x1={n(from)} y1={n(y2)} x2={n(x)} y2={n(y2)} stroke={t.line} strokeWidth={0.4} strokeDasharray="2 2" opacity={0.55} />
      <line x1={n(x)} y1={n(y1)} x2={n(x)} y2={n(y2)} stroke={t.line} strokeWidth={0.6} />
      <line x1={n(x - TICK)} y1={n(y1)} x2={n(x + TICK)} y2={n(y1)} stroke={t.line} strokeWidth={0.9} />
      <line x1={n(x - TICK)} y1={n(y2)} x2={n(x + TICK)} y2={n(y2)} stroke={t.line} strokeWidth={0.9} />
      <g transform={`translate(${n(x)} ${n((y1 + y2) / 2)}) rotate(-90)`}>
        <DimLabel label={label} tone={tone} />
      </g>
    </g>
  );
}

/** A true radius leader: cross at the arc centre, line out to the arc itself. */
function RadiusLeader({
  cx,
  cy,
  r,
  angleDeg,
  label,
  tone,
  labelDx,
  labelDy,
  anchor = "start",
}: {
  cx: number;
  cy: number;
  r: number;
  angleDeg: number;
  label: string;
  tone: Tone;
  labelDx: number;
  labelDy: number;
  anchor?: "start" | "end";
}) {
  const t = TONES[tone];
  const rad = (angleDeg * Math.PI) / 180;
  const ax = cx + r * Math.cos(rad);
  const ay = cy + r * Math.sin(rad);
  return (
    <g>
      <line x1={n(cx - 2.5)} y1={n(cy)} x2={n(cx + 2.5)} y2={n(cy)} stroke={t.line} strokeWidth={0.5} />
      <line x1={n(cx)} y1={n(cy - 2.5)} x2={n(cx)} y2={n(cy + 2.5)} stroke={t.line} strokeWidth={0.5} />
      <line x1={n(cx)} y1={n(cy)} x2={n(ax)} y2={n(ay)} stroke={t.line} strokeWidth={0.6} />
      <text
        className="numeric"
        x={n(cx + labelDx)}
        y={n(cy + labelDy)}
        textAnchor={anchor}
        fill={t.text}
        style={{ fontSize: FONT, letterSpacing: 0.2 }}
      >
        {label}
      </text>
    </g>
  );
}

export function DielineFigure({
  preset,
  variant = "detail",
  className,
  legend,
}: {
  preset: CardPresetDef;
  variant?: "detail" | "thumb";
  className?: string;
  legend?: boolean;
}) {
  const bleed = toPt(bleedRect(preset));
  const trim = toPt(trimRect(preset));
  const safe = toPt(safeRect(preset));
  const cav = toPt(cavityRect(preset));
  const trimR = PT(preset.cornerRadius);
  const safeR = PT(safeCornerRadius(preset));
  const cavR = PT(preset.cavity.cornerRadius);

  const detail = variant === "detail";
  const showLegend = legend ?? detail;
  const G = GUTTER[variant];
  const vbW = bleed.w + G * 2;
  const vbH = bleed.h + G * 2;

  const trimPath = segsToSvgPath(roundedRectPath(trimRect(preset), preset.cornerRadius), 1 / 1_000_000);
  const safePath = segsToSvgPath(roundedRectPath(safeRect(preset), safeCornerRadius(preset)), 1 / 1_000_000);
  const cavPath = segsToSvgPath(roundedRectPath(cavityRect(preset), preset.cavity.cornerRadius), 1 / 1_000_000);

  const cx = trim.x + trim.w / 2;
  const cy = trim.y + trim.h / 2;

  const inches = (u: number) => `${formatLength(u, "in")} in`;
  const titleId = `dieline-${preset.code}-title`;
  const descId = `dieline-${preset.code}-desc`;

  return (
    <figure className={cn("m-0", className)}>
      <svg
        viewBox={`0 0 ${n(vbW)} ${n(vbH)}`}
        role="img"
        aria-labelledby={`${titleId} ${descId}`}
        preserveAspectRatio="xMidYMid meet"
        className="block h-auto w-full"
        style={{ fontFamily: "var(--font-sans)" }}
      >
        {/* One text child only: the HTML parser treats an SVG <title> as raw
            text, so React's separator comment between two children would be
            parsed as literal text and break hydration. */}
        <title id={titleId}>{`${preset.code} dieline, drawn to scale`}</title>
        <desc id={descId}>
          {`Full-bleed page ${inches(fullBleedWidth(preset))} by ${inches(fullBleedHeight(preset))}; trim ${inches(
            preset.trimWidth,
          )} by ${inches(preset.trimHeight)} with a ${inches(preset.cornerRadius)} corner radius; safe area inset ${insetSummary(
            preset.safeArea,
          )} with its own ${inches(safeCornerRadius(preset))} corner radius; cavity footprint ${inches(
            preset.cavity.rect.w,
          )} by ${inches(preset.cavity.rect.h)}.`}
        </desc>

        <rect x={0} y={0} width={n(vbW)} height={n(vbH)} fill={BG} />

        <g transform={`translate(${G} ${G})`}>
          {/* Full-bleed page. Square corners: the PDF page is not rounded. */}
          <rect x={0} y={0} width={n(bleed.w)} height={n(bleed.h)} fill="#14171b" />

          {/* Centre lines, drawn under everything so they never break an edge. */}
          <g stroke="#3a424b" strokeWidth={0.5} strokeDasharray="6 4">
            <line x1={n(cx)} y1={0} x2={n(cx)} y2={n(bleed.h)} />
            <line x1={0} y1={n(cy)} x2={n(bleed.w)} y2={n(cy)} />
          </g>

          <rect
            x={0}
            y={0}
            width={n(bleed.w)}
            height={n(bleed.h)}
            fill="none"
            stroke={TONES.bleed.line}
            strokeWidth={0.7}
            strokeDasharray="4 3"
          />
          <path d={trimPath} fill={TONES.trim.line} fillOpacity={0.05} stroke={TONES.trim.line} strokeWidth={1} />
          <path d={safePath} fill="none" stroke={TONES.safe.line} strokeWidth={0.7} strokeDasharray="3 3" />
          {/* Outline only: a tint over the cavity would cover most of the card. */}
          <path d={cavPath} fill="none" stroke={TONES.cavity.line} strokeWidth={0.7} strokeDasharray="5 3" />

          {detail ? (
            <>
              <text
                x={n(cav.x + cav.w / 2)}
                y={n(cav.y + 11)}
                textAnchor="middle"
                fill={TONES.cavity.text}
                style={{ fontSize: FONT, letterSpacing: 1.2 }}
              >
                CAVITY
              </text>

              <RadiusLeader
                cx={trim.x + trimR}
                cy={trim.y + trimR}
                r={trimR}
                angleDeg={225}
                label={`R ${inches(preset.cornerRadius)}`}
                tone="trim"
                labelDx={4}
                labelDy={FONT + 1}
              />
              <RadiusLeader
                cx={safe.x + safe.w - safeR}
                cy={safe.y + safeR}
                r={safeR}
                angleDeg={-45}
                label={`R ${inches(safeCornerRadius(preset))}`}
                tone="safe"
                labelDx={-5}
                labelDy={FONT + 4}
                anchor="end"
              />
              <RadiusLeader
                cx={cav.x + cavR}
                cy={cav.y + cav.h - cavR}
                r={cavR}
                angleDeg={135}
                label={`R ≈ ${inches(preset.cavity.cornerRadius)}`}
                tone="cavity"
                labelDx={5}
                labelDy={-4}
              />
            </>
          ) : null}
        </g>

        {detail ? (
          <g transform={`translate(${G} ${G})`}>
            <HDim x1={trim.x} x2={trim.x + trim.w} y={-D1} from={trim.y} label={`${inches(preset.trimWidth)} trim`} tone="trim" />
            <HDim x1={0} x2={bleed.w} y={-D2} from={0} label={`${inches(fullBleedWidth(preset))} bleed`} tone="bleed" />
            <VDim y1={trim.y} y2={trim.y + trim.h} x={-D1} from={trim.x} label={`${inches(preset.trimHeight)} trim`} tone="trim" />
            <VDim y1={0} y2={bleed.h} x={-D2} from={0} label={`${inches(fullBleedHeight(preset))} bleed`} tone="bleed" />
            <VDim
              y1={safe.y}
              y2={safe.y + safe.h}
              x={bleed.w + D1}
              from={safe.x + safe.w}
              label={`${inches(safeRect(preset).h)} safe`}
              tone="safe"
            />
            <VDim
              y1={cav.y}
              y2={cav.y + cav.h}
              x={bleed.w + D2}
              from={cav.x + cav.w}
              label={`${inches(preset.cavity.rect.h)} cavity`}
              tone="cavity"
            />
            <HDim
              x1={safe.x}
              x2={safe.x + safe.w}
              y={bleed.h + D1}
              from={safe.y + safe.h}
              label={`${inches(safeRect(preset).w)} safe`}
              tone="safe"
            />
            <HDim
              x1={cav.x}
              x2={cav.x + cav.w}
              y={bleed.h + D2}
              from={cav.y + cav.h}
              label={`${inches(preset.cavity.rect.w)} cavity`}
              tone="cavity"
            />
          </g>
        ) : null}
      </svg>

      {showLegend ? (
        <figcaption className="mt-3">
          <dl className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
            <LegendItem tone="bleed" term="Full bleed">
              {insetSummary(preset.bleed)} · {inches(fullBleedWidth(preset))} ×{" "}
              {inches(fullBleedHeight(preset))}
            </LegendItem>
            <LegendItem tone="trim" term="Trim">
              {inches(preset.trimWidth)} × {inches(preset.trimHeight)} · R {inches(preset.cornerRadius)}
            </LegendItem>
            <LegendItem tone="safe" term="Safe area">
              {insetSummary(preset.safeArea)} from trim · R {inches(safeCornerRadius(preset))}
            </LegendItem>
            <LegendItem tone="cavity" term="Cavity">
              {inches(preset.cavity.rect.w)} × {inches(preset.cavity.rect.h)} · R ≈{" "}
              {inches(preset.cavity.cornerRadius)} (approximate)
            </LegendItem>
          </dl>
        </figcaption>
      ) : null}
    </figure>
  );
}

function LegendItem({
  tone,
  term,
  children,
}: {
  tone: Tone;
  term: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span
        aria-hidden
        className="mt-1 h-2 w-2 shrink-0 rounded-[1px]"
        style={{ backgroundColor: TONES[tone].line }}
      />
      <dt className="shrink-0 text-ink-300">{term}</dt>
      <dd className="numeric min-w-0 text-ink-400">{children}</dd>
    </div>
  );
}
