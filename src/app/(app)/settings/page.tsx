import type { ReactNode } from "react";
import Link from "next/link";
import { eq, sql } from "drizzle-orm";
import { assets, db, gs1Connections, users } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { loadOrgSettings } from "@/server/render";
import { hasCredentialKey } from "@/server/crypto";
import { storageMode } from "@/server/storage";
import { PageHeader, Panel, Badge } from "@/components/ui/panel";
import { DefRow } from "@/components/settings/field";
import { formatLength } from "@/lib/units";

export const dynamic = "force-dynamic";

type Card = {
  href: string;
  title: string;
  description: string;
  state: ReactNode;
  facts: Array<[string, string]>;
};

export default async function SettingsPage() {
  const user = await requireUser();
  const settings = await loadOrgSettings(user.orgId);

  const [connection] = await db
    .select()
    .from(gs1Connections)
    .where(eq(gs1Connections.orgId, user.orgId))
    .limit(1);

  const [userCounts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`(count(*) filter (where ${users.active}))::int`,
      admins: sql<number>`(count(*) filter (where ${users.role} = 'admin' and ${users.active}))::int`,
    })
    .from(users)
    .where(eq(users.orgId, user.orgId));

  const [assetCounts] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(assets)
    .where(eq(assets.orgId, user.orgId));

  const gs1Live = Boolean(connection?.enabled) && (connection?.provider ?? "disabled") !== "disabled";
  const intentConfigured = Boolean(settings.outputIntent.iccBase64);

  const cards: Card[] = [
    {
      href: "/settings/organisation",
      title: "Organisation",
      description: "Black rules, preflight thresholds and the export policy.",
      state: <Badge tone="brand">{settings.profile.name}</Badge>,
      facts: [
        ["Ink limit", `${(Math.min(settings.blackRules.totalAreaCoverageLimit, settings.profile.inkLimit) / 10).toFixed(0)} %`],
        ["Minimum image DPI", String(settings.profile.minImageDpi)],
        [
          "Rich-black text floor",
          `${formatLength(Math.max(settings.blackRules.richBlackMinTextSize, settings.profile.richBlackMinTextSize), "pt")} pt`,
        ],
        ["Errors block export", settings.treatErrorAsBlocking ? "Yes" : "No"],
      ],
    },
    {
      href: "/settings/output-intent",
      title: "Output intent",
      description: "The printing condition production PDFs are tied to.",
      state: intentConfigured ? (
        <Badge tone="ok">profile embedded</Badge>
      ) : (
        <Badge tone="warning">no profile</Badge>
      ),
      facts: [
        ["Condition", settings.outputIntent.conditionName],
        ["Identifier", settings.outputIntent.identifier],
        ["PDF/X", "Never claimed — see the page"],
      ],
    },
    {
      href: "/settings/gs1",
      title: "GS1 connector",
      description: "Optional. Verification and enrichment, never automatic.",
      state: gs1Live ? <Badge tone="ok">enabled</Badge> : <Badge tone="neutral">disabled</Badge>,
      facts: [
        ["Provider", connection?.provider ?? "disabled"],
        ["Credential", (connection?.credentialCiphertext ?? "") !== "" ? "Stored" : "None"],
        [
          "Last test",
          connection?.lastTestAt
            ? `${connection.lastTestOk ? "Passed" : "Failed"} ${connection.lastTestAt.toLocaleDateString()}`
            : "Not run",
        ],
      ],
    },
    {
      href: "/settings/users",
      title: "Users & roles",
      description: "Who has access, and exactly what each role can do.",
      state: <Badge tone="neutral">{userCounts?.active ?? 0} active</Badge>,
      facts: [
        ["Members", String(userCounts?.total ?? 0)],
        ["Admins", String(userCounts?.admins ?? 0)],
        ["Your role", user.role],
      ],
    },
    {
      href: "/settings/assets",
      title: "Assets",
      description: "Uploaded artwork, with the measurements preflight uses.",
      state: <Badge tone="neutral">{assetCounts?.total ?? 0} files</Badge>,
      facts: [
        ["Storage", storageMode() === "vercel-blob" ? "Vercel Blob (private)" : "Local disk"],
        ["Served", "Through the app, org-checked"],
      ],
    },
  ];

  return (
    <>
      <PageHeader
        title="Settings"
        description="Everything that changes how this organisation's cards are produced: the numbers preflight enforces, the printing condition exports declare, the GS1 connection and who can do what."
      />

      <div className="space-y-6 p-8">
        <div className="grid gap-4 xl:grid-cols-2">
          {cards.map((card) => (
            <Link
              key={card.href}
              href={card.href}
              className="group rounded-panel border border-ink-800 bg-ink-850/60 transition-colors hover:border-ink-700 hover:bg-ink-850"
            >
              <div className="flex items-start justify-between gap-3 border-b border-ink-800 px-4 py-3">
                <div className="min-w-0">
                  <h2 className="text-[13px] font-semibold text-ink-100 group-hover:text-brand-200">
                    {card.title}
                  </h2>
                  <p className="mt-0.5 text-xs text-ink-400">{card.description}</p>
                </div>
                <div className="shrink-0">{card.state}</div>
              </div>
              <div>
                {card.facts.map(([label, value]) => (
                  <DefRow key={label} label={label} value={value} numeric />
                ))}
              </div>
            </Link>
          ))}
        </div>

        <Panel
          title="Deployment"
          description="Facts about this installation, not settings. Stated so nothing on the screens above has to be guessed at."
        >
          <div className="grid sm:grid-cols-2">
            <div>
              <DefRow
                label="Credential encryption"
                value={
                  hasCredentialKey()
                    ? "CREDENTIAL_KEY is set — connector credentials can be stored"
                    : "CREDENTIAL_KEY is missing — connector credentials cannot be stored"
                }
              />
              <DefRow
                label="Asset storage"
                value={storageMode() === "vercel-blob" ? "Vercel Blob, private" : "Local disk under .data/blob"}
              />
            </div>
            <div className="border-t border-ink-800/60 sm:border-l sm:border-t-0">
              <DefRow
                label="Malware scanning"
                value="No scanner configured — uploads record 'skipped'"
              />
              <DefRow
                label="Audit trail"
                value={can(user.role, "audit.read") ? "Readable by your role" : "Not readable by your role"}
              />
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}
