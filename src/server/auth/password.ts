import bcrypt from "bcryptjs";

/**
 * Password hashing. bcrypt with cost 12 — the standard OWASP recommendation and
 * still comfortably inside a serverless function's CPU budget (~200 ms).
 */
const COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

/**
 * A REAL bcrypt hash at the same cost factor, of a password nobody has.
 *
 * The obvious version of this — comparing against a made-up string — returns in
 * microseconds because bcrypt rejects a malformed hash before doing any work,
 * which hands an attacker a timing oracle for "does this email have an account".
 * Comparing against a valid hash costs the same ~200 ms as a real check, so the
 * two paths are indistinguishable. `tests/integration/auth.test.ts` measures it.
 */
const DUMMY_HASH = "$2b$12$abcdefghijklmnopqrstuufI5nLbA198I63OJsBZSppsRVnVFQdbW";

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!hash) {
    await bcrypt.compare(plain, DUMMY_HASH);
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
