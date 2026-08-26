"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, Images, PlugZap, Printer, SlidersHorizontal, Users } from "lucide-react";
import { cn } from "@/lib/cn";

type Item = {
  href: string;
  label: string;
  icon: typeof Building2;
  exact?: boolean;
};

const ITEMS: Item[] = [
  { href: "/settings", label: "Overview", icon: SlidersHorizontal, exact: true },
  { href: "/settings/organisation", label: "Organisation", icon: Building2 },
  { href: "/settings/output-intent", label: "Output intent", icon: Printer },
  { href: "/settings/gs1", label: "GS1 connector", icon: PlugZap },
  { href: "/settings/users", label: "Users & roles", icon: Users },
  { href: "/settings/assets", label: "Assets", icon: Images },
];

export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="sticky top-0 w-52 shrink-0 self-start p-3">
      <ul className="space-y-0.5">
        {ITEMS.map((item) => {
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
                  "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
                  active
                    ? "bg-ink-800 text-ink-50"
                    : "text-ink-400 hover:bg-ink-850 hover:text-ink-100",
                )}
              >
                <Icon size={15} strokeWidth={1.75} aria-hidden />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
