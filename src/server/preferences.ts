"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, users } from "@/server/db";
import { requireUser } from "@/server/auth/current";

/**
 * Per-user editor preferences (spec §24: "Persist editor preferences per user").
 *
 * Only view state lives here — units, overlay toggles, snapping. Nothing that
 * affects the artwork itself, so a preference can never change what prints.
 */
export const EditorPreferencesSchema = z.object({
  unit: z.enum(["in", "mm", "pt"]).default("in"),
  snap: z.boolean().default(true),
  snapToleranceUpt: z.number().int().min(0).max(3_600_000).default(216_000),
  overlays: z
    .object({
      bleed: z.boolean().default(true),
      trim: z.boolean().default(true),
      safe: z.boolean().default(true),
      cavity: z.boolean().default(true),
      centerLines: z.boolean().default(false),
      guides: z.boolean().default(true),
      rulers: z.boolean().default(true),
      grid: z.boolean().default(false),
      outlines: z.boolean().default(false),
    })
    .default({
      bleed: true,
      trim: true,
      safe: true,
      cavity: true,
      centerLines: false,
      guides: true,
      rulers: true,
      grid: false,
      outlines: false,
    }),
  leftTab: z.enum(["data", "layers"]).default("data"),
});
export type EditorPreferences = z.infer<typeof EditorPreferencesSchema>;

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
  return parsed.success ? parsed.data : EditorPreferencesSchema.parse({});
}
