"use client";

import { Fragment } from "react";
import { previewCss } from "@/lib/color/types";
import { segsToSvgPath } from "@/lib/geometry/types";
import { uptToPt } from "@/lib/units";
import type { DrawOp, SidePlan } from "@/lib/design/render";

/**
 * SVG renderer for a resolved render plan.
 *
 * The SVG user-space unit is the PDF point, so the numbers in this markup are
 * the same numbers the PDF writer emits — a 4.3675 in card is 314.46 units wide
 * in both. Zoom is applied by the outer <svg> viewBox, never by rewriting
 * coordinates, so no amount of zooming can drift the geometry.
 *
 * Colour is `previewCss`, which is explicitly a CMYK→RGB approximation. The UI
 * says so next to the swatches; nothing here claims to be colour-managed.
 */

const pt = (u: number) => uptToPt(u);

export function PlanLayer({
  plan,
  overrides,
  assetUrl,
  interactive = false,
  onPointerDownElement,
}: {
  plan: SidePlan;
  /** Transient drag/resize previews keyed by element id. */
  overrides?: Map<string, { x: number; y: number; w: number; h: number }> | null;
  assetUrl: (assetId: string) => string | null;
  interactive?: boolean;
  onPointerDownElement?: (id: string, e: React.PointerEvent) => void;
}) {
  return (
    <g>
      {plan.ops.map((op) => (
        <OpNode
          key={`${op.elementId}-${op.z}-${op.op}`}
          op={op}
          override={overrides?.get(op.elementId) ?? null}
          assetUrl={assetUrl}
          interactive={interactive}
          onPointerDownElement={onPointerDownElement}
        />
      ))}
    </g>
  );
}

function OpNode({
  op,
  override,
  assetUrl,
  interactive,
  onPointerDownElement,
}: {
  op: DrawOp;
  override: { x: number; y: number; w: number; h: number } | null;
  assetUrl: (assetId: string) => string | null;
  interactive: boolean;
  onPointerDownElement?: (id: string, e: React.PointerEvent) => void;
}) {
  // A drag preview shifts the whole op by the frame delta rather than re-laying
  // it out, so dragging a text block stays at 60fps and the committed result is
  // still produced by the one true layout pass.
  const dx = override ? override.x - op.frame.x : 0;
  const dy = override ? override.y - op.frame.y : 0;
  const sx = override && op.frame.w ? override.w / op.frame.w : 1;
  const sy = override && op.frame.h ? override.h / op.frame.h : 1;

  const cx = op.frame.x + op.frame.w / 2;
  const cy = op.frame.y + op.frame.h / 2;

  const transforms: string[] = [];
  if (dx || dy) transforms.push(`translate(${pt(dx)} ${pt(dy)})`);
  if (sx !== 1 || sy !== 1) {
    transforms.push(`translate(${pt(op.frame.x)} ${pt(op.frame.y)})`);
    transforms.push(`scale(${sx} ${sy})`);
    transforms.push(`translate(${-pt(op.frame.x)} ${-pt(op.frame.y)})`);
  }
  if (op.rotation) transforms.push(`rotate(${op.rotation / 1000} ${pt(cx)} ${pt(cy)})`);

  const common = {
    transform: transforms.length ? transforms.join(" ") : undefined,
    opacity: op.opacity / 10_000,
    ...(interactive
      ? {
          onPointerDown: (e: React.PointerEvent) => onPointerDownElement?.(op.elementId, e),
          style: { cursor: "move" as const },
        }
      : {}),
  };

  switch (op.op) {
    case "path":
      return (
        <path
          {...common}
          d={segsToSvgPath(op.segs, 1 / 1_000_000, 4)}
          fill={previewCss(op.fill)}
          stroke={op.stroke.space === "none" ? "none" : previewCss(op.stroke)}
          strokeWidth={pt(op.strokeWidth)}
        />
      );

    case "ellipse":
      return (
        <ellipse
          {...common}
          cx={pt(op.rect.x + op.rect.w / 2)}
          cy={pt(op.rect.y + op.rect.h / 2)}
          rx={pt(op.rect.w / 2)}
          ry={pt(op.rect.h / 2)}
          fill={previewCss(op.fill)}
          stroke={op.stroke.space === "none" ? "none" : previewCss(op.stroke)}
          strokeWidth={pt(op.strokeWidth)}
        />
      );

    case "line":
      return (
        <line
          {...common}
          x1={pt(op.x1)}
          y1={pt(op.y1)}
          x2={pt(op.x2)}
          y2={pt(op.y2)}
          stroke={previewCss(op.stroke)}
          strokeWidth={pt(op.strokeWidth)}
          strokeLinecap="butt"
        />
      );

    case "text":
      return (
        <g {...common}>
          {op.fill.space !== "none" ? (
            <rect
              x={pt(op.frame.x)}
              y={pt(op.frame.y)}
              width={pt(op.frame.w)}
              height={pt(op.frame.h)}
              fill={previewCss(op.fill)}
            />
          ) : null}
          {op.spans.map((s, i) => (
            <text
              key={i}
              x={pt(s.x)}
              y={pt(s.y)}
              fill={previewCss(s.color)}
              style={{
                fontFamily: `"${s.fontFamily}"`,
                fontWeight: s.fontWeight,
                fontStyle: s.italic ? "italic" : "normal",
                fontSize: `${pt(s.fontSize)}px`,
                letterSpacing: s.tracking ? `${pt(s.tracking)}px` : undefined,
                whiteSpace: "pre",
              }}
              // The engine already measured and positioned every span; telling
              // the browser the exact advance keeps a hinting difference from
              // shifting a line relative to the PDF.
              textLength={pt(s.width) || undefined}
              lengthAdjust="spacingAndGlyphs"
            >
              {s.text}
            </text>
          ))}
        </g>
      );

    case "image": {
      const url = op.assetId ? assetUrl(op.assetId) : null;
      const clipId = `clip-${op.elementId}`;
      if (!url) {
        return (
          <g {...common}>
            <rect
              x={pt(op.frame.x)}
              y={pt(op.frame.y)}
              width={pt(op.frame.w)}
              height={pt(op.frame.h)}
              fill="#2b3138"
              stroke={op.missing ? "#e82627" : "#4e5762"}
              strokeWidth={0.75}
              strokeDasharray="3 2"
            />
            <text
              x={pt(op.frame.x + op.frame.w / 2)}
              y={pt(op.frame.y + op.frame.h / 2)}
              textAnchor="middle"
              fill={op.missing ? "#f37b79" : "#939eaa"}
              style={{ fontSize: "7px", fontFamily: "Inter" }}
            >
              {op.missing ? "Missing asset" : "Image"}
            </text>
          </g>
        );
      }
      return (
        <g {...common}>
          <defs>
            <clipPath id={clipId}>
              <rect
                x={pt(op.clip.x)}
                y={pt(op.clip.y)}
                width={pt(op.clip.w)}
                height={pt(op.clip.h)}
                rx={pt(op.cornerRadius)}
              />
            </clipPath>
          </defs>
          <image
            clipPath={`url(#${clipId})`}
            href={url}
            x={pt(op.dest.x)}
            y={pt(op.dest.y)}
            width={pt(op.dest.w)}
            height={pt(op.dest.h)}
            preserveAspectRatio="none"
          />
        </g>
      );
    }

    case "barcode": {
      if (!op.render) {
        return (
          <g {...common}>
            <rect
              x={pt(op.frame.x)}
              y={pt(op.frame.y)}
              width={pt(op.frame.w)}
              height={pt(op.frame.h)}
              fill="#2b1416"
              stroke="#e82627"
              strokeWidth={0.75}
            />
            <text
              x={pt(op.frame.x + op.frame.w / 2)}
              y={pt(op.frame.y + op.frame.h / 2)}
              textAnchor="middle"
              fill="#f37b79"
              style={{ fontSize: "6px", fontFamily: "Inter" }}
            >
              Barcode error
            </text>
          </g>
        );
      }
      const r = op.render;
      return (
        <g {...common}>
          {op.quietZoneFill.space !== "none" ? (
            <rect
              x={pt(op.origin.x)}
              y={pt(op.origin.y)}
              width={pt(r.width)}
              height={pt(r.height)}
              fill={previewCss(op.quietZoneFill)}
            />
          ) : null}
          {r.bars.map((b, i) => (
            <rect
              key={i}
              x={pt(op.origin.x + b.x)}
              y={pt(op.origin.y + b.y)}
              width={pt(b.w)}
              height={pt(b.h)}
              fill={previewCss(op.barColor)}
              shapeRendering="crispEdges"
            />
          ))}
          {r.text.map((t, i) => (
            <Fragment key={i}>
              <text
                x={pt(op.origin.x + t.x + (t.align === "center" ? t.width / 2 : 0))}
                y={pt(op.origin.y + t.baseline)}
                textAnchor={t.align === "center" ? "middle" : "start"}
                fill={previewCss(op.barColor)}
                style={{
                  fontFamily: `"${op.humanReadableFontFamily}"`,
                  fontWeight: op.humanReadableFontWeight,
                  fontSize: `${pt(t.fontSize)}px`,
                  letterSpacing: `${pt(t.fontSize) * 0.06}px`,
                }}
              >
                {t.text}
              </text>
            </Fragment>
          ))}
        </g>
      );
    }
  }
}
