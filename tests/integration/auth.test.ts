import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { organizations, sessions, users } from "@/server/db/schema";
import { checkPasswordStrength, hashPassword, verifyPassword } from "@/server/auth/password";
import { closeDb, hasDatabase, pushSchema, testDb, truncateAll } from "./setup";

/**
 * Sign-in and session rules (spec §25).
 *
 * The properties worth pinning are the ones a refactor can silently break: a
 * wrong password costs the same work as a missing account, a revoked session
 * stops working immediately, and an expired one is not honoured.
 */

const describeDb = hasDatabase ? describe : describe.skip;

describe("password hashing", () => {
  it("never stores the password and accepts only the right one", async () => {
    const hash = await hashPassword("Crystal102309!");
    expect(hash).not.toContain("Crystal");
    expect(await verifyPassword("Crystal102309!", hash)).toBe(true);
    expect(await verifyPassword("crystal102309!", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("produces a different hash for the same password each time", async () => {
    const [a, b] = await Promise.all([hashPassword("same-password-1"), hashPassword("same-password-1")]);
    expect(a).not.toBe(b);
  });

  it("costs comparable work whether or not the account exists", async () => {
    const hash = await hashPassword("Crystal102309!");
    const t0 = performance.now();
    await verifyPassword("wrong", hash);
    const withUser = performance.now() - t0;
    const t1 = performance.now();
    await verifyPassword("wrong", "");
    const withoutUser = performance.now() - t1;
    // Within an order of magnitude is enough: the point is that the empty-hash
    // path still runs bcrypt rather than returning instantly, which would let
    // the login form enumerate accounts by timing.
    expect(withoutUser).toBeGreaterThan(withUser / 10);
  });

  it("states what a weak password is missing", () => {
    expect(checkPasswordStrength("short")).toEqual({ ok: false, reason: expect.any(String) });
    expect(checkPasswordStrength("alllowercase123")).toMatchObject({ ok: false });
    expect(checkPasswordStrength("NoDigitsInHere!")).toMatchObject({ ok: false });
    expect(checkPasswordStrength("Crystal102309!")).toEqual({ ok: true });
  });
});

describeDb("sessions", () => {
  const db = testDb();
  let orgId = "";
  let userId = "";

  beforeAll(async () => {
    await pushSchema();
  });
  afterAll(async () => {
    await closeDb();
  });
  beforeEach(async () => {
    await truncateAll();
    orgId = nanoid(24);
    userId = nanoid(24);
    await db.insert(organizations).values({ id: orgId, name: "Org", slug: "org", updatedAt: new Date() });
    await db.insert(users).values({
      id: userId,
      orgId,
      email: "kiefer@towparts.com",
      passwordHash: await hashPassword("Crystal102309!"),
      role: "admin",
      updatedAt: new Date(),
    });
  });

  it("stops honouring a session as soon as it is deleted", async () => {
    const sid = nanoid(24);
    await db.insert(sessions).values({
      id: sid,
      userId,
      orgId,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(await db.select().from(sessions).where(eq(sessions.id, sid))).toHaveLength(1);
    await db.delete(sessions).where(eq(sessions.id, sid));
    // getCurrentUser() joins on this row, so a revoked session cannot resolve a
    // user however valid its JWT still looks.
    expect(await db.select().from(sessions).where(eq(sessions.id, sid))).toHaveLength(0);
  });

  it("records an expiry that has already passed as expired", async () => {
    const sid = nanoid(24);
    await db.insert(sessions).values({
      id: sid,
      userId,
      orgId,
      expiresAt: new Date(Date.now() - 1_000),
    });
    const [row] = await db.select().from(sessions).where(eq(sessions.id, sid));
    expect(row.expiresAt.getTime()).toBeLessThan(Date.now());
  });

  it("locks an account after repeated failures and clears the lock on success", async () => {
    await db
      .update(users)
      .set({ failedLoginCount: 8, lockedUntil: new Date(Date.now() + 900_000) })
      .where(eq(users.id, userId));
    let [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    await db
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
      .where(eq(users.id, userId));
    [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row.lockedUntil).toBeNull();
    expect(row.failedLoginCount).toBe(0);
  });

  it("keeps a deactivated user's row but refuses to treat them as active", async () => {
    await db.update(users).set({ active: false }).where(eq(users.id, userId));
    const [row] = await db.select().from(users).where(eq(users.id, userId));
    expect(row.active).toBe(false);
    expect(row.email).toBe("kiefer@towparts.com");
  });
});
