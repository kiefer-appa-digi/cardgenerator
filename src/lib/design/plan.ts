import {
  CARD_PRESETS,
  bleedRect,
  cavityRect,
  safeCornerRadius,
  safeRect,
  trimRect,
  type CardPresetDef,
} from "@/lib/geometry/presets";
import {
  insetRect,
  roundedRectPath,
  type Rect,
} from "@/lib/geometry/types";
import { NONE, type PrintColor } from "@/lib/color/types";
import type { Upt } from "@/lib/units";
import {
  isElementVisible,
  resolveBinding,
  resolveBindingText,
  type BindingIssue,
} from "@/lib/data/binding";
import { renderBomBlock } from "@/lib/data/bom";
import type { ProductContext } from "@/lib/data/context";
import { layoutText, resolveRuns, verticalOffset } from "@/lib/text/layout";
import { renderBarcode } from "@/lib/barcode";
import type {
  BarcodeElement,
  BomListElement,
  CardSide,
  DesignDoc,
  DesignElement,
  ImageElement,
  ShapeElement,
  SideKey,
  TextElement,
} from "./schema";
import { defaultElementName } from "./schema";
import type {
  DrawOp,
  ElementDiagnostics,
  SidePlan,
  TextSpanOp,
} from "./render";

/**
 * Resolve one card side into a render plan. Pure: no DOM, no database, no I/O.
 * Give it the same inputs and it produces byte-identical output, which is what
 * makes the exported PDF deterministic (spec §15).
 */

export type AssetInfo = {
  id: string;
  /** Pixel dimensions, when the asset is raster. Null for vector sources. */
  pixelWidth: number | null;
  pixelHeight: number | null;
  colorSpace: string;
  contentType: string;
  /**
   * Whether the file carries an embedded ICC profile. A CMYK asset without one
   * is in the right colour space but records nothing about WHICH CMYK, which is
   * a different finding from an RGB asset that still needs converting.
   */
  hasIccProfile: boolean;
};

export type PlanInput = {
  doc: DesignDoc;
  side: SideKey;
  product: ProductContext;
  /** Resolve an asset id to its metadata. Missing ids become ASSET_MISSING. */
  assets: Map<string, AssetInfo>;
};

function emptyDiag(el: DesignElement, side: SideKey): ElementDiagnostics {
  return {
    elementId: el.id,
    elementName: defaultElementName(el),
    kind: el.kind,
    side,
    frame: el.frame,
    visible: true,
    hiddenReason: "visible",
    bindingIssues: [],
    overflow: false,
    overflowAmount: 0,
    fontsMissing: [],
    unmappedGlyphs: false,
    truncatedCount: 0,
    bomEmpty: false,
    effectiveDpi: null,
    assetMissing: false,
    barcodeError: null,
    barcodeNotes: [],
    quietBox: null,
    symbolBox: null,
    moduleWidth: null,
  };
}

export function planSide(input: PlanInput): SidePlan {
  const { doc, side, product, assets } = input;
  const preset: CardPresetDef = CARD_PRESETS[doc.presetCode];
  const cardSide: CardSide = doc[side];

  const canvas = bleedRect(preset);
  const trim = trimRect(preset);
  const safe = doc.safeAreaOverride
    ? insetRect(trim, doc.safeAreaOverride)
    : safeRect(preset);
  const cavity = cavityRect(preset);

  const ops: DrawOp[] = [];
  const diagnostics: ElementDiagnostics[] = [];
  const faces = new Set<string>();
  const assetIds = new Set<string>();

  // Group opacity multiplies into children; groups themselves draw nothing.
  const groupOpacity = new Map<string, number>();
  for (const el of cardSide.elements) {
    if (el.kind === "group") {
      for (const cid of el.childIds) {
        groupOpacity.set(cid, (groupOpacity.get(cid) ?? 10_000) * (el.opacity / 10_000));
      }
    }
  }
  const groupHidden = new Set<string>();
  for (const el of cardSide.elements) {
    if (el.kind === "group" && el.hidden) for (const cid of el.childIds) groupHidden.add(cid);
  }

  cardSide.elements.forEach((el, index) => {
    if (el.kind === "group") return;

    const diag = emptyDiag(el, side);

    const vis = isElementVisible(el, product);
    diag.bindingIssues.push(...vis.issues);
    if (!vis.visible || groupHidden.has(el.id)) {
      diag.visible = false;
      diag.hiddenReason = groupHidden.has(el.id) ? "hidden-flag" : vis.reason;
      diagnostics.push(diag);
      return;
    }

    const opacity = Math.round(el.opacity * ((groupOpacity.get(el.id) ?? 10_000) / 10_000));
    const base = {
      elementId: el.id,
      z: index,
      opacity,
      rotation: el.rotation,
      frame: el.frame,
    };

    switch (el.kind) {
      case "shape":
        ops.push(...planShape(el, base));
        break;
      case "text": {
        const built = planText(el, product, base);
        ops.push(built.op);
        Object.assign(diag, built.diag);
        for (const f of built.faces) faces.add(f);
        break;
      }
      case "bomList": {
        const built = planBom(el, product, base);
        ops.push(built.op);
        Object.assign(diag, built.diag);
        for (const f of built.faces) faces.add(f);
        break;
      }
      case "image": {
        const built = planImage(el, product, assets, base);
        ops.push(built.op);
        Object.assign(diag, built.diag);
        if (built.op.assetId) assetIds.add(built.op.assetId);
        break;
      }
      case "barcode": {
        const built = planBarcode(el, product, base);
        ops.push(built.op);
        Object.assign(diag, built.diag);
        for (const f of built.faces) faces.add(f);
        break;
      }
    }
    diagnostics.push(diag);
  });

  return {
    side,
    canvas,
    trim,
    safe,
    cavity,
    cornerRadius: preset.cornerRadius,
    safeCornerRadius: safeCornerRadius(preset, doc.safeAreaOverride),
    background: cardSide.background,
    ops,
    diagnostics,
    facesUsed: [...faces].sort(),
    assetsUsed: [...assetIds],
  };
}

type Base = {
  elementId: string;
  z: number;
  opacity: number;
  rotation: number;
  frame: Rect;
};

/* ------------------------------------------------------------------ shape */

function planShape(el: ShapeElement, base: Base): DrawOp[] {
  if (el.shape === "line") {
    return [
      {
        ...base,
        op: "line",
        // A line element's frame is its bounding box; the line runs corner to
        // corner of that box, which is how the editor's line tool draws it.
        x1: el.frame.x,
        y1: el.frame.y + Math.round(el.frame.h / 2),
        x2: el.frame.x + el.frame.w,
        y2: el.frame.y + Math.round(el.frame.h / 2),
        stroke: el.stroke.space === "none" ? el.fill : el.stroke,
        strokeWidth: el.strokeWidth || 1_000_000,
      },
    ];
  }
  if (el.shape === "ellipse") {
    return [
      {
        ...base,
        op: "ellipse",
        rect: el.frame,
        fill: el.fill,
        stroke: el.stroke,
        strokeWidth: el.strokeWidth,
      },
    ];
  }
  return [
    {
      ...base,
      op: "path",
      segs: roundedRectPath(el.frame, el.cornerRadius),
      fill: el.fill,
      stroke: el.stroke,
      strokeWidth: el.strokeWidth,
    },
  ];
}

/* ------------------------------------------------------------------- text */

function planText(el: TextElement, ctx: ProductContext, base: Base) {
  const issues: BindingIssue[] = [];
  const box = insetRect(el.frame, el.padding);

  const paras = resolveRuns(
    el.paragraphs,
    {
      fontFamily: el.fontFamily,
      fontWeight: el.fontWeight,
      italic: el.italic,
      fontSize: el.fontSize,
      tracking: el.tracking,
      color: el.color,
    },
    (run) => {
      if (!run.binding) return run.text;
      const r = resolveBinding(run.binding, ctx);
      issues.push(...r.issues);
      return r.text;
    },
  );

  const laid = layoutText(paras, {
    maxWidth: box.w,
    maxHeight: box.h,
    align: el.align,
    lineHeightBps: el.lineHeight,
    transform: el.transform,
    autoFit: el.autoFit,
  });

  const dy = verticalOffset(laid, box.h, el.verticalAlign);
  const spans: TextSpanOp[] = [];
  const faces = new Set<string>();
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const line of laid.lines) {
    for (const s of line.spans) {
      const x = box.x + s.x;
      const y = box.y + dy + line.baseline;
      spans.push({
        text: s.text,
        x,
        y,
        width: s.width,
        fontFamily: s.run.fontFamily,
        fontWeight: s.run.fontWeight,
        italic: s.run.italic,
        fontSize: s.run.fontSize,
        tracking: s.run.tracking,
        color: s.run.color,
        faceKey: s.faceKey,
        fontMissing: s.fontMissing,
      });
      if (!s.fontMissing) faces.add(s.faceKey);
      if (x < minX) minX = x;
      if (x + s.width > maxX) maxX = x + s.width;
      if (y - line.ascent < minY) minY = y - line.ascent;
      if (y + line.descent > maxY) maxY = y + line.descent;
    }
  }

  const inkBounds: Rect =
    spans.length === 0
      ? { x: box.x, y: box.y, w: 0, h: 0 }
      : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };

  const op: DrawOp = {
    ...base,
    op: "text",
    spans,
    fill: el.fill,
    inkBounds,
    overflow: laid.overflow,
    overflowAmount: laid.overflowAmount,
    usedFontSize: laid.usedFontSize,
    requestedFontSize: el.fontSize,
    fontsMissing: laid.fontsMissing,
    unmappedGlyphs: laid.unmappedGlyphs,
  };

  return {
    op,
    faces: [...faces],
    diag: {
      bindingIssues: issues,
      overflow: laid.overflow,
      overflowAmount: laid.overflowAmount,
      fontsMissing: laid.fontsMissing,
      unmappedGlyphs: laid.unmappedGlyphs,
    } satisfies Partial<ElementDiagnostics>,
  };
}

/* ---------------------------------------------------------------- BOM list */

function planBom(el: BomListElement, ctx: ProductContext, base: Base) {
  const bom = renderBomBlock(el, ctx);
  const box = el.frame;
  const faces = new Set<string>();
  const spans: TextSpanOp[] = [];

  // Heading and the item columns are laid out as separate blocks so a long
  // heading cannot push the list out of the frame unnoticed.
  let cursorY = box.y;
  let overflow = false;
  let overflowAmount = 0;
  let usedFontSize = el.fontSize;
  const fontsMissing = new Set<string>();
  let unmapped = false;

  if (bom.heading) {
    const laid = layoutText(
      [
        {
          runs: [
            {
              text: bom.heading,
              fontFamily: el.fontFamily,
              fontWeight: el.headingFontWeight,
              italic: false,
              fontSize: el.headingFontSize,
              tracking: el.tracking,
              color: el.color,
            },
          ],
          spaceBefore: 0,
          spaceAfter: 0,
        },
      ],
      {
        maxWidth: box.w,
        maxHeight: box.h,
        align: el.align,
        lineHeightBps: el.lineHeight,
        transform: "none",
      },
    );
    for (const line of laid.lines) {
      for (const s of line.spans) {
        spans.push({
          text: s.text,
          x: box.x + s.x,
          y: cursorY + line.baseline,
          width: s.width,
          fontFamily: s.run.fontFamily,
          fontWeight: s.run.fontWeight,
          italic: s.run.italic,
          fontSize: s.run.fontSize,
          tracking: s.run.tracking,
          color: s.run.color,
          faceKey: s.faceKey,
          fontMissing: s.fontMissing,
        });
        if (!s.fontMissing) faces.add(s.faceKey);
      }
    }
    for (const f of laid.fontsMissing) fontsMissing.add(f);
    unmapped ||= laid.unmappedGlyphs;
    cursorY += laid.height;
  }

  const listTop = cursorY;
  const listHeight = Math.max(0, box.y + box.h - listTop);
  const colCount = Math.max(1, el.columns);
  const colWidth = Math.round((box.w - el.columnGap * (colCount - 1)) / colCount);

  const columnLines = bom.empty && bom.emptyText ? [[bom.emptyText]] : bom.columns;

  columnLines.forEach((lines, ci) => {
    if (lines.length === 0) return;
    const laid = layoutText(
      lines.map((text) => ({
        runs: [
          {
            text,
            fontFamily: el.fontFamily,
            fontWeight: el.fontWeight,
            italic: false,
            fontSize: el.fontSize,
            tracking: el.tracking,
            color: el.color,
          },
        ],
        spaceBefore: 0,
        spaceAfter: el.itemSpacing,
      })),
      {
        maxWidth: colWidth,
        maxHeight: listHeight,
        align: el.align,
        lineHeightBps: el.lineHeight,
        transform: "none",
        autoFit: el.autoFit,
      },
    );
    const colX = box.x + ci * (colWidth + el.columnGap);
    for (const line of laid.lines) {
      for (const s of line.spans) {
        spans.push({
          text: s.text,
          x: colX + s.x,
          y: listTop + line.baseline,
          width: s.width,
          fontFamily: s.run.fontFamily,
          fontWeight: s.run.fontWeight,
          italic: s.run.italic,
          fontSize: s.run.fontSize,
          tracking: s.run.tracking,
          color: s.run.color,
          faceKey: s.faceKey,
          fontMissing: s.fontMissing,
        });
        if (!s.fontMissing) faces.add(s.faceKey);
      }
    }
    for (const f of laid.fontsMissing) fontsMissing.add(f);
    unmapped ||= laid.unmappedGlyphs;
    if (laid.overflow) {
      overflow = true;
      overflowAmount = Math.max(overflowAmount, laid.overflowAmount);
    }
    // The smallest size any column had to fall back to is the one that matters.
    if (laid.usedFontSize && laid.usedFontSize < usedFontSize) usedFontSize = laid.usedFontSize;
  });

  const inkBounds: Rect =
    spans.length === 0
      ? { x: box.x, y: box.y, w: 0, h: 0 }
      : spans.reduce<Rect>(
          (acc, s) => {
            const x0 = Math.min(acc.x, s.x);
            const y0 = Math.min(acc.y, s.y - s.fontSize);
            const x1 = Math.max(acc.x + acc.w, s.x);
            const y1 = Math.max(acc.y + acc.h, s.y);
            return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
          },
          { x: spans[0].x, y: spans[0].y - spans[0].fontSize, w: 0, h: 0 },
        );

  const op: DrawOp = {
    ...base,
    op: "text",
    spans,
    fill: NONE as PrintColor,
    inkBounds,
    overflow,
    overflowAmount,
    usedFontSize,
    requestedFontSize: el.fontSize,
    fontsMissing: [...fontsMissing],
    unmappedGlyphs: unmapped,
  };

  return {
    op,
    faces: [...faces],
    diag: {
      bindingIssues: bom.issues,
      overflow,
      overflowAmount,
      fontsMissing: [...fontsMissing],
      unmappedGlyphs: unmapped,
      truncatedCount: bom.truncatedCount,
      bomEmpty: bom.empty,
    } satisfies Partial<ElementDiagnostics>,
  };
}

/* ------------------------------------------------------------------ image */

function planImage(
  el: ImageElement,
  ctx: ProductContext,
  assets: Map<string, AssetInfo>,
  base: Base,
) {
  let assetId = el.assetId;
  const issues: BindingIssue[] = [];
  if (el.binding) {
    const bound = resolveBindingText(el.binding, ctx);
    if (bound) assetId = bound;
  }
  const info = assetId ? assets.get(assetId) : undefined;
  const missing = Boolean(assetId) && !info;

  const frame = el.frame;
  const scale = el.scale / 10_000;
  let dest: Rect = frame;

  if (info?.pixelWidth && info?.pixelHeight) {
    // Crop first: the visible portion of the source drives the aspect ratio.
    const srcW = (info.pixelWidth * el.crop.w) / 10_000;
    const srcH = (info.pixelHeight * el.crop.h) / 10_000;
    const srcAspect = srcW / srcH;
    const frameAspect = frame.w / frame.h;

    if (el.fit === "stretch") {
      dest = frame;
    } else {
      const cover = el.fit === "fill" || el.fit === "crop";
      const useWidth = cover ? srcAspect < frameAspect : srcAspect > frameAspect;
      const w = useWidth ? frame.w : Math.round(frame.h * srcAspect);
      const h = useWidth ? Math.round(frame.w / srcAspect) : frame.h;
      const sw = Math.round(w * scale);
      const sh = Math.round(h * scale);
      dest = {
        x: frame.x + Math.round(((frame.w - sw) * el.focalX) / 10_000),
        y: frame.y + Math.round(((frame.h - sh) * el.focalY) / 10_000),
        w: sw,
        h: sh,
      };
    }
  }

  // Effective resolution at the placed size: the honest number a press cares
  // about, not the file's declared DPI.
  let effectiveDpi: number | null = null;
  if (info?.pixelWidth && dest.w > 0) {
    const placedInches = dest.w / 72_000_000;
    const usedPixels = (info.pixelWidth * el.crop.w) / 10_000;
    effectiveDpi = Math.round(usedPixels / placedInches);
  }

  const op: DrawOp = {
    ...base,
    op: "image",
    assetId: assetId ?? null,
    dest,
    clip: frame,
    cornerRadius: el.cornerRadius,
    crop: el.crop,
    effectiveDpi,
    isBackground: el.isBackground,
    missing,
  };

  return {
    op,
    diag: {
      bindingIssues: issues,
      effectiveDpi,
      assetMissing: missing,
    } satisfies Partial<ElementDiagnostics>,
  };
}

/* ---------------------------------------------------------------- barcode */

function planBarcode(el: BarcodeElement, ctx: ProductContext, base: Base) {
  const issues: BindingIssue[] = [];
  let value = el.value;
  if (el.binding) {
    const r = resolveBinding(el.binding, ctx);
    issues.push(...r.issues);
    value = r.text;
  }

  const result = renderBarcode({
    symbology: el.symbology,
    value,
    magnificationBps: el.magnification,
    barHeight: el.barHeight,
    showHumanReadable: el.showHumanReadable,
    humanReadableFontSize: el.humanReadableFontSize,
    showLightMarginIndicator: el.showLightMarginIndicator,
    digitalLinkDomain: el.digitalLinkDomain,
  });

  const origin = { x: el.frame.x, y: el.frame.y };
  const render = result.ok ? result.render : null;

  const quietBox: Rect = render
    ? { x: origin.x, y: origin.y, w: render.width, h: render.height }
    : el.frame;
  const symbolBox: Rect = render
    ? {
        x: origin.x + render.quietLeft,
        y: origin.y + render.quietTop,
        w: render.width - render.quietLeft - render.quietRight,
        h: render.height - render.quietTop - render.quietBottom,
      }
    : el.frame;

  const op: DrawOp = {
    ...base,
    op: "barcode",
    origin,
    render,
    error: result.ok ? null : `${result.error.code}: ${result.error.message}`,
    barColor: el.barColor,
    quietZoneFill: el.quietZoneFill,
    quietBox,
    symbolBox,
    humanReadableFontFamily: "Inter",
    humanReadableFontWeight: 500,
  };

  return {
    op,
    faces: el.showHumanReadable ? ["Inter:500"] : [],
    diag: {
      bindingIssues: issues,
      barcodeError: result.ok ? null : `${result.error.code}: ${result.error.message}`,
      barcodeNotes: render?.notes ?? [],
      quietBox,
      symbolBox,
      moduleWidth: render?.moduleWidth ?? null,
    } satisfies Partial<ElementDiagnostics>,
  };
}

export function planDocument(input: {
  doc: DesignDoc;
  product: ProductContext;
  assets: Map<string, AssetInfo>;
}): Record<SideKey, SidePlan> {
  return {
    front: planSide({ ...input, side: "front" }),
    back: planSide({ ...input, side: "back" }),
  };
}

export type { Upt };
