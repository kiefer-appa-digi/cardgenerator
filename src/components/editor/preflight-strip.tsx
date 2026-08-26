"use client";

import { AlertOctagon, AlertTriangle, CheckCircle2, ChevronUp, Info, XCircle } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";
import type { PreflightFinding, PreflightReport, Severity } from "@/lib/preflight/types";
import type { EditorStore } from "@/lib/editor/store";

const SEV_META: Record<
  Severity,
  { icon: typeof Info; className: string; label: string }
> = {
  info: { icon: Info, className: "text-sev-info", label: "Info" },
  warning: { icon: AlertTriangle, className: "text-sev-warning", label: "Warning" },
  error: { icon: XCircle, className: "text-sev-error", label: "Error" },
  blocking: { icon: AlertOctagon, className: "text-sev-blocking", label: "Blocking" },
};

/**
 * The status strip is always visible while editing. A designer should never have
 * to go looking for the reason a card cannot be exported — the count that
 * matters is on screen, and clicking a finding selects the offending element.
 */
export function PreflightStrip({
  store,
  report,
  running,
  onRun,
}: {
  store: EditorStore;
  report: PreflightReport | null;
  running: boolean;
  onRun: () => void;
}) {
  const [open, setOpen] = useState(false);
  const counts = report?.counts ?? { info: 0, warning: 0, error: 0, blocking: 0 };
  const clean = report && counts.blocking === 0 && counts.error === 0;

  return (
    <div className="shrink-0 border-t border-ink-800 bg-ink-950">
      <div className="flex h-9 items-center gap-3 px-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-2 text-xs text-ink-300 hover:text-ink-100"
        >
          <ChevronUp
            size={14}
            className={cn("transition-transform", open && "rotate-180")}
          />
          Preflight
        </button>

        {report ? (
          <div className="flex items-center gap-3">
            {clean ? (
              <span className="flex items-center gap-1.5 text-xs text-sev-ok">
                <CheckCircle2 size={13} />
                No blocking issues
              </span>
            ) : null}
            {(["blocking", "error", "warning", "info"] as const).map((sev) => {
              const n = counts[sev];
              if (!n) return null;
              const M = SEV_META[sev];
              const Icon = M.icon;
              return (
                <button
                  key={sev}
                  type="button"
                  onClick={() => setOpen(true)}
                  className={cn("flex items-center gap-1 text-xs", M.className)}
                >
                  <Icon size={13} />
                  <span className="numeric">{n}</span>
                  <span className="text-ink-400">{M.label.toLowerCase()}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <span className="text-xs text-ink-500">not run</span>
        )}

        <div className="flex-1" />

        <button
          type="button"
          onClick={onRun}
          disabled={running}
          className="h-6 rounded border border-ink-700 px-2 text-[11px] text-ink-300 hover:border-ink-600 hover:text-ink-100 disabled:opacity-50"
        >
          {running ? "Checking…" : "Re-run"}
        </button>
      </div>

      {open && report ? (
        <div className="max-h-56 overflow-y-auto border-t border-ink-800">
          {report.findings.length === 0 ? (
            <p className="px-3 py-4 text-xs text-ink-400">
              Every check passed for this card and product.
            </p>
          ) : (
            <ul className="divide-y divide-ink-800/60">
              {report.findings.map((f, i) => (
                <FindingRow key={i} finding={f} store={store} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function FindingRow({ finding, store }: { finding: PreflightFinding; store: EditorStore }) {
  const M = SEV_META[finding.severity];
  const Icon = M.icon;
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          if (finding.side) store.setSide(finding.side);
          if (finding.elementId) store.select([finding.elementId]);
        }}
        className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-ink-800/50"
      >
        <Icon size={13} className={cn("mt-0.5 shrink-0", M.className)} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13px] font-medium text-ink-100">{finding.title}</span>
            {finding.elementName ? (
              <span className="text-[11px] text-ink-500">{finding.elementName}</span>
            ) : null}
            <span className="rounded bg-ink-800 px-1 py-px text-[9px] uppercase tracking-wide text-ink-500">
              {finding.code}
            </span>
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-400">
            {finding.detail}
          </span>
          {finding.remedy ? (
            <span className="mt-0.5 block text-[11px] leading-relaxed text-brand-300">
              {finding.remedy}
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}
