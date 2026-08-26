"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { CheckboxField, ErrorNote, Field, OkNote, TextInput } from "@/components/settings/field";
import { saveOrganisationSettingsAction } from "@/server/settings";
import { previewCss, TINT_MAX, type Cmyk } from "@/lib/color/types";
import { formatLength, parseLength } from "@/lib/units";

/**
 * Organisation defaults: black handling, the preflight profile thresholds and
 * the export policy (spec §14, §16, §21).
 *
 * Everything is entered in the unit a prepress operator would say out loud —
 * percent of ink, points of type, DPI — and converted to the stored integer
 * unit on save. Nothing is clamped silently: a value the system cannot use is
 * refused with the reason.
 */

export type OrganisationSettingsView = {
  blackRules: {
    textBlack: Cmyk;
    richBlack: Cmyk;
    totalAreaCoverageLimit: number;
    richBlackMinTextSize: number;
  };
  preflightProfile: {
    name: string;
    minImageDpi: number;
    criticalImageDpi: number;
    bleedCoverageBps: number;
    inkLimit: number;
    barcodeMinMagnificationBps: number;
    barcodeMaxMagnificationBps: number;
    barcodeMinContrast: number;
    richBlackMinTextSize: number;
  };
  exportPolicy: { treatErrorAsBlocking: boolean; allowOverride: boolean };
};

/** Tenths of a percent → percent, and back. */
const tenthsToPct = (v: number) => String(v / 10);
const bpsToPct = (v: number) => String(v / 100);

type Draft = {
  textBlackK: string;
  richBlackC: string;
  richBlackM: string;
  richBlackY: string;
  richBlackK: string;
  tacLimitPct: string;
  richBlackMinTextPt: string;
  profileName: string;
  minImageDpi: string;
  criticalImageDpi: string;
  bleedCoveragePct: string;
  inkLimitPct: string;
  barcodeMinMagPct: string;
  barcodeMaxMagPct: string;
  barcodeMinContrastPct: string;
  profileRichBlackMinTextPt: string;
  treatErrorAsBlocking: boolean;
  allowOverride: boolean;
};

function toDraft(v: OrganisationSettingsView): Draft {
  return {
    textBlackK: tenthsToPct(v.blackRules.textBlack.k),
    richBlackC: tenthsToPct(v.blackRules.richBlack.c),
    richBlackM: tenthsToPct(v.blackRules.richBlack.m),
    richBlackY: tenthsToPct(v.blackRules.richBlack.y),
    richBlackK: tenthsToPct(v.blackRules.richBlack.k),
    tacLimitPct: tenthsToPct(v.blackRules.totalAreaCoverageLimit),
    richBlackMinTextPt: formatLength(v.blackRules.richBlackMinTextSize, "pt"),
    profileName: v.preflightProfile.name,
    minImageDpi: String(v.preflightProfile.minImageDpi),
    criticalImageDpi: String(v.preflightProfile.criticalImageDpi),
    bleedCoveragePct: bpsToPct(v.preflightProfile.bleedCoverageBps),
    inkLimitPct: tenthsToPct(v.preflightProfile.inkLimit),
    barcodeMinMagPct: bpsToPct(v.preflightProfile.barcodeMinMagnificationBps),
    barcodeMaxMagPct: bpsToPct(v.preflightProfile.barcodeMaxMagnificationBps),
    barcodeMinContrastPct: tenthsToPct(v.preflightProfile.barcodeMinContrast),
    profileRichBlackMinTextPt: formatLength(v.preflightProfile.richBlackMinTextSize, "pt"),
    treatErrorAsBlocking: v.exportPolicy.treatErrorAsBlocking,
    allowOverride: v.exportPolicy.allowOverride,
  };
}

type Parsed = { ok: true; value: number } | { ok: false; error: string };

function num(raw: string, label: string, min: number, max: number, integer = true): Parsed {
  const n = Number(raw.trim());
  if (raw.trim() === "" || !Number.isFinite(n)) return { ok: false, error: `${label} must be a number.` };
  if (integer && !Number.isInteger(n)) return { ok: false, error: `${label} must be a whole number.` };
  if (n < min || n > max) return { ok: false, error: `${label} must be between ${min} and ${max}.` };
  return { ok: true, value: n };
}

function tint(raw: string, label: string): Parsed {
  const n = Number(raw.trim());
  if (raw.trim() === "" || !Number.isFinite(n)) return { ok: false, error: `${label} must be a number.` };
  if (n < 0 || n > 100) return { ok: false, error: `${label} must be between 0 and 100 %.` };
  return { ok: true, value: Math.round(n * 10) };
}

export function OrganisationForm({
  initial,
  editable,
}: {
  initial: OrganisationSettingsView;
  editable: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setSaved(false);
  };

  const dirty = useMemo(() => {
    const base = toDraft(initial);
    return (Object.keys(base) as Array<keyof Draft>).filter((k) => base[k] !== draft[k]);
  }, [draft, initial]);

  const richBlackTac = useMemo(() => {
    const parts = [draft.richBlackC, draft.richBlackM, draft.richBlackY, draft.richBlackK].map((s) =>
      Number(s.trim()),
    );
    if (parts.some((n) => !Number.isFinite(n))) return null;
    return parts.reduce((a, b) => a + b, 0);
  }, [draft.richBlackC, draft.richBlackM, draft.richBlackY, draft.richBlackK]);

  const tacLimit = Number(draft.tacLimitPct.trim());
  const richBlackOverLimit =
    richBlackTac !== null && Number.isFinite(tacLimit) && richBlackTac > tacLimit;

  const richBlackPreview: Cmyk = {
    space: "cmyk",
    c: Math.min(TINT_MAX, Math.max(0, Math.round(Number(draft.richBlackC) * 10) || 0)),
    m: Math.min(TINT_MAX, Math.max(0, Math.round(Number(draft.richBlackM) * 10) || 0)),
    y: Math.min(TINT_MAX, Math.max(0, Math.round(Number(draft.richBlackY) * 10) || 0)),
    k: Math.min(TINT_MAX, Math.max(0, Math.round(Number(draft.richBlackK) * 10) || 0)),
  };

  const submit = () => {
    setError(null);
    setSaved(false);

    const fields: Array<[string, Parsed]> = [
      ["textBlackK", tint(draft.textBlackK, "Text black K")],
      ["richBlackC", tint(draft.richBlackC, "Rich black C")],
      ["richBlackM", tint(draft.richBlackM, "Rich black M")],
      ["richBlackY", tint(draft.richBlackY, "Rich black Y")],
      ["richBlackK", tint(draft.richBlackK, "Rich black K")],
      ["tacLimitPct", num(draft.tacLimitPct, "Total ink limit", 100, 400, false)],
      ["minImageDpi", num(draft.minImageDpi, "Minimum image resolution", 72, 2400)],
      ["criticalImageDpi", num(draft.criticalImageDpi, "Critical image resolution", 36, 2400)],
      ["bleedCoveragePct", num(draft.bleedCoveragePct, "Bleed coverage", 0, 100, false)],
      ["inkLimitPct", num(draft.inkLimitPct, "Press ink limit", 100, 400, false)],
      ["barcodeMinMagPct", num(draft.barcodeMinMagPct, "Minimum barcode magnification", 50, 300, false)],
      ["barcodeMaxMagPct", num(draft.barcodeMaxMagPct, "Maximum barcode magnification", 50, 300, false)],
      ["barcodeMinContrastPct", num(draft.barcodeMinContrastPct, "Minimum barcode contrast", 0, 100, false)],
    ];
    const bad = fields.find(([, p]) => !p.ok);
    if (bad && !bad[1].ok) {
      setError(bad[1].error);
      return;
    }
    const value = (key: string): number => {
      const found = fields.find(([k]) => k === key);
      return found && found[1].ok ? found[1].value : 0;
    };

    const orgTextSize = parseLength(draft.richBlackMinTextPt, "pt");
    const profileTextSize = parseLength(draft.profileRichBlackMinTextPt, "pt");
    if (orgTextSize === null || profileTextSize === null) {
      setError("The rich-black minimum text size must be a size, e.g. 14 or 14pt.");
      return;
    }
    if (draft.profileName.trim() === "") {
      setError("Give the preflight profile a name — it is recorded on every report.");
      return;
    }

    start(async () => {
      const res = await saveOrganisationSettingsAction({
        blackRules: {
          textBlack: { space: "cmyk", c: 0, m: 0, y: 0, k: value("textBlackK") },
          richBlack: {
            space: "cmyk",
            c: value("richBlackC"),
            m: value("richBlackM"),
            y: value("richBlackY"),
            k: value("richBlackK"),
          },
          totalAreaCoverageLimit: Math.round(value("tacLimitPct") * 10),
          richBlackMinTextSize: orgTextSize,
        },
        preflightProfile: {
          name: draft.profileName.trim(),
          minImageDpi: value("minImageDpi"),
          criticalImageDpi: value("criticalImageDpi"),
          bleedCoverageBps: Math.round(value("bleedCoveragePct") * 100),
          inkLimit: Math.round(value("inkLimitPct") * 10),
          barcodeMinMagnificationBps: Math.round(value("barcodeMinMagPct") * 100),
          barcodeMaxMagnificationBps: Math.round(value("barcodeMaxMagPct") * 100),
          barcodeMinContrast: Math.round(value("barcodeMinContrastPct") * 10),
          richBlackMinTextSize: profileTextSize,
        },
        exportPolicy: {
          treatErrorAsBlocking: draft.treatErrorAsBlocking,
          allowOverride: draft.allowOverride,
        },
      });
      if (res.ok) {
        setSaved(true);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  };

  return (
    <div className="space-y-6">
      <Panel
        title="Black rules"
        description="How this organisation builds black. Enforced by preflight and by the PDF writer."
      >
        <div className="space-y-5 p-4">
          <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
            <Field label="Text black K %" htmlFor="textBlackK">
              <TextInput
                id="textBlackK"
                numeric
                inputMode="decimal"
                disabled={!editable}
                value={draft.textBlackK}
                onChange={(e) => set("textBlackK", e.target.value)}
              />
            </Field>
            <p className="self-end pb-1 text-[11px] leading-relaxed text-ink-500">
              Text black is black ink only — C, M and Y are fixed at zero. Body copy
              built from four inks shows every registration error on the press, so the
              rule is a constraint rather than a default.
            </p>
          </div>

          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wider text-ink-400">
                Rich black
              </span>
              <span
                aria-hidden
                className="h-4 w-8 rounded border border-ink-700"
                style={{ background: previewCss(richBlackPreview) }}
              />
              <span className="numeric text-[11px] text-ink-500">
                {richBlackTac === null ? "—" : `${richBlackTac.toFixed(1)} % total ink`}
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              {(
                [
                  ["richBlackC", "Cyan %"],
                  ["richBlackM", "Magenta %"],
                  ["richBlackY", "Yellow %"],
                  ["richBlackK", "Black %"],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label} htmlFor={key}>
                  <TextInput
                    id={key}
                    numeric
                    inputMode="decimal"
                    disabled={!editable}
                    value={draft[key]}
                    onChange={(e) => set(key, e.target.value)}
                  />
                </Field>
              ))}
            </div>
            {richBlackOverLimit ? (
              <p className="mt-2 rounded border border-amber-800/50 bg-amber-500/10 px-2 py-1.5 text-[11px] text-sev-warning">
                This rich black is {richBlackTac?.toFixed(1)} % ink, above the{" "}
                {draft.tacLimitPct} % limit below. Every solid built from it will raise
                an ink-limit finding.
              </p>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Total ink limit %"
              htmlFor="tacLimitPct"
              hint="Organisation ceiling on total area coverage. The lower of this and the press profile's ink limit is the one enforced."
            >
              <TextInput
                id="tacLimitPct"
                numeric
                inputMode="decimal"
                disabled={!editable}
                value={draft.tacLimitPct}
                onChange={(e) => set("tacLimitPct", e.target.value)}
              />
            </Field>
            <Field
              label="Rich black minimum text size (pt)"
              htmlFor="richBlackMinTextPt"
              hint="Type smaller than this set in rich black is flagged as a registration risk. The larger of this and the press profile's value wins, because a bigger threshold flags more type."
            >
              <TextInput
                id="richBlackMinTextPt"
                numeric
                inputMode="decimal"
                disabled={!editable}
                value={draft.richBlackMinTextPt}
                onChange={(e) => set("richBlackMinTextPt", e.target.value)}
              />
            </Field>
          </div>
        </div>
      </Panel>

      <Panel
        title="Preflight profile"
        description="The press's numbers. Recorded by name on every preflight report and every export."
      >
        <div className="space-y-4 p-4">
          <Field
            label="Profile name"
            htmlFor="profileName"
            hint="Shown on the preflight report and stored with each result, so an old report still says what it was judged against."
          >
            <TextInput
              id="profileName"
              disabled={!editable}
              value={draft.profileName}
              onChange={(e) => set("profileName", e.target.value)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <Field
              label="Minimum image DPI"
              htmlFor="minImageDpi"
              hint="Effective resolution at placed size. Below this is a warning."
            >
              <TextInput
                id="minImageDpi"
                numeric
                inputMode="numeric"
                disabled={!editable}
                value={draft.minImageDpi}
                onChange={(e) => set("minImageDpi", e.target.value)}
              />
            </Field>
            <Field
              label="Critical image DPI"
              htmlFor="criticalImageDpi"
              hint="Below this the warning becomes an error. Must be at or below the minimum."
            >
              <TextInput
                id="criticalImageDpi"
                numeric
                inputMode="numeric"
                disabled={!editable}
                value={draft.criticalImageDpi}
                onChange={(e) => set("criticalImageDpi", e.target.value)}
              />
            </Field>
            <Field
              label="Bleed coverage %"
              htmlFor="bleedCoveragePct"
              hint="How much of the bleed box artwork must cover."
            >
              <TextInput
                id="bleedCoveragePct"
                numeric
                inputMode="decimal"
                disabled={!editable}
                value={draft.bleedCoveragePct}
                onChange={(e) => set("bleedCoveragePct", e.target.value)}
              />
            </Field>
            <Field
              label="Press ink limit %"
              htmlFor="inkLimitPct"
              hint="The press's total area coverage ceiling."
            >
              <TextInput
                id="inkLimitPct"
                numeric
                inputMode="decimal"
                disabled={!editable}
                value={draft.inkLimitPct}
                onChange={(e) => set("inkLimitPct", e.target.value)}
              />
            </Field>
            <Field
              label="Barcode magnification min %"
              htmlFor="barcodeMinMagPct"
              hint="GS1 General Specifications allow 80–200 % for UPC-A and EAN-13."
            >
              <TextInput
                id="barcodeMinMagPct"
                numeric
                inputMode="decimal"
                disabled={!editable}
                value={draft.barcodeMinMagPct}
                onChange={(e) => set("barcodeMinMagPct", e.target.value)}
              />
            </Field>
            <Field label="Barcode magnification max %" htmlFor="barcodeMaxMagPct">
              <TextInput
                id="barcodeMaxMagPct"
                numeric
                inputMode="decimal"
                disabled={!editable}
                value={draft.barcodeMaxMagPct}
                onChange={(e) => set("barcodeMaxMagPct", e.target.value)}
              />
            </Field>
            <Field
              label="Barcode contrast ΔK %"
              htmlFor="barcodeMinContrastPct"
              hint="Minimum ink difference between bars and background."
            >
              <TextInput
                id="barcodeMinContrastPct"
                numeric
                inputMode="decimal"
                disabled={!editable}
                value={draft.barcodeMinContrastPct}
                onChange={(e) => set("barcodeMinContrastPct", e.target.value)}
              />
            </Field>
            <Field
              label="Profile rich-black min text (pt)"
              htmlFor="profileRichBlackMinTextPt"
              hint="The press's own figure. Compared with the organisation's; the larger applies."
            >
              <TextInput
                id="profileRichBlackMinTextPt"
                numeric
                inputMode="decimal"
                disabled={!editable}
                value={draft.profileRichBlackMinTextPt}
                onChange={(e) => set("profileRichBlackMinTextPt", e.target.value)}
              />
            </Field>
          </div>
        </div>
      </Panel>

      <Panel
        title="Export policy"
        description="What stops a production export, and who may override it."
      >
        <div className="space-y-4 p-4">
          <CheckboxField
            id="treatErrorAsBlocking"
            label="Treat errors as blocking"
            description="Blocking findings always stop a production export. With this on, error-severity findings stop it too — a stricter house rule for shops that will not print over a known defect."
            checked={draft.treatErrorAsBlocking}
            disabled={!editable}
            onChange={(v) => set("treatErrorAsBlocking", v)}
          />
          <CheckboxField
            id="allowOverride"
            label="Allow admins to override a blocked export"
            description="An override is never silent: it records who forced the run, the note they wrote and the preflight report at that moment. Turn this off and a blocked export can only be fixed, not forced."
            checked={draft.allowOverride}
            disabled={!editable}
            onChange={(v) => set("allowOverride", v)}
          />
        </div>
      </Panel>

      {editable ? (
        <div className="sticky bottom-0 -mx-8 flex items-center justify-between gap-4 border-t border-ink-800 bg-ink-900/95 px-8 py-3 backdrop-blur">
          <div className="min-w-0 text-[12px] text-ink-400">
            {error ? (
              <ErrorNote>{error}</ErrorNote>
            ) : saved && dirty.length === 0 ? (
              <OkNote>Saved. New exports and preflight runs use these values.</OkNote>
            ) : dirty.length > 0 ? (
              <span className="numeric">
                {dirty.length} unsaved change{dirty.length === 1 ? "" : "s"}
              </span>
            ) : (
              <span>No changes.</span>
            )}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(toDraft(initial));
                setError(null);
                setSaved(false);
              }}
              disabled={pending || dirty.length === 0}
            >
              Revert
            </Button>
            <Button
              variant="primary"
              onClick={submit}
              disabled={pending || dirty.length === 0}
            >
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-[12px] text-ink-500">
          Your role can read these settings but not change them. An admin can.
        </p>
      )}
    </div>
  );
}
