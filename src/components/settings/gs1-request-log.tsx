import { Fragment } from "react";
import { Panel, EmptyState, Badge } from "@/components/ui/panel";
import { Gs1ClearLogButton } from "@/components/settings/gs1-clear-log-button";

/**
 * The GS1 request log (spec §13B: "request logging with secrets redacted").
 *
 * Every field here was written through `redact()` inside the adapter before it
 * reached the database — header values are replaced by key name, the credential
 * is registered as a literal secret so an API that echoes it back cannot leak
 * it, and any high-entropy blob is dropped. Nothing on this screen is filtered
 * at render time, because a log that is only safe when the UI hides part of it
 * is not a safe log.
 */

export type Gs1LogRow = {
  id: string;
  method: string;
  path: string;
  statusCode: number | null;
  durationMs: number | null;
  requestSummary: unknown;
  responseSummary: unknown;
  error: string;
  createdAt: string;
};

function statusTone(status: number | null, error: string) {
  if (error !== "") return "danger" as const;
  if (status === null) return "neutral" as const;
  if (status >= 200 && status < 300) return "ok" as const;
  if (status === 429) return "warning" as const;
  return "danger" as const;
}

function operationOf(summary: unknown): string {
  if (summary && typeof summary === "object" && "operation" in summary) {
    const op = (summary as { operation?: unknown }).operation;
    if (typeof op === "string") return op;
  }
  return "";
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return "[unserialisable]";
  }
}

export function Gs1RequestLog({
  rows,
  editable,
}: {
  rows: Gs1LogRow[];
  editable: boolean;
}) {
  return (
    <Panel
      title="Request log"
      description="Every call this organisation has made, with secrets redacted before the row was written."
      actions={editable && rows.length > 0 ? <Gs1ClearLogButton /> : null}
    >
      {rows.length === 0 ? (
        <EmptyState
          title="No requests yet"
          description="Nothing has been sent to GS1 from this organisation. Run the connection test above, or verify a product's GTIN, and the exchange will be recorded here."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                <th scope="col" className="px-4 py-2 font-medium">
                  When
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Operation
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Request
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  Duration
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Fragment key={row.id}>
                  <tr className="border-b border-ink-800/40">
                    <td className="numeric whitespace-nowrap px-4 py-2 align-top text-[12px] text-ink-400">
                      {new Date(row.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 align-top text-[12px] text-ink-300">
                      {operationOf(row.requestSummary) || "—"}
                    </td>
                    <td className="px-4 py-2 align-top">
                      <span className="numeric text-[11px] font-semibold uppercase text-ink-400">
                        {row.method}
                      </span>{" "}
                      <span className="break-all font-mono text-[12px] text-ink-200">{row.path}</span>
                      {row.error ? (
                        <div className="mt-0.5 text-[11px] text-flag-300">{row.error}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 align-top">
                      <Badge tone={statusTone(row.statusCode, row.error)}>
                        {row.statusCode ?? "no response"}
                      </Badge>
                    </td>
                    <td className="numeric px-4 py-2 text-right align-top text-[12px] text-ink-400">
                      {row.durationMs === null ? "—" : `${row.durationMs} ms`}
                    </td>
                  </tr>
                  <tr className="border-b border-ink-800/60">
                    <td colSpan={5} className="px-4 pb-2">
                      <details>
                        <summary className="cursor-pointer text-[11px] text-ink-500 hover:text-ink-300">
                          Redacted payload
                        </summary>
                        <div className="mt-2 grid gap-2 lg:grid-cols-2">
                          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded border border-ink-800 bg-ink-950 p-2 font-mono text-[11px] leading-relaxed text-ink-300">
                            {pretty(row.requestSummary)}
                          </pre>
                          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded border border-ink-800 bg-ink-950 p-2 font-mono text-[11px] leading-relaxed text-ink-300">
                            {pretty(row.responseSummary)}
                          </pre>
                        </div>
                      </details>
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
