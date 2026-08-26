import "server-only";
import { nanoid } from "nanoid";
import { db, auditLogs } from "@/server/db";

/** Append-only audit trail (spec §25). Never blocks the caller's work. */
export async function audit(entry: {
  orgId: string;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
  ip?: string;
}): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: nanoid(24),
      orgId: entry.orgId,
      userId: entry.userId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      detail: entry.detail ?? {},
      ip: entry.ip ?? "",
    });
  } catch (e) {
    // An audit write must never take down the operation it is recording, but it
    // must be visible in the platform logs when it fails.
    console.error("[audit] failed to record", entry.action, e);
  }
}
