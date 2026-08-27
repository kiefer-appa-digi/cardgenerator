import { Panel, Badge, EmptyState } from "@/components/ui/panel";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { checkIdentifier, IDENTIFIER_LABELS, identifierOrder } from "./identifier-check";

export type IdentifierRow = {
  id: string;
  kind: string;
  value: string;
  isPrimary: boolean;
  /** The importer's verdict, kept as provenance and compared with a fresh one. */
  valid: boolean;
  validationNote: string;
};

/**
 * Identifiers with their check-digit state.
 *
 * Two columns say something different and both are needed: "Check digit" is
 * computed now, from lib/barcode/gtin.ts; "At import" is what the importer
 * recorded when the row was written. When they disagree the value changed after
 * it was imported, and that is worth seeing.
 */
export function IdentifiersPanel({
  identifiers,
  gtin14ForCard,
  upcaForCard,
}: {
  identifiers: IdentifierRow[];
  /** The GTIN-14 an ITF-14 or Digital Link would encode, or null when none resolves. */
  gtin14ForCard: string | null;
  /** The UPC-A the front of the card would encode, or null when none resolves. */
  upcaForCard: string | null;
}) {
  const rows = [...identifiers].sort(
    (a, b) => identifierOrder(a.kind) - identifierOrder(b.kind) || a.value.localeCompare(b.value),
  );

  return (
    <Panel
      title="Identifiers"
      description="Check digits are recomputed on every view; a value is never silently corrected."
    >
      {rows.length === 0 ? (
        <EmptyState
          title="No identifiers"
          description="Nothing to encode and nothing to look this product up by. Identifiers arrive with the GS1 product export — map the GTIN and U.P.C. columns on the next import."
          action={
            <Link href="/imports/new">
              <Button variant="outline" size="sm">
                Import product data
              </Button>
            </Link>
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                <th scope="col" className="px-4 py-2 font-medium">
                  Identifier
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Value
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Check digit
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  At import
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const state = checkIdentifier(r.kind, r.value);
                const agrees =
                  (state.state === "valid" || state.state === "not-applicable") === r.valid;
                return (
                  <tr key={r.id} className="border-b border-ink-800/60 align-top last:border-0">
                    <th scope="row" className="px-4 py-2.5 text-left font-normal">
                      <span className="text-[13px] text-ink-200">
                        {IDENTIFIER_LABELS[r.kind] ?? r.kind}
                      </span>
                      {r.isPrimary ? (
                        <Badge tone="brand" className="ml-2">
                          primary
                        </Badge>
                      ) : null}
                    </th>
                    <td className="numeric px-4 py-2.5 text-[13px] text-ink-100">
                      {r.value || <span className="text-ink-600">—</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      {state.state === "valid" ? (
                        <Badge tone="ok">
                          <span className="numeric">{state.found}</span> correct
                        </Badge>
                      ) : state.state === "invalid" ? (
                        <Badge tone="danger">
                          <span className="numeric">{state.found}</span> wrong · expected{" "}
                          <span className="numeric">{state.expected}</span>
                        </Badge>
                      ) : state.state === "unusable" ? (
                        <Badge tone="warning">unusable</Badge>
                      ) : (
                        <span className="text-[11px] text-ink-500">not applicable</span>
                      )}
                      <p className="mt-1 max-w-md text-[11px] leading-relaxed text-ink-500">
                        {state.note}
                      </p>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={r.valid ? "neutral" : "danger"}>
                        {r.valid ? "accepted" : "rejected"}
                      </Badge>
                      {!agrees ? (
                        <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-sev-warning">
                          The import verdict and the check recomputed now disagree. Either the
                          value was edited after it was imported or it was imported under a
                          different rule; the recomputed column is the one that governs the card.
                        </p>
                      ) : null}
                      {r.validationNote ? (
                        <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-ink-500">
                          {r.validationNote}
                        </p>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Two answers, because the retail symbol on the front and a GTIN-14
          symbol are encoded from different values and one can exist without the
          other. Stating only the GTIN-14 would promise a scannable card for a
          variable-measure product whose UPC-A element preflight will reject. */}
      <div className="space-y-1 border-t border-ink-800 px-4 py-2.5">
        {upcaForCard ? (
          <p className="text-[11px] text-ink-400">
            The UPC-A on the front encodes{" "}
            <span className="numeric text-ink-200">{upcaForCard}</span>.
          </p>
        ) : (
          <p className="text-[11px] text-sev-warning">
            No held identifier is a UPC-A, so the retail symbol on the front cannot be drawn.
          </p>
        )}
        {gtin14ForCard ? (
          <p className="text-[11px] text-ink-400">
            A GTIN-14 symbol — ITF-14 or a GS1 Digital Link QR — encodes{" "}
            <span className="numeric text-ink-200">{gtin14ForCard}</span>.
          </p>
        ) : (
          <p className="text-[11px] text-sev-warning">
            No held identifier normalises to a GTIN-14 either, so no barcode of any symbology can
            be encoded.
          </p>
        )}
      </div>
    </Panel>
  );
}
