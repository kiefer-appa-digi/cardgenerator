import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * Form primitives for the settings screens.
 *
 * Every control is labelled by a real <label for>, not a placeholder: these are
 * press tolerances and credentials, and a screen reader user has to be able to
 * tell an ink limit from a DPI threshold. Numeric inputs carry `.numeric` so a
 * transposed digit is visible at a glance.
 */

export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: React.ReactNode;
  htmlFor: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <label
        htmlFor={htmlFor}
        className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-ink-400"
      >
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 text-[11px] leading-relaxed text-ink-500">{hint}</p> : null}
    </div>
  );
}

const CONTROL =
  "h-8 w-full rounded border border-ink-700 bg-ink-850 px-2 text-sm text-ink-100 " +
  "placeholder:text-ink-600 focus:border-brand-500 disabled:cursor-not-allowed disabled:text-ink-500";

export function TextInput({
  className,
  numeric,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { numeric?: boolean }) {
  return <input {...props} className={cn(CONTROL, numeric && "numeric", className)} />;
}

export function TextArea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        CONTROL,
        "h-auto min-h-16 resize-y py-1.5 leading-relaxed",
        className,
      )}
    />
  );
}

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cn(CONTROL, "pr-6", className)}>
      {children}
    </select>
  );
}

/**
 * A checkbox with its explanation attached. Policy switches are the settings a
 * person is most likely to misread, so the consequence is written next to the
 * control rather than in a tooltip.
 */
export function CheckboxField({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  description: React.ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-brand-500)] disabled:cursor-not-allowed"
      />
      <div className="min-w-0">
        <label htmlFor={id} className="block text-[13px] font-medium text-ink-100">
          {label}
        </label>
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-500">{description}</p>
      </div>
    </div>
  );
}

/** Read-only fact row, used wherever a value is stated rather than edited. */
export function DefRow({
  label,
  value,
  numeric,
}: {
  label: string;
  value: React.ReactNode;
  numeric?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-ink-800/60 px-4 py-2 last:border-0">
      <span className="shrink-0 text-[11px] uppercase tracking-wider text-ink-500">{label}</span>
      <span className={cn("min-w-0 truncate text-[13px] text-ink-200", numeric && "numeric")}>
        {value}
      </span>
    </div>
  );
}

/** Inline error, consistent with the design form's alert treatment. */
export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded border border-flag-800 bg-flag-900/30 px-2.5 py-1.5 text-[12px] leading-relaxed text-flag-200"
    >
      {children}
    </p>
  );
}

export function OkNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded border border-emerald-800/50 bg-emerald-500/10 px-2.5 py-1.5 text-[12px] leading-relaxed text-sev-ok">
      {children}
    </p>
  );
}
