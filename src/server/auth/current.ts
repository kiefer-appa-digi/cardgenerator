import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";
import { db, sessions, users } from "@/server/db";
import { readSessionCookie, verifySession } from "./session";
import { can, type Capability } from "./rbac";
import type { Role } from "@/server/db/schema";

export type CurrentUser = {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: Role;
  sessionId: string;
  preferences: Record<string, unknown>;
};

/**
 * Resolve the signed-in user. Cached per request so a page that checks
 * authorisation in five places still makes one query.
 *
 * The JWT alone is not trusted for authorisation: the session row is re-read so
 * a revoked session, a deactivated user or a role change takes effect at once.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = await readSessionCookie();
  if (!token) return null;
  const claims = await verifySession(token);
  if (!claims) return null;

  const rows = await db
    .select({
      id: users.id,
      orgId: users.orgId,
      email: users.email,
      name: users.name,
      role: users.role,
      active: users.active,
      preferences: users.preferences,
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, claims.sid))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (!row.active) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  // The token's org must still match the user's org: a moved user loses the session.
  if (row.orgId !== claims.org) return null;

  return {
    id: row.id,
    orgId: row.orgId,
    email: row.email,
    name: row.name,
    role: row.role as Role,
    sessionId: row.sessionId,
    preferences: (row.preferences ?? {}) as Record<string, unknown>,
  };
});

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Throws 401 when signed out. Use at the top of every server action. */
export async function requireUser(): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) throw new AuthError("Not signed in", 401);
  return u;
}

/** Throws 403 when the role lacks the capability. */
export async function requireCapability(cap: Capability): Promise<CurrentUser> {
  const u = await requireUser();
  if (!can(u.role, cap)) {
    throw new AuthError(`Your role (${u.role}) cannot ${cap}`, 403);
  }
  return u;
}

/**
 * Organisation isolation guard. Every read of a tenant-scoped row goes through
 * this, so a forged id from the client cannot reach another org's data.
 */
export function assertSameOrg(user: CurrentUser, rowOrgId: string | null | undefined): void {
  if (!rowOrgId || rowOrgId !== user.orgId) {
    throw new AuthError("Not found in your organisation", 403);
  }
}
