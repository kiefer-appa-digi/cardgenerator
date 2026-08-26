"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Boxes,
  FileStack,
  LayoutTemplate,
  LogOut,
  Package,
  Ruler,
  Settings,
  Layers,
  PackageCheck,
  Upload,
} from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { logoutAction } from "@/server/auth/actions";
import { ROLE_LABELS } from "@/server/auth/rbac";
import type { Role } from "@/server/db/schema";
import { cn } from "@/lib/cn";

type NavItem = {
  href: string;
  label: string;
  icon: typeof Boxes;
  exact?: boolean;
};

const NAV: NavItem[] = [
  { href: "/", label: "Overview", icon: Boxes, exact: true },
  { href: "/products", label: "Products", icon: Package },
  { href: "/designs", label: "Cards", icon: FileStack },
  { href: "/templates", label: "Templates", icon: LayoutTemplate },
  { href: "/presets", label: "Dielines", icon: Ruler },
  { href: "/imports", label: "Import", icon: Upload },
  { href: "/batch", label: "Batch", icon: Layers },
  { href: "/exports", label: "Exports", icon: PackageCheck },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({
  user,
  children,
}: {
  user: { name: string; email: string; role: Role };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  // The editor takes over the whole viewport; the shell gets out of its way.
  const isEditor = pathname.includes("/edit");
  if (isEditor) return <>{children}</>;

  return (
    <div className="flex h-screen overflow-hidden bg-ink-900">
      <nav
        aria-label="Primary"
        className="flex w-56 shrink-0 flex-col border-r border-ink-800 bg-ink-950"
      >
        <Link href="/" className="flex h-14 shrink-0 items-center gap-2.5 border-b border-ink-800 px-4">
          <BrandLogo variant="mark-full-color" className="h-6 w-auto" alt="" />
          <span className="font-display text-[13px] font-bold uppercase tracking-[0.14em] text-ink-200">
            Card Designer
          </span>
        </Link>

        <ul className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {NAV.map((item) => {
            const active = item.exact
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                    active
                      ? "bg-brand-600/15 text-brand-200 shadow-[inset_2px_0_0_var(--color-brand-500)]"
                      : "text-ink-300 hover:bg-ink-850 hover:text-ink-100",
                  )}
                >
                  <Icon size={16} strokeWidth={1.75} aria-hidden />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="border-t border-ink-800 p-3">
          <div className="truncate text-[13px] font-medium text-ink-200">{user.name}</div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-300">
              {ROLE_LABELS[user.role]}
            </span>
          </div>
          <form action={logoutAction}>
            <button
              type="submit"
              className="mt-2.5 flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-xs text-ink-400 transition-colors hover:text-ink-100"
            >
              <LogOut size={14} strokeWidth={1.75} aria-hidden />
              Sign out
            </button>
          </form>
        </div>
      </nav>

      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
