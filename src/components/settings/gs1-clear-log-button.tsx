"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { clearGs1LogsAction } from "@/server/gs1-actions";

/**
 * Clearing the log is itself audited, so the audit trail still records that a
 * person removed the request history and when.
 */
export function Gs1ClearLogButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);

  if (!confirm) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
        Clear log
      </Button>
    );
  }

  return (
    <span className="flex items-center gap-2 text-[11px] text-ink-400">
      Delete every logged request?
      <Button
        size="sm"
        variant="danger"
        disabled={pending}
        onClick={() =>
          start(async () => {
            await clearGs1LogsAction();
            setConfirm(false);
            router.refresh();
          })
        }
      >
        {pending ? "Clearing…" : "Delete"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
        Cancel
      </Button>
    </span>
  );
}
