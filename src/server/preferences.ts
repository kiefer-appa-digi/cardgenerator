"use server";

import { eq } from "drizzle-orm";
import { db, users } from "@/server/db";
import { requireUser } from "@/server/auth/current";
import {
  DEFAULT_EDITOR_PREFERENCES,
  EditorPreferencesSchema,
  type EditorPreferences,
} from "@/lib/editor/preferences";

export async function saveEditorPreferencesAction(raw: unknown) {
  const user = await requireUser();
  const parsed = EditorPreferencesSchema.safeParse(raw);
  if (!parsed.success) return { ok: false as const, error: "Those preferences are not valid." };

  const existing = (user.preferences ?? {}) as Record<string, unknown>;
  await db
    .update(users)
    .set({ preferences: { ...existing, editor: parsed.data }, updatedAt: new Date() })
    .where(eq(users.id, user.id));
  return { ok: true as const };
}

export async function readEditorPreferences(): Promise<EditorPreferences> {
  const user = await requireUser();
  const stored = (user.preferences as { editor?: unknown } | null)?.editor;
  // A stored preference that no longer validates falls back to the defaults
  // rather than throwing a designer out of the editor.
  const parsed = EditorPreferencesSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : DEFAULT_EDITOR_PREFERENCES;
}
