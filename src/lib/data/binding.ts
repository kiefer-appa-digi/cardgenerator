import { isKnownPath, type ProductContext } from "./context";
import { applyFormat, applyTextTransform, stringifyScalar, type FormatIssue } from "./format";
import type { Binding, DesignElement, TextElement, TextRun } from "@/lib/design/schema";
import type { CheckCode } from "@/lib/preflight/types";

/**
 * DATA BINDING — spec §10.
 *
 * One template must set hundreds of SKUs, so every string on a card is either
 * literal copy or a resolution against the selected ProductContext. This module
 * is the only place that turns a binding into characters, and it is used by the
 * editor preview, the preflight engine and the PDF writer alike, so all three
 * agree on what a card says.
 *
 * Two shapes of binding exist and both live here:
 *
 *  - A structured `Binding` (path + fallback + prefix/suffix + transform +
 *    format + joiner), attached to a text run, an image or a barcode.
 *  - A `{token}` template, which is how a designer types a variable inline in a
 *    line of copy: "P/N {partNumber}".
 *
 * Everything returns a rich result rather than a bare string. A caller has to
 * be able to tell "this product has no warnings" from "this template points at
 * a field that does not exist", because the first is normal and the second is a
 * blocking preflight finding. A literal "{partNumber}" must never reach a
 * plate, so an unresolved token renders as nothing and is reported instead.
 */

/* ------------------------------------------------------------------ issues */

export const BINDING_ISSUE_CODES = [
  /** The path is not in FIELD_CATALOG: a typo, or a field that was removed. */
  "UNKNOWN_PATH",
  /** The path is not present on this product at all. */
  "MISSING_VALUE",
  /** The path exists and holds nothing. */
  "EMPTY_VALUE",
  /** The value is an object or a collection and cannot be printed as one line. */
  "NOT_TEXT",
  /** A repeating block points at something that is not a list. */
  "NOT_A_LIST",
  /** The format hint did not apply; the value printed unformatted. */
  "BAD_FORMAT",
  /** A {token} produced nothing. */
  "UNRESOLVED_TOKEN",
  /** A stray { or } in a template. */
  "UNBALANCED_BRACE",
  /** A repeating block dropped rows to stay inside its configured item limit. */
  "TRUNCATED",
] as const;
export type BindingIssueCode = (typeof BINDING_ISSUE_CODES)[number];

export type BindingIssue = {
  code: BindingIssueCode;
  /** Dotted path, token, or row locator the issue is about. "" if template-wide. */
  path: string;
  detail: string;
};

/**
 * Which preflight check an issue rolls up into. Unknown paths are a template
 * defect (§21 "unresolved variables" vs a genuinely empty product field), so
 * they get their own code and the deployment can grade them differently.
 */
export function bindingPreflightCode(issue: BindingIssue): CheckCode {
  if (issue.code === "UNKNOWN_PATH") return "BINDING_UNKNOWN_PATH";
  if (issue.code === "TRUNCATED") return "BOM_OVERFLOW";
  return "BINDING_UNRESOLVED";
}

function fromFormatIssue(issue: FormatIssue, path: string): BindingIssue {
  const detail =
    issue.kind === "unknown-pattern"
      ? `Format "${issue.format}" is not a number or date pattern; "${issue.raw}" printed unformatted.`
      : issue.kind === "not-a-number"
        ? `Format "${issue.format}" needs a number but "${issue.raw}" is not one.`
        : `Format "${issue.format}" needs a date but "${issue.raw}" is not one.`;
  return { code: "BAD_FORMAT", path, detail };
}

/* --------------------------------------------------------------- traversal */

/**
 * Dotted-path read. This is `resolvePath` from lib/data/context.ts with one
 * addition: only own properties are followed. Binding paths are typed by users,
 * and "constructor" or "toString" must resolve to nothing rather than reaching
 * up the prototype chain. It also accepts any root, which is what lets a BOM
 * row be read with the same code as a ProductContext.
 */
export function getPath(root: unknown, path: string): unknown {
  if (path === "") return undefined;
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Emptiness as conditional visibility means it: no value, no text, no rows. */
export function isTruthyValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

/* -------------------------------------------------------- binding defaults */

export const DEFAULT_BINDING: Omit<Binding, "path"> = {
  fallback: "",
  prefix: "",
  suffix: "",
  transform: "none",
  joiner: ", ",
  hideWhenEmpty: false,
};

/** What the editor's "insert variable" action creates, and what tests build. */
export function makeBinding(partial: Partial<Binding> & { path: string }): Binding {
  return { ...DEFAULT_BINDING, ...partial };
}

/* ----------------------------------------------------------- resolveBinding */

export type BindingStatus = "ok" | "empty" | "missing";

export type BindingResolution = {
  path: string;
  /**
   * The product data as text: list-joined and formatted, but before the
   * fallback, the transform and the prefix/suffix. This is the field's own
   * content, which is what "did the product have this?" means.
   */
  value: string;
  /** What the renderer draws: prefix + transform(value or fallback) + suffix. */
  text: string;
  status: BindingStatus;
  /** Path is not in FIELD_CATALOG. Preflight raises BINDING_UNKNOWN_PATH. */
  unknownPath: boolean;
  usedFallback: boolean;
  /** hideWhenEmpty is set and nothing filled the slot: do not draw the element. */
  hidden: boolean;
  /** Entries joined when the value was a list; 0 for a scalar. */
  listCount: number;
  issues: BindingIssue[];
};

export function resolveBinding(binding: Binding, ctx: ProductContext): BindingResolution {
  const path = binding.path;
  const issues: BindingIssue[] = [];

  const unknownPath = !isKnownPath(path);
  if (unknownPath) {
    issues.push({
      code: "UNKNOWN_PATH",
      path,
      detail: `"${path}" is not a known product field.`,
    });
  }

  const raw = getPath(ctx, path);
  let status: BindingStatus = "ok";
  let value = "";
  let listCount = 0;
  let notText = false;

  if (raw === undefined || raw === null) {
    status = "missing";
    issues.push({ code: "MISSING_VALUE", path, detail: `This product has no value at "${path}".` });
  } else if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const item of raw) {
      if (item !== null && typeof item === "object" && !(item instanceof Date)) {
        // A collection of rows is a repeating block's job, not a text run's.
        notText = true;
        parts.length = 0;
        break;
      }
      const out = applyFormat(item, binding.format);
      if (out.issue) issues.push(fromFormatIssue(out.issue, path));
      const t = out.text.trim();
      if (t !== "") parts.push(t);
    }
    if (notText) {
      issues.push({
        code: "NOT_TEXT",
        path,
        detail: `"${path}" is a repeating collection; bind a pack-contents block to it instead of a text run.`,
      });
    }
    listCount = parts.length;
    value = parts.join(binding.joiner);
    status = value === "" ? "empty" : "ok";
  } else if (typeof raw === "object" && !(raw instanceof Date)) {
    notText = true;
    issues.push({
      code: "NOT_TEXT",
      path,
      detail: `"${path}" is a group of fields, not a value; bind one of its fields.`,
    });
    status = "empty";
  } else {
    const out = applyFormat(raw, binding.format);
    if (out.issue) issues.push(fromFormatIssue(out.issue, path));
    value = out.text;
    status = value === "" ? "empty" : "ok";
  }

  if (status === "empty" && !notText) {
    issues.push({ code: "EMPTY_VALUE", path, detail: `"${path}" is empty on this product.` });
  }

  // The fallback, the transform and the prefix/suffix all decorate whatever
  // fills the slot. A fallback typed as "TBD" under an uppercase transform is
  // meant to read "TBD", and "P/N " in front of nothing is worse than nothing,
  // so an empty slot produces an empty string rather than bare decoration.
  let slot = value;
  let usedFallback = false;
  if (status !== "ok" && binding.fallback !== "") {
    slot = binding.fallback;
    usedFallback = true;
  }
  const text =
    slot === "" ? "" : `${binding.prefix}${applyTextTransform(slot, binding.transform)}${binding.suffix}`;

  return {
    path,
    value,
    text,
    status,
    unknownPath,
    usedFallback,
    hidden: binding.hideWhenEmpty && text === "",
    listCount,
    issues,
  };
}

/** The common case: give me the characters. */
export function resolveBindingText(binding: Binding, ctx: ProductContext): string {
  return resolveBinding(binding, ctx).text;
}

/* ------------------------------------------------------------- {token} text */

/** Prefix that reaches the product from inside a repeating row template. */
export const PRODUCT_TOKEN_PREFIX = "product.";

export type TokenValue = {
  /** The path exists on the object being resolved against. */
  found: boolean;
  /** The path is a documented field. False raises BINDING_UNKNOWN_PATH. */
  known: boolean;
  value: unknown;
};
export type TokenLookup = (path: string) => TokenValue;

export type TokenOptions = {
  /** Separator when a token resolves to a list. Defaults to ", ". */
  joiner?: string;
};

export type TokenResolution = {
  text: string;
  /** Token paths in order of first appearance. */
  paths: string[];
  tokenCount: number;
  /** Tokens that printed nothing. */
  unresolvedCount: number;
  issues: BindingIssue[];
};

type Segment = { kind: "text"; text: string } | { kind: "token"; path: string };

/**
 * Split a template into literal text and tokens.
 *
 * "{{" is a literal "{" and "}}" a literal "}", which is how a designer prints
 * a brace. An opening brace with no partner is emitted literally and reported:
 * dropping it would hide the typo, and leaving the rest of the line to be eaten
 * as a token name would delete real copy.
 */
function parseTemplate(template: string): { segments: Segment[]; issues: BindingIssue[] } {
  const segments: Segment[] = [];
  const issues: BindingIssue[] = [];
  let buf = "";
  let i = 0;

  const flush = (): void => {
    if (buf !== "") {
      segments.push({ kind: "text", text: buf });
      buf = "";
    }
  };

  while (i < template.length) {
    const c = template[i];
    if (c === "{") {
      if (template[i + 1] === "{") {
        buf += "{";
        i += 2;
        continue;
      }
      const close = template.indexOf("}", i + 1);
      if (close === -1) {
        issues.push({
          code: "UNBALANCED_BRACE",
          path: "",
          detail: `Unclosed "{" at position ${i}; it printed as a literal brace.`,
        });
        buf += "{";
        i += 1;
        continue;
      }
      flush();
      segments.push({ kind: "token", path: template.slice(i + 1, close).trim() });
      i = close + 1;
      continue;
    }
    if (c === "}") {
      if (template[i + 1] === "}") {
        buf += "}";
        i += 2;
        continue;
      }
      issues.push({
        code: "UNBALANCED_BRACE",
        path: "",
        detail: `Unmatched "}" at position ${i}; it printed as a literal brace.`,
      });
      buf += "}";
      i += 1;
      continue;
    }
    buf += c;
    i += 1;
  }
  flush();
  return { segments, issues };
}

/** Token paths referenced by a template, deduped, in order of appearance. */
export function templatePaths(template: string): string[] {
  const seen: string[] = [];
  for (const seg of parseTemplate(template).segments) {
    if (seg.kind === "token" && seg.path !== "" && !seen.includes(seg.path)) seen.push(seg.path);
  }
  return seen;
}

/** Resolve "{a} {b}" against an arbitrary lookup. The engine behind both wrappers. */
export function resolveTokensWith(
  template: string,
  lookup: TokenLookup,
  opts: TokenOptions = {},
): TokenResolution {
  const joiner = opts.joiner ?? ", ";
  const { segments, issues } = parseTemplate(template);
  const paths: string[] = [];
  let text = "";
  let tokenCount = 0;
  let unresolvedCount = 0;

  for (const seg of segments) {
    if (seg.kind === "text") {
      text += seg.text;
      continue;
    }
    tokenCount += 1;
    if (seg.path !== "" && !paths.includes(seg.path)) paths.push(seg.path);

    if (seg.path === "") {
      unresolvedCount += 1;
      issues.push({ code: "UNRESOLVED_TOKEN", path: "", detail: "Empty token {} printed nothing." });
      continue;
    }

    const hit = lookup(seg.path);
    if (!hit.known) {
      issues.push({
        code: "UNKNOWN_PATH",
        path: seg.path,
        detail: `"{${seg.path}}" is not a known field.`,
      });
    }
    if (!hit.found) {
      unresolvedCount += 1;
      issues.push({
        code: "UNRESOLVED_TOKEN",
        path: seg.path,
        detail: `"{${seg.path}}" has no value here and printed nothing.`,
      });
      continue;
    }

    const rendered = renderTokenValue(hit.value, joiner);
    if (rendered.notText) {
      unresolvedCount += 1;
      issues.push({
        code: "NOT_TEXT",
        path: seg.path,
        detail: `"{${seg.path}}" is a group or collection and printed nothing.`,
      });
      continue;
    }
    if (rendered.text === "") {
      unresolvedCount += 1;
      issues.push({
        code: "EMPTY_VALUE",
        path: seg.path,
        detail: `"{${seg.path}}" is empty and printed nothing.`,
      });
      continue;
    }
    text += rendered.text;
  }

  return { text, paths, tokenCount, unresolvedCount, issues };
}

function renderTokenValue(value: unknown, joiner: string): { text: string; notText: boolean } {
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (item !== null && typeof item === "object" && !(item instanceof Date)) {
        return { text: "", notText: true };
      }
      const t = stringifyScalar(item).trim();
      if (t !== "") parts.push(t);
    }
    return { text: parts.join(joiner), notText: false };
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return { text: "", notText: true };
  }
  return { text: stringifyScalar(value), notText: false };
}

/** Lookup against the product. `custom.*` resolves even though it is not catalogued. */
export function productLookup(ctx: ProductContext): TokenLookup {
  return (path) => {
    const value = getPath(ctx, path);
    const found = value !== undefined && value !== null;
    return { found, known: isKnownPath(path) || found, value };
  };
}

export function resolveTokens(
  template: string,
  ctx: ProductContext,
  opts: TokenOptions = {},
): TokenResolution {
  return resolveTokensWith(template, productLookup(ctx), opts);
}

export function resolveTokensText(template: string, ctx: ProductContext): string {
  return resolveTokens(template, ctx).text;
}

/* ---------------------------------------------------- conditional visibility */

export type VisibleWhenExpr = {
  path: string;
  op: "truthy" | "falsy" | "eq" | "ne";
  /** Right-hand literal for eq/ne, quotes stripped. */
  literal: string;
};

/**
 * Parse a `visibleWhen` expression.
 *
 * The documented forms are a bare path ("show when this product has one") and a
 * negated path ("!warnings"). Equality against a literal is supported too
 * because a lifecycle field like `status` is the other thing templates key off,
 * and it stays a comparison rather than an expression language on purpose:
 * anything a designer can type has to be explainable in a preflight message.
 */
export function parseVisibleWhen(expr: string): VisibleWhenExpr {
  const src = expr.trim();
  const cmp = /^(.*?)\s*(==|!=)\s*(.*)$/.exec(src);
  if (cmp) {
    return {
      path: cmp[1].trim(),
      op: cmp[2] === "==" ? "eq" : "ne",
      literal: unquote(cmp[3].trim()),
    };
  }
  if (src.startsWith("!")) return { path: src.slice(1).trim(), op: "falsy", literal: "" };
  return { path: src, op: "truthy", literal: "" };
}

function unquote(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

export type VisibilityDecision = {
  visible: boolean;
  /** Why the answer is what it is, for the layers panel and HIDDEN_REQUIRED. */
  reason: "visible" | "hidden-flag" | "visible-when" | "empty-binding";
  path?: string;
  issues: BindingIssue[];
};

export function evaluateVisibleWhen(
  expr: string | undefined,
  ctx: ProductContext,
): VisibilityDecision {
  if (expr === undefined || expr.trim() === "") return { visible: true, reason: "visible", issues: [] };
  const parsed = parseVisibleWhen(expr);
  const issues: BindingIssue[] = [];
  if (parsed.path === "") {
    issues.push({
      code: "UNRESOLVED_TOKEN",
      path: "",
      detail: `Visibility rule "${expr}" names no field; the element stays visible.`,
    });
    return { visible: true, reason: "visible", issues };
  }
  const raw = getPath(ctx, parsed.path);
  if (!isKnownPath(parsed.path) && raw === undefined) {
    issues.push({
      code: "UNKNOWN_PATH",
      path: parsed.path,
      detail: `Visibility rule points at "${parsed.path}", which is not a known product field.`,
    });
  }

  let visible: boolean;
  switch (parsed.op) {
    case "truthy":
      visible = isTruthyValue(raw);
      break;
    case "falsy":
      visible = !isTruthyValue(raw);
      break;
    case "eq":
    case "ne": {
      const actual = renderTokenValue(raw, ", ").text.trim();
      const equal = actual === parsed.literal;
      visible = parsed.op === "eq" ? equal : !equal;
      break;
    }
  }
  return {
    visible,
    reason: visible ? "visible" : "visible-when",
    path: parsed.path,
    issues,
  };
}

/* ------------------------------------------------------------ text elements */

/**
 * A run's printed text. When a run carries a binding the binding wins: `text`
 * is then the design-time placeholder the designer sees before a product is
 * selected. Otherwise the run's own copy is scanned for {tokens}.
 */
export function resolveRun(run: TextRun, ctx: ProductContext): { text: string; hidden: boolean; issues: BindingIssue[] } {
  if (run.binding) {
    const r = resolveBinding(run.binding, ctx);
    return { text: r.text, hidden: r.hidden, issues: r.issues };
  }
  const r = resolveTokens(run.text, ctx);
  return { text: r.text, hidden: false, issues: r.issues };
}

/** Plain resolved text of a whole text element, paragraphs joined with newlines. */
export function resolveTextElementText(
  el: TextElement,
  ctx: ProductContext,
): { text: string; issues: BindingIssue[]; hiddenByBinding: boolean } {
  const issues: BindingIssue[] = [];
  let sawHideWhenEmpty = false;
  const paras = el.paragraphs.map((p) =>
    p.runs
      .map((run) => {
        const r = resolveRun(run, ctx);
        issues.push(...r.issues);
        if (r.hidden) sawHideWhenEmpty = true;
        return r.text;
      })
      .join(""),
  );
  const text = paras.join("\n");
  return { text, issues, hiddenByBinding: sawHideWhenEmpty && text.trim() === "" };
}

/* --------------------------------------------------------- element visibility */

/**
 * Should this element be drawn for this product?
 *
 * Order matters: an explicitly hidden element is hidden whatever the data says,
 * then the visibility rule, then hideWhenEmpty on the element's own binding.
 * The reason travels with the answer so preflight can tell a designer that a
 * *required* element vanished because of a rule rather than a mistake.
 */
export function isElementVisible(el: DesignElement, ctx: ProductContext): VisibilityDecision {
  if (el.hidden) return { visible: false, reason: "hidden-flag", issues: [] };

  const rule = evaluateVisibleWhen(el.visibleWhen, ctx);
  if (!rule.visible) return rule;
  const issues = [...rule.issues];

  switch (el.kind) {
    case "text": {
      const r = resolveTextElementText(el, ctx);
      issues.push(...r.issues);
      if (r.hiddenByBinding) return { visible: false, reason: "empty-binding", issues };
      break;
    }
    case "image":
    case "barcode": {
      if (el.binding) {
        const r = resolveBinding(el.binding, ctx);
        issues.push(...r.issues);
        if (r.hidden) return { visible: false, reason: "empty-binding", issues };
      }
      break;
    }
    case "bomList": {
      // Read the source directly rather than calling the renderer: bom.ts
      // depends on this module, and the only question here is "any rows?".
      const rows = getPath(ctx, el.sourcePath);
      const hasRows = Array.isArray(rows) && rows.length > 0;
      if (!hasRows && el.emptyText === "" && !el.showHeading) {
        return { visible: false, reason: "empty-binding", issues };
      }
      break;
    }
    case "shape":
    case "group":
      break;
  }
  return { visible: true, reason: "visible", issues };
}

/* -------------------------------------------------------- collectBindingPaths */

/**
 * Every product path an element references, for `design_elements.binding_paths`.
 *
 * The save path writes this so "which designs use identifiers.upc12?" is an
 * index lookup instead of a scan of every design JSON. Row tokens inside a
 * repeating block are recorded against the collection they iterate, as
 * "bom.items[].partNumber", so a row field is distinguishable from a top-level
 * one; a row token written as "{product.x}" is recorded as the plain path "x"
 * because that is what it actually reads.
 */
export function collectBindingPaths(el: DesignElement): string[] {
  const out = new Set<string>();

  if (el.visibleWhen !== undefined && el.visibleWhen.trim() !== "") {
    const p = parseVisibleWhen(el.visibleWhen).path;
    if (p !== "") out.add(p);
  }

  switch (el.kind) {
    case "text":
      for (const para of el.paragraphs) {
        for (const run of para.runs) {
          if (run.binding) out.add(run.binding.path);
          else for (const p of templatePaths(run.text)) out.add(p);
        }
      }
      break;
    case "image":
    case "barcode":
      if (el.binding) out.add(el.binding.path);
      break;
    case "bomList": {
      out.add(el.sourcePath);
      for (const p of templatePaths(el.heading)) out.add(p);
      for (const p of templatePaths(el.emptyText)) out.add(p);
      for (const p of templatePaths(el.itemTemplate)) {
        if (p.startsWith(PRODUCT_TOKEN_PREFIX)) {
          const direct = p.slice(PRODUCT_TOKEN_PREFIX.length);
          if (direct !== "") out.add(direct);
        } else {
          out.add(`${el.sourcePath}[].${p}`);
        }
      }
      break;
    }
    case "shape":
    case "group":
      break;
  }

  return [...out].filter((p) => p !== "").sort();
}

/** Paths an element references that no longer exist in FIELD_CATALOG. */
export function unknownBindingPaths(paths: string[]): string[] {
  return paths.filter((p) => {
    const base = p.includes("[].") ? p.slice(0, p.indexOf("[].")) : p;
    return !isKnownPath(base);
  });
}
