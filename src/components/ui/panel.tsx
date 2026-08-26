import * as React from "react";
import { cn } from "@/lib/cn";

export function PageHeader({
  title,
  description,
  actions,
  meta,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
}) {
  return (
    <header className="border-b border-ink-800 bg-ink-950/60 px-8 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-display text-xl font-bold tracking-tight text-ink-50">{title}</h1>
          {description ? (
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-400">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {meta ? <div className="mt-4">{meta}</div> : null}
    </header>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-panel border border-ink-800 bg-ink-850/60 shadow-[0_1px_0_rgba(255,255,255,0.02)_inset]",
        className,
      )}
    >
      {title ? (
        <div className="flex items-center justify-between gap-3 border-b border-ink-800 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold text-ink-100">{title}</h2>
            {description ? <p className="mt-0.5 text-xs text-ink-400">{description}</p> : null}
          </div>
          {actions}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <h3 className="text-sm font-semibold text-ink-200">{title}</h3>
      <p className="mt-1.5 max-w-md text-sm leading-relaxed text-ink-400">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "default" | "warning" | "danger" | "ok";
}) {
  const tones = {
    default: "text-ink-50",
    warning: "text-sev-warning",
    danger: "text-sev-blocking",
    ok: "text-sev-ok",
  } as const;
  return (
    <div className="rounded-panel border border-ink-800 bg-ink-850/60 px-4 py-3.5">
      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-400">{label}</div>
      <div className={cn("numeric mt-1.5 font-display text-2xl font-bold", tones[tone])}>
        {value}
      </div>
      {sub ? <div className="mt-1 text-xs text-ink-400">{sub}</div> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "brand" | "ok" | "warning" | "danger" | "info";
  className?: string;
}) {
  const tones = {
    neutral: "bg-ink-800 text-ink-300 border-ink-700",
    brand: "bg-brand-600/15 text-brand-200 border-brand-700/50",
    ok: "bg-emerald-500/10 text-sev-ok border-emerald-700/40",
    warning: "bg-amber-500/10 text-sev-warning border-amber-700/40",
    danger: "bg-flag-600/15 text-flag-300 border-flag-700/50",
    info: "bg-sky-500/10 text-sev-info border-sky-700/40",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
