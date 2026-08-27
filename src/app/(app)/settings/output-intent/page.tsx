import { eq } from "drizzle-orm";
import { db, organizations } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import { can } from "@/server/auth/rbac";
import { loadOrgSettings } from "@/server/render";
import { PageHeader, Panel, Badge } from "@/components/ui/panel";
import {
  OutputIntentForm,
  type OutputIntentView,
} from "@/components/settings/output-intent-form";
import type { OutputIntentMeta } from "@/server/settings";

export const dynamic = "force-dynamic";

export default async function OutputIntentPage() {
  const user = await requireUser();
  const editable = can(user.role, "org.manage");
  const settings = await loadOrgSettings(user.orgId);

  // The upload metadata sits beside the intent so the intent itself stays
  // exactly the shape the PDF writer parses.
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, user.orgId))
    .limit(1);
  const meta = ((org?.settings ?? {}) as Record<string, unknown>).outputIntentMeta as
    | OutputIntentMeta
    | null
    | undefined;

  const configured = Boolean(settings.outputIntent.iccBase64);
  const view: OutputIntentView = {
    identifier: settings.outputIntent.identifier,
    conditionName: settings.outputIntent.conditionName,
    registryName: settings.outputIntent.registryName,
    info: settings.outputIntent.info,
    profile: configured && meta ? meta : null,
  };

  return (
    <>
      <PageHeader
        title="Output intent"
        description="The printing condition production PDFs are tied to. Supplied by the printer — this application never invents one."
        actions={
          configured ? (
            <Badge tone="ok">profile embedded</Badge>
          ) : (
            <Badge tone="warning">no profile</Badge>
          )
        }
      />

      <div className="max-w-4xl space-y-6 p-8">
        <Panel title={configured ? "What exports do now" : "What exports do without a profile"}>
          <div className="space-y-3 px-4 py-4 text-sm leading-relaxed text-ink-300">
            {configured ? (
              <>
                <p>
                  Production exports embed{" "}
                  <span className="text-ink-100">{settings.outputIntent.conditionName}</span> as the
                  file&rsquo;s <span className="font-mono text-[12px] text-ink-200">/OutputIntent</span>,
                  with the ICC profile written into the document. The CMYK numbers in the file are
                  now tied to a stated printing condition.
                </p>
                <p>
                  That still does not make the file conforming PDF/X, and nothing in this
                  application claims it does. The exporter writes no XMP metadata, so a certified
                  PDF/X-4 file needs a conversion and verification pass — Ghostscript with a PDF/X
                  definition, callas pdfToolbox, or an Acrobat preflight profile — after export.
                </p>
              </>
            ) : (
              <>
                <p>
                  No ICC profile is configured, so every production PDF is written as DeviceCMYK
                  with <span className="text-ink-100">no OutputIntent at all</span>. The ink values
                  are real and exact, but they are not tied to any printing condition, so nothing in
                  the file says what those numbers should look like on paper.
                </p>
                <p>
                  A file with no OutputIntent{" "}
                  <span className="text-ink-100">is not PDF/X and is not being called PDF/X</span>.
                  Every production export raises an{" "}
                  <span className="font-mono text-[12px] text-ink-200">OUTPUT_INTENT_MISSING</span>{" "}
                  warning saying exactly this, rather than shipping a file that looks compliant.
                </p>
                <p className="text-ink-400">
                  To fix it: ask the printer which condition they will run, get the matching ICC
                  profile from them, and upload it below. Writing an identifier such as
                  &ldquo;FOGRA39&rdquo; without the profile would name a condition the file cannot
                  point at, so the exporter ignores it.
                </p>
              </>
            )}
          </div>
        </Panel>

        <OutputIntentForm initial={view} configured={configured} editable={editable} />

        <Panel title="Related">
          <div className="px-4 py-3 text-[12px] leading-relaxed text-ink-400">
            The full account of what this pipeline does and does not guarantee — colour handling,
            spot inks, placed RGB rasters, font embedding — is in{" "}
            <span className="font-mono text-ink-300">/docs/print-pipeline.md</span> in the
            repository.
          </div>
        </Panel>
      </div>
    </>
  );
}
