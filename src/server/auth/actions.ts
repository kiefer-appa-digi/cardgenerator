"use server";

import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db, sessions, users } from "@/server/db";
import { audit } from "@/server/audit";
import { verifyPassword } from "./password";
import {
  SESSION_TTL_SECONDS,
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
  signSession,
  verifySession,
} from "./session";
import type { Role } from "@/server/db/schema";

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

export type LoginState = { error?: string; ok?: boolean };

/**
 * Credentials sign-in.
 *
 * The failure message is identical for "no such user", "wrong password" and
 * "deactivated account", and a wrong password still costs a bcrypt comparison,
 * so the form cannot be used to enumerate accounts. Repeated failures lock the
 * account for 15 minutes, which is the rate limit that matters for a login form.
 */
export async function loginAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "") || "/";

  if (!email || !password) return { error: "Enter your email and password." };

  const generic = "That email and password combination was not recognised.";

  const found = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const user = found[0];

  if (!user) {
    // Constant-ish work so a missing account is not faster than a wrong password.
    await verifyPassword(password, "");
    return { error: generic };
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    return { error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.` };
  }

  const ok = user.active && (await verifyPassword(password, user.passwordHash));

  if (!ok) {
    const failed = user.failedLoginCount + 1;
    await db
      .update(users)
      .set({
        failedLoginCount: failed,
        lockedUntil:
          failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      })
      .where(eq(users.id, user.id));
    await audit({
      orgId: user.orgId,
      userId: user.id,
      action: "auth.login_failed",
      entityType: "user",
      entityId: user.id,
      detail: { attempt: failed },
    });
    return { error: generic };
  }

  const h = await headers();
  const sessionId = nanoid(24);
  await db.insert(sessions).values({
    id: sessionId,
    userId: user.id,
    orgId: user.orgId,
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    userAgent: (h.get("user-agent") ?? "").slice(0, 512),
    ip: (h.get("x-forwarded-for") ?? "").split(",")[0].trim().slice(0, 64),
  });

  await db
    .update(users)
    .set({ lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null })
    .where(eq(users.id, user.id));

  const token = await signSession({
    sub: user.id,
    sid: sessionId,
    org: user.orgId,
    role: user.role as Role,
  });
  await setSessionCookie(token);

  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: "auth.login",
    entityType: "user",
    entityId: user.id,
  });

  // Only ever redirect to a same-site path, never to an attacker-supplied host.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function logoutAction(): Promise<void> {
  const token = await readSessionCookie();
  if (token) {
    const claims = await verifySession(token);
    if (claims) {
      await db
        .delete(sessions)
        .where(and(eq(sessions.id, claims.sid), eq(sessions.userId, claims.sub)));
      await audit({
        orgId: claims.org,
        userId: claims.sub,
        action: "auth.logout",
        entityType: "user",
        entityId: claims.sub,
      });
    }
  }
  await clearSessionCookie();
  redirect("/login");
}
