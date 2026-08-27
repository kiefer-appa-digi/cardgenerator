"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, Stat, Badge } from "@/components/ui/panel";
import { commitAftermarketAction, type AftermarketPreview } from "@/server/aftermarket-import";

/**
 * Review screen for the Aftermarket BOM workbook.
 *
 * The column-mapping wizard cannot express this file: its BOM sheets are
 * block-structured, so there is nothing to map. What a reviewer needs to see
 * instead is what the reader made of each block — the pack lines it will print,
 * the clamshell it found, and every kit it could not match — before any of it
 * reaches a card.
 */
export function AftermarketReview({
  importId,
  status,
  preview,
  report,
  canCommit,
}: {
  importId: string;
  status: string;
  preview: AftermarketPreview | null;
  report: Record<string, unknown>;
  canCommit: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "match" | "unmatched" | "notes">("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = useMemo(() => {
    const all = preview?.rows ?? [];
    if (filter === "match") return all.filter((r) => r.status.startsWith("match"));
    if (filter === "unmatched") return all.filter((r) => r.status === "unmatched");
    if (filter === "notes") return all.filter((r) => r.notes.length > 0);
    return all;
  }, [preview, filter]);

  if (status === "committed") {
    const r = report as {
      bomsWritten?: number;
      packLinesWritten?: number;
      presetsAssigned?: number;
      presetConflicts?: Array<{ partNumber: string; had: string; found: string }>;
      unmatched?: Array<{ partNumber: string; upc: string; description: string; reason: string }>;
      duplicateUpcs?: Array<{ key: string; sheet: string; partNumber: string }>;
    };
    return (
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Pack contents written" value={r.bomsWritten ?? 0} tone="ok" />
          <Stat label="Pack lines" value={r.packLinesWritten ?? 0} />
          <Stat label="Card presets assigned" value={r.presetsAssigned ?? 0} />
          <Stat
            label="Not in the catalogue"
            value={r.unmatched?.length ?? 0}
            tone={r.unmatched?.length ? "warning" : "default"}
          />
        </div>

        {r.presetConflicts?.length ? (
          <Panel
            title={`Card-preset conflicts (${r.presetConflicts.length})`}
            description="The catalogue already named a different clamshell. Left as they were — only the brand owner knows which is current."
          >
            <ul className="divide-y divide-ink-800/60">
              {r.presetConflicts.map((c, i) => (
                <li key={i} className="numeric px-4 py-2 text-sm text-ink-300">
                  {c.partNumber}: catalogue says {c.had}, workbook says {c.found}
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}

        {r.unmatched?.length ? (
          <Panel
            title={`Kits not in the catalogue (${r.unmatched.length})`}
            description="Named in the workbook, not created. A bill of materials is not a product register."
          >
            <ul className="max-h-72 divide-y divide-ink-800/60 overflow-y-auto">
              {r.unmatched.map((u, i) => (
                <li key={i} className="px-4 py-2 text-[13px]">
                  <span className="numeric mr-2 text-ink-100">{u.partNumber || "(no part number)"}</span>
                  <span className="numeric mr-2 text-ink-500">{u.upc}</span>
                  <span className="text-ink-400">{u.description}</span>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
      </div>
    );
  }

  if (!preview) {
    return (
      <Panel>
        <p className="px-4 py-6 text-sm text-ink-400">
          This import has no preview to review. Upload the workbook again.
        </p>
      </Panel>
    );
  }

  const c = preview.counts;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Stat label="Kits" value={c.kits} />
        <Stat label="Matched" value={c.matched + c.matchedByPart} tone="ok" sub={`${c.matchedByPart} by part number`} />
        <Stat label="Pack lines" value={c.packLines} />
        <Stat label="Presets to assign" value={c.presetsToAssign} />
        <Stat
          label="Preset conflicts"
          value={c.presetConflicts}
          tone={c.presetConflicts ? "warning" : "default"}
        />
        <Stat
          label="Not in catalogue"
          value={c.unmatched}
          tone={c.unmatched ? "warning" : "default"}
        />
      </div>

      <Panel title="What this workbook is the authority for">
        <div className="space-y-2 px-4 py-3 text-[13px] leading-relaxed text-ink-300">
          <p>
            Committing writes <span className="text-ink-100">pack contents</span> and{" "}
            <span className="text-ink-100">card-preset assignments</span> onto products that
            are already in the catalogue. It does not create products, change a part number, or
            touch identity — the GS1 export is the authority for those.
          </p>
          <p className="text-ink-400">
            Pack contents are replaced, not merged: a line this workbook no longer lists must
            not survive on a card. A preset the catalogue already names is left alone and
            reported as a conflict.
          </p>
        </div>
      </Panel>

      {preview.duplicateKeys.length ? (
        <Panel
          title={`One UPC on more than one kit (${c.duplicateUpcs})`}
          description="A GTIN identifies exactly one trade item, so one of each pair is wrong. Both are kept for review; neither was used to fill in the other."
        >
          <ul className="divide-y divide-ink-800/60">
            {preview.duplicateKeys.map((d, i) => (
              <li key={i} className="numeric px-4 py-1.5 text-[13px] text-ink-300">
                {d.key} — {d.partNumber} ({d.sheet} row {d.rowNumber})
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Panel
        title="Kits"
        actions={
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            aria-label="Filter kits"
            className="h-7 rounded border border-ink-700 bg-ink-850 px-1.5 text-xs text-ink-200"
          >
            <option value="all">All kits</option>
            <option value="match">Matched</option>
            <option value="unmatched">Not in the catalogue</option>
            <option value="notes">With notes</option>
          </select>
        }
      >
        <div className="max-h-[32rem] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-ink-850">
              <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                <th className="px-4 py-2 font-medium">Part</th>
                <th className="px-4 py-2 font-medium">UPC</th>
                <th className="px-4 py-2 font-medium">Dieline</th>
                <th className="numeric px-4 py-2 text-right font-medium">Lines</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const open = expanded === `${r.partNumber}-${r.upc}`;
                const conflict =
                  r.existingPreset && r.presetCode && r.existingPreset !== r.presetCode;
                return (
                  <tr
                    key={`${r.partNumber}-${r.upc}-${r.description.slice(0, 12)}`}
                    className="border-b border-ink-800/60 align-top last:border-0"
                  >
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : `${r.partNumber}-${r.upc}`)}
                        className="numeric text-left text-ink-100 hover:text-brand-300"
                      >
                        {r.partNumber || "—"}
                      </button>
                      <div className="max-w-md truncate text-[11px] text-ink-500">
                        {r.description}
                      </div>
                      {open ? (
                        <ul className="mt-2 space-y-0.5 rounded border border-ink-800 bg-ink-900 p-2">
                          {r.packLines.length ? (
                            r.packLines.map((l, i) => (
                              <li key={i} className="numeric text-[11px] text-ink-200">
                                {l}
                              </li>
                            ))
                          ) : (
                            <li className="text-[11px] italic text-ink-500">
                              No printable pack contents — every line is packaging, labour or a label.
                            </li>
                          )}
                          {r.notes.map((n, i) => (
                            <li key={`n${i}`} className="mt-1 flex gap-1.5 text-[11px] text-sev-warning">
                              <Info size={11} className="mt-0.5 shrink-0" />
                              {n}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </td>
                    <td className="numeric px-4 py-2 text-ink-400">{r.upc || "—"}</td>
                    <td className="px-4 py-2">
                      {r.presetCode ? (
                        <span className="flex items-center gap-1.5">
                          <Badge tone={conflict ? "warning" : "brand"}>{r.presetCode}</Badge>
                          {conflict ? (
                            <span className="text-[10px] text-sev-warning">was {r.existingPreset}</span>
                          ) : null}
                          {r.presetSource && r.presetSource !== "BOM_AxleTekA" ? (
                            <span className="text-[10px] text-ink-500">via {r.presetSource}</span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-ink-600">unknown</span>
                      )}
                    </td>
                    <td className="numeric px-4 py-2 text-right text-ink-300">
                      {r.packLines.length}
                    </td>
                    <td className="px-4 py-2">
                      <Badge
                        tone={
                          r.status === "match"
                            ? "ok"
                            : r.status === "match-by-part"
                              ? "info"
                              : "warning"
                        }
                      >
                        {r.status === "match"
                          ? "by UPC"
                          : r.status === "match-by-part"
                            ? "by part"
                            : r.status === "no-contents"
                              ? "no contents"
                              : "not in catalogue"}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      {preview.unread.length ? (
        <Panel
          title="Sheets this reader does not use"
          description="Named so nothing looks like it was missed."
        >
          <ul className="divide-y divide-ink-800/60">
            {preview.unread.map((u) => (
              <li key={u.sheet} className="px-4 py-2 text-[13px]">
                <span className="text-ink-100">{u.sheet}</span>
                <span className="ml-2 text-ink-400">{u.reason}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-md border border-flag-800 bg-flag-900/30 px-3 py-2 text-sm text-flag-200">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3 rounded-panel border border-ink-800 bg-ink-850/60 px-4 py-3">
        <p className="text-sm text-ink-400">
          {c.matched + c.matchedByPart} products will get pack contents and{" "}
          {c.presetsToAssign} will get a card preset.
          {c.unmatched ? ` ${c.unmatched} kits are not in the catalogue and will not be created.` : ""}
        </p>
        <Button
          variant="primary"
          disabled={pending || !canCommit}
          onClick={() => {
            setError(null);
            start(async () => {
              const res = await commitAftermarketAction(importId);
              if (res.ok) router.refresh();
              else setError(res.error);
            });
          }}
        >
          {pending ? "Committing…" : "Commit pack contents"}
        </Button>
      </div>
    </div>
  );
}
