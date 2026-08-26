import * as React from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg" | "icon";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-brand-600 text-white hover:bg-brand-500 active:bg-brand-700 disabled:bg-ink-700 disabled:text-ink-400",
  secondary:
    "bg-ink-700 text-ink-100 hover:bg-ink-600 active:bg-ink-750 disabled:bg-ink-800 disabled:text-ink-500",
  ghost:
    "bg-transparent text-ink-200 hover:bg-ink-750 hover:text-ink-50 disabled:text-ink-500",
  outline:
    "border border-ink-600 bg-transparent text-ink-100 hover:bg-ink-750 hover:border-ink-500 disabled:text-ink-500",
  danger:
    "bg-flag-600 text-white hover:bg-flag-500 active:bg-flag-700 disabled:bg-ink-700 disabled:text-ink-400",
};

const SIZES: Record<Size, string> = {
  sm: "h-7 px-2.5 text-xs gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
  lg: "h-11 px-5 text-sm gap-2",
  icon: "h-8 w-8 justify-center",
};

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ className, variant = "secondary", size = "md", ...props }, ref) {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex select-none items-center rounded-md font-medium transition-colors",
          "disabled:cursor-not-allowed",
          VARIANTS[variant],
          SIZES[size],
          className,
        )}
        {...props}
      />
    );
  },
);
