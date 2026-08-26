"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, ChevronRight, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, Stat, Badge } from "@/components/ui/panel";
import { commitImportAction, previewImportAction, cancelImportAction } from "@/server/imports";
import type { ImportPreview, SheetMapping } from "@/lib/import/types";
import { cn } from "@/lib/cn";

type TargetField = { key: string; label: string; group: string; multi: boolean };

/**
 * The mapping and preview wizard.
 *
 * Everything a reviewer needs to decide "is this safe to commit" is on one
 * screen: what each column became, what each row would do, and every finding
 * that would otherwise be discovered after the write.
 */
export function ImportWizard({
  importId,
  status,
  initialMapping,
  headers,
  initialPreview,
  report,
  targetFields,
  canCommit,
}: {
  importId: string;
  status: string;
  initialMapping: SheetMapping | null;
  headers: string[];
  initialPreview: ImportPreview | null;
  report: Record<string, unknown>;
  targetFields: TargetField[];
  canCommit: boolean;
}) {
  const router = useRouter();
  const [mapping, setMapping] = useState<SheetMapping | null>(initialMapping);
  const [preview, setPreview] = useState<ImportPreview | null>(initialPreview);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [rowFilter, setRowFilter] = useState<"all" | "create" | "update" | "skip" | "findings">("all");

  const committed = status === "committed";
  const cancelled = status === "cancelled";

  const grouped = useMemo(() => {
    const g = new Map<string, TargetField[]>();
    for (const f of targetFields) {
      const arr = g.get(f.group) ?? [];
      arr.push(f);
      g.set(f.group, arr);
    }
    return [...g.entries()];
  }, [targetFields]);

  const setColumnField = (columnIndex: number, field: string | null) => {
    if (!mapping) return;
    const columns = mapping.columns.map((c) =>
      c.columnIndex === columnIndex
        ? { ...c, field, source: "manual" as const, confidence: field ? 100 : 0, supersededBy: null }
        : c,
    );
    setMapping({
      ...mapping,
      columns,
      mappedFields: Array.from(new Set(columns.map((c) => c.field).filter(Boolean) as string[])),
    });
    setPreview(null);
  };

  const runPreview = () => {
    if (!mapping) return;
    setError(null);
    start(async () => {
      const res = await previewImportAction(importId, mapping);
      if (res.ok) setPreview(res.preview);
      else setError(res.error);
    });
  };

  const commit = () => {
    setError(null);
    start(async () => {
      const res = await commitImportAction(importId);
      if (res.ok) router.refresh();
      else setError(res.error);
    });
  };

  const cancel = () => {
    start(async () => {
      await cancelImportAction(importId);
      router.push("/imports");
    });
  };

  if (committed) {
    const r = report as {
      created?: number; updated?: number; identifiers?: number;
      bomItems?: number; brandsCreated?: string[];
      errors?: Array<{ rowNumber: number; message: string }>;
      skipped?: Array<{ rowNumber: number; reason: string }>;
    };
    return (
      <div className="space-y-6">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Created" value={r.created ?? 0} tone="ok" />
          <Stat label="Updated" value={r.updated ?? 0} />
          <Stat label="Identifiers" value={r.identifiers ?? 0} />
          <Stat
            label="Failed rows"
            value={r.errors?.length ?? 0}
            tone={r.errors?.length ? "danger" : "default"}
          />
        </div>
        {r.errors?.length ? (
          <Panel title="Rows that failed" description="Nothing disappeared silently.">
            <ul className="divide-y divide-ink-800/60">
              {r.errors.map((e, i) => (
                <li key={i} className="px-4 py-2 text-sm text-ink-300">
                  <span className="numeric mr-2 text-ink-500">row {e.rowNumber}</span>
                  {e.message}
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
        {r.skipped?.length ? (
          <Panel
            title={`Rows deliberately skipped (${r.skipped.length})`}
            description="Recorded with the reason rather than dropped."
          >
            <ul className="max-h-64 divide-y divide-ink-800/60 overflow-y-auto">
              {r.skipped.map((s, i) => (
                <li key={i} className="px-4 py-1.5 text-[13px] text-ink-400">
                  <span className="numeric mr-2 text-ink-500">row {s.rowNumber}</span>
                  {s.reason}
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
      </div>
    );
  }

  if (cancelled) {
    return (
      <Panel>
        <p className="px-4 py-6 text-sm text-ink-400">
          This import was cancelled. Nothing was written.
        </p>
      </Panel>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-xs text-ink-400">
        <Step n={1} label="Map columns" active={!preview} done={Boolean(preview)} />
        <ChevronRight size={13} />
        <Step n={2} label="Review preview" active={Boolean(preview)} done={false} />
        <ChevronRight size={13} />
        <Step n={3} label="Commit" active={false} done={false} />
      </div>

      {error ? (
        <p role="alert" className="rounded-md border border-flag-800 bg-flag-900/30 px-3 py-2 text-sm text-flag-200">
          {error}
        </p>
      ) : null}

      <Panel
        title="Column mapping"
        description={
          mapping
            ? `Profile: ${mapping.profileId} (${Math.round(mapping.profileScore)}% match) · header row ${mapping.headerRowNumber}`
            : "No mapping available"
        }
        actions={
          <Button size="sm" variant="primary" onClick={runPreview} disabled={pending || !mapping}>
            {pending ? "Working…" : preview ? "Re-preview" : "Preview changes"}
          </Button>
        }
      >
        {!mapping ? (
          <p className="px-4 py-6 text-sm text-ink-400">The workbook produced no readable sheet.</p>
        ) : (
          <div className="max-h-[26rem] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-ink-850">
                <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                  <th className="px-4 py-2 font-medium">Column</th>
                  <th className="px-4 py-2 font-medium">Maps to</th>
                  <th className="numeric px-4 py-2 text-right font-medium">Confidence</th>
                  <th className="px-4 py-2 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {mapping.columns.map((c) => (
                  <tr key={c.columnIndex} className="border-b border-ink-800/60 last:border-0">
                    <td className="px-4 py-1.5 text-ink-200">
                      {headers[c.columnIndex] ?? c.header}
                    </td>
                    <td className="px-4 py-1.5">
                      <select
                        value={c.field ?? ""}
                        onChange={(e) => setColumnField(c.columnIndex, e.target.value || null)}
                        aria-label={`Map column ${c.header}`}
                        className="h-7 w-full max-w-64 rounded border border-ink-700 bg-ink-850 px-1.5 text-xs text-ink-100"
                      >
                        <option value="">Do not import</option>
                        {grouped.map(([group, fields]) => (
                          <optgroup key={group} label={group}>
                            {fields.map((f) => (
                              <option key={f.key} value={f.key}>
                                {f.label}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </td>
                    <td className="numeric px-4 py-1.5 text-right text-ink-400">
                      {c.field ? `${Math.round(c.confidence)}%` : "—"}
                    </td>
                    <td className="px-4 py-1.5 text-[11px] text-ink-500">
                      {c.supersededBy !== null
                        ? `Superseded by "${headers[c.supersededBy] ?? `column ${c.supersededBy}`}"`
                        : c.source === "manual"
                          ? "Set by you"
                          : c.source === "profile"
                            ? "From source profile"
                            : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {mapping && mapping.missingRequired.length > 0 ? (
        <Panel title="Required fields not mapped">
          <ul className="px-4 py-3 text-sm text-sev-warning">
            {mapping.missingRequired.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {preview ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <Stat label="Rows" value={preview.summary.totalRows} />
            <Stat label="Create" value={preview.summary.create} tone="ok" />
            <Stat label="Update" value={preview.summary.update} />
            <Stat label="Unchanged" value={preview.summary.unchanged} />
            <Stat
              label="Skip"
              value={preview.summary.skip}
              tone={preview.summary.skip ? "warning" : "default"}
            />
            <Stat
              label="Invalid GTIN"
              value={preview.summary.invalidGtins}
              tone={preview.summary.invalidGtins ? "danger" : "ok"}
            />
          </div>

          {preview.findings.length ? (
            <Panel title="Mapping findings">
              <ul className="divide-y divide-ink-800/60">
                {preview.findings.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 px-4 py-2 text-sm">
                    <FindingIcon severity={f.severity} />
                    <span className="text-ink-300">{f.message}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          {preview.duplicateGtins.length ? (
            <Panel
              title={`Duplicate GTINs in this file (${preview.duplicateGtins.length})`}
              description="A GTIN identifies exactly one trade item. These rows cannot all be right."
            >
              <ul className="max-h-40 divide-y divide-ink-800/60 overflow-y-auto">
                {preview.duplicateGtins.map((d) => (
                  <li key={d.value} className="numeric px-4 py-1.5 text-[13px] text-ink-300">
                    {d.value} — rows {d.rowNumbers.join(", ")}
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          {preview.crossBrandPartNumbers.length ? (
            <Panel
              title={`Part numbers used by more than one brand (${preview.crossBrandPartNumbers.length})`}
              description="Legitimate in this catalogue — the same part is sold under several brands. Reported so it is a decision, not a surprise."
            >
              <ul className="max-h-40 divide-y divide-ink-800/60 overflow-y-auto">
                {preview.crossBrandPartNumbers.slice(0, 40).map((d) => (
                  <li key={d.value} className="numeric px-4 py-1.5 text-[13px] text-ink-400">
                    {d.value} — {d.rowNumbers.length} rows
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          <Panel
            title="Rows"
            actions={
              <select
                value={rowFilter}
                onChange={(e) => setRowFilter(e.target.value as typeof rowFilter)}
                aria-label="Filter rows"
                className="h-7 rounded border border-ink-700 bg-ink-850 px-1.5 text-xs text-ink-200"
              >
                <option value="all">All rows</option>
                <option value="create">Create</option>
                <option value="update">Update</option>
                <option value="skip">Skip</option>
                <option value="findings">With findings</option>
              </select>
            }
          >
            <div className="max-h-[30rem] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-ink-850">
                  <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                    <th className="px-4 py-2 font-medium">Row</th>
                    <th className="px-4 py-2 font-medium">Action</th>
                    <th className="px-4 py-2 font-medium">Part</th>
                    <th className="px-4 py-2 font-medium">Brand</th>
                    <th className="px-4 py-2 font-medium">GTIN</th>
                    <th className="px-4 py-2 font-medium">Findings</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows
                    .filter((r) =>
                      rowFilter === "all"
                        ? true
                        : rowFilter === "findings"
                          ? r.findings.length > 0
                          : r.classification === rowFilter,
                    )
                    .slice(0, 400)
                    .map((r) => (
                      <tr key={r.rowNumber} className="border-b border-ink-800/60 last:border-0">
                        <td className="numeric px-4 py-1.5 text-ink-500">{r.rowNumber}</td>
                        <td className="px-4 py-1.5">
                          <Badge
                            tone={
                              r.classification === "create"
                                ? "ok"
                                : r.classification === "update"
                                  ? "info"
                                  : r.classification === "skip"
                                    ? "warning"
                                    : "neutral"
                            }
                          >
                            {r.classification}
                          </Badge>
                        </td>
                        <td className="numeric px-4 py-1.5 text-ink-200">
                          {r.fields["product.partNumber"] ?? "—"}
                        </td>
                        <td className="px-4 py-1.5 text-ink-400">
                          {r.fields["brand.name"] ?? "—"}
                        </td>
                        <td className="numeric px-4 py-1.5 text-ink-400">
                          {r.identifiers.find((i) => i.kind.startsWith("gtin"))?.canonical ?? "—"}
                        </td>
                        <td className="px-4 py-1.5">
                          {r.findings.length ? (
                            <span className="flex flex-wrap gap-1">
                              {r.findings.slice(0, 3).map((f, i) => (
                                <span
                                  key={i}
                                  title={f.message}
                                  className={cn(
                                    "rounded px-1 py-px text-[9px] uppercase tracking-wide",
                                    f.severity === "error"
                                      ? "bg-flag-600/20 text-flag-300"
                                      : f.severity === "warning"
                                        ? "bg-amber-500/15 text-sev-warning"
                                        : "bg-ink-800 text-ink-400",
                                  )}
                                >
                                  {f.code}
                                </span>
                              ))}
                            </span>
                          ) : (
                            <span className="text-ink-600">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <div className="flex items-center justify-between gap-3 rounded-panel border border-ink-800 bg-ink-850/60 px-4 py-3">
            <p className="text-sm text-ink-400">
              {preview.committable
                ? `${preview.summary.create} products will be created and ${preview.summary.update} updated.`
                : "This import is blocked by errors above and cannot be committed as mapped."}
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={cancel} disabled={pending}>
                Cancel import
              </Button>
              <Button
                variant="primary"
                onClick={commit}
                disabled={pending || !preview.committable || !canCommit}
              >
                {pending ? "Committing…" : "Commit import"}
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Step({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5",
        active ? "text-brand-300" : done ? "text-sev-ok" : "text-ink-500",
      )}
    >
      <span
        className={cn(
          "flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold",
          active ? "bg-brand-600 text-white" : done ? "bg-emerald-600 text-white" : "bg-ink-700",
        )}
      >
        {done ? <Check size={9} /> : n}
      </span>
      {label}
    </span>
  );
}

function FindingIcon({ severity }: { severity: string }) {
  if (severity === "error")
    return <XCircle size={14} className="mt-0.5 shrink-0 text-sev-error" />;
  if (severity === "warning")
    return <AlertTriangle size={14} className="mt-0.5 shrink-0 text-sev-warning" />;
  return <Check size={14} className="mt-0.5 shrink-0 text-sev-info" />;
}
