import { Fragment } from "react";
import { Check, Minus } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { CAPABILITIES, ROLE_DESCRIPTIONS, ROLE_LABELS, can, type Capability } from "@/server/auth/rbac";
import { ROLES } from "@/server/db/schema";

/**
 * The capability matrix, rendered straight from `@/server/auth/rbac`.
 *
 * It is generated from the same table the server actions call, not written out
 * by hand, so it cannot drift from what the system actually enforces. If a
 * capability is added to the table it appears here on the next render.
 */

const CAPABILITY_LABELS: Record<Capability, string> = {
  "product.read": "View products",
  "product.write": "Create and edit products",
  "product.import": "Import product workbooks",
  "design.read": "View cards",
  "design.write": "Create and edit cards",
  "design.submit": "Submit a card for review",
  "design.approve": "Approve or reject a card",
  "template.read": "View templates",
  "template.write": "Create and edit templates",
  "export.proof": "Export a proof PDF",
  "export.production": "Export a production PDF",
  "export.override_blocking": "Force an export past a blocking finding",
  "asset.upload": "Upload and delete assets",
  "gs1.read": "See GS1 status and results",
  "gs1.configure": "Change the GS1 connection and credential",
  "gs1.sync": "Run a GS1 lookup and accept fields",
  "org.manage": "Change organisation settings and users",
  "audit.read": "Read the audit trail",
};

const GROUP_LABELS: Record<string, string> = {
  product: "Products",
  design: "Cards",
  template: "Templates",
  export: "Export",
  asset: "Assets",
  gs1: "GS1",
  org: "Organisation",
  audit: "Audit",
};

function groupOf(capability: Capability): string {
  return capability.split(".")[0];
}

export function CapabilityMatrix() {
  const groups: Array<[string, Capability[]]> = [];
  for (const capability of CAPABILITIES) {
    const key = groupOf(capability);
    const last = groups[groups.length - 1];
    if (last && last[0] === key) last[1].push(capability);
    else groups.push([key, [capability]]);
  }

  return (
    <Panel
      title="What each role can do"
      description="Enforced by every server action and route handler. Hiding a button is never the control."
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">
            Capabilities granted to each role in this organisation
          </caption>
          <thead>
            <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
              <th scope="col" className="px-4 py-2 font-medium">
                Capability
              </th>
              {ROLES.map((role) => (
                <th key={role} scope="col" className="px-4 py-2 text-center font-medium">
                  {ROLE_LABELS[role]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(([group, capabilities]) => (
              <Fragment key={group}>
                <tr className="border-b border-ink-800/60 bg-ink-900/40">
                  <th
                    scope="colgroup"
                    colSpan={ROLES.length + 1}
                    className="px-4 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wider text-ink-500"
                  >
                    {GROUP_LABELS[group] ?? group}
                  </th>
                </tr>
                {capabilities.map((capability) => (
                  <tr key={capability} className="border-b border-ink-800/40 last:border-0">
                    <th scope="row" className="px-4 py-1.5 text-left font-normal">
                      <span className="text-[13px] text-ink-200">
                        {CAPABILITY_LABELS[capability]}
                      </span>
                      <span className="ml-2 font-mono text-[10px] text-ink-600">{capability}</span>
                    </th>
                    {ROLES.map((role) => {
                      const allowed = can(role, capability);
                      return (
                        <td key={role} className="px-4 py-1.5 text-center">
                          <span className="sr-only">
                            {allowed ? "Allowed" : "Not allowed"} for {ROLE_LABELS[role]}
                          </span>
                          {allowed ? (
                            <Check size={14} aria-hidden strokeWidth={2.25} className="inline text-sev-ok" />
                          ) : (
                            <Minus size={14} aria-hidden className="inline text-ink-700" />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 border-t border-ink-800 px-4 py-3 sm:grid-cols-2 xl:grid-cols-4">
        {ROLES.map((role) => (
          <div key={role}>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-300">
              {ROLE_LABELS[role]}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
              {ROLE_DESCRIPTIONS[role]}
            </p>
          </div>
        ))}
      </div>
    </Panel>
  );
}
