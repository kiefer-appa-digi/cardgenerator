import { PageHeader, Panel } from "@/components/ui/panel";
import { UploadForm } from "./upload-form";
import { requireCapability } from "@/server/auth/current";

export default async function NewImportPage() {
  const user = await requireCapability("product.import");
  return (
    <>
      <PageHeader
        title="New import"
        description="Upload an .xlsx workbook. The sheet is inspected, columns are matched to product fields, and you approve a full preview before anything is written."
      />
      <div className="p-8">
        <div className="max-w-2xl space-y-6">
          <Panel title="Workbook">
            <UploadForm orgId={user.orgId} />
          </Panel>
          <Panel title="What happens next">
            <ol className="space-y-3 px-4 py-4 text-sm leading-relaxed text-ink-300">
              <li>
                <span className="font-medium text-ink-100">1. Inspect.</span> Every
                sheet is read, the header row is detected, and a source profile is
                matched — the GS1 Data Hub export and a generic product/BOM sheet
                are both recognised.
              </li>
              <li>
                <span className="font-medium text-ink-100">2. Map.</span> Columns
                are scored against product fields. Every suggestion is shown with
                its confidence and can be overridden; a column that lost a contest
                says which column beat it.
              </li>
              <li>
                <span className="font-medium text-ink-100">3. Preview.</span> Each
                row is classified create, update, unchanged or skipped, with
                duplicate GTINs, failed check digits and non-sellable rows called
                out. Source data is never silently corrected.
              </li>
              <li>
                <span className="font-medium text-ink-100">4. Commit.</span> Only
                then is anything written, and the whole source row is kept on the
                product for provenance.
              </li>
            </ol>
          </Panel>
        </div>
      </div>
    </>
  );
}
