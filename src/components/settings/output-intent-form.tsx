"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { ErrorNote, Field, OkNote, TextArea, TextInput } from "@/components/settings/field";
import { saveOutputIntentAction } from "@/server/settings";

/**
 * Output intent editor (spec §14).
 *
 * The condition name and the ICC profile are edited together because they are
 * one claim: an identifier without a profile is a printing condition the file
 * cannot point at, and the export refuses to write an OutputIntent for it.
 */

export type OutputIntentView = {
  identifier: string;
  conditionName: string;
  registryName: string;
  info: string;
  profile: {
    filename: string;
    byteSize: number;
    colorSpace: string;
    componentCount: number;
    updatedAt: string;
    updatedBy: string;
  } | null;
};

export function OutputIntentForm({
  initial,
  configured,
  editable,
}: {
  initial: OutputIntentView;
  /**
   * Whether an ICC profile is actually embedded. Kept separate from
   * `initial.profile`, which carries the *upload* record: a profile written
   * before that record existed, or by a migration, is still embedded and must
   * still be removable. Hiding the control because the paperwork is missing
   * would strand a profile nobody can take out.
   */
  configured: boolean;
  editable: boolean;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);

  const send = (extra?: Record<string, string>) => {
    const form = formRef.current;
    if (!form) return;
    const data = new FormData(form);
    for (const [k, v] of Object.entries(extra ?? {})) data.set(k, v);
    setError(null);
    setSaved(null);
    start(async () => {
      const res = await saveOutputIntentAction(data);
      if (res.ok) {
        setFilename(null);
        setSaved(
          extra?.removeProfile === "1"
            ? "The ICC profile was removed. Exports carry no OutputIntent again."
            : "Saved.",
        );
        form.reset();
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  };

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      className="space-y-6"
    >
      <Panel
        title="Printing condition"
        description="Recorded in the PDF's OutputIntent dictionary when a profile is present."
      >
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field
            label="Output condition identifier"
            htmlFor="identifier"
            hint='The registry key, e.g. "FOGRA39L" or "CGATS21-2-CRPC1". Use "none" when the press has no registered condition.'
          >
            <TextInput
              id="identifier"
              name="identifier"
              defaultValue={initial.identifier}
              disabled={!editable}
            />
          </Field>
          <Field
            label="Condition name"
            htmlFor="conditionName"
            hint="How the press describes the condition in plain words."
          >
            <TextInput
              id="conditionName"
              name="conditionName"
              defaultValue={initial.conditionName}
              disabled={!editable}
            />
          </Field>
          <Field
            label="Registry name"
            htmlFor="registryName"
            hint="Where the identifier is registered, e.g. http://www.color.org."
          >
            <TextInput
              id="registryName"
              name="registryName"
              defaultValue={initial.registryName}
              disabled={!editable}
            />
          </Field>
          <Field
            label="Info"
            htmlFor="info"
            hint="Free text written into the intent dictionary. A good place for the paper stock and the print vendor."
            className="sm:col-span-2"
          >
            <TextArea id="info" name="info" defaultValue={initial.info} disabled={!editable} />
          </Field>
        </div>
      </Panel>

      <Panel
        title="ICC profile"
        description="The press's output profile. Validated here with the same decoder the exporter uses."
      >
        <div className="space-y-4 p-4">
          {editable ? (
            <label
              className={
                "flex cursor-pointer flex-col items-center justify-center rounded-panel border-2 " +
                "border-dashed border-ink-700 px-6 py-8 text-center transition-colors hover:border-ink-600"
              }
            >
              <Upload size={20} className="mb-2 text-ink-400" aria-hidden />
              <span className="text-sm font-medium text-ink-100">
                {filename ?? (configured ? "Replace the ICC profile" : "Choose an .icc or .icm profile")}
              </span>
              <span className="mt-1 text-[11px] text-ink-500">
                CMYK, RGB or grayscale. The header is checked: a truncated or fake
                profile is refused rather than embedded.
              </span>
              <input
                type="file"
                name="profile"
                accept=".icc,.icm,application/vnd.iccprofile"
                className="sr-only"
                disabled={pending}
                onChange={(e) => setFilename(e.target.files?.[0]?.name ?? null)}
              />
            </label>
          ) : null}

          {configured ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-ink-800 bg-ink-900/60 px-3 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-[13px] text-ink-100">
                  {initial.profile ? initial.profile.filename : "An ICC profile is embedded"}
                </div>
                <div className="numeric mt-0.5 text-[11px] text-ink-500">
                  {initial.profile ? (
                    <>
                      {initial.profile.colorSpace} · {initial.profile.componentCount} channels ·{" "}
                      {(initial.profile.byteSize / 1024).toFixed(0)} KB · uploaded{" "}
                      {new Date(initial.profile.updatedAt).toLocaleDateString()} by{" "}
                      {initial.profile.updatedBy}
                    </>
                  ) : (
                    "No upload record was kept for it, so its filename, size and colour space are not known here. Replace it to record those."
                  )}
                </div>
              </div>
              {editable ? (
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  disabled={pending}
                  onClick={() => send({ removeProfile: "1" })}
                >
                  Remove profile
                </Button>
              ) : null}
            </div>
          ) : null}

          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {saved ? <OkNote>{saved}</OkNote> : null}
        </div>
      </Panel>

      {editable ? (
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Saving…" : "Save output intent"}
          </Button>
        </div>
      ) : (
        <p className="text-[12px] text-ink-500">
          Your role can read the output intent but not change it. An admin can.
        </p>
      )}
    </form>
  );
}
