import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * CREDENTIAL CRYPTO AND LOG REDACTION — spec §13B and §25.
 *
 * Third-party credentials (today: the GS1 US API key or bearer token) are stored
 * encrypted at rest. AES-256-GCM is used rather than CBC because GCM is
 * authenticated: a wrong key, a truncated ciphertext or a flipped bit fails the
 * tag check instead of silently producing garbage that later gets sent to a
 * remote API as if it were a key.
 *
 * Layout matches `gs1_connections` in the DB schema: ciphertext / iv / tag are
 * stored as three separate hex columns rather than one packed blob, so a key
 * rotation can be audited column by column and a malformed row is obvious.
 *
 * Everything here is server-only. `node:crypto` does not exist in the browser,
 * which is a deliberate second line of defence behind "never import this from a
 * client component".
 *
 * Nothing in this module ever puts key material, plaintext or ciphertext into an
 * error message. Failures are returned as typed results with fixed strings, so a
 * caller that logs an error cannot accidentally log a secret.
 */

/** AES-256 needs a 32-byte key, written in .env as 64 hex characters. */
export const CREDENTIAL_KEY_BYTES = 32;
export const CREDENTIAL_KEY_HEX_LENGTH = CREDENTIAL_KEY_BYTES * 2;
/** 96-bit IV is the GCM-native size; anything else forces an internal GHASH. */
export const CREDENTIAL_IV_BYTES = 12;
export const CREDENTIAL_TAG_BYTES = 16;

const ALGORITHM = "aes-256-gcm";

/** Stored form. All three parts are lowercase hex. */
export type EncryptedCredential = {
  ciphertext: string;
  iv: string;
  tag: string;
};

export type CryptoErrorCode =
  | "KEY_MISSING"
  | "KEY_MALFORMED"
  | "PLAINTEXT_EMPTY"
  | "PAYLOAD_MALFORMED"
  | "DECRYPT_FAILED"
  | "ENCRYPT_FAILED";

export type CryptoFailure = {
  ok: false;
  code: CryptoErrorCode;
  /** Fixed, secret-free text. Safe to log and to show to an admin. */
  message: string;
};

export type EncryptResult = { ok: true; value: EncryptedCredential } | CryptoFailure;
export type DecryptResult = { ok: true; value: string } | CryptoFailure;

/**
 * Optional additional authenticated data. Bind a ciphertext to the row that owns
 * it (e.g. `gs1:<orgId>`) so a row copied between organisations fails to decrypt
 * rather than granting one tenant another tenant's API key.
 */
export type CryptoOptions = {
  key?: string | Uint8Array;
  aad?: string;
};

function fail(code: CryptoErrorCode, message: string): CryptoFailure {
  return { ok: false, code, message };
}

const HEX_ONLY = /^[0-9a-fA-F]+$/;

/**
 * Resolve the key. An explicit key wins (tests, key rotation); otherwise
 * `process.env.CREDENTIAL_KEY`. `process.env` is read here and not at module
 * scope so that importing this file has no environment dependency and a test can
 * set the variable after import.
 */
function resolveKey(explicit: string | Uint8Array | undefined): { ok: true; key: Buffer } | CryptoFailure {
  const raw = explicit ?? process.env.CREDENTIAL_KEY;
  if (raw === undefined || raw === null || raw === "") {
    return fail(
      "KEY_MISSING",
      "CREDENTIAL_KEY is not set. Generate one with `openssl rand -hex 32` and add it to the environment.",
    );
  }
  if (typeof raw !== "string") {
    if (raw.byteLength !== CREDENTIAL_KEY_BYTES) {
      return fail("KEY_MALFORMED", `CREDENTIAL_KEY must be ${CREDENTIAL_KEY_BYTES} bytes.`);
    }
    return { ok: true, key: Buffer.from(raw) };
  }
  const hex = raw.trim();
  if (hex.length !== CREDENTIAL_KEY_HEX_LENGTH || !HEX_ONLY.test(hex)) {
    return fail(
      "KEY_MALFORMED",
      `CREDENTIAL_KEY must be exactly ${CREDENTIAL_KEY_HEX_LENGTH} hexadecimal characters.`,
    );
  }
  return { ok: true, key: Buffer.from(hex, "hex") };
}

/** True when a usable key is configured. Used by the settings UI to explain why GS1 is off. */
export function hasCredentialKey(): boolean {
  return resolveKey(undefined).ok;
}

export function encryptCredential(plaintext: string, options: CryptoOptions = {}): EncryptResult {
  if (plaintext === "") return fail("PLAINTEXT_EMPTY", "Refusing to encrypt an empty credential.");
  const resolved = resolveKey(options.key);
  if (!resolved.ok) return resolved;
  try {
    const iv = randomBytes(CREDENTIAL_IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, resolved.key, iv);
    if (options.aad !== undefined) cipher.setAAD(Buffer.from(options.aad, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      ok: true,
      value: {
        ciphertext: ciphertext.toString("hex"),
        iv: iv.toString("hex"),
        tag: cipher.getAuthTag().toString("hex"),
      },
    };
  } catch {
    // The thrown error can carry OpenSSL detail about the key; it is dropped.
    return fail("ENCRYPT_FAILED", "Credential encryption failed.");
  }
}

export function decryptCredential(
  payload: EncryptedCredential,
  options: CryptoOptions = {},
): DecryptResult {
  const resolved = resolveKey(options.key);
  if (!resolved.ok) return resolved;

  if (
    typeof payload.ciphertext !== "string" ||
    typeof payload.iv !== "string" ||
    typeof payload.tag !== "string" ||
    payload.ciphertext === "" ||
    payload.ciphertext.length % 2 !== 0 ||
    !HEX_ONLY.test(payload.ciphertext) ||
    !HEX_ONLY.test(payload.iv) ||
    !HEX_ONLY.test(payload.tag) ||
    payload.iv.length !== CREDENTIAL_IV_BYTES * 2 ||
    payload.tag.length !== CREDENTIAL_TAG_BYTES * 2
  ) {
    return fail("PAYLOAD_MALFORMED", "Stored credential is malformed.");
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, resolved.key, Buffer.from(payload.iv, "hex"));
    if (options.aad !== undefined) decipher.setAAD(Buffer.from(options.aad, "utf8"));
    decipher.setAuthTag(Buffer.from(payload.tag, "hex"));
    const out = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "hex")),
      decipher.final(),
    ]);
    return { ok: true, value: out.toString("utf8") };
  } catch {
    // Wrong key, wrong AAD, or tampered ciphertext. All three are the same
    // answer to the caller and none of them may echo the inputs.
    return fail(
      "DECRYPT_FAILED",
      "Credential could not be decrypted. The encryption key may have changed; re-enter the credential.",
    );
  }
}

/**
 * Key rotation (spec §13B "API key rotation"): decrypt under the old key and
 * re-encrypt under the new one without the plaintext ever leaving this call.
 */
export function rotateCredential(
  payload: EncryptedCredential,
  oldKey: string | Uint8Array,
  newKey: string | Uint8Array,
  aad?: string,
): EncryptResult {
  const opened = decryptCredential(payload, { key: oldKey, aad });
  if (!opened.ok) return opened;
  return encryptCredential(opened.value, { key: newKey, aad });
}

/* ------------------------------------------------------------- redaction */

export const REDACTED = "[redacted]";

/**
 * Key names that mean "this value is a secret". Compared against the key with
 * every non-alphanumeric character removed, so `x-api-key`, `apiKey`, `API_KEY`
 * and `apikey` all match one entry.
 *
 * Substrings only for tokens long enough to be unambiguous. `auth` is NOT a
 * substring rule because it would swallow `author`.
 */
const SENSITIVE_KEY_SUBSTRINGS = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "authorization",
  "credential",
  "bearer",
  "privatekey",
  "accesskey",
  "signature",
  "cookie",
  "encryptionkey",
  "salt",
];

/** Short names that are only sensitive when they are the whole key. */
const SENSITIVE_KEY_EXACT = new Set(["key", "auth", "pwd", "pass", "sig", "jwt", "dsn", "hash"]);

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized === "") return false;
  if (SENSITIVE_KEY_EXACT.has(normalized)) return true;
  return SENSITIVE_KEY_SUBSTRINGS.some((s) => normalized.includes(s));
}

/** `Authorization: Bearer xyz` style values, wherever they appear in free text. */
const AUTH_SCHEME_RE = /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/**
 * `apikey=xyz`, `token: xyz`, `"password":"xyz"` inside a serialised blob. The
 * separator group swallows the closing quote of a JSON key, so the rule fires on
 * `{"api_key":"…"}` and not only on shell-style assignments.
 */
const INLINE_ASSIGNMENT_RE =
  /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization|credential)\b(["']?\s*[=:]\s*)(["']?)([^"'&\s,}]{4,})\3/gi;
/**
 * A bare high-entropy blob: 32+ characters of pure token alphabet with no
 * spaces. Deliberately conservative — every real field in this application
 * (descriptions, part numbers, GTINs, URLs) either contains a space, a dot or a
 * colon, or is shorter than 32 characters.
 */
const OPAQUE_BLOB_RE = /^[A-Za-z0-9_+/=-]{32,}$/;

/** Query parameters whose values are secrets even though the URL is loggable. */
function redactQueryValues(search: URLSearchParams): void {
  for (const name of Array.from(search.keys())) {
    if (isSensitiveKey(name)) search.set(name, REDACTED);
  }
}

/**
 * Make a URL safe to log: drop userinfo, redact secret-looking query values.
 * Returns the input scrubbed as free text when it does not parse as a URL.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username !== "" || url.password !== "") {
      url.username = REDACTED;
      url.password = "";
    }
    redactQueryValues(url.searchParams);
    return url.toString();
  } catch {
    return redactString(raw);
  }
}

/** Host (and port) of a URL, or "" — the only part of a base URL safe to echo. */
export function hostOf(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return "";
  }
}

export type RedactOptions = {
  /**
   * Literal secret values to scrub wherever they occur, at any depth and inside
   * any string. Pass the credential you are using: it defends against a remote
   * API that echoes the Authorization header back inside an error body.
   */
  secrets?: readonly string[];
  maxDepth?: number;
  maxStringLength?: number;
};

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_STRING = 2000;

function scrubLiterals(input: string, secrets: readonly string[]): string {
  let out = input;
  for (const secret of secrets) {
    // Below 8 characters a "secret" is likely to be a common substring; blanket
    // replacement would corrupt unrelated text without protecting anything real.
    if (typeof secret !== "string" || secret.length < 8) continue;
    // split/join replaces every occurrence in one pass. A `while (includes)`
    // loop must not be used here: a secret that is a substring of REDACTED
    // (e.g. "redacted") reintroduces itself on every replacement and spins
    // forever, blocking the event loop of the whole server.
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Scrub one string: literal secrets first, then the shape-based rules. */
export function redactString(input: string, options: RedactOptions = {}): string {
  const max = options.maxStringLength ?? DEFAULT_MAX_STRING;
  let out = scrubLiterals(input, options.secrets ?? []);
  if (OPAQUE_BLOB_RE.test(out.trim())) return REDACTED;
  out = out.replace(AUTH_SCHEME_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(
    INLINE_ASSIGNMENT_RE,
    (_m, name: string, sep: string, quote: string) => `${name}${sep}${quote}${REDACTED}${quote}`,
  );
  if (out.length > max) out = `${out.slice(0, max)}…[truncated]`;
  return out;
}

function isPlainish(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-copy a value into something safe to write to a log, an audit row or a
 * `gs1_request_logs` payload. Never mutates the input.
 *
 * Rules, in order: a key that names a secret is replaced wholesale; a string is
 * scrubbed by `redactString`; binary is reduced to a length; cycles and
 * excessive depth are replaced by markers rather than throwing.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  return redactInner(value, options, options.maxDepth ?? DEFAULT_MAX_DEPTH, new WeakSet<object>());
}

function redactInner(
  value: unknown,
  options: RedactOptions,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case "string":
      return redactString(value, options);
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return `${value.toString()}n`;
    case "function":
      return "[function]";
    case "symbol":
      return "[symbol]";
    default:
      break;
  }

  const obj = value as object;
  if (seen.has(obj)) return "[circular]";
  if (depth <= 0) return "[depth-limited]";

  if (obj instanceof Date) return obj.toISOString();
  if (obj instanceof URL) return redactUrl(obj.toString());
  if (obj instanceof Error) {
    // The stack is dropped: frames can carry inlined argument text on some
    // runtimes, and a stack is never the thing that makes a GS1 log useful.
    return { name: obj.name, message: redactString(obj.message, options) };
  }
  if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) {
    return `[binary ${obj.byteLength} bytes]`;
  }

  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map((item) => redactInner(item, options, depth - 1, seen));
    }
    if (obj instanceof Set) {
      return Array.from(obj, (item) => redactInner(item, options, depth - 1, seen));
    }
    if (obj instanceof Map) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of obj) {
        const key = String(k);
        out[key] = isSensitiveKey(key) ? REDACTED : redactInner(v, options, depth - 1, seen);
      }
      return out;
    }
    if (!isPlainish(obj)) {
      // A class instance: copy its own enumerable data only, never its methods.
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = isSensitiveKey(k) ? REDACTED : redactInner(v, options, depth - 1, seen);
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redactInner(v, options, depth - 1, seen);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}

/** Convenience for log sinks that need a string. */
export function redactToJson(value: unknown, options: RedactOptions = {}): string {
  try {
    return JSON.stringify(redact(value, options)) ?? "null";
  } catch {
    return '"[unserializable]"';
  }
}
