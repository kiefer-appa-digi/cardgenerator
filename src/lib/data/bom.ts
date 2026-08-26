import type { ProductContext } from "./context";
import {
  PRODUCT_TOKEN_PREFIX,
  getPath,
  isBindablePath,
  resolveTokens,
  resolveTokensWith,
  type BindingIssue,
  type TokenLookup,
} from "./binding";
import type { BomListElement } from "@/lib/design/schema";

/**
 * PACK-CONTENTS RENDERING — spec §11.
 *
 * "This Pack Includes" is a repeating block, not a text box someone retyped per
 * SKU. Each row of the bound collection is run through the element's
 * `itemTemplate`, so the reference line in the spec,
 *
 *   "{quantity}) {name} ({partNumber})"  ->  "2) Inner Bearing (L44643)"
 *
 * is literally what this module produces.
 *
 * The spec's hard rule is that production copy is never silently clipped. This
 * module therefore reports rather than hides: a `maxItems` cut is counted, a
 * template token the row does not have prints nothing and is reported, and a
 * row that renders to nothing at all is reported instead of leaving a blank
 * line in the list. Fitting the result into the frame is the layout engine's
 * job; this module only decides what the words are.
 */

/** Row fields a BOM template may reference (see BomItemContext in data/context.ts). */
export const BOM_ROW_TOKENS = [
  "quantity",
  "quantityText",
  "name",
  "partNumber",
  "description",
  "position",
  "unitOfMeasure",
] as const;
export type BomRowToken = (typeof BOM_ROW_TOKENS)[number];

export function isBomRowToken(path: string): path is BomRowToken {
  return (BOM_ROW_TOKENS as readonly string[]).includes(path);
}

export type BomRender = {
  /** Resolved heading, or null when the block does not show one. */
  heading: string | null;
  /** Item lines, in source order, after maxItems. Never contains `emptyText`. */
  lines: string[];
  /** The lines the block actually draws, distributed down each column. */
  columns: string[][];
  /** Rows present in the bound collection before maxItems. */
  sourceCount: number;
  /** Rows dropped by maxItems. Non-zero is a BOM_OVERFLOW candidate. */
  truncatedCount: number;
  /** No item lines were produced. Preflight raises BOM_EMPTY. */
  empty: boolean;
  /** Resolved placeholder, drawn only when `empty`. "" when none is configured. */
  emptyText: string;
  issues: BindingIssue[];
};

/**
 * Resolve a row template token. `{product.x}` reaches past the row to the
 * product, which is how a row line can carry the parent part number. Anything
 * else is a row field: it is "known" if it is one of the documented BOM tokens
 * or if this particular collection happens to carry it, so pointing the block
 * at a non-BOM collection does not flood preflight with unknown-path noise.
 */
export function bomRowLookup(row: unknown, ctx: ProductContext): TokenLookup {
  return (path) => {
    if (path.startsWith(PRODUCT_TOKEN_PREFIX)) {
      const direct = path.slice(PRODUCT_TOKEN_PREFIX.length);
      const value = getPath(ctx, direct);
      const found = value !== undefined && value !== null;
      return { found, known: isBindablePath(direct, value), value };
    }
    const value = getPath(row, path);
    const found = value !== undefined && value !== null;
    return { found, known: isBomRowToken(path) || found, value };
  };
}

/**
 * Split lines into columns, reading down then across — the way a parts list is
 * read on a card. Columns are balanced with the remainder on the left, so a
 * five-line list in two columns sets 3 + 2 rather than 4 + 1.
 */
export function splitIntoColumns(lines: string[], columns: number): string[][] {
  const cols = Math.max(1, Math.floor(columns));
  const out: string[][] = [];
  const base = Math.floor(lines.length / cols);
  const remainder = lines.length % cols;
  let at = 0;
  for (let c = 0; c < cols; c++) {
    const take = base + (c < remainder ? 1 : 0);
    out.push(lines.slice(at, at + take));
    at += take;
  }
  return out;
}

export function renderBomBlock(el: BomListElement, ctx: ProductContext): BomRender {
  const issues: BindingIssue[] = [];

  const raw = getPath(ctx, el.sourcePath);
  let rows: unknown[] = [];
  if (raw === undefined || raw === null) {
    issues.push({
      code: "MISSING_VALUE",
      path: el.sourcePath,
      detail: `This product has no collection at "${el.sourcePath}".`,
    });
  } else if (!Array.isArray(raw)) {
    issues.push({
      code: "NOT_A_LIST",
      path: el.sourcePath,
      detail: `"${el.sourcePath}" is not a repeating collection, so no rows could be laid out.`,
    });
  } else {
    rows = raw;
  }

  const sourceCount = rows.length;
  const limit = el.maxItems === null ? sourceCount : Math.max(0, el.maxItems);
  const kept = rows.slice(0, limit);
  const truncatedCount = sourceCount - kept.length;
  if (truncatedCount > 0) {
    issues.push({
      code: "TRUNCATED",
      path: el.sourcePath,
      detail: `${truncatedCount} of ${sourceCount} pack-contents rows were dropped by the ${limit}-item limit and are not on the card.`,
    });
  }

  const lines: string[] = [];
  kept.forEach((row, index) => {
    const r = resolveTokensWith(el.itemTemplate, bomRowLookup(row, ctx), { joiner: ", " });
    for (const issue of r.issues) {
      issues.push({ ...issue, detail: `Row ${index + 1}: ${issue.detail}` });
    }
    // Only the ends are trimmed. Interior spacing is the designer's template,
    // and collapsing it would quietly rewrite approved copy.
    const text = r.text.trim();
    if (text === "") {
      issues.push({
        code: "EMPTY_VALUE",
        path: `${el.sourcePath}[${index}]`,
        detail: `Row ${index + 1} rendered no text and was left off the card.`,
      });
      return;
    }
    lines.push(text);
  });

  const empty = lines.length === 0;
  let emptyText = "";
  if (empty && el.emptyText !== "") {
    const r = resolveTokens(el.emptyText, ctx);
    issues.push(...r.issues);
    emptyText = r.text.trim();
  }

  let heading: string | null = null;
  if (el.showHeading) {
    const r = resolveTokens(el.heading, ctx);
    issues.push(...r.issues);
    heading = r.text;
  }

  const drawn = empty ? (emptyText === "" ? [] : [emptyText]) : lines;

  return {
    heading,
    lines,
    columns: splitIntoColumns(drawn, el.columns),
    sourceCount,
    truncatedCount,
    empty,
    emptyText,
    issues,
  };
}

/**
 * The lines the block draws, flat: the item lines, or the single placeholder
 * line when the product has no pack contents, or nothing at all.
 */
export function renderBomLines(el: BomListElement, ctx: ProductContext): string[] {
  const r = renderBomBlock(el, ctx);
  if (!r.empty) return r.lines;
  return r.emptyText === "" ? [] : [r.emptyText];
}
