import Link from "next/link";
import { requireCapability } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { gs1SettingsViewAction } from "@/server/gs1-actions";
import { PageHeader, Panel, Badge, Stat } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Gs1ConnectionForm } from "@/components/settings/gs1-connection-form";
import { Gs1CredentialPanel } from "@/components/settings/gs1-credential-panel";
import { Gs1RequestLog } from "@/components/settings/gs1-request-log";

export const dynamic = "force-dynamic";

const SYNC_LABEL: Record<string, string> = {
  pending: "differences awaiting review",
  applied: "fields accepted",
  no_changes: "nothing to accept",
  failed: "failed",
};

const SYNC_TONE: Record<string, "neutral" | "info" | "ok" | "warning" | "danger"> = {
  pending: "warning",
  applied: "ok",
  no_changes: "neutral",
  failed: "danger",
};

export default async function Gs1SettingsPage() {
  const user = await requireCapability("gs1.read");
  const editable = can(user.role, "gs1.configure");
  const view = await gs1SettingsViewAction();

  const { connection, credential, lastTest, logs, syncs } = view;
  const live = connection.enabled && connection.provider !== "disabled";

  return (
    <>
      <PageHeader
        title="GS1 connector"
        description="An optional connected service. Verification and enrichment are read-only, and nothing GS1 returns is ever written to a product without someone accepting it field by field."
        actions={
          live ? <Badge tone="ok">enabled</Badge> : <Badge tone="neutral">disabled</Badge>
        }
        meta={
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Connection"
              value={live ? "Enabled" : "Off"}
              tone={live ? "ok" : "default"}
              sub={connection.provider === "disabled" ? "no provider chosen" : connection.provider}
            />
            <Stat
              label="Credential"
              value={credential.configured ? "Stored" : "None"}
              tone={credential.configured ? "ok" : "default"}
              sub={
                credential.rotatedAt
                  ? `rotated ${new Date(credential.rotatedAt).toLocaleDateString()}`
                  : "never set"
              }
            />
            <Stat
              label="Last test"
              value={lastTest.at ? (lastTest.ok ? "Passed" : "Failed") : "—"}
              tone={lastTest.at ? (lastTest.ok ? "ok" : "warning") : "default"}
              sub={lastTest.at ? new Date(lastTest.at).toLocaleString() : "not run"}
            />
            <Stat label="Requests logged" value={logs.length} sub="most recent 50" />
          </div>
        }
      />

      <div className="space-y-6 p-8">
        {!live ? (
          <Panel title="GS1 is switched off — nothing is broken">
            <div className="space-y-3 px-4 py-4 text-sm leading-relaxed text-ink-300">
              <p>
                This is the default state and the application is complete in it. Cards, preflight,
                proofs and production exports never call GS1.
              </p>
              <div className="grid gap-4 pt-1 sm:grid-cols-2">
                <div>
                  <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
                    Still done locally
                  </h3>
                  <ul className="space-y-1 text-[13px] text-ink-300">
                    <li>GTIN and UPC check digits, validated on import and in preflight</li>
                    <li>UPC-A, EAN-13 and Code 128 symbol generation with quiet-zone checks</li>
                    <li>GS1 Digital Link URIs for QR codes, built and parsed offline</li>
                    <li>Company prefix recorded on the product record</li>
                  </ul>
                </div>
                <div>
                  <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
                    Needs a connection
                  </h3>
                  <ul className="space-y-1 text-[13px] text-ink-400">
                    <li>Confirming a GTIN is licensed to your company prefix</li>
                    <li>Pulling registry attributes to compare against a product</li>
                    <li>Publishing your own records (Data Hub only)</li>
                  </ul>
                </div>
              </div>
            </div>
          </Panel>
        ) : (
          <Panel title="Verify a product against the registry">
            <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-4">
              <p className="max-w-2xl text-sm leading-relaxed text-ink-300">
                Look up a GTIN, compare every field the registry publishes against the local
                product, and accept the differences one at a time. Nothing is applied
                automatically, and nothing is applied that was not on the comparison you were
                shown.
              </p>
              <Link href="/settings/gs1/verify">
                <Button variant="primary">Open verify &amp; enrich</Button>
              </Link>
            </div>
          </Panel>
        )}

        {lastTest.at && !lastTest.ok && lastTest.detail ? (
          <Panel title="Last connection test failed">
            <p className="px-4 py-3 text-[13px] leading-relaxed text-sev-warning">
              {lastTest.detail}
            </p>
          </Panel>
        ) : null}

        <Gs1ConnectionForm
          initial={connection}
          hasCredential={credential.configured}
          editable={editable}
        />

        <Gs1CredentialPanel
          configured={credential.configured}
          rotatedAt={credential.rotatedAt}
          keyVersion={credential.keyVersion}
          credentialKeyAvailable={credential.keyAvailable}
          authMode={connection.authMode}
          editable={editable}
        />

        {syncs.length > 0 ? (
          <Panel
            title="Verification history"
            description="What was checked, and exactly which fields a person accepted from each answer."
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                    <th scope="col" className="px-4 py-2 font-medium">
                      When
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Product
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      GTIN
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Outcome
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Accepted
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {syncs.map((s) => (
                    <tr key={s.id} className="border-b border-ink-800/60 last:border-0">
                      <td className="numeric whitespace-nowrap px-4 py-2 text-[12px] text-ink-400">
                        {new Date(s.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-2">
                        <Link
                          href={`/settings/gs1/verify?product=${s.productId}`}
                          className="numeric text-[13px] text-ink-100 hover:text-brand-300"
                        >
                          {s.partNumber || s.productId.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="numeric px-4 py-2 text-[12px] text-ink-300">{s.gtin}</td>
                      <td className="px-4 py-2">
                        <Badge tone={SYNC_TONE[s.status] ?? "neutral"}>
                          {SYNC_LABEL[s.status] ?? s.status}
                        </Badge>
                        {s.error ? (
                          <div className="mt-0.5 max-w-md text-[11px] text-flag-300">{s.error}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 text-[12px] text-ink-300">
                        {s.acceptedFields.length === 0 ? (
                          <span className="text-ink-600">nothing written</span>
                        ) : (
                          <span className="font-mono text-[11px]">{s.acceptedFields.join(", ")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ) : null}

        <Gs1RequestLog rows={logs} editable={editable} />
      </div>
    </>
  );
}
