"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Search } from "lucide-react";
import { Panel, Badge, EmptyState } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { ErrorNote, Field, OkNote, TextInput } from "@/components/settings/field";
import {
  acceptGs1FieldsAction,
  verifyProductGtinAction,
  type Gs1VerifyOutcome,
} from "@/server/gs1-actions";
import type { Gs1DiffKind } from "@/lib/gs1/types";
import { cn } from "@/lib/cn";

/**
 * VERIFY AND ENRICH — spec §13A.
 *
 * "Never overwrite local data automatically. Show a diff and require explicit
 * acceptance." That is the whole design of this screen:
 *
 *  - the comparison is read-only until a person ticks something;
 *  - there is no select-all and no "apply everything", because a single click
 *    that replaces approved on-pack copy with registry strings is exactly the
 *    failure the rule exists to prevent;
 *  - rows that match, and rows the registry left empty, are still listed, so
 *    the table says what was checked rather than only what disagreed.
 */

export type VerifyProduct = {
  id: string;
  partNumber: string;
  description: string;
  brandName: string;
  gtin: string;
};

const KIND_LABEL: Record<Gs1DiffKind, string> = {
  "missing-locally": "missing locally",
  conflict: "differs",
  match: "match",
  "remote-empty": "not published",
};

const KIND_TONE: Record<Gs1DiffKind, "info" | "warning" | "ok" | "neutral"> = {
  "missing-locally": "info",
  conflict: "warning",
  match: "ok",
  "remote-empty": "neutral",
};

export function Gs1Verify({
  products,
  initialProductId,
  live,
  canCheck,
  canAccept,
}: {
  products: VerifyProduct[];
  initialProductId: string | null;
  live: boolean;
  /** gs1.sync — sending a request to the registry. */
  canCheck: boolean;
  /** product.write + gs1.sync — writing an accepted field back. */
  canAccept: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [query, setQuery] = useState("");
  const [productId, setProductId] = useState<string | null>(initialProductId);
  const [gtinOverride, setGtinOverride] = useState("");
  const [outcome, setOutcome] = useState<Gs1VerifyOutcome | null>(null);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applied, setApplied] = useState<string[] | null>(null);

  const selectedProduct = products.find((p) => p.id === productId) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? products.filter(
          (p) =>
            p.partNumber.toLowerCase().includes(q) ||
            p.description.toLowerCase().includes(q) ||
            p.brandName.toLowerCase().includes(q) ||
            p.gtin.includes(q),
        )
      : products;
    return base.slice(0, 150);
  }, [products, query]);

  const acceptableCount = outcome?.diffs.filter((d) => d.acceptable).length ?? 0;

  const check = () => {
    if (!productId) return;
    setError(null);
    setOutcome(null);
    setSelected(new Set());
    setApplied(null);
    start(async () => {
      const res = await verifyProductGtinAction({
        productId,
        ...(gtinOverride.trim() === "" ? {} : { gtin: gtinOverride.trim() }),
      });
      if (res.ok) setOutcome(res.outcome);
      else setError({ message: res.error, detail: res.detail });
      router.refresh();
    });
  };

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const accept = () => {
    if (!outcome || selected.size === 0) return;
    setError(null);
    start(async () => {
      const res = await acceptGs1FieldsAction({
        syncRecordId: outcome.syncRecordId,
        paths: [...selected],
      });
      if (res.ok) {
        setApplied(res.applied);
        setSelected(new Set());
        router.refresh();
      } else {
        setError({ message: res.error });
      }
    });
  };

  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-[380px_1fr]">
        <Panel title="Product" description="The local record the registry answer is compared against.">
          <div className="border-b border-ink-800 p-3">
            <div className="relative">
              <Search
                size={14}
                aria-hidden
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-500"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search part number, description, brand or GTIN"
                aria-label="Search products"
                className="h-8 w-full rounded border border-ink-700 bg-ink-850 pl-8 pr-2 text-sm text-ink-100 placeholder:text-ink-600 focus:border-brand-500"
              />
            </div>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {filtered.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={productId === p.id}
                onClick={() => {
                  setProductId(p.id);
                  setOutcome(null);
                  setApplied(null);
                  setError(null);
                  setGtinOverride("");
                }}
                className={cn(
                  "flex w-full items-baseline gap-2 px-4 py-1.5 text-left",
                  productId === p.id ? "bg-brand-600/15" : "hover:bg-ink-800/50",
                )}
              >
                <span className="numeric w-20 shrink-0 text-[13px] text-ink-100">
                  {p.partNumber || "—"}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink-400">
                  {p.description}
                </span>
                <span className="numeric shrink-0 text-[11px] text-ink-500">{p.gtin || "no GTIN"}</span>
              </button>
            ))}
            {filtered.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-500">
                No products match &ldquo;{query}&rdquo;.
              </p>
            ) : null}
          </div>
        </Panel>

        <div className="min-w-0 space-y-6">
          <Panel title="Check">
            <div className="space-y-4 p-4">
              {selectedProduct ? (
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="numeric text-sm font-medium text-ink-100">
                    {selectedProduct.partNumber || "—"}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink-400">
                    {selectedProduct.description}
                  </span>
                  <Link
                    href={`/products/${selectedProduct.id}`}
                    className="text-xs text-brand-300 hover:text-brand-200"
                  >
                    Open product →
                  </Link>
                </div>
              ) : (
                <p className="text-sm text-ink-400">Choose a product on the left.</p>
              )}

              <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
                <Field
                  label="GTIN to check"
                  htmlFor="gtinOverride"
                  hint={
                    selectedProduct?.gtin
                      ? `Leave blank to use the product's recorded GTIN, ${selectedProduct.gtin}.`
                      : "This product has no GTIN on record, so one has to be typed here."
                  }
                >
                  <TextInput
                    id="gtinOverride"
                    numeric
                    inputMode="numeric"
                    placeholder={selectedProduct?.gtin || "00810797030124"}
                    value={gtinOverride}
                    disabled={!productId || pending}
                    onChange={(e) => setGtinOverride(e.target.value)}
                  />
                </Field>
                <Button
                  variant="primary"
                  onClick={check}
                  disabled={!productId || pending || !live || !canCheck}
                  className="sm:mb-[1.375rem]"
                >
                  {pending ? "Checking…" : "Check against GS1"}
                </Button>
              </div>

              {live && !canCheck ? (
                <p className="rounded border border-ink-700 bg-ink-900/60 px-2.5 py-2 text-[12px] leading-relaxed text-ink-400">
                  Your role can read GS1 results but cannot send a lookup. A designer or an admin
                  can run the check.
                </p>
              ) : null}

              {!live ? (
                <p className="rounded border border-ink-700 bg-ink-900/60 px-2.5 py-2 text-[12px] leading-relaxed text-ink-400">
                  The GS1 connection is switched off, so no lookup can run. Everything else on this
                  product keeps working. Turn the connector on under{" "}
                  <Link href="/settings/gs1" className="text-brand-300 hover:text-brand-200">
                    Settings → GS1 connector
                  </Link>
                  .
                </p>
              ) : null}

              {error ? (
                <div className="space-y-1.5">
                  <ErrorNote>{error.message}</ErrorNote>
                  {error.detail ? (
                    <pre className="max-h-32 overflow-auto rounded border border-ink-800 bg-ink-950 p-2 font-mono text-[11px] text-ink-400">
                      {error.detail}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </div>
          </Panel>

          {outcome ? (
            <Panel title="Registry answer">
              <div className="grid gap-4 p-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Badge
                      tone={
                        outcome.verify.status === "verified"
                          ? "ok"
                          : outcome.verify.status === "inactive"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {outcome.verify.status}
                    </Badge>
                    <span className="numeric text-[13px] text-ink-200">{outcome.gtin}</span>
                  </div>
                  <p className="text-[12px] leading-relaxed text-ink-400">
                    {outcome.verify.detail ||
                      (outcome.verify.status === "verified"
                        ? "The registry recognises this GTIN."
                        : "The registry returned no record for this GTIN.")}
                  </p>
                  <p className="numeric text-[11px] text-ink-500">
                    check digit {outcome.verify.checkDigitValid ? "valid" : "invalid"} ·{" "}
                    {outcome.attempts} request{outcome.attempts === 1 ? "" : "s"} ·{" "}
                    {outcome.durationMs} ms
                  </p>
                </div>
                <dl className="space-y-1 text-[12px]">
                  {(
                    [
                      ["Licensee", outcome.verify.company.name],
                      ["Company prefix", outcome.verify.company.gs1CompanyPrefix],
                      ["Licence status", outcome.verify.company.licenseStatus],
                      ["GLN", outcome.verify.company.gln],
                      ["Country of licence", outcome.verify.company.countryOfLicense],
                    ] as const
                  )
                    .filter(([, v]) => v !== "")
                    .map(([label, value]) => (
                      <div key={label} className="flex items-baseline justify-between gap-3">
                        <dt className="text-[11px] uppercase tracking-wider text-ink-500">{label}</dt>
                        <dd className="numeric truncate text-ink-200">{value}</dd>
                      </div>
                    ))}
                </dl>
              </div>
            </Panel>
          ) : null}

          {outcome ? (
            <Panel
              title="Field comparison"
              description="Tick only what should be written to the local product. Nothing here is applied on its own."
              actions={
                <span className="numeric text-[11px] text-ink-400">
                  {acceptableCount} of {outcome.diffs.length} differ
                </span>
              }
            >
              {outcome.diffs.length === 0 ? (
                <EmptyState
                  title="Nothing to compare"
                  description="The registry recognised the GTIN but published no attributes for it, so there is nothing to accept. The verification itself is recorded on the product's history."
                />
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                          <th scope="col" className="w-10 px-4 py-2 font-medium">
                            <span className="sr-only">Accept</span>
                          </th>
                          <th scope="col" className="px-4 py-2 font-medium">
                            Field
                          </th>
                          <th scope="col" className="px-4 py-2 font-medium">
                            Local value
                          </th>
                          <th scope="col" className="px-4 py-2 font-medium">
                            GS1 value
                          </th>
                          <th scope="col" className="px-4 py-2 font-medium">
                            State
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {outcome.diffs.map((d) => {
                          const checkboxId = `accept-${d.path.replace(/\./g, "-")}`;
                          const disabled = !d.acceptable || !canAccept || applied !== null;
                          return (
                            <tr
                              key={d.path}
                              className={cn(
                                "border-b border-ink-800/60 last:border-0",
                                !d.acceptable && "opacity-60",
                                selected.has(d.path) && "bg-brand-600/10",
                              )}
                            >
                              <td className="px-4 py-2 align-top">
                                {d.acceptable ? (
                                  <input
                                    id={checkboxId}
                                    type="checkbox"
                                    checked={selected.has(d.path)}
                                    disabled={disabled}
                                    onChange={() => toggle(d.path)}
                                    className="mt-0.5 h-4 w-4 accent-[var(--color-brand-500)] disabled:cursor-not-allowed"
                                  />
                                ) : (
                                  <span aria-hidden className="text-ink-700">
                                    —
                                  </span>
                                )}
                              </td>
                              <th scope="row" className="px-4 py-2 text-left align-top font-normal">
                                <label
                                  htmlFor={d.acceptable ? checkboxId : undefined}
                                  className="block text-[13px] text-ink-100"
                                >
                                  {d.label}
                                </label>
                                <span className="font-mono text-[10px] text-ink-600">{d.path}</span>
                              </th>
                              <td className="px-4 py-2 align-top text-[12px] text-ink-300">
                                {d.localValue || <span className="text-ink-600">empty</span>}
                              </td>
                              <td className="px-4 py-2 align-top text-[12px] text-ink-200">
                                {d.remoteValue || <span className="text-ink-600">empty</span>}
                              </td>
                              <td className="px-4 py-2 align-top">
                                <Badge tone={KIND_TONE[d.kind]}>{KIND_LABEL[d.kind]}</Badge>
                                {d.overwritesLocal ? (
                                  <div className="mt-1 text-[10px] uppercase tracking-wider text-sev-warning">
                                    overwrites
                                  </div>
                                ) : null}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-800 px-4 py-3">
                    <div className="min-w-0 text-[12px] text-ink-400">
                      {applied ? (
                        <OkNote>
                          Applied {applied.length} field{applied.length === 1 ? "" : "s"} to the
                          product. Run the check again to see the comparison as it stands now.
                        </OkNote>
                      ) : !canAccept ? (
                        "Your role can read this comparison but cannot write it to the product."
                      ) : selected.size === 0 ? (
                        "Nothing selected. Each field is accepted on its own."
                      ) : (
                        <span className="numeric">
                          {selected.size} field{selected.size === 1 ? "" : "s"} selected
                        </span>
                      )}
                    </div>
                    <Button
                      variant="primary"
                      onClick={accept}
                      disabled={pending || selected.size === 0 || !canAccept || applied !== null}
                    >
                      {pending
                        ? "Applying…"
                        : `Accept ${selected.size} field${selected.size === 1 ? "" : "s"}`}
                    </Button>
                  </div>
                </>
              )}
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  );
}
