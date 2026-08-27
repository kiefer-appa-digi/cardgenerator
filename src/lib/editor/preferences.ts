import { z } from "zod";

/**
 * Per-user editor preferences (spec §24: "Persist editor preferences per user").
 *
 * The schema lives here rather than beside the server action because a
 * "use server" module may only export async functions — exporting a Zod object
 * from one fails the build. Keeping the shape in a plain module also lets the
 * client validate before sending.
 *
 * Only view state belongs here — units, overlay toggles, snapping, which panel
 * tab was open. Nothing that affects the artwork, so a preference can never
 * change what prints.
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

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = EditorPreferencesSchema.parse({});
