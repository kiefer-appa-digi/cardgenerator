import { bindingPreflightCode, type BindingIssue } from "@/lib/data/binding";
import { FIELD_CATALOG } from "@/lib/data/context";
import type { DrawOp } from "@/lib/design/render";
import type { CheckCode, PreflightFinding, Severity } from "../types";
import {
  at,
  finding,
  inNum,
  inches,
  ptNum,
  type PreflightContext,
} from "./context";

/**
 * VARIABLE-DATA CHECKS — spec §10, §11, §21.
 *
 * A template is only worth having if it fails loudly on the SKU it does not fit.
 * These checks turn the binding issues the plan already recorded into findings a
 * person can act on: which element, which path, and whether the fix belongs in
 * the template or in the product record.
 */

/** Does this element put any resolved content on the page at all? */
function elementDrawsContent(ops: DrawOp[] | undefined): boolean {
  if (!ops || ops.length === 0) return false;
  return ops.some((op) => {
    switch (op.op) {
      case "text":
        return op.spans.some((s) => s.text.trim() !== "");
      case "image":
        return op.assetId !== null && !op.missing;
      case "barcode":
        return op.render !== null;
      default:
        return true;
    }
  });
}

/** Catalogue paths that look like what the template meant. */
function nearestPaths(path: string): string[] {
  const leaf = path.split(".").pop() ?? path;
  const needle = leaf.toLowerCase();
  if (needle.length < 3) return [];
  return FIELD_CATALOG.map((f) => f.path)
    .filter((p) => p.toLowerCase().includes(needle) || needle.includes(p.split(".").pop() ?? ""))
    .slice(0, 3);
}

/**
 * A missing product field and an unknown binding path are different failures
 * with different owners: one is fixed in the product record, the other in the
 * template. `bindingPreflightCode()` gives the base mapping; MISSING_VALUE is
 * then split out so the two never share a queue.
 */
function codeFor(issue: BindingIssue): CheckCode {
  const base = bindingPreflightCode(issue);
  if (base === "BINDING_UNRESOLVED" && issue.code === "MISSING_VALUE") return "PRODUCT_FIELD_MISSING";
  return base;
}

export function checkBindings(ctx: PreflightContext): PreflightFinding[] {
  const out: PreflightFinding[] = [];
  const seen = new Set<string>();

  for (const diag of ctx.plan.diagnostics) {
    const el = ctx.elements.get(diag.elementId);
    const required = el?.required ?? false;
    const draws = elementDrawsContent(ctx.opsByElement.get(diag.elementId));

    // A path that is not in the catalogue also resolves to nothing, so the
    // resolver records both an unknown path and a missing value. Only the first
    // is actionable — telling someone to populate a field that does not exist
    // sends them to the wrong screen — so the rest of that path is suppressed.
    const unknownPaths = new Set(
      diag.bindingIssues.filter((i) => i.code === "UNKNOWN_PATH").map((i) => i.path),
    );

    for (const issue of diag.bindingIssues) {
      // TRUNCATED maps to BOM_OVERFLOW through bindingPreflightCode(); the BOM
      // check reports it with the row count, so it is not duplicated here.
      if (issue.code === "TRUNCATED") continue;
      if (issue.code !== "UNKNOWN_PATH" && unknownPaths.has(issue.path)) continue;

      const code = codeFor(issue);
      const key = `${code}|${diag.elementId}|${issue.path}|${issue.code}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Nothing drawn means the card is missing content; something drawn means a
      // fallback or sibling copy filled the slot and a human should confirm it.
      //
      // Unless the element is not on the card at all. `hideWhenEmpty` and
      // `visibleWhen` are documented features (§10): an element configured to
      // disappear when its field is blank resolves EMPTY_VALUE *every time the
      // feature works*, and grading that as an error means a template cannot use
      // conditional visibility without failing its own preflight. The finding is
      // still worth recording — it says which SKU dropped which slot — but it is
      // information, not a defect. A required element that vanished is reported
      // by HIDDEN_REQUIRED instead, which owns that severity.
      const severity: Severity = !diag.visible
        ? "info"
        : required || !draws
          ? "error"
          : "warning";

      if (code === "BINDING_UNKNOWN_PATH") {
        const suggestions = nearestPaths(issue.path);
        out.push(
          finding({
            code,
            severity: "error",
            title: `Template points at an unknown field "${issue.path}"`,
            detail:
              `${issue.detail} Nothing will ever resolve there for any product, so this element prints ` +
              `${draws ? "only its literal copy" : "nothing"} on every SKU in the run.`,
            remedy: suggestions.length
              ? `Repoint the binding at one of: ${suggestions.join(", ")}. If the field was removed from the catalogue on purpose, delete the binding rather than leaving it dangling.`
              : `Repoint the binding at a field in the data browser, or delete it. The catalogue currently exposes ${FIELD_CATALOG.length} fields.`,
            ...at(ctx, diag.elementId, diag.frame),
            measurements: { path: issue.path, elementKind: diag.kind },
          }),
        );
        continue;
      }

      if (code === "PRODUCT_FIELD_MISSING") {
        out.push(
          finding({
            code,
            severity,
            title: `Product has no value for "${issue.path}"`,
            detail:
              `${issue.detail} ` +
              (!diag.visible
                ? `The element is not on the card for this product (${diag.hiddenReason}), which is what the template asked for when the field is blank — recorded so the run manifest shows which SKUs dropped this slot.`
                : draws
                  ? "Something else filled the slot — a fallback, a prefix or another run — so check that what prints is what was meant."
                  : "Nothing printed in its place, so the card goes out with that content absent.") +
              ` Product "${ctx.product.partNumber || ctx.product.id || "(unidentified)"}".`,
            remedy: !diag.visible
              ? `No action needed if this SKU is meant to ship without "${issue.path}". If it is not, populate the field on the product record or give the binding a fallback.`
              : `Populate "${issue.path}" on the product record, or give the binding a fallback so the template degrades predictably across the run.`,
            ...at(ctx, diag.elementId, diag.frame),
            measurements: {
              path: issue.path,
              drewContent: draws ? 1 : 0,
              hiddenReason: diag.visible ? "visible" : diag.hiddenReason,
            },
          }),
        );
        continue;
      }

      out.push(
        finding({
          code: "BINDING_UNRESOLVED",
          severity,
          title:
            issue.code === "NOT_TEXT" || issue.code === "NOT_A_LIST"
              ? `Binding "${issue.path}" is the wrong shape for this element`
              : issue.code === "BAD_FORMAT"
                ? `Format hint did not apply to "${issue.path}"`
                : `Variable "${issue.path || issue.code}" did not resolve`,
          detail:
            `${issue.detail} ` +
            (!diag.visible
              ? `The element is not on the card for this product (${diag.hiddenReason}), which is the configured behaviour for a blank field rather than a fault — recorded so the run manifest shows which SKUs dropped this slot.`
              : draws
                ? "The element still prints, so confirm the visible result rather than assuming it is complete."
                : "The element prints nothing as a result."),
          remedy:
            issue.code === "NOT_TEXT" || issue.code === "NOT_A_LIST"
              ? "Bind a pack-contents block to the collection and keep text runs on scalar fields."
              : issue.code === "BAD_FORMAT"
                ? "Correct the format hint on the binding, or clear it so the value prints as stored."
                : issue.code === "UNBALANCED_BRACE"
                  ? "Fix the stray brace in the copy: a literal { or } must be balanced or removed, or it will print as typed."
                  : !diag.visible
                    ? `No action needed if this SKU is meant to ship without this slot. If it is not, populate the field, add a fallback, or clear the hide-when-empty setting.`
                    : `Populate the field, add a fallback to the binding, or remove the variable if the copy no longer needs it.`,
          ...at(ctx, diag.elementId, diag.frame),
          measurements: {
            path: issue.path,
            issue: issue.code,
            drewContent: draws ? 1 : 0,
            hiddenReason: diag.visible ? "visible" : diag.hiddenReason,
          },
        }),
      );
    }
  }

  return out;
}

/* ------------------------------------------------------------ BOM blocks */

export function checkBom(ctx: PreflightContext): PreflightFinding[] {
  const out: PreflightFinding[] = [];

  for (const diag of ctx.plan.diagnostics) {
    if (diag.kind !== "bomList") continue;
    const el = ctx.elements.get(diag.elementId);
    const required = el?.required ?? false;
    const ops = ctx.opsByElement.get(diag.elementId) ?? [];
    const textOp = ops.find((op) => op.op === "text");

    if (diag.truncatedCount > 0) {
      const shown = ctx.product.bom.items.length - diag.truncatedCount;
      out.push(
        finding({
          code: "BOM_OVERFLOW",
          severity: "blocking",
          title: `${diag.truncatedCount} pack-contents row(s) were dropped`,
          detail:
            `The block's item limit kept ${shown} of ${ctx.product.bom.items.length} rows, so ` +
            `${diag.truncatedCount} line(s) of what is actually in the pack are not on the card. A ` +
            `pack-contents list that is missing items is a customer-facing inaccuracy, not a layout ` +
            `preference.`,
          remedy:
            `Raise or clear the block's maximum item count and make the frame tall enough for ` +
            `${ctx.product.bom.items.length} rows, or split the list across two columns. If the extra ` +
            `rows genuinely do not belong on the card, remove them from the product's BOM instead.`,
          ...at(ctx, diag.elementId, diag.frame),
          measurements: {
            droppedRows: diag.truncatedCount,
            shownRows: shown,
            totalRows: ctx.product.bom.items.length,
          },
        }),
      );
    }

    if (diag.overflow && textOp && textOp.op === "text") {
      out.push(
        finding({
          code: "BOM_OVERFLOW",
          severity: "blocking",
          title: "Pack-contents list does not fit its frame",
          detail:
            `The rendered list is ${inches(diag.overflowAmount)} taller than the ${inches(diag.frame.h)} ` +
            `frame` +
            (textOp.usedFontSize < textOp.requestedFontSize
              ? `, after auto-fit had already shrunk it from ${ptNum(textOp.requestedFontSize)} pt to ` +
                `${ptNum(textOp.usedFontSize)} pt`
              : ` and auto-fit did not reduce it`) +
            `. The rows past the bottom of the frame would be cut off.`,
          remedy:
            `Make the frame at least ${inches(diag.frame.h + diag.overflowAmount)} tall, use two columns, ` +
            `or lower the auto-fit minimum — then check the result is still legible at the size it lands on.`,
          ...at(ctx, diag.elementId, diag.frame),
          measurements: {
            overflowIn: inNum(diag.overflowAmount),
            frameHeightIn: inNum(diag.frame.h),
            usedPt: ptNum(textOp.usedFontSize),
          },
        }),
      );
    }

    if (diag.bomEmpty) {
      out.push(
        finding({
          code: "BOM_EMPTY",
          severity: required ? "error" : "warning",
          title: "Pack-contents block has no rows",
          detail:
            `"${diag.elementName}" is bound to ${el?.kind === "bomList" ? `"${el.sourcePath}"` : "a collection"} ` +
            `and this product resolved ${ctx.product.bom.items.length} row(s), so the block prints ` +
            `${el?.kind === "bomList" && el.emptyText ? `its placeholder copy "${el.emptyText}"` : "nothing but its heading"}.`,
          remedy:
            `Add the pack contents to the product's BOM, set placeholder copy on the block, or hide the ` +
            `block for products that have no BOM using a visibility rule.`,
          ...at(ctx, diag.elementId, diag.frame),
          measurements: { rows: ctx.product.bom.items.length },
        }),
      );
    }
  }

  return out;
}

export function dataChecks(ctx: PreflightContext): PreflightFinding[] {
  return [...checkBindings(ctx), ...checkBom(ctx)];
}
