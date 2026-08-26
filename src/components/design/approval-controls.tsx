"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { decideApprovalAction, submitForReviewAction } from "@/server/designs";

export function ApprovalControls({
  designId,
  status,
  canSubmit,
  canApprove,
  blocking,
  errors,
}: {
  designId: string;
  status: string;
  canSubmit: boolean;
  canApprove: boolean;
  blocking: number;
  errors: number;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    start(async () => {
      const res = await fn();
      if (res.ok) { setNote(""); router.refresh(); }
      else setError(res.error ?? "That did not work.");
    });
  };

  return (
    <div className="space-y-3 p-4">
      {blocking > 0 ? (
        <p className="rounded border border-flag-800 bg-flag-900/25 px-3 py-2 text-[12px] leading-relaxed text-flag-200">
          {blocking} blocking preflight {blocking === 1 ? "issue" : "issues"} on the current
          revision. Production export is blocked until they are resolved or an
          administrator records an override with a reason.
        </p>
      ) : errors > 0 ? (
        <p className="rounded border border-amber-800/50 bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-sev-warning">
          {errors} preflight {errors === 1 ? "error" : "errors"} on the current revision.
        </p>
      ) : null}

      <label className="block">
        <span className="mb-1 block text-[10px] uppercase tracking-wide text-ink-500">
          Note
        </span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="What changed, or why this is approved."
          className="w-full resize-y rounded border border-ink-700 bg-ink-850 px-2 py-1.5 text-[13px] text-ink-100 placeholder:text-ink-600 focus:border-brand-500"
        />
      </label>

      {error ? (
        <p role="alert" className="rounded border border-flag-800 bg-flag-900/30 px-2 py-1.5 text-[12px] text-flag-200">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {status === "draft" && canSubmit ? (
          <Button
            variant="primary"
            disabled={pending}
            onClick={() => run(() => submitForReviewAction(designId, note))}
          >
            Submit for review
          </Button>
        ) : null}
        {status === "in_review" && canApprove ? (
          <>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => run(() => decideApprovalAction(designId, "approved", note))}
            >
              Approve
            </Button>
            <Button
              variant="danger"
              disabled={pending}
              onClick={() => run(() => decideApprovalAction(designId, "rejected", note))}
            >
              Send back
            </Button>
          </>
        ) : null}
        {status === "approved" ? (
          <p className="text-[12px] leading-relaxed text-ink-400">
            This revision is approved and frozen. Editing the card creates a new
            revision and supersedes this one; the approved artwork itself is never
            altered.
          </p>
        ) : null}
        {status === "in_review" && !canApprove ? (
          <p className="text-[12px] text-ink-400">
            Waiting on a reviewer. Your role cannot approve artwork.
          </p>
        ) : null}
      </div>
    </div>
  );
}
