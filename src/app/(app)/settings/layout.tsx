import { SettingsNav } from "@/components/settings/settings-nav";

/**
 * Settings keeps its own column of navigation so a person changing an ink limit
 * can move to the output intent without going back to the top-level shell.
 */
export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return (
    <div className="flex min-h-full">
      <div className="shrink-0 border-r border-ink-800 bg-ink-950/40">
        <SettingsNav />
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
