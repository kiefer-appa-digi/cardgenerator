import type { TextOp } from "@/lib/design/render";
import type { PreflightFinding } from "../types";
import {
  at,
  finding,
  inNum,
  inches,
  opPaintBounds,
  ptNum,
  rotatedTo,
  textInkRect,
  type PreflightContext,
} from "./context";

/**
 * TEXT AND REQUIRED-CONTENT CHECKS — spec §9, §21.
 *
 * The rule the spec is unambiguous about: production copy is never silently
 * clipped. Overflow is therefore blocking, not a warning — a run cannot go to
 * press with a sentence that stops halfway through, and no amount of "the
 * preview looked fine" changes that.
 */

function textOps(ctx: PreflightContext): TextOp[] {
  return ctx.plan.ops.filter((op): op is TextOp => op.op === "text");
}

/* --------------------------------------------------------- missing fonts */

export function checkFontMissing(ctx: PreflightContext): PreflightFinding[] {
  const out: PreflightFinding[] = [];
  for (const op of textOps(ctx)) {
    const el = ctx.elements.get(op.elementId);
    // BOM blocks and text blocks both report here; the layout engine records the
    // requested family name, not the substituted one.
    if (op.fontsMissing.length > 0) {
      const substituted = [...new Set(op.spans.filter((s) => s.fontMissing).map((s) => s.faceKey))];
      out.push(
        finding({
          code: "FONT_MISSING",
          severity: "error",
          title: `Font ${op.fontsMissing.map((f) => `"${f}"`).join(", ")} is not installed`,
          detail:
            `This block asks for ${op.fontsMissing.map((f) => `"${f}"`).join(", ")}, which is not one of ` +
            `the licensed faces this application can embed. It was laid out with ` +
            `${substituted.join(", ") || "Inter:400"} instead, so the line breaks, the widths and the ` +
            `printed shapes are all a substitute for what was designed.`,
          remedy:
            "Set the block to one of the shipped families (Inter, Archivo, Barlow Condensed) or have the required face licensed and added to src/assets/fonts. Do not export until the face on screen is the face that will be embedded.",
          ...at(ctx, op.elementId, rotatedTo(textInkRect(op), op)),
          measurements: {
            requested: op.fontsMissing.join(", "),
            substituted: substituted.join(", ") || "Inter:400",
            elementKind: el?.kind ?? "text",
          },
        }),
      );
    }
    if (op.unmappedGlyphs) {
      out.push(
        finding({
          code: "FONT_MISSING",
          severity: "warning",
          title: "Characters are missing from the chosen face",
          detail:
            `At least one character in this block is outside the metrics of the face it is set in, so it ` +
            `was measured with the fallback advance and may image as a blank or a substituted glyph. ` +
            `Accented, currency and typographic characters pasted from a spreadsheet are the usual cause.`,
          remedy:
            "Find the offending characters (usually smart quotes, dashes or accents) and either replace them with supported equivalents or set that run in a face that carries them.",
          ...at(ctx, op.elementId, rotatedTo(textInkRect(op), op)),
          measurements: { spans: op.spans.length },
        }),
      );
    }
  }
  return out;
}

/* -------------------------------------------------------------- overflow */

export function checkTextOverflow(ctx: PreflightContext): PreflightFinding[] {
  const out: PreflightFinding[] = [];
  for (const op of textOps(ctx)) {
    const el = ctx.elements.get(op.elementId);
    if (el && el.kind !== "text") continue; // BOM overflow is reported by the data checks.
    if (!op.overflow) continue;

    const shrank = op.usedFontSize > 0 && op.usedFontSize < op.requestedFontSize;
    out.push(
      finding({
        code: "TEXT_OVERFLOW",
        severity: "blocking",
        title: "Copy does not fit its frame",
        detail:
          `The laid text is ${inches(op.overflowAmount)} taller than the ${inches(op.frame.h)} frame at ` +
          `(${inches(op.frame.x)}, ${inches(op.frame.y)}). ` +
          (shrank
            ? `Auto-fit already reduced the type from ${ptNum(op.requestedFontSize)} pt to ` +
              `${ptNum(op.usedFontSize)} pt and it still does not fit, so it stopped at the configured ` +
              `minimum rather than shrinking further.`
            : `Auto-fit is off, so the surplus lines are simply outside the frame.`) +
          ` Copy is never clipped silently, which is why this blocks the export instead of trimming the text.`,
        remedy:
          `Make the frame at least ${inches(op.frame.h + op.overflowAmount)} tall, cut ` +
          `${inches(op.overflowAmount)} worth of copy, or lower the auto-fit minimum size — and then ` +
          `read the result, because a smaller minimum can take legal copy below its legible size.`,
        ...at(ctx, op.elementId, opPaintBounds(op)),
        measurements: {
          overflowIn: inNum(op.overflowAmount),
          frameHeightIn: inNum(op.frame.h),
          requestedPt: ptNum(op.requestedFontSize),
          usedPt: ptNum(op.usedFontSize),
        },
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------- required content */

/**
 * `required` is a promise the template makes: this content will be on every card
 * in the run. An element that resolves to nothing, or that a rule hides, breaks
 * that promise, so both are blocking and both name the reason.
 */
export function checkRequiredContent(ctx: PreflightContext): PreflightFinding[] {
  const out: PreflightFinding[] = [];

  for (const op of textOps(ctx)) {
    const el = ctx.elements.get(op.elementId);
    if (!el?.required) continue;
    const printed = op.spans.map((s) => s.text).join("").trim();
    if (printed !== "") continue;
    out.push(
      finding({
        code: "TEXT_EMPTY_REQUIRED",
        severity: "blocking",
        title: "Required text block is empty",
        detail:
          `"${ctx.labels.get(op.elementId) ?? op.elementId}" is marked required but resolved to no ` +
          `characters for this product, leaving an empty ${inches(op.frame.w)} × ${inches(op.frame.h)} ` +
          `frame at (${inches(op.frame.x)}, ${inches(op.frame.y)}).`,
        remedy:
          "Fill in the product field the block is bound to, give the binding a fallback, or clear the required flag if the block really is optional for this product.",
        ...at(ctx, op.elementId, op.frame),
        measurements: { spans: op.spans.length },
      }),
    );
  }

  for (const diag of ctx.plan.diagnostics) {
    if (diag.visible) continue;
    const el = ctx.elements.get(diag.elementId);
    if (!el?.required) continue;

    const byRule = diag.hiddenReason === "visible-when";
    const byData = diag.hiddenReason === "empty-binding";
    out.push(
      finding({
        code: "HIDDEN_REQUIRED",
        severity: diag.hiddenReason === "hidden-flag" ? "blocking" : "error",
        title:
          diag.hiddenReason === "hidden-flag"
            ? "Required element is switched off"
            : byRule
              ? "Required element is hidden by its visibility rule"
              : "Required element is hidden because its data is empty",
        detail:
          `"${diag.elementName}" is marked required but does not render for this product ` +
          `(reason: ${diag.hiddenReason}). ` +
          (byRule
            ? `The rule "${el.visibleWhen ?? ""}" evaluated false, so the element was dropped from the plan by design rather than by mistake — but the card still goes out without it.`
            : byData
              ? "Its binding resolved empty and the element is set to hide when empty, so the card would print without required content."
              : "Someone hid it in the layers panel; nothing about the product data caused this.") +
          ` Its frame is ${inches(diag.frame.w)} × ${inches(diag.frame.h)} at (${inches(diag.frame.x)}, ${inches(diag.frame.y)}).`,
        remedy:
          diag.hiddenReason === "hidden-flag"
            ? "Unhide the element, or clear its required flag if it is genuinely optional."
            : byRule
              ? `Populate the field the rule tests, change the rule, or clear the required flag. Do not export a run in which a required element is absent on some SKUs without deciding that is acceptable.`
              : "Populate the bound product field, give the binding a fallback, or clear the required flag.",
        ...at(ctx, diag.elementId, diag.frame),
        measurements: { hiddenReason: diag.hiddenReason, kind: diag.kind },
      }),
    );
  }

  return out;
}

export function textChecks(ctx: PreflightContext): PreflightFinding[] {
  return [
    ...checkFontMissing(ctx),
    ...checkTextOverflow(ctx),
    ...checkRequiredContent(ctx),
  ];
}
