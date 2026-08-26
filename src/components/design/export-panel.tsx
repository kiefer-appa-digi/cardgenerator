"use client";

import { useState, useTransition } from "react";
import { Download, FileCheck2, FileWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, Stat, Badge } from "@/components/ui/panel";
import { exportDesignAction } from "@/server/exports";
import type { PreflightReport } from "@/lib/preflight/types";

export function ExportPanel({
  designId,
  designName,
  presetCode,
  trim,
  fullBleed,
  status,
  revisionNumber,
  report,
  canProduction,
  canOverride,
  outputIntent,
}: {
  designId: string;
  designName: string;
  presetCode: string;
  trim: string;
  fullBleed: string;
  status: string;
  revisionNumber: number;
  report: PreflightReport | null;
  canProduction: boolean;
  canOverride: boolean;
  outputIntent: { configured: boolean; conditionName: string };
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<PreflightReport | null>(null);
  const [note, setNote] = useState("");
  const [done, setDone] = useState<{ id: string; filename: string } | null>(null);

  const run = (kind: "production" | "proof", overrideNote?: string) => {
    setError(null);
    setDone(null);
    start(async () => {
      const res = await exportDesignAction({ designId, kind, overrideNote });
      if (res.ok) {
        setBlocked(null);
        setNote("");
        setDone({ id: res.artifactId, filename: res.filename });
      } else {
        setError(res.error);
        setBlocked(res.report ?? null);
      }
    });
  };

  const counts = report?.counts;

  return (
    <div className="grid max-w-5xl gap-6 xl:grid-cols-[1fr_340px]">
      <div className="space-y-6">
        <Panel title="Production PDF" description="Two pages, front and back, on the full-bleed canvas.">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-4 text-sm">
            <Row label="Dieline" value={presetCode} />
            <Row label="Revision" value={String(revisionNumber)} />
            <Row label="Trim" value={trim} />
            <Row label="Page (full bleed)" value={fullBleed} />
            <Row label="Colour" value="DeviceCMYK, vector text and barcodes" />
            <Row label="Fonts" value="Embedded and subset" />
          </dl>
          <div className="border-t border-ink-800 px-4 py-3">
            <p className="text-[12px] leading-relaxed text-ink-400">
              {outputIntent.configured ? (
                <>
                  Output intent: <span className="text-ink-200">{outputIntent.conditionName}</span>.
                  The ICC profile configured for this deployment is embedded in the file.
                </>
              ) : (
                <>
                  No ICC output intent is configured for this deployment, so the PDF
                  is DeviceCMYK with no OutputIntent and is{" "}
                  <span className="text-ink-200">not PDF/X conformant</span>. That is
                  stated rather than papered over — see{" "}
                  <code className="text-ink-300">/docs/print-pipeline.md</code> for the
                  remaining step to a certified PDF/X file.
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2 border-t border-ink-800 px-4 py-3">
            <Button
              variant="primary"
              disabled={pending || !canProduction}
              onClick={() => run("production")}
            >
              <FileCheck2 size={14} /> {pending ? "Generating…" : "Production PDF"}
            </Button>
            <Button variant="outline" disabled={pending} onClick={() => run("proof")}>
              <FileWarning size={14} /> Proof PDF
            </Button>
          </div>
        </Panel>

        {error ? (
          <Panel title={blocked ? "Export blocked" : "Export failed"}>
            <div className="space-y-3 px-4 py-4">
              <p role="alert" className="text-sm leading-relaxed text-flag-200">
                {error}
              </p>
              {blocked && canOverride ? (
                <>
                  <label className="block">
                    <span className="mb-1 block text-[10px] uppercase tracking-wide text-ink-500">
                      Override reason (recorded in the audit log)
                    </span>
                    <textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={3}
                      placeholder="Why this artwork may go to press despite the blocking findings, and who authorised it."
                      className="w-full resize-y rounded border border-ink-700 bg-ink-850 px-2 py-1.5 text-[13px] text-ink-100 placeholder:text-ink-600 focus:border-brand-500"
                    />
                  </label>
                  <Button
                    variant="danger"
                    disabled={pending || note.trim().length < 12}
                    onClick={() => run("production", note)}
                  >
                    Override and export
                  </Button>
                </>
              ) : blocked ? (
                <p className="text-[12px] text-ink-400">
                  Only an administrator can override blocking findings.
                </p>
              ) : null}
            </div>
          </Panel>
        ) : null}

        {done ? (
          <Panel title="Export ready">
            <div className="flex items-center justify-between gap-4 px-4 py-4">
              <div className="min-w-0">
                <p className="truncate text-sm text-ink-100">{done.filename}</p>
                <p className="mt-0.5 text-[12px] text-ink-400">
                  The file was read back and checked against the expected page boxes,
                  fonts and colour spaces before it was offered to you.
                </p>
              </div>
              <a href={`/api/artifacts/${done.id}`} download>
                <Button variant="primary">
                  <Download size={14} /> Download
                </Button>
              </a>
            </div>
          </Panel>
        ) : null}
      </div>

      <div className="space-y-4">
        <Panel title="Preflight">
          {counts ? (
            <div className="grid grid-cols-2 gap-3 p-3">
              <Stat label="Blocking" value={counts.blocking} tone={counts.blocking ? "danger" : "ok"} />
              <Stat label="Errors" value={counts.error} tone={counts.error ? "warning" : "ok"} />
              <Stat label="Warnings" value={counts.warning} />
              <Stat label="Info" value={counts.info} />
            </div>
          ) : (
            <p className="px-4 py-4 text-sm text-ink-400">
              Preflight has not been stored for this revision yet. Open the editor, or
              run an export — either one records a result.
            </p>
          )}
          <div className="border-t border-ink-800 px-4 py-3">
            <Badge tone={status === "approved" ? "ok" : "neutral"}>{status.replace("_", " ")}</Badge>
            <p className="mt-2 text-[12px] leading-relaxed text-ink-400">
              {status === "approved"
                ? "This card exports its approved, frozen revision — not a later draft."
                : "This card is not approved. A proof is fine; a production export will carry a draft watermark in the proof slug and should be reviewed first."}
            </p>
          </div>
        </Panel>
        <Panel title="Proof PDF">
          <p className="px-4 py-3 text-[12px] leading-relaxed text-ink-400">
            A proof is the same artwork on a larger sheet, with a non-printing
            overlay showing trim, bleed, safe area and the clamshell cavity, plus a
            slug carrying the card name, SKU, GTIN, revision, dimensions, timestamp
            and approval status. It is never blocked by preflight — the point of a
            proof is to look at what is wrong.
          </p>
        </Panel>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className="numeric mt-0.5 text-[13px] text-ink-200">{value}</dd>
    </div>
  );
}
