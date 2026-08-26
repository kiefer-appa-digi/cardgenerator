import Link from "next/link";
import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { cn } from "@/lib/cn";
import { summariseReadiness, type ReadinessCheck } from "./readiness";

/**
 * The first thing on the product page, on purpose.
 *
 * A designer who opens a product is about to decide whether to start a card. The
 * answer to that question is here, stated before any of the data that would let
 * them work it out for themselves.
 */
export function ReadinessPanel({ checks }: { checks: ReadinessCheck[] }) {
  const summary = summariseReadiness(checks);

  const headline = !summary.ready
    ? `This product cannot produce a card yet — ${summary.blocking} blocking ${
        summary.blocking === 1 ? "gap" : "gaps"
      }`
    : summary.warnings
      ? `Ready to produce a card, with ${summary.warnings} ${
          summary.warnings === 1 ? "gap" : "gaps"
        } a template would leave empty`
      : "Ready to produce a card";

  return (
    <Panel
      className={cn(
        !summary.ready && "border-flag-700/60",
        summary.ready && summary.warnings > 0 && "border-amber-700/40",
      )}
    >
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3",
          !summary.ready
            ? "border-flag-800/60 bg-flag-600/10"
            : summary.warnings
              ? "border-amber-800/40 bg-amber-500/[0.06]"
              : "border-ink-800 bg-emerald-500/[0.05]",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          {!summary.ready ? (
            <CircleX size={16} strokeWidth={1.75} className="shrink-0 text-sev-blocking" aria-hidden />
          ) : summary.warnings ? (
            <TriangleAlert size={16} strokeWidth={1.75} className="shrink-0 text-sev-warning" aria-hidden />
          ) : (
            <CircleCheck size={16} strokeWidth={1.75} className="shrink-0 text-sev-ok" aria-hidden />
          )}
          <h2 className="text-[13px] font-semibold text-ink-100">{headline}</h2>
        </div>
        <p className="numeric text-[11px] text-ink-400">
          {checks.filter((c) => c.ok).length} of {checks.length} checks satisfied
        </p>
      </div>

      <ul className="divide-y divide-ink-800/60">
        {checks.map((c) => (
          <li key={c.key} className="flex items-start gap-3 px-4 py-2.5">
            <span className="mt-0.5 shrink-0" aria-hidden>
              {c.ok ? (
                <CircleCheck size={14} strokeWidth={1.75} className="text-sev-ok" />
              ) : c.severity === "blocking" ? (
                <CircleX size={14} strokeWidth={1.75} className="text-sev-blocking" />
              ) : (
                <TriangleAlert size={14} strokeWidth={1.75} className="text-sev-warning" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
                <span className="text-[13px] font-medium text-ink-100">{c.label}</span>
                <span className="numeric min-w-0 truncate text-[12px] text-ink-400">
                  {c.evidence}
                </span>
                <span className="sr-only">
                  {c.ok ? "satisfied" : c.severity === "blocking" ? "blocking" : "warning"}
                </span>
              </div>
              {c.problem ? (
                <p className="mt-0.5 text-[12px] leading-relaxed text-ink-400">
                  {c.problem}
                  {c.remedy ? (
                    <>
                      {" "}
                      <Link
                        href={c.remedy.href}
                        className="whitespace-nowrap text-brand-300 hover:text-brand-200"
                      >
                        {c.remedy.label} →
                      </Link>
                    </>
                  ) : null}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
