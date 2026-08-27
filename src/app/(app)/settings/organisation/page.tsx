import { requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { loadOrgSettings } from "@/server/render";
import { PageHeader, Panel, Badge } from "@/components/ui/panel";
import { DefRow } from "@/components/settings/field";
import { OrganisationForm } from "@/components/settings/organisation-form";
import { formatColor } from "@/lib/color/types";
import { formatLength } from "@/lib/units";

export const dynamic = "force-dynamic";

export default async function OrganisationSettingsPage() {
  const user = await requireUser();
  const editable = can(user.role, "org.manage");
  const settings = await loadOrgSettings(user.orgId);

  // Two controls govern each of these; the pipeline enforces one number. Which
  // one it is, is stated here rather than left for someone to discover in a
  // preflight finding.
  const effectiveInkLimit = Math.min(
    settings.blackRules.totalAreaCoverageLimit,
    settings.profile.inkLimit,
  );
  const effectiveRichBlackText = Math.max(
    settings.blackRules.richBlackMinTextSize,
    settings.profile.richBlackMinTextSize,
  );

  return (
    <>
      <PageHeader
        title="Organisation"
        description="Black handling, the preflight thresholds every card is judged against, and what stops a production export."
        actions={
          editable ? null : <Badge tone="neutral">read-only for your role</Badge>
        }
      />

      <div className="max-w-5xl space-y-6 p-8">
        <Panel
          title="In force now"
          description="What the preflight engine and the PDF writer actually use."
        >
          <div className="grid sm:grid-cols-2">
            <div>
              <DefRow label="Text black" value={formatColor(settings.blackRules.textBlack)} numeric />
              <DefRow label="Rich black" value={formatColor(settings.blackRules.richBlack)} numeric />
              <DefRow
                label="Ink limit enforced"
                value={`${(effectiveInkLimit / 10).toFixed(1)} %`}
                numeric
              />
              <DefRow
                label="Rich-black text floor"
                value={`${formatLength(effectiveRichBlackText, "pt")} pt`}
                numeric
              />
            </div>
            <div className="border-t border-ink-800/60 sm:border-l sm:border-t-0">
              <DefRow label="Preflight profile" value={settings.profile.name} />
              <DefRow
                label="Image resolution"
                value={`${settings.profile.minImageDpi} min · ${settings.profile.criticalImageDpi} critical`}
                numeric
              />
              <DefRow
                label="Errors block export"
                value={settings.treatErrorAsBlocking ? "Yes" : "No — blocking findings only"}
              />
              <DefRow
                label="Admin override"
                value={settings.allowOverride ? "Permitted, with an audited note" : "Not permitted"}
              />
            </div>
          </div>
        </Panel>

        <OrganisationForm
          editable={editable}
          initial={{
            blackRules: {
              textBlack: settings.blackRules.textBlack,
              richBlack: settings.blackRules.richBlack,
              totalAreaCoverageLimit: settings.blackRules.totalAreaCoverageLimit,
              richBlackMinTextSize: settings.blackRules.richBlackMinTextSize,
            },
            preflightProfile: {
              name: settings.profile.name,
              minImageDpi: settings.profile.minImageDpi,
              criticalImageDpi: settings.profile.criticalImageDpi,
              bleedCoverageBps: settings.profile.bleedCoverageBps,
              inkLimit: settings.profile.inkLimit,
              barcodeMinMagnificationBps: settings.profile.barcodeMinMagnificationBps,
              barcodeMaxMagnificationBps: settings.profile.barcodeMaxMagnificationBps,
              barcodeMinContrast: settings.profile.barcodeMinContrast,
              richBlackMinTextSize: settings.profile.richBlackMinTextSize,
            },
            exportPolicy: {
              treatErrorAsBlocking: settings.treatErrorAsBlocking,
              allowOverride: settings.allowOverride,
            },
          }}
        />
      </div>
    </>
  );
}
