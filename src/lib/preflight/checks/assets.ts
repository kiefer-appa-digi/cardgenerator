import { uptToIn } from "@/lib/units";
import { rectContains } from "@/lib/geometry/types";
import type { ImageOp } from "@/lib/design/render";
import type { AssetInfo } from "@/lib/design/plan";
import type { PreflightFinding, Severity } from "../types";
import {
  at,
  finding,
  inNum,
  inches,
  opPaintBounds,
  type PreflightContext,
} from "./context";

/**
 * Colour-space names, as the metadata layer reports them.
 *
 * sharp reports a single-channel image as "b-w"; other decoders say "gray",
 * "grey", "grayscale" or "DeviceGray". Missing any of those spellings makes the
 * grayscale checks fire on an asset that is already grayscale, which is exactly
 * the kind of false alarm that gets a preflight panel ignored.
 */
export const GRAYSCALE_SPACES = /^(b-w|b_w|bw|gray|grey|grayscale|greyscale|gray-?alpha|grey-?alpha|devicegray|calgray|k)$/i;

export function isGrayscaleSpace(space: string): boolean {
  return GRAYSCALE_SPACES.test(space.trim());
}

/** Colour spaces that carry chroma and so need converting for a CMYK press. */
export function isRgbSpace(space: string): boolean {
  return /^(srgb|rgb|rgb16|rgba|adobe-?rgb|display-?p3|p3|scrgb|lab|cmc)$/i.test(space.trim());
}


/**
 * PLACED-ASSET CHECKS — spec §8, §14, §21.
 *
 * Resolution is judged on the effective DPI the plan already computed at the
 * placed size, never on whatever DPI a file claims in its header. A 300 dpi
 * logo scaled to 250 % is a 120 dpi logo, and that is the number a press cares
 * about.
 */

/** Raster formats the PDF writer can embed without re-encoding. */
const EMBEDDABLE = new Set(["image/png", "image/jpeg", "image/jpg"]);

const RGB_SPACES = /rgb|p3|lab|hsv|indexed|ycbcr/i;
const PRINT_SPACES = /cmyk|gray|grey|separation|devicen/i;

function isBleedArt(ctx: PreflightContext, op: ImageOp): boolean {
  return op.isBackground || !rectContains(ctx.plan.trim, opPaintBounds(op));
}
function dpiSeverity(ctx: PreflightContext, dpi: number): Severity | null {
  if (dpi < ctx.profile.criticalImageDpi) return "error";
  if (dpi < ctx.profile.minImageDpi) return "warning";
  return null;
}

export function assetChecks(ctx: PreflightContext): PreflightFinding[] {
  const out: PreflightFinding[] = [];

  for (const op of ctx.plan.ops) {
    if (op.op !== "image") continue;
    const el = ctx.elements.get(op.elementId);
    const required = el?.required ?? false;
    const bounds = opPaintBounds(op);

    /* ---------------------------------------------------------- missing */

    if (op.assetId === null) {
      out.push(
        finding({
          code: "ASSET_MISSING",
          severity: required ? "error" : "warning",
          title: "Image element has no asset assigned",
          detail:
            `The ${inches(op.frame.w)} × ${inches(op.frame.h)} frame at (${inches(op.frame.x)}, ` +
            `${inches(op.frame.y)}) is an empty placeholder: no asset id is set and no binding ` +
            `resolved one for this product, so nothing images there.`,
          remedy:
            "Assign an image to the element, bind it to a product field that holds an asset id, or delete the empty frame so it does not travel with the template.",
          ...at(ctx, op.elementId, bounds),
          measurements: { frameWidthIn: inNum(op.frame.w), frameHeightIn: inNum(op.frame.h) },
        }),
      );
      continue;
    }

    if (op.missing) {
      out.push(
        finding({
          code: "ASSET_MISSING",
          severity: "error",
          title: "Linked asset is not available",
          detail:
            `Asset "${op.assetId}" is referenced by this element but is not in the asset set supplied ` +
            `to preflight, so the ${inches(op.dest.w)} × ${inches(op.dest.h)} placement has no pixels ` +
            `behind it and would export as a hole in the artwork.`,
          remedy:
            `Re-upload the asset or repoint the element at one that exists. If the image comes from a ` +
            `product binding, check that the product record still carries that asset id.`,
          ...at(ctx, op.elementId, bounds),
          measurements: { assetId: op.assetId },
        }),
      );
      continue;
    }

    const info: AssetInfo | undefined = ctx.assets.get(op.assetId);
    if (!info) continue;

    /* ------------------------------------------------------- file format */

    if (!EMBEDDABLE.has(info.contentType.toLowerCase())) {
      out.push(
        finding({
          code: "ASSET_UNSUPPORTED",
          severity: "error",
          title: `"${info.contentType}" cannot be embedded in the production PDF`,
          detail:
            `Asset "${op.assetId}" is ${info.contentType}. The PDF writer embeds PNG and JPEG only; ` +
            `anything else would have to be rasterised or dropped, and rasterising production artwork ` +
            `is not something this pipeline does silently.`,
          remedy:
            "Convert the file to PNG (flat art, transparency) or JPEG (photography) at final placed size and at least " +
            `${ctx.profile.minImageDpi} dpi, then replace the asset.`,
          ...at(ctx, op.elementId, bounds),
          measurements: { contentType: info.contentType, assetId: op.assetId },
        }),
      );
    }

    /* ------------------------------------------------------ colour space */

    const space = info.colorSpace.trim();
    if (RGB_SPACES.test(space)) {
      out.push(
        finding({
          code: "ASSET_RGB_IN_CMYK",
          severity: "warning",
          title: `Placed image is ${space} in a CMYK job`,
          detail:
            `Asset "${op.assetId}" carries a ${space} colour space. It will be converted to CMYK for ` +
            `output using a naive numeric model, not an ICC transform, so the printed ink recipe is an ` +
            `estimate rather than a specified one — saturated brand colours in particular will not match.`,
          remedy:
            "Convert the image to CMYK in a colour-managed application, using the press's output profile, and re-upload it. Where the colour is brand-critical, have the ink values specified rather than converted.",
          ...at(ctx, op.elementId, bounds),
          measurements: { colorSpace: space, assetId: op.assetId },
        }),
      );
    } else if (space === "" || !PRINT_SPACES.test(space)) {
      out.push(
        finding({
          code: "ASSET_RGB_IN_CMYK",
          severity: "info",
          title: "Placed image declares no colour space",
          detail:
            `Asset "${op.assetId}" records its colour space as "${space || "unknown"}", so preflight ` +
            `cannot tell whether it is already CMYK. It will be treated as RGB at export and converted ` +
            `numerically.`,
          remedy:
            "Re-upload the asset from a colour-managed application so the colour space is recorded, or confirm with the press that a numeric conversion is acceptable for this image.",
          ...at(ctx, op.elementId, bounds),
          measurements: { colorSpace: space || "unknown", assetId: op.assetId },
        }),
      );
    }

    /* -------------------------------------------------------- resolution */

    if (op.effectiveDpi === null) {
      if (EMBEDDABLE.has(info.contentType.toLowerCase())) {
        out.push(
          finding({
            code: "ASSET_LOW_DPI",
            severity: "info",
            title: "Image resolution could not be measured",
            detail:
              `Asset "${op.assetId}" has no recorded pixel dimensions, so the effective resolution at ` +
              `the placed size of ${inches(op.dest.w)} × ${inches(op.dest.h)} is unknown. Preflight is ` +
              `not going to assume it is adequate.`,
            remedy:
              `Re-inspect the asset so its pixel dimensions are recorded, then re-run preflight. At this ` +
              `placed size the file needs at least ${Math.ceil(uptToIn(op.dest.w) * ctx.profile.minImageDpi)} px across.`,
            ...at(ctx, op.elementId, bounds),
            measurements: { placedWidthIn: inNum(op.dest.w), assetId: op.assetId },
          }),
        );
      }
      continue;
    }

    const dpi = op.effectiveDpi;
    const severity = dpiSeverity(ctx, dpi);
    const bleedArt = isBleedArt(ctx, op);
    const neededPx = Math.ceil(uptToIn(op.dest.w) * ctx.profile.minImageDpi);
    const usedPx = info.pixelWidth === null ? null : Math.round((info.pixelWidth * op.crop.w) / 10_000);

    if (severity) {
      out.push(
        finding({
          code: bleedArt ? "BLEED_LOW_DPI" : "ASSET_LOW_DPI",
          severity,
          title: bleedArt
            ? `Bleed artwork is ${dpi} dpi at its placed size`
            : `Image is ${dpi} dpi at its placed size`,
          detail:
            `${usedPx === null ? "The image" : `${usedPx} px`} of source spans ${inches(op.dest.w)} on the ` +
            `page, giving ${dpi} dpi — below the profile minimum of ${ctx.profile.minImageDpi} dpi` +
            (severity === "error" ? ` and below the ${ctx.profile.criticalImageDpi} dpi floor` : "") +
            `. ` +
            (bleedArt
              ? "This is the art that runs to the trimmed edge, so the softness lands on the most visible part of the card."
              : "At this resolution the halftone will show visible pixel structure at reading distance."),
          remedy:
            `Supply the image at ${neededPx} px or wider for this placement (${ctx.profile.minImageDpi} dpi ` +
            `at ${inches(op.dest.w)})` +
            // A background's placed size is fixed by the card, so shrinking it is
            // not an option the way it is for a logo.
            (bleedArt || usedPx === null
              ? "."
              : `, or reduce the placed width to ${(usedPx / ctx.profile.minImageDpi).toFixed(2)} in and re-fit the frame.`),
          ...at(ctx, op.elementId, bounds),
          measurements: {
            effectiveDpi: dpi,
            minimumDpi: ctx.profile.minImageDpi,
            criticalDpi: ctx.profile.criticalImageDpi,
            placedWidthIn: inNum(op.dest.w),
            requiredPixels: neededPx,
            sourcePixels: usedPx ?? "unknown",
          },
        }),
      );
    }

    /* --------------------------------------------------------- upscaling */

    // The asset carries no declared resolution, so "native size" is taken at the
    // profile's target: the size at which one source pixel becomes one printed
    // dot. Placed wider than that, the RIP has to invent the difference. The
    // reference is stated in the finding rather than left implied.
    if (usedPx !== null && dpi < ctx.profile.minImageDpi) {
      const nativeIn = usedPx / ctx.profile.minImageDpi;
      const placedIn = uptToIn(op.dest.w);
      const upscalePct = Math.round((placedIn / Math.max(1e-9, nativeIn)) * 100);
      out.push(
        finding({
          code: "IMAGE_UPSCALED",
          severity: "warning",
          title: `Image is enlarged to ${upscalePct} % of its native size`,
          detail:
            `${usedPx} px of source is ${nativeIn.toFixed(3)} in wide at the profile's ` +
            `${ctx.profile.minImageDpi} dpi target — the asset declares no resolution of its own, so that ` +
            `is the reference — and it is placed ${placedIn.toFixed(3)} in wide. ` +
            `${Math.max(0, upscalePct - 100)} % of the printed pixels are interpolated. This placement is ` +
            `not print-ready, whatever the on-screen preview looks like.`,
          remedy:
            `Replace the asset with one at least ${neededPx} px wide, or place it no wider than ` +
            `${nativeIn.toFixed(3)} in. Interpolating in an image editor first does not add detail and ` +
            `will not clear this finding.`,
          ...at(ctx, op.elementId, bounds),
          measurements: {
            upscalePct,
            nativeWidthIn: Number(nativeIn.toFixed(4)),
            placedWidthIn: inNum(op.dest.w),
            sourcePixels: usedPx,
            referenceDpi: ctx.profile.minImageDpi,
          },
        }),
      );
    }
  }

  return out;
}
