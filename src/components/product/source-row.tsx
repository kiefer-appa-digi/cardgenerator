import { ChevronRight } from "lucide-react";

/**
 * The source row exactly as it was imported.
 *
 * Kept verbatim and shown verbatim, including the columns that arrived empty:
 * the difference between "the workbook had no Net Weight column" and "the
 * workbook had one and it was blank" is the difference between a mapping bug
 * and a data gap, and only the untouched row can tell them apart.
 *
 * Collapsed by default — it is provenance, consulted when a value on the page
 * looks wrong, not something to read on the way past. `<details>` is used so it
 * opens with no JavaScript and is announced as a disclosure.
 */
export function SourceRow({
  title,
  description,
  row,
}: {
  title: string;
  description: string;
  row: Record<string, unknown>;
}) {
  const entries = Object.entries(row).sort(([a], [b]) => a.localeCompare(b));
  const filled = entries.filter(([, v]) => stringify(v).length > 0).length;

  return (
    <details className="group rounded-panel border border-ink-800 bg-ink-850/60">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={14}
          strokeWidth={2}
          aria-hidden
          className="shrink-0 text-ink-500 transition-transform group-open:rotate-90"
        />
        <span className="text-[13px] font-semibold text-ink-100">{title}</span>
        <span className="numeric text-xs text-ink-500">
          {entries.length} columns · {filled} carry a value
        </span>
      </summary>
      <p className="border-t border-ink-800 px-4 py-2.5 text-xs leading-relaxed text-ink-400">
        {description}
      </p>
      {entries.length === 0 ? (
        <p className="px-4 py-3 text-sm text-ink-500">Nothing was retained for this record.</p>
      ) : (
        <div className="overflow-x-auto border-t border-ink-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                <th scope="col" className="px-4 py-2 font-medium">
                  Column
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Value
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([key, value]) => {
                const text = stringify(value);
                return (
                  <tr key={key} className="border-b border-ink-800/60 last:border-0">
                    <th
                      scope="row"
                      className="w-72 px-4 py-1.5 text-left align-top text-[12px] font-normal text-ink-400"
                    >
                      {key}
                    </th>
                    <td
                      className={
                        text
                          ? "numeric px-4 py-1.5 align-top text-[12px] text-ink-100"
                          : "px-4 py-1.5 align-top text-[12px] text-ink-600"
                      }
                    >
                      {text || "empty"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
