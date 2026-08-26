"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, LayoutTemplate, SquarePen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  createDesignAction,
  duplicateTemplateAction,
  ensureMasterTemplatesAction,
} from "@/server/templates";

/**
 * The two write actions the template screens offer. Both are gated by
 * `template.write` on the server; the pages hide them from roles that cannot
 * use them so the UI does not offer a button that will only throw.
 */

export function EnsureMasterTemplatesButton({
  missing,
  size = "sm",
}: {
  /** Preset codes with no master template yet; drives the label. */
  missing: string[];
  size?: "sm" | "md";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setError(null);
    start(async () => {
      try {
        await ensureMasterTemplatesAction();
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "The master templates could not be created.");
      }
    });
  };

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Button variant="primary" size={size} onClick={run} disabled={pending}>
        <LayoutTemplate size={14} strokeWidth={1.75} aria-hidden />
        {pending
          ? "Creating…"
          : missing.length === 1
            ? `Create the ${missing[0]} master template`
            : `Create ${missing.length} master templates`}
      </Button>
      {error ? (
        <p role="alert" className="text-[11px] text-flag-200">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function DuplicateTemplateButton({
  templateId,
  size = "sm",
  variant = "outline",
}: {
  templateId: string;
  size?: "sm" | "md";
  variant?: "outline" | "secondary";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setError(null);
    start(async () => {
      try {
        const res = await duplicateTemplateAction(templateId);
        // Landing on the copy is the only way to see that it is a separate,
        // editable template and not an edit of the master.
        if (res.ok) router.push(`/templates/${res.templateId}`);
        else setError(res.error);
      } catch (e) {
        setError(e instanceof Error ? e.message : "The template could not be duplicated.");
      }
    });
  };

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button variant={variant} size={size} onClick={run} disabled={pending}>
        <Copy size={13} strokeWidth={1.75} aria-hidden />
        {pending ? "Duplicating…" : "Duplicate"}
      </Button>
      {error ? (
        <span role="alert" className="text-[11px] text-flag-200">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Creates a draft card from this template and opens it in the editor.
 *
 * No product is attached: this is the "design against sample data" path the new
 * card screen also offers. A card that must carry a real SKU is started there
 * instead, where the product is chosen at the same time as the template.
 */
export function StartCardButton({
  templateId,
  presetCode,
  size = "sm",
  variant = "outline",
}: {
  templateId: string;
  presetCode: string;
  size?: "sm" | "md";
  variant?: "outline" | "primary";
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setError(null);
    start(async () => {
      try {
        const res = await createDesignAction({
          name: "",
          presetCode,
          productId: null,
          templateId,
        });
        if (res.ok) router.push(`/designs/${res.designId}/edit`);
        else setError(res.error);
      } catch (e) {
        setError(e instanceof Error ? e.message : "The card could not be created.");
      }
    });
  };

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button variant={variant} size={size} onClick={run} disabled={pending}>
        <SquarePen size={13} strokeWidth={1.75} aria-hidden />
        {pending ? "Creating…" : "Start a card"}
      </Button>
      {error ? (
        <span role="alert" className="text-[11px] text-flag-200">
          {error}
        </span>
      ) : null}
    </span>
  );
}
