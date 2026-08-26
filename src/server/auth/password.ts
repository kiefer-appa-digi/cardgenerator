import bcrypt from "bcryptjs";

/**
 * Password hashing. bcrypt with cost 12 — the standard OWASP recommendation and
 * still comfortably inside a serverless function's CPU budget (~200 ms).
 */
const COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!hash) {
    // Still burn the time so a missing user is indistinguishable from a wrong
    // password by timing.
    await bcrypt.compare(plain, "$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv");
    return false;
  }
  return bcrypt.compare(plain, hash);
}

export type PasswordIssue = { ok: false; reason: string } | { ok: true };

export function checkPasswordStrength(plain: string): PasswordIssue {
  if (plain.length < 12) return { ok: false, reason: "Use at least 12 characters." };
  if (!/[a-z]/.test(plain) || !/[A-Z]/.test(plain))
    return { ok: false, reason: "Mix upper and lower case." };
  if (!/\d/.test(plain)) return { ok: false, reason: "Include at least one digit." };
  return { ok: true };
}
