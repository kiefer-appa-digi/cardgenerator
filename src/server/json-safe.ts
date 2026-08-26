import "server-only";

/**
 * PostgreSQL's `jsonb` cannot represent U+0000, and neither can a lone surrogate
 * that occasionally survives a round trip through a spreadsheet export. A single
 * stray NUL in one cell would otherwise fail an entire import with
 * "unsupported Unicode escape sequence".
 *
 * These characters carry no meaning in packaging copy — they are transport
 * artefacts, not data — so they are removed rather than the import rejected. The
 * count and the affected field paths are returned so the import report can state
 * exactly how many cells were touched: removing an unrepresentable control
 * character is not the same as silently correcting a value, and the user is told
 * either way.
 */

// C0 controls except tab/newline/carriage return, DEL, the C1 range, the two
// permanently-unassigned noncharacters at the end of the BMP, and unpaired
// surrogates.
const ILLEGAL = new RegExp(
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\uFFFE\\uFFFF]" +
    "|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])" +
    "|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]",
  "g",
);

export type SanitiseResult<T> = { value: T; removed: number; fields: string[] };

export function jsonSafe<T>(input: T): SanitiseResult<T> {
  let removed = 0;
  const fields = new Set<string>();

  const walk = (node: unknown, path: string): unknown => {
    if (typeof node === "string") {
      const cleaned = node.replace(ILLEGAL, () => {
        removed += 1;
        return "";
      });
      if (cleaned !== node) fields.add(path);
      return cleaned;
    }
    if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`));
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(v, path ? `${path}.${k}` : k);
      }
      return out;
    }
    return node;
  };

  const value = walk(input, "") as T;
  return { value, removed, fields: [...fields].slice(0, 50) };
}
