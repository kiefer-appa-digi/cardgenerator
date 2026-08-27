"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound } from "lucide-react";
import { Panel, Badge } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { ErrorNote, Field, OkNote, TextInput } from "@/components/settings/field";
import { clearGs1CredentialAction, setGs1CredentialAction } from "@/server/gs1-actions";

/**
 * Credential entry — write-only by construction (spec §13B, §25).
 *
 * This component has no way to display a credential because no server action
 * returns one. What it can show is the two facts the database keeps outside the
 * ciphertext: that a credential exists, and when it was last written.
 */
export function Gs1CredentialPanel({
  configured,
  rotatedAt,
  keyVersion,
  credentialKeyAvailable,
  authMode,
  editable,
}: {
  configured: boolean;
  rotatedAt: string | null;
  keyVersion: number;
  credentialKeyAvailable: boolean;
  authMode: "none" | "bearer" | "api-key";
  editable: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const submit = () => {
    setError(null);
    setDone(null);
    start(async () => {
      const res = await setGs1CredentialAction({ credential: value });
      if (res.ok) {
        // The plaintext is dropped from the component the moment it is stored;
        // there is nothing to keep and keeping it would put it in a React tree.
        setValue("");
        setDone(
          `Stored as key version ${res.keyVersion}. Run the connection test to confirm it works.`,
        );
        router.refresh();
      } else setError(res.error);
    });
  };

  const clear = () => {
    setError(null);
    setDone(null);
    start(async () => {
      const res = await clearGs1CredentialAction();
      if (res.ok) {
        setConfirmClear(false);
        setDone("The stored credential was removed and the connection was switched off.");
        router.refresh();
      } else setError(res.error);
    });
  };

  return (
    <Panel
      title="Credential"
      description="Encrypted with AES-256-GCM before it reaches the database and never sent back to a browser."
      actions={
        configured ? <Badge tone="ok">configured</Badge> : <Badge tone="neutral">not set</Badge>
      }
    >
      <div className="space-y-4 p-4">
        <dl className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-3">
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-ink-500">Stored</dt>
            <dd className="mt-0.5 text-ink-200">{configured ? "Yes" : "No"}</dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-ink-500">Last rotated</dt>
            <dd className="numeric mt-0.5 text-ink-200">
              {rotatedAt ? new Date(rotatedAt).toLocaleString() : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] uppercase tracking-wider text-ink-500">Key version</dt>
            {/* The column defaults to 1 on a connection row that has never held
                a credential. Printing that would claim a first key exists. */}
            <dd className="numeric mt-0.5 text-ink-200">{configured ? keyVersion : "—"}</dd>
          </div>
        </dl>

        {authMode === "none" ? (
          <p className="text-[12px] leading-relaxed text-ink-400">
            The connection is set to use no authentication, so no credential is required. Anything
            stored here is kept but not sent.
          </p>
        ) : null}

        {!credentialKeyAvailable ? (
          <ErrorNote>
            CREDENTIAL_KEY is not set on this deployment, so a credential cannot be encrypted and
            cannot be stored. Generate one with <span className="font-mono">openssl rand -hex 32</span>{" "}
            and add it to the environment.
          </ErrorNote>
        ) : null}

        {editable ? (
          <>
            <Field
              label={configured ? "Replace the credential" : "API key or bearer token"}
              htmlFor="gs1Credential"
              hint="Pasted once. It is encrypted here and can only be replaced afterwards, never read back — not by you, not by another admin, not by this screen."
            >
              <TextInput
                id="gs1Credential"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste the credential"
                value={value}
                disabled={pending || !credentialKeyAvailable}
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>

            {error ? <ErrorNote>{error}</ErrorNote> : null}
            {done ? <OkNote>{done}</OkNote> : null}

            <div className="flex flex-wrap items-center justify-between gap-3">
              {configured ? (
                confirmClear ? (
                  <div className="flex items-center gap-2 text-[12px] text-ink-300">
                    <span>Remove the stored credential and disable the connection?</span>
                    <Button size="sm" variant="danger" onClick={clear} disabled={pending}>
                      Remove
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setConfirmClear(true)} disabled={pending}>
                    Remove stored credential
                  </Button>
                )
              ) : (
                <span />
              )}
              <Button
                variant="primary"
                onClick={submit}
                disabled={pending || value.trim() === "" || !credentialKeyAvailable}
              >
                <KeyRound size={14} aria-hidden />
                {pending ? "Storing…" : configured ? "Rotate credential" : "Store credential"}
              </Button>
            </div>
          </>
        ) : (
          <p className="text-[12px] text-ink-500">
            Your role can see whether a credential is configured but cannot change it. An admin can.
          </p>
        )}
      </div>
    </Panel>
  );
}
