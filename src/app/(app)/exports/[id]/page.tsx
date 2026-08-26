import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { cardTemplates, db, exportArtifacts, exportJobs, users } from "@/server/db";
import { assertSameOrg, requireUser } from "@/server/auth/current";
import { PageHeader, Panel, Badge, Stat } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { CARD_PRESETS, type CardPresetDef } from "@/lib/geometry/presets";
import { formatLength } from "@/lib/units";
import { cn } from "@/lib/cn";
import type { ComplianceStatus, ExportPageBoxes } from "@/lib/pdf/production";
import type { PdfValidationReport, ValidationCheck } from "@/lib/pdf/validate";
import type { PreflightFinding, Severity } from "@/lib/preflight/types";

export const dynamic = "force-dynamic";

/**
 * EXPORT JOB DETAIL.
 *
 * Three things are shown, and none of them are paraphrased: the manifest the run
 * wrote, the compliance status the PDF writer returned, and the post-export
 * validation checks with the values that were actually measured in the file.
 *
 * The writer's `complianceStatus.label` and its `remainingForPdfX` list are
 * printed verbatim. This screen never calls a file PDF/X-compliant — the
 * exporter does not produce conforming PDF/X and says so, and repeating that
 * honestly is the whole point of the field (spec §15, §32).
 */

const KIND_TONE: Record<string, "brand" | "info" | "neutral"> = {
  production: "brand",
  proof: "info",
  batch: "neutral",
};

const STATUS_TONE: Record<string, "ok" | "danger" | "info" | "neutral"> = {
  complete: "ok",
  failed: "danger",
  running: "info",
  queued: "neutral",
};

const CHECK_TONE = {
  pass: "ok",
  fail: "danger",
  not_applicable: "neutral",
} as const;

const SEVERITY_TONE: Record<Severity, "info" | "warning" | "danger"> = {
  info: "info",
  warning: "warning",
  error: "danger",
  blocking: "danger",
};

/** One row of the manifest written by `renderOne()` in src/server/exports.ts. */
type ManifestRow = {
  sku?: string;
  gtin?: string;
  presetCode?: string;
  template?: string;
  revision?: number;
  filename?: string;
  exportedAt?: string;
  preflight?: { blocking?: number; error?: number; warning?: number; exportable?: boolean };
  validation?: { passed?: boolean; failed?: number } | null;
  status?: string;
};

/** What `exportArtifacts.validation` holds; jsonb carries no type of its own. */
type ArtifactValidation = {
  complianceStatus?: ComplianceStatus;
  notes?: PreflightFinding[];
  pageBoxes?: ExportPageBoxes[];
  checks?: PdfValidationReport;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function ExportJobPage({ params }: PageProps<"/exports/[id]">) {
  const { id } = await params;
  const user = await requireUser();

  const [job] = await db.select().from(exportJobs).where(eq(exportJobs.id, id)).limit(1);
  if (!job) notFound();
  assertSameOrg(user, job.orgId);

  const [author] = job.createdBy
    ? await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, job.createdBy))
        .limit(1)
    : [];
  const [overrideAuthor] = job.overrideBy
    ? await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, job.overrideBy))
        .limit(1)
    : [];

  const artifacts = await db
    .select()
    .from(exportArtifacts)
    .where(and(eq(exportArtifacts.orgId, user.orgId), eq(exportArtifacts.jobId, job.id)))
    .orderBy(asc(exportArtifacts.createdAt));

  const manifest = (job.manifest ?? []) as ManifestRow[];
  const request = (job.request ?? {}) as { designId?: string; revisionId?: string };

  // The manifest stores template ids, which are meaningless to a person.
  const templateIds = [
    ...new Set(
      [...manifest.map((m) => m.template), job.templateId].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      ),
    ),
  ];
  const templateRows = templateIds.length
    ? await db
        .select({ id: cardTemplates.id, name: cardTemplates.name })
        .from(cardTemplates)
        .where(and(eq(cardTemplates.orgId, user.orgId), inArray(cardTemplates.id, templateIds)))
    : [];
  const templateNames = new Map(templateRows.map((t) => [t.id, t.name]));

  const preset = job.presetCode
    ? CARD_PRESETS[job.presetCode as CardPresetDef["code"]]
    : undefined;
  const durationMs =
    job.startedAt && job.finishedAt ? job.finishedAt.getTime() - job.startedAt.getTime() : null;

  const anyInvalid = artifacts.some((a) => a.status === "invalid");

  const title =
    artifacts.length === 1
      ? artifacts[0].filename
      : `${job.kind === "production" ? "Production" : job.kind === "proof" ? "Proof" : "Batch"} export`;

  return (
    <>
      <PageHeader
        title={title}
        description={
          job.status === "failed"
            ? "This run did not produce a file. The failure is recorded below, verbatim."
            : "The manifest, the compliance status the writer returned, and the checks the finished file was measured against."
        }
        actions={
          <>
            <Link href="/exports">
              <Button variant="ghost">All exports</Button>
            </Link>
            {request.designId ? (
              <Link href={`/designs/${request.designId}`}>
                <Button variant="outline">Open the card</Button>
              </Link>
            ) : null}
            {artifacts.length === 1 ? (
              <a href={`/api/artifacts/${artifacts[0].id}`} download>
                <Button variant="primary">Download</Button>
              </a>
            ) : null}
          </>
        }
        meta={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={KIND_TONE[job.kind] ?? "neutral"}>{job.kind}</Badge>
            <Badge tone={STATUS_TONE[job.status] ?? "neutral"}>{job.status}</Badge>
            {job.presetCode ? <Badge>{job.presetCode}</Badge> : null}
            {job.templateId ? (
              <Link
                href={`/templates/${job.templateId}`}
                className="text-xs text-brand-300 hover:text-brand-200"
              >
                {templateNames.get(job.templateId) ?? job.templateId}
              </Link>
            ) : null}
            <span className="numeric text-xs text-ink-500">
              {author?.name || author?.email || "unknown"} · {job.createdAt.toLocaleString()}
            </span>
            {preset ? (
              <span className="numeric text-xs text-ink-500">
                trim {formatLength(preset.trimWidth, "in")} ×{" "}
                {formatLength(preset.trimHeight, "in")} in · page{" "}
                {formatLength(preset.trimWidth + preset.bleed.left + preset.bleed.right, "in")} ×{" "}
                {formatLength(preset.trimHeight + preset.bleed.top + preset.bleed.bottom, "in")} in
              </span>
            ) : null}
          </div>
        }
      />

      <div className="space-y-6 p-8">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="Items"
            value={`${job.completedItems} / ${job.totalItems}`}
            sub={job.failedItems ? `${job.failedItems} failed` : "all accounted for"}
            tone={job.failedItems ? "danger" : "default"}
          />
          <Stat label="Files produced" value={artifacts.length} />
          <Stat
            label="Post-export checks"
            value={artifacts.length === 0 ? "—" : anyInvalid ? "failed" : "passed"}
            tone={artifacts.length === 0 ? "default" : anyInvalid ? "danger" : "ok"}
            sub={
              artifacts.length === 0
                ? "no file to check"
                : anyInvalid
                  ? "See the checks below"
                  : undefined
            }
          />
          <Stat
            label="Duration"
            value={durationMs === null ? "—" : `${(durationMs / 1000).toFixed(1)} s`}
            sub={job.finishedAt ? job.finishedAt.toLocaleTimeString() : "still running"}
          />
        </div>

        {job.status === "failed" && job.error ? (
          <Panel
            title="Failure"
            description="Recorded exactly as it was raised. Nothing is trimmed — the detail is the point."
          >
            <pre
              role="alert"
              className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-4 py-3.5 font-mono text-[11px] leading-relaxed text-flag-200"
            >
              {job.error}
            </pre>
          </Panel>
        ) : null}

        {job.overrideNote ? (
          <Panel title="Blocking-error override">
            <div className="space-y-2 px-4 py-3.5">
              <p className="text-[13px] leading-relaxed text-ink-200">{job.overrideNote}</p>
              <p className="text-[11px] text-ink-500">
                Recorded by {overrideAuthor?.name || overrideAuthor?.email || "unknown"}. This run
                went to press with blocking preflight findings outstanding; the same note is in the
                audit log.
              </p>
            </div>
          </Panel>
        ) : null}

        <Panel
          title="Manifest"
          description="One row per item the job wrote — spec §19. This is what a press or a records request is answered with."
        >
          {manifest.length === 0 ? (
            <p className="px-4 py-4 text-sm text-ink-400">
              This job wrote no manifest rows{job.status === "failed" ? " because it failed." : "."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                    <th scope="col" className="px-4 py-2 font-medium">
                      SKU
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      GTIN
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Dieline
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Template
                    </th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">
                      Rev
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Filename
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Exported
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Preflight
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {manifest.map((m, i) => (
                    <tr
                      key={`${m.filename ?? "row"}-${i}`}
                      className="border-b border-ink-800/60 align-top last:border-0"
                    >
                      <th scope="row" className="numeric px-4 py-2.5 text-left font-normal text-ink-100">
                        {m.sku || <span className="text-ink-600">—</span>}
                      </th>
                      <td className="numeric px-4 py-2.5 text-ink-300">
                        {m.gtin || <span className="text-ink-600">none</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        {m.presetCode ? <Badge>{m.presetCode}</Badge> : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-[12px] text-ink-300">
                        {m.template ? (
                          <Link
                            href={`/templates/${m.template}`}
                            className="hover:text-brand-300"
                          >
                            {templateNames.get(m.template) ?? m.template}
                          </Link>
                        ) : (
                          <span className="text-ink-600">Blank card</span>
                        )}
                      </td>
                      <td className="numeric px-4 py-2.5 text-right text-ink-300">
                        {m.revision ?? "—"}
                      </td>
                      <td className="px-4 py-2.5 text-[12px] text-ink-200">{m.filename ?? "—"}</td>
                      <td className="numeric px-4 py-2.5 text-[12px] text-ink-400">
                        {m.exportedAt ? new Date(m.exportedAt).toLocaleString() : "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="flex flex-wrap items-center gap-1">
                          <Badge tone={m.preflight?.blocking ? "danger" : "ok"}>
                            <span className="numeric">{m.preflight?.blocking ?? 0}</span> blocking
                          </Badge>
                          <Badge tone={m.preflight?.error ? "warning" : "neutral"}>
                            <span className="numeric">{m.preflight?.error ?? 0}</span> error
                          </Badge>
                          <Badge>
                            <span className="numeric">{m.preflight?.warning ?? 0}</span> warning
                          </Badge>
                          {m.status ? (
                            <Badge tone={m.status === "ok" ? "ok" : "danger"}>{m.status}</Badge>
                          ) : null}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {artifacts.map((artifact) => {
          const validation = (artifact.validation ?? {}) as ArtifactValidation;
          return (
            <section key={artifact.id} className="space-y-6">
              <div className="flex flex-wrap items-baseline justify-between gap-3 border-t border-ink-800 pt-6">
                <h2 className="font-display text-base font-bold text-ink-100">
                  {artifact.filename}
                </h2>
                <div className="flex items-center gap-3">
                  <span className="numeric text-[11px] text-ink-500">
                    {formatBytes(artifact.byteSize)}
                  </span>
                  <Badge tone={artifact.status === "ok" ? "ok" : "danger"}>{artifact.status}</Badge>
                  <a
                    href={`/api/artifacts/${artifact.id}`}
                    download
                    className="text-xs text-brand-300 hover:text-brand-200"
                  >
                    Download →
                  </a>
                </div>
              </div>

              {artifact.error ? (
                <p role="alert" className="text-[13px] leading-relaxed text-flag-200">
                  {artifact.error}
                </p>
              ) : null}

              <ComplianceStatusPanel status={validation.complianceStatus} />
              <PageBoxesPanel boxes={validation.pageBoxes} />
              <ValidationPanel report={validation.checks} kind={artifact.kind} />
              <ExportNotesPanel notes={validation.notes} />
            </section>
          );
        })}
      </div>
    </>
  );
}

/* ------------------------------------------------------- compliance status */

function ComplianceStatusPanel({ status }: { status: ComplianceStatus | undefined }) {
  if (!status) {
    return (
      <Panel title="Compliance status">
        <p className="px-4 py-4 text-sm text-ink-400">
          The writer recorded no compliance status for this file.
        </p>
      </Panel>
    );
  }

  const oi = status.outputIntent;

  return (
    <Panel
      title="Compliance status"
      description="Reported by the PDF writer, quoted exactly as it was returned."
    >
      <p className="border-b border-ink-800 px-4 py-3.5 text-[13px] leading-relaxed text-ink-100">
        {status.label}
      </p>

      <dl className="grid gap-x-6 gap-y-3 px-4 py-4 text-sm sm:grid-cols-2 xl:grid-cols-3">
        <Field label="Level" value={status.level} mono />
        <Field label="PDF version" value={status.pdfVersion} numeric />
        <Field label="Claims PDF/X" value={status.claimsPdfX ? "yes" : "no"} />
        <Field
          label="Colour spaces in content"
          value={status.colorSpaces.length ? status.colorSpaces.join(", ") : "none recorded"}
        />
        <Field
          label="Placed image colour spaces"
          value={
            status.placedImageColorSpaces.length
              ? status.placedImageColorSpaces.join(", ")
              : "no placed rasters"
          }
        />
        <Field label="Text" value={status.vectorText ? "live text in embedded fonts" : "rasterised"} />
        <Field
          label="Fonts"
          value={`${status.fonts.embedded} embedded, ${
            status.fonts.allSubset ? "all subset" : "not all subset"
          }`}
          numeric
        />
        <Field
          label="Substituted families"
          value={status.fontsMissing.length ? status.fontsMissing.join(", ") : "none"}
        />
        <Field label="Transparency" value={status.transparencyPresent ? "present" : "none"} />
        <Field
          label="Output intent"
          value={oi.embedded ? `${oi.conditionName} (${oi.subtype ?? "no subtype"})` : "none embedded"}
        />
        <Field label="Output intent identifier" value={oi.identifier || "none"} mono />
        <Field
          label="ICC profile"
          value={
            oi.iccByteLength
              ? `${oi.iccColorSpace ?? "unknown space"}, ${oi.iccByteLength} bytes`
              : "none"
          }
          numeric
        />
      </dl>

      {oi.reason ? (
        <p className="border-t border-ink-800 px-4 py-3 text-[12px] leading-relaxed text-ink-400">
          {oi.reason}
        </p>
      ) : null}

      {status.fonts.faces.length ? (
        <div className="border-t border-ink-800 px-4 py-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">
            Embedded faces
          </h3>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {status.fonts.faces.map((f) => (
              <li
                key={f.faceKey}
                className="rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-[11px] text-ink-300"
              >
                {f.faceKey}{" "}
                <span className="numeric font-mono text-ink-500">{f.subsetTag}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {status.spotConversions.length ? (
        <div className="border-t border-ink-800 px-4 py-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">
            Spot inks flattened to their CMYK alternate
          </h3>
          <ul className="mt-1.5 space-y-1">
            {status.spotConversions.map((s) => (
              <li key={`${s.name}-${s.tint}`} className="text-[12px] text-ink-300">
                {s.name}{" "}
                <span className="numeric text-ink-400">
                  at {(s.tint / 10).toFixed(1)} % → C {(s.alternate.c / 10).toFixed(1)} M{" "}
                  {(s.alternate.m / 10).toFixed(1)} Y {(s.alternate.y / 10).toFixed(1)} K{" "}
                  {(s.alternate.k / 10).toFixed(1)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="border-t border-ink-800 px-4 py-3.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">
          Remaining before a certified PDF/X file exists
        </h3>
        <ol className="mt-2 space-y-2">
          {status.remainingForPdfX.map((item, i) => (
            <li key={i} className="flex gap-2.5 text-[12px] leading-relaxed text-ink-300">
              <span className="numeric shrink-0 text-ink-500">{i + 1}.</span>
              <span>{item}</span>
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------- page boxes */

function PageBoxesPanel({ boxes }: { boxes: ExportPageBoxes[] | undefined }) {
  if (!boxes?.length) return null;
  return (
    <Panel
      title="Page boxes as written"
      description="Points, lower-left origin. TrimBox is where the cutter cuts."
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
              <th scope="col" className="px-4 py-2 font-medium">
                Page
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Side
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                MediaBox
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                BleedBox
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                TrimBox
              </th>
              <th scope="col" className="px-4 py-2 text-right font-medium">
                Trim (in)
              </th>
            </tr>
          </thead>
          <tbody>
            {boxes.map((b) => (
              <tr key={b.index} className="border-b border-ink-800/60 last:border-0">
                <th scope="row" className="numeric px-4 py-2 text-left font-normal text-ink-200">
                  {b.index + 1}
                </th>
                <td className="px-4 py-2 capitalize text-ink-300">{b.side}</td>
                <td className="numeric px-4 py-2 text-[12px] text-ink-400">{boxText(b.mediaBox)}</td>
                <td className="numeric px-4 py-2 text-[12px] text-ink-400">{boxText(b.bleedBox)}</td>
                <td className="numeric px-4 py-2 text-[12px] text-ink-400">{boxText(b.trimBox)}</td>
                <td className="numeric px-4 py-2 text-right text-[12px] text-ink-300">
                  {b.trimWidthIn.toFixed(5)} × {b.trimHeightIn.toFixed(5)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function boxText(b: { x: number; y: number; width: number; height: number }): string {
  return `${b.x}, ${b.y}, ${b.width}, ${b.height}`;
}

/* ------------------------------------------------------ post-export checks */

function ValidationPanel({
  report,
  kind,
}: {
  report: PdfValidationReport | undefined;
  kind: string;
}) {
  if (!report) {
    return (
      <Panel title="Post-export validation">
        <p className="px-4 py-4 text-sm leading-relaxed text-ink-400">
          {kind === "proof"
            ? "Proofs are not structurally validated: a proof carries deliberate non-printing furniture that a production check would correctly reject."
            : "No post-export validation was recorded for this file."}
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title="Post-export validation"
      description="The written file was read back and measured. Every check states what was found, what it had to be, and the tolerance applied."
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-ink-800 px-4 py-3">
        <Badge tone={report.passed ? "ok" : "danger"}>
          {report.passed ? "all checks passed" : "check failed"}
        </Badge>
        <span className="numeric text-[12px] text-ink-400">
          {report.counts.pass} pass · {report.counts.fail} fail · {report.counts.notApplicable} not
          applicable
        </span>
        <span className="numeric text-[12px] text-ink-500">
          PDF {report.headerVersion} · {report.pageCount} pages · {report.byteLength} bytes ·{" "}
          {new Date(report.ranAt).toLocaleString()}
        </span>
      </div>

      <ul className="divide-y divide-ink-800/60">
        {report.checks.map((check) => (
          <CheckRow key={check.id} check={check} />
        ))}
      </ul>

      {report.warnings.length ? (
        <div className="border-t border-ink-800 px-4 py-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">
            Validator warnings
          </h3>
          <ul className="mt-1.5 space-y-1">
            {report.warnings.map((w, i) => (
              <li key={i} className="text-[12px] leading-relaxed text-sev-warning">
                {w}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="border-t border-ink-800 px-4 py-3 text-[11px] leading-relaxed text-ink-500">
        {report.complianceNote}
      </p>
    </Panel>
  );
}

function CheckRow({ check }: { check: ValidationCheck }) {
  const measurements = Object.entries(check.measurements);
  return (
    <li className="px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={CHECK_TONE[check.status]}>{check.status.replace("_", " ")}</Badge>
        <h3 className="text-[13px] font-semibold text-ink-100">{check.title}</h3>
        <code className="font-mono text-[10px] uppercase tracking-wider text-ink-500">
          {check.id}
        </code>
      </div>

      <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-3">
        <Field label="Measured" value={check.measured} numeric />
        <Field label="Expected" value={check.expected} numeric />
        <Field label="Tolerance" value={check.tolerance} numeric />
      </dl>

      <p className="mt-2 max-w-4xl text-[12px] leading-relaxed text-ink-400">{check.detail}</p>

      {measurements.length ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {measurements.map(([k, v]) => (
            <li
              key={k}
              className="rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-[11px] text-ink-400"
            >
              {k} <span className="numeric text-ink-200">{String(v)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {check.pageResults.length ? (
        <details className="mt-2 group">
          <summary className="cursor-pointer text-[11px] uppercase tracking-wider text-ink-500 hover:text-ink-300">
            {check.pageResults.length} page result
            {check.pageResults.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 space-y-2 border-l border-ink-800 pl-3">
            {check.pageResults.map((pr) => (
              <li key={`${pr.page}-${pr.side ?? "any"}`}>
                <div className="flex items-center gap-2">
                  <span className="numeric text-[11px] text-ink-400">page {pr.page}</span>
                  {pr.side ? (
                    <span className="text-[11px] capitalize text-ink-500">{pr.side}</span>
                  ) : null}
                  <Badge tone={CHECK_TONE[pr.status]}>{pr.status.replace("_", " ")}</Badge>
                </div>
                <p className="numeric mt-0.5 text-[11px] leading-relaxed text-ink-300">
                  {pr.measured}
                </p>
                <p className="mt-0.5 max-w-3xl text-[11px] leading-relaxed text-ink-500">
                  {pr.detail}
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------ writer notes */

function ExportNotesPanel({ notes }: { notes: PreflightFinding[] | undefined }) {
  if (!notes?.length) return null;
  return (
    <Panel
      title="Findings recorded while writing"
      description="Raised by the writer itself, in the same vocabulary preflight uses."
    >
      <ul className="divide-y divide-ink-800/60">
        {notes.map((n, i) => (
          <li key={`${n.code}-${n.side ?? "doc"}-${i}`} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={SEVERITY_TONE[n.severity]}>{n.severity}</Badge>
              <span className="text-[13px] font-medium text-ink-100">{n.title}</span>
              {n.side ? (
                <span className="text-[11px] capitalize text-ink-500">{n.side}</span>
              ) : null}
              <code className="font-mono text-[10px] uppercase tracking-wider text-ink-500">
                {n.code}
              </code>
            </div>
            <p className="mt-1 max-w-4xl text-[12px] leading-relaxed text-ink-400">{n.detail}</p>
            {n.remedy ? (
              <p className="mt-1 max-w-4xl text-[12px] leading-relaxed text-ink-300">{n.remedy}</p>
            ) : null}
            {n.measurements ? (
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {Object.entries(n.measurements).map(([k, v]) => (
                  <li
                    key={k}
                    className="rounded border border-ink-700 bg-ink-900 px-1.5 py-0.5 text-[11px] text-ink-400"
                  >
                    {k} <span className="numeric text-ink-200">{String(v)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/* -------------------------------------------------------------------- bits */

function Field({
  label,
  value,
  numeric = false,
  mono = false,
}: {
  label: string;
  value: string;
  numeric?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-ink-500">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 text-[12px] leading-relaxed text-ink-200",
          numeric && "numeric",
          mono && "font-mono",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
