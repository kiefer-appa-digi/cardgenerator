import Link from "next/link";
import { Badge } from "@/components/ui/panel";
import type { PresetDiscrepancy } from "@/lib/geometry/presets";
import { formatLength, inToUpt } from "@/lib/units";

/**
 * SOURCE CONFLICTS
 *
 * The supplied Sinclair & Rush drawings and the specification do not always
 * agree. Spec §2 settles it: the preset is authoritative and the CAD numbers are
 * kept as reference metadata, so this table reports the difference rather than
 * reconciling it. A positive delta means the card we would print is LARGER than
 * the drawing allows, which is the direction that jams a clamshell.
 *
 * `presetDiscrepancies()` returns inches as plain numbers; they are converted
 * back to µpt so every figure on screen still comes out of `formatLength` and
 * reads identically to the dimension tables.
 */

const inches = (n: number) => formatLength(inToUpt(n), "in");
const mm = (n: number) => formatLength(inToUpt(n), "mm");

export function DiscrepancyTable({
  rows,
  showPreset = true,
}: {
  rows: PresetDiscrepancy[];
  showPreset?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      {/* A minimum width, so a narrow panel scrolls the table sideways instead
          of squeezing "Reading" into a one-word-per-line column. */}
      <table className="w-full min-w-[64rem] text-sm">
        <caption className="sr-only">
          Every numeric disagreement between the authoritative card presets and the supplied CAD
          drawings.
        </caption>
        <thead>
          <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
            {showPreset ? (
              <th scope="col" className="px-4 py-2 font-medium">
                Dieline
              </th>
            ) : null}
            <th scope="col" className="px-4 py-2 font-medium">
              Measure
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              Preset (in)
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              CAD (in)
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              Δ (in)
            </th>
            <th scope="col" className="px-4 py-2 text-right font-medium">
              Δ (mm)
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Reading
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d, i) => {
            const larger = d.deltaIn > 0;
            return (
              <tr
                key={`${d.preset}-${d.field}-${i}`}
                className="border-b border-ink-800/60 align-top last:border-0"
              >
                {showPreset ? (
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/presets/${d.preset}`}
                      className="numeric font-medium text-ink-100 hover:text-brand-300"
                    >
                      {d.preset}
                    </Link>
                  </td>
                ) : null}
                <th
                  scope="row"
                  className="whitespace-nowrap px-4 py-2.5 text-left font-normal text-ink-200"
                >
                  {d.field}
                </th>
                <td className="numeric px-4 py-2.5 text-right font-medium text-ink-50">
                  {inches(d.authoritativeIn)}
                </td>
                <td className="numeric px-4 py-2.5 text-right text-ink-300">{inches(d.cadIn)}</td>
                <td
                  className={
                    larger
                      ? "numeric px-4 py-2.5 text-right font-medium text-sev-warning"
                      : "numeric px-4 py-2.5 text-right font-medium text-ink-200"
                  }
                >
                  {larger ? "+" : ""}
                  {inches(d.deltaIn)}
                </td>
                <td className="numeric px-4 py-2.5 text-right text-ink-400">
                  {larger ? "+" : ""}
                  {mm(d.deltaIn)}
                </td>
                <td className="w-[24rem] max-w-md px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={d.severity === "warning" ? "warning" : "info"}>
                      {larger ? "card larger" : "card smaller"}
                    </Badge>
                    {d.severity === "warning" ? <Badge tone="neutral">review</Badge> : null}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-ink-400">{d.note}</p>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
