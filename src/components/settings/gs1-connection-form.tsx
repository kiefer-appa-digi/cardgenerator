"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Panel, Badge } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { ErrorNote, Field, OkNote, Select, TextInput } from "@/components/settings/field";
import { saveGs1ConnectionAction, setGs1EnabledAction, testGs1ConnectionAction } from "@/server/gs1-actions";
import { GS1_AUTH_MODES, GS1_PROVIDERS, type Gs1ConnectionTest } from "@/lib/gs1/types";

/**
 * The GS1 connection settings (spec §13B).
 *
 * The credential is not on this form — it has its own panel because it is
 * write-only and this one is not. Saving the connection can never blank a
 * stored key, and the two panels state their own state separately so neither
 * can imply something about the other.
 */

const PROVIDER_LABELS: Record<(typeof GS1_PROVIDERS)[number], string> = {
  disabled: "Disabled — no GS1 connection",
  "gs1us-verified": "Verified by GS1 — registry lookup",
  "gs1us-datahub": "GS1 US Data Hub — manage your own records",
  custom: "Custom endpoint",
};

const PROVIDER_NOTES: Record<(typeof GS1_PROVIDERS)[number], string> = {
  disabled:
    "The application works fully in this state. Cards, preflight and exports never call GS1; GTIN check digits are still validated locally.",
  "gs1us-verified":
    "Read-only. Confirms a GTIN is licensed and returns the attributes the registry publishes. It cannot publish your records.",
  "gs1us-datahub":
    "Brand-owner access. Adds the ability to publish your own records, in addition to lookup.",
  custom:
    "A deployment-supplied endpoint that speaks the same shapes. Every operation is attempted until the endpoint says otherwise.",
};

const AUTH_LABELS: Record<(typeof GS1_AUTH_MODES)[number], string> = {
  none: "None — the endpoint is open",
  bearer: "Bearer token (Authorization header)",
  "api-key": "API key header",
};

export type Gs1ConnectionView = {
  provider: (typeof GS1_PROVIDERS)[number];
  baseUrl: string;
  companyPrefix: string;
  authMode: (typeof GS1_AUTH_MODES)[number];
  apiKeyHeader: string;
  timeoutMs: number;
  paths: { test: string; verify: string; product: string; publish: string };
  enabled: boolean;
};

export function Gs1ConnectionForm({
  initial,
  hasCredential,
  editable,
}: {
  initial: Gs1ConnectionView;
  hasCredential: boolean;
  editable: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<Gs1ConnectionView>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<Gs1ConnectionTest | null>(null);

  const set = <K extends keyof Gs1ConnectionView>(key: K, value: Gs1ConnectionView[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaved(false);
  };

  const dirty = useMemo(
    () => JSON.stringify({ ...draft, enabled: false }) !== JSON.stringify({ ...initial, enabled: false }),
    [draft, initial],
  );

  const save = () => {
    setError(null);
    setSaved(false);
    start(async () => {
      const res = await saveGs1ConnectionAction({
        provider: draft.provider,
        baseUrl: draft.baseUrl.trim(),
        companyPrefix: draft.companyPrefix.trim(),
        authMode: draft.authMode,
        apiKeyHeader: draft.apiKeyHeader.trim() || "x-api-key",
        timeoutMs: draft.timeoutMs,
        paths: draft.paths,
      });
      if (res.ok) {
        setSaved(true);
        router.refresh();
      } else setError(res.error);
    });
  };

  const toggle = () => {
    setError(null);
    start(async () => {
      const res = await setGs1EnabledAction(!initial.enabled);
      if (res.ok) router.refresh();
      else setError(res.error);
    });
  };

  const runTest = () => {
    setError(null);
    setTest(null);
    start(async () => {
      const res = await testGs1ConnectionAction();
      if (res.ok) {
        setTest(res.test);
        router.refresh();
      } else setError(res.error);
    });
  };

  return (
    <Panel
      title="Connection"
      description="Identity and transport. The credential is stored separately and is never shown here."
      actions={
        editable ? (
          <Button size="sm" variant={initial.enabled ? "outline" : "primary"} onClick={toggle} disabled={pending}>
            {initial.enabled ? "Disable" : "Enable"}
          </Button>
        ) : null
      }
    >
      <div className="space-y-5 p-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <Field label="Provider" htmlFor="provider" hint={PROVIDER_NOTES[draft.provider]}>
            <Select
              id="provider"
              value={draft.provider}
              disabled={!editable}
              onChange={(e) => set("provider", e.target.value as Gs1ConnectionView["provider"])}
            >
              {GS1_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="GS1 company prefix"
            htmlFor="companyPrefix"
            hint="Your licensed prefix, 6 to 12 digits. Used to tell your own GTINs from a supplier's."
          >
            <TextInput
              id="companyPrefix"
              numeric
              inputMode="numeric"
              placeholder="0810797"
              value={draft.companyPrefix}
              disabled={!editable}
              onChange={(e) => set("companyPrefix", e.target.value)}
            />
          </Field>

          <Field
            label="Base URL"
            htmlFor="baseUrl"
            hint="The API root, without a trailing path. https only in production."
            className="lg:col-span-2"
          >
            <TextInput
              id="baseUrl"
              placeholder="https://api.gs1us.org"
              value={draft.baseUrl}
              disabled={!editable}
              onChange={(e) => set("baseUrl", e.target.value)}
            />
          </Field>

          <Field label="Authentication" htmlFor="authMode" hint={AUTH_LABELS[draft.authMode]}>
            <Select
              id="authMode"
              value={draft.authMode}
              disabled={!editable}
              onChange={(e) => set("authMode", e.target.value as Gs1ConnectionView["authMode"])}
            >
              {GS1_AUTH_MODES.map((m) => (
                <option key={m} value={m}>
                  {AUTH_LABELS[m]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="API key header"
            htmlFor="apiKeyHeader"
            hint="Only used in API-key mode. GS1 US fronts some APIs with a gateway that expects x-api-key."
          >
            <TextInput
              id="apiKeyHeader"
              value={draft.apiKeyHeader}
              disabled={!editable || draft.authMode !== "api-key"}
              onChange={(e) => set("apiKeyHeader", e.target.value)}
            />
          </Field>
        </div>

        <details className="rounded border border-ink-800 bg-ink-900/40">
          <summary className="cursor-pointer px-3 py-2 text-[12px] text-ink-300">
            Endpoint paths and timeout
          </summary>
          <div className="grid gap-4 border-t border-ink-800 p-3 sm:grid-cols-2">
            {(
              [
                ["test", "Connection test path", "A cheap authenticated endpoint. Used only by the test button."],
                ["verify", "Verify path", "{gtin} is substituted with the 14-digit form."],
                ["product", "Product path", "Full attribute lookup. Often the same as verify."],
                ["publish", "Publish path", "Only used by providers that can publish."],
              ] as const
            ).map(([key, label, hint]) => (
              <Field key={key} label={label} htmlFor={`path-${key}`} hint={hint}>
                <TextInput
                  id={`path-${key}`}
                  value={draft.paths[key]}
                  disabled={!editable}
                  onChange={(e) => set("paths", { ...draft.paths, [key]: e.target.value })}
                />
              </Field>
            ))}
            <Field
              label="Timeout (ms)"
              htmlFor="timeoutMs"
              hint="Per attempt. Retries with backoff are handled by the adapter."
            >
              <TextInput
                id="timeoutMs"
                numeric
                inputMode="numeric"
                value={String(draft.timeoutMs)}
                disabled={!editable}
                onChange={(e) => set("timeoutMs", Number(e.target.value) || 0)}
              />
            </Field>
          </div>
        </details>

        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {saved && !dirty ? <OkNote>Connection saved.</OkNote> : null}

        {test ? (
          <div
            className={
              "rounded border px-3 py-2.5 text-[12px] leading-relaxed " +
              (test.ok
                ? "border-emerald-800/50 bg-emerald-500/10 text-sev-ok"
                : "border-amber-800/50 bg-amber-500/10 text-sev-warning")
            }
          >
            <div className="flex items-center gap-2">
              <Badge tone={test.ok ? "ok" : "warning"}>{test.ok ? "reachable" : "failed"}</Badge>
              {test.host ? <span className="text-ink-300">{test.host}</span> : null}
              <span className="numeric text-ink-400">{test.latencyMs} ms</span>
            </div>
            <p className="mt-1.5 text-ink-300">{test.detail || test.error?.message}</p>
            {test.error ? (
              <p className="numeric mt-1 text-[11px] text-ink-500">
                {test.error.code}
                {test.error.status ? ` · HTTP ${test.error.status}` : ""} · {test.error.attempts}{" "}
                attempt{test.error.attempts === 1 ? "" : "s"}
                {test.error.retryable ? " · retryable" : ""}
              </p>
            ) : null}
          </div>
        ) : null}

        {editable ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-800 pt-4">
            <p className="text-[11px] text-ink-500">
              {hasCredential
                ? "A credential is stored. The test sends one authenticated request and records it in the log below."
                : "No credential is stored, so an authenticated test will fail with 401 until one is added."}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={runTest} disabled={pending}>
                {pending ? "Working…" : "Test connection"}
              </Button>
              <Button variant="primary" onClick={save} disabled={pending || !dirty}>
                Save connection
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
