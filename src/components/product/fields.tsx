import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * A description list for record fields. `dl`/`dt`/`dd` rather than a table:
 * these are label/value pairs of one record, not rows of a set, and a screen
 * reader announces them as pairs.
 */
export function FieldGrid({
  children,
  columns = 2,
  className,
}: {
  children: React.ReactNode;
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "grid gap-x-6 gap-y-3.5 px-4 py-3.5",
        columns === 2 && "sm:grid-cols-2",
        columns === 3 && "sm:grid-cols-2 xl:grid-cols-3",
        className,
      )}
    >
      {children}
    </dl>
  );
}

/**
 * One label/value pair. An absent value is stated as "not recorded" rather than
 * drawn as an em dash alone: on a page whose whole job is to show what is
 * missing, silence is the wrong way to say it.
 */
export function Field({
  label,
  value,
  numeric,
  wide,
  hint,
}: {
  label: string;
  value: string | number | null | undefined;
  /** Dimensions, tints, GTINs and counts get tabular figures. */
  numeric?: boolean;
  /** Span the full grid width — for long copy such as a description. */
  wide?: boolean;
  hint?: string;
}) {
  const text = value === null || value === undefined ? "" : String(value);
  const empty = text.trim().length === 0;
  return (
    <div className={cn("min-w-0", wide && "sm:col-span-full")}>
      <dt className="text-[10px] font-medium uppercase tracking-wider text-ink-500">{label}</dt>
      <dd
        className={cn(
          "mt-0.5 text-[13px] leading-relaxed",
          empty ? "text-ink-600" : "text-ink-100",
          numeric && "numeric",
        )}
      >
        {empty ? "not recorded" : text}
      </dd>
      {hint ? <dd className="mt-0.5 text-[11px] text-ink-500">{hint}</dd> : null}
    </div>
  );
}
