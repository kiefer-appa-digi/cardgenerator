import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import type { Role } from "@/server/db/schema";

/**
 * Sessions are stateless signed JWTs in an HttpOnly, SameSite=Lax cookie, backed
 * by a `sessions` row so an administrator can revoke one. The JWT carries only
 * what authorisation needs — no email, no name, nothing worth stealing from a
 * decoded token.
 */

export const SESSION_COOKIE = "cardgen_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

export type SessionClaims = {
  sub: string; // user id
  sid: string; // session row id
  org: string; // organization id
  role: Role;
};

function secret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      "AUTH_SECRET must be set to at least 32 characters. See .env.example.",
    );
  }
  return new TextEncoder().encode(s);
}

export async function signSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({ org: claims.org, role: claims.role, sid: claims.sid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret());
}

export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    if (!payload.sub || typeof payload.org !== "string" || typeof payload.sid !== "string") {
      return null;
    }
    return {
      sub: payload.sub,
      sid: payload.sid,
      org: payload.org,
      role: payload.role as Role,
    };
  } catch {
    return null;
  }
}

export async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

export async function readSessionCookie(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(SESSION_COOKIE)?.value ?? null;
}
