"use server";

import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { revalidatePath } from "next/cache";
import { db, organizations, users } from "@/server/db";
import { requireCapability } from "@/server/auth/current";
import { audit } from "@/server/audit";
import { checkPasswordStrength, hashPassword } from "@/server/auth/password";
import { BlackRulesSchema, OutputIntentSchema } from "@/lib/color/types";
import { PreflightProfileSchema } from "@/lib/preflight/types";
import { decodeIccProfile, InvalidIccProfileError } from "@/lib/pdf/production";
import { ROLES } from "@/server/db/schema";

/**
 * ORGANISATION SETTINGS — spec §14, §21, §25.
 *
 * Everything on these screens ends up in one place: `organizations.settings`.
 * `loadOrgSettings` in `@/server/render` is the only reader, and it parses each
 * branch through the same zod schema the rest of the pipeline uses, so a value
 * saved here cannot arrive at the PDF writer in a shape it does not expect.
 *
 * The write is a shallow merge of named branches rather than a whole-object
 * replace: two admins editing different screens must not silently drop each
 * other's work, and a branch this file does not know about (added by a later
 * migration) must survive a save.
 */

export type ActionResult = { ok: true } | { ok: false; error: string };

/** The branches this file owns. Anything else in the blob is left untouched. */
type SettingsBranch =
  | "blackRules"
  | "preflightProfile"
  | "outputIntent"
  | "outputIntentMeta"
  | "exportPolicy";

async function readSettings(orgId: string): Promise<Record<string, unknown>> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return (org?.settings ?? {}) as Record<string, unknown>;
}

async function mergeSettings(
  orgId: string,
  patch: Partial<Record<SettingsBranch, unknown>>,
): Promise<void> {
  const current = await readSettings(orgId);
  await db
    .update(organizations)
    .set({ settings: { ...current, ...patch }, updatedAt: new Date() })
    .where(eq(organizations.id, orgId));
}

/* ----------------------------------------------- black rules + preflight */

const ExportPolicySchema = z.object({
  treatErrorAsBlocking: z.boolean(),
  allowOverride: z.boolean(),
});

const OrganisationSettingsInputSchema = z.object({
  blackRules: BlackRulesSchema,
  // `treatErrorAsBlocking` lives on the export policy; the profile takes its
  // copy from there at read time so the two can never disagree.
  preflightProfile: PreflightProfileSchema.omit({ treatErrorAsBlocking: true }),
  exportPolicy: ExportPolicySchema,
});

export type OrganisationSettingsInput = z.infer<typeof OrganisationSettingsInputSchema>;

/**
 * Save the black rules, the preflight profile thresholds and the export policy.
 *
 * Cross-field rules are checked here and refused with a sentence rather than
 * being clamped: a "critical" DPI above the minimum DPI is not a value the
 * system can guess the intent of, and silently reordering the two would make
 * the screen lie about what the press is being held to.
 */
export async function saveOrganisationSettingsAction(input: unknown): Promise<ActionResult> {
  const user = await requireCapability("org.manage");

  const parsed = OrganisationSettingsInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue.path.join(".") || "input"}: ${issue.message}` };
  }
  const { blackRules, preflightProfile, exportPolicy } = parsed.data;

  if (preflightProfile.criticalImageDpi > preflightProfile.minImageDpi) {
    return {
      ok: false,
      error:
        "The critical image resolution must be at or below the minimum resolution — " +
        "it is the point at which a low-resolution warning becomes an error.",
    };
  }
  if (preflightProfile.barcodeMinMagnificationBps > preflightProfile.barcodeMaxMagnificationBps) {
    return { ok: false, error: "The minimum barcode magnification is above the maximum." };
  }
  if (blackRules.textBlack.c + blackRules.textBlack.m + blackRules.textBlack.y > 0) {
    return {
      ok: false,
      error:
        "Text black must be black ink only. Any C, M or Y in body type prints as a " +
        "registration error on press; use the rich black for large solids instead.",
    };
  }

  await mergeSettings(user.orgId, { blackRules, preflightProfile, exportPolicy });

  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: "org.settings_update",
    entityType: "organization",
    entityId: user.orgId,
    detail: {
      totalAreaCoverageLimit: blackRules.totalAreaCoverageLimit,
      richBlackMinTextSize: blackRules.richBlackMinTextSize,
      profileName: preflightProfile.name,
      minImageDpi: preflightProfile.minImageDpi,
      inkLimit: preflightProfile.inkLimit,
      treatErrorAsBlocking: exportPolicy.treatErrorAsBlocking,
      allowOverride: exportPolicy.allowOverride,
    },
  });

  revalidatePath("/settings");
  revalidatePath("/settings/organisation");
  return { ok: true };
}

/* --------------------------------------------------------- output intent */

/**
 * 8 MB of base64 is roughly a 6 MB profile. Real press profiles are 0.5–2 MB;
 * anything an order of magnitude larger is not an output profile.
 */
const MAX_ICC_BYTES = 6 * 1024 * 1024;

const OutputIntentInputSchema = z.object({
  identifier: z.string().trim().max(128),
  conditionName: z.string().trim().max(200),
  registryName: z.string().trim().max(200),
  info: z.string().trim().max(1000),
});

export type OutputIntentMeta = {
  filename: string;
  byteSize: number;
  colorSpace: string;
  componentCount: number;
  updatedAt: string;
  updatedBy: string;
};

/**
 * Save the printing condition, and optionally replace the ICC profile.
 *
 * The profile is validated with the same decoder the PDF writer uses
 * (`decodeIccProfile`), so a file that would be rejected at export time is
 * rejected here, on the screen where someone can do something about it. A
 * profile that fails the header check is never stored: an OutputIntent that
 * names a condition it cannot point at is worse than no OutputIntent at all.
 */
export async function saveOutputIntentAction(formData: FormData): Promise<ActionResult> {
  const user = await requireCapability("org.manage");

  const parsed = OutputIntentInputSchema.safeParse({
    identifier: String(formData.get("identifier") ?? ""),
    conditionName: String(formData.get("conditionName") ?? ""),
    registryName: String(formData.get("registryName") ?? ""),
    info: String(formData.get("info") ?? ""),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const settings = await readSettings(user.orgId);
  const existing = OutputIntentSchema.parse((settings.outputIntent as object) ?? {});
  const existingMeta = (settings.outputIntentMeta ?? null) as OutputIntentMeta | null;

  const remove = formData.get("removeProfile") === "1";
  const file = formData.get("profile");
  const hasUpload = file instanceof File && file.size > 0;

  let iccBase64 = remove ? undefined : existing.iccBase64;
  let meta: OutputIntentMeta | null = remove ? null : existingMeta;

  if (hasUpload) {
    if (file.size > MAX_ICC_BYTES) {
      return {
        ok: false,
        error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. An ICC output profile is normally under 2 MB.`,
      };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const base64 = Buffer.from(bytes).toString("base64");
    try {
      const decoded = decodeIccProfile(base64);
      iccBase64 = base64;
      meta = {
        filename: file.name,
        byteSize: bytes.byteLength,
        colorSpace: decoded.colorSpace,
        componentCount: decoded.componentCount,
        updatedAt: new Date().toISOString(),
        updatedBy: user.name || user.email,
      };
    } catch (e) {
      if (e instanceof InvalidIccProfileError) return { ok: false, error: e.message };
      throw e;
    }
  }

  const nextIntent = OutputIntentSchema.parse({
    identifier: parsed.data.identifier || "none",
    conditionName: parsed.data.conditionName || "Not specified",
    registryName: parsed.data.registryName,
    info: parsed.data.info,
    ...(iccBase64 === undefined ? {} : { iccBase64 }),
  });

  await mergeSettings(user.orgId, { outputIntent: nextIntent, outputIntentMeta: meta });

  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: hasUpload ? "org.output_intent_profile" : remove ? "org.output_intent_clear" : "org.output_intent_update",
    entityType: "organization",
    entityId: user.orgId,
    detail: {
      identifier: nextIntent.identifier,
      conditionName: nextIntent.conditionName,
      profile: meta === null ? null : { filename: meta.filename, bytes: meta.byteSize, colorSpace: meta.colorSpace },
    },
  });

  revalidatePath("/settings");
  revalidatePath("/settings/output-intent");
  return { ok: true };
}

/* ------------------------------------------------------------------ users */

const RoleSchema = z.enum(ROLES);

/** Deliberately permissive: the only address that matters is one that reaches a person. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const NewUserSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(320)
    .refine((v) => EMAIL_RE.test(v), "Enter a valid email address."),
  name: z.string().trim().max(200),
  role: RoleSchema,
  password: z.string().min(1),
});

/**
 * Add a member of this organisation.
 *
 * The initial password is set by the admin and checked against the same
 * strength rule the login path assumes. There is no email delivery in this
 * deployment, so the honest flow is "you set it, you hand it over, they change
 * it" rather than an invitation link that goes nowhere.
 */
export async function createUserAction(input: unknown): Promise<
  { ok: true; userId: string } | { ok: false; error: string }
> {
  const actor = await requireCapability("org.manage");

  const parsed = NewUserSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue.path.join(".") || "input"}: ${issue.message}` };
  }
  const { email, name, role, password } = parsed.data;

  const strength = checkPasswordStrength(password);
  if (!strength.ok) return { ok: false, error: strength.reason };

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) return { ok: false, error: "An account with that email already exists." };

  const id = nanoid(24);
  await db.insert(users).values({
    id,
    orgId: actor.orgId,
    email,
    name,
    passwordHash: await hashPassword(password),
    role,
    active: true,
    updatedAt: new Date(),
  });

  await audit({
    orgId: actor.orgId,
    userId: actor.id,
    action: "org.user_create",
    entityType: "user",
    entityId: id,
    detail: { email, role },
  });

  revalidatePath("/settings/users");
  return { ok: true, userId: id };
}

const UserRoleSchema = z.object({ userId: z.string().min(1).max(32), role: RoleSchema });

export async function setUserRoleAction(input: unknown): Promise<ActionResult> {
  const actor = await requireCapability("org.manage");

  const parsed = UserRoleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid role change." };
  const { userId, role } = parsed.data;

  const [target] = await db
    .select({ id: users.id, orgId: users.orgId, email: users.email, role: users.role })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, actor.orgId)))
    .limit(1);
  if (!target) return { ok: false, error: "That user is not in your organisation." };
  if (target.role === role) return { ok: true };

  // Losing the last admin locks the organisation out of its own settings, GS1
  // credentials and blocking-error overrides. Refused rather than warned about.
  if (target.role === "admin" && role !== "admin") {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.orgId, actor.orgId), eq(users.role, "admin"), eq(users.active, true)));
    if (n <= 1) {
      return { ok: false, error: "This is the only active admin. Promote someone else first." };
    }
  }

  await db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, userId));
  await audit({
    orgId: actor.orgId,
    userId: actor.id,
    action: "org.user_role",
    entityType: "user",
    entityId: userId,
    detail: { email: target.email, from: target.role, to: role },
  });

  revalidatePath("/settings/users");
  return { ok: true };
}

const UserActiveSchema = z.object({ userId: z.string().min(1).max(32), active: z.boolean() });

export async function setUserActiveAction(input: unknown): Promise<ActionResult> {
  const actor = await requireCapability("org.manage");

  const parsed = UserActiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid change." };
  const { userId, active } = parsed.data;

  if (userId === actor.id && !active) {
    return { ok: false, error: "You cannot deactivate your own account." };
  }

  const [target] = await db
    .select({ id: users.id, email: users.email, role: users.role, active: users.active })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, actor.orgId)))
    .limit(1);
  if (!target) return { ok: false, error: "That user is not in your organisation." };
  if (target.active === active) return { ok: true };

  if (!active && target.role === "admin") {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.orgId, actor.orgId), eq(users.role, "admin"), eq(users.active, true)));
    if (n <= 1) {
      return { ok: false, error: "This is the only active admin. Promote someone else first." };
    }
  }

  await db.update(users).set({ active, updatedAt: new Date() }).where(eq(users.id, userId));
  await audit({
    orgId: actor.orgId,
    userId: actor.id,
    action: active ? "org.user_activate" : "org.user_deactivate",
    entityType: "user",
    entityId: userId,
    detail: { email: target.email },
  });

  revalidatePath("/settings/users");
  return { ok: true };
}
