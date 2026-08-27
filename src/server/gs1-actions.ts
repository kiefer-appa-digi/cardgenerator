"use server";

import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { revalidatePath } from "next/cache";
import {
  brands,
  db,
  gs1Connections,
  gs1RequestLogs,
  gs1SyncRecords,
  organizations,
  productIdentifiers,
  products,
} from "@/server/db";
import { requireCapability } from "@/server/auth/current";
import { audit } from "@/server/audit";
import { buildProductContext } from "@/server/products";
import { jsonSafe } from "@/server/json-safe";
import {
  decryptCredential,
  encryptCredential,
  hasCredentialKey,
  redactUrl,
} from "@/server/crypto";
import { applyAcceptedFields, diffRemoteAgainstLocal, getAdapter } from "@/lib/gs1";
import { describeGtinFailure, isValidGtin, normalizeGtin } from "@/lib/gs1/gtin";
import {
  Gs1AuthModeSchema,
  Gs1ConnectionConfigSchema,
  Gs1FieldDiffSchema,
  Gs1PathsSchema,
  Gs1ProviderSchema,
  type Gs1ConnectionConfig,
  type Gs1ConnectionTest,
  type Gs1FieldDiff,
  type Gs1LogEvent,
  type Gs1Logger,
  type Gs1ProductRecord,
  type Gs1VerifyResult,
} from "@/lib/gs1/types";

/**
 * GS1 CONNECTOR ACTIONS — spec §13, §25.
 *
 * Three rules hold everywhere in this file.
 *
 *  1. The credential is write-only. It arrives from the browser once, is
 *     encrypted with `CREDENTIAL_KEY` before the row is written, and is
 *     decrypted only inside the call that needs it. No action returns it, and
 *     no action returns anything derived from it. The settings screen learns
 *     exactly two facts: whether one is stored, and when it was last rotated.
 *
 *  2. Nothing is ever auto-applied to a product. `verifyProductGtinAction`
 *     reads and compares; `acceptGs1FieldsAction` writes, and only the fields a
 *     person ticked, and only if those fields are still marked acceptable on
 *     the stored diff. A stale acceptance list cannot write a value nobody saw.
 *
 *  3. GS1 being off is the normal state, not an error. Every action degrades to
 *     a typed, displayable "not configured" answer instead of throwing.
 */

export type Gs1ActionResult = { ok: true } | { ok: false; error: string };

/** AAD binds a ciphertext to its organisation: a copied row will not decrypt. */
function credentialAad(orgId: string): string {
  return `gs1:${orgId}`;
}

/* ------------------------------------------------------ transport options */

/**
 * `gs1_connections` has columns for the connection's identity and its encrypted
 * credential, but none for the non-secret transport details the adapter also
 * needs (auth mode, header name, endpoint paths, timeout). Those live in the
 * organisation's settings blob alongside the rest of the deployment
 * configuration rather than in a schema change, and they are non-secret by
 * construction — the credential is the only secret and it never comes near
 * this branch.
 */
const Gs1TransportSchema = z.object({
  authMode: Gs1AuthModeSchema,
  apiKeyHeader: z.string().trim().min(1).max(64),
  paths: Gs1PathsSchema,
  timeoutMs: z.number().int().min(1_000).max(60_000),
});
type Gs1Transport = z.infer<typeof Gs1TransportSchema>;

const DEFAULT_TRANSPORT: Gs1Transport = {
  authMode: "bearer",
  apiKeyHeader: "x-api-key",
  paths: Gs1PathsSchema.parse({}),
  timeoutMs: 10_000,
};

async function readTransport(orgId: string): Promise<Gs1Transport> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const settings = (org?.settings ?? {}) as Record<string, unknown>;
  const parsed = Gs1TransportSchema.safeParse(settings.gs1Transport);
  return parsed.success ? parsed.data : DEFAULT_TRANSPORT;
}

async function writeTransport(orgId: string, transport: Gs1Transport): Promise<void> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const settings = (org?.settings ?? {}) as Record<string, unknown>;
  await db
    .update(organizations)
    .set({ settings: { ...settings, gs1Transport: transport }, updatedAt: new Date() })
    .where(eq(organizations.id, orgId));
}

/* ------------------------------------------------------------ connection */

type ConnectionRow = typeof gs1Connections.$inferSelect;

async function readConnection(orgId: string): Promise<ConnectionRow | undefined> {
  const [row] = await db
    .select()
    .from(gs1Connections)
    .where(eq(gs1Connections.orgId, orgId))
    .limit(1);
  return row;
}

/** Create the row on first write. One connection per organisation. */
async function ensureConnection(orgId: string): Promise<ConnectionRow> {
  const existing = await readConnection(orgId);
  if (existing) return existing;
  const id = nanoid(24);
  await db.insert(gs1Connections).values({ id, orgId, updatedAt: new Date() });
  const created = await readConnection(orgId);
  if (!created) throw new Error("The GS1 connection row could not be created.");
  return created;
}

/**
 * Assemble the server-only config the adapter needs, decrypting the credential
 * for the lifetime of this call. A credential that cannot be decrypted (the key
 * changed, the row was copied) is left empty, which `getAdapter` reports as a
 * misconfiguration rather than sending an empty Authorization header.
 */
async function buildConfig(orgId: string): Promise<Gs1ConnectionConfig> {
  const row = await readConnection(orgId);
  if (!row) return Gs1ConnectionConfigSchema.parse({});
  const transport = await readTransport(orgId);

  let credential = "";
  if (row.credentialCiphertext !== "") {
    const opened = decryptCredential(
      {
        ciphertext: row.credentialCiphertext,
        iv: row.credentialIv,
        tag: row.credentialTag,
      },
      { aad: credentialAad(orgId) },
    );
    if (opened.ok) credential = opened.value;
  }

  return Gs1ConnectionConfigSchema.parse({
    provider: row.provider,
    enabled: row.enabled,
    baseUrl: row.baseUrl,
    companyPrefix: row.companyPrefix,
    authMode: transport.authMode,
    credential,
    apiKeyHeader: transport.apiKeyHeader,
    timeoutMs: transport.timeoutMs,
    paths: transport.paths,
  });
}

/* --------------------------------------------------------- request logging */

type PendingLogRow = {
  method: string;
  path: string;
  statusCode: number | null;
  durationMs: number | null;
  requestSummary: unknown;
  responseSummary: unknown;
  error: string;
};

/**
 * Turn the adapter's log events into `gs1_request_logs` rows — one per attempt.
 *
 * Everything on a `Gs1LogEvent` has already been through `redact()` inside the
 * adapter, so nothing here has to filter; it only has to pair each request with
 * its outcome. The cap exists because a rate-limited batch can otherwise write
 * a log row per retry per product.
 */
const MAX_LOG_ROWS_PER_CALL = 12;

function createLogCollector(operation: string): { logger: Gs1Logger; rows: PendingLogRow[] } {
  const rows: PendingLogRow[] = [];
  const byAttempt = new Map<number, PendingLogRow>();
  const requests = new Map<number, unknown>();

  const logger: Gs1Logger = (event: Gs1LogEvent) => {
    if (event.phase === "retry") return;
    if (event.phase === "request") {
      requests.set(event.attempt, event.request ?? {});
      return;
    }

    const existing = byAttempt.get(event.attempt);
    if (existing) {
      // The loop emits a final "error" event for the attempt it gave up on; it
      // annotates the row that attempt already produced instead of adding one.
      if (existing.error === "" && event.phase === "error") {
        existing.error = event.message ?? event.errorCode ?? "";
      }
      if (existing.statusCode === null && event.status !== undefined) {
        existing.statusCode = event.status;
      }
      return;
    }

    if (rows.length >= MAX_LOG_ROWS_PER_CALL) return;
    const row: PendingLogRow = {
      method: event.method,
      path: event.path,
      statusCode: event.status ?? null,
      durationMs: event.durationMs ?? null,
      requestSummary: {
        operation,
        attempt: event.attempt,
        host: event.host,
        request: requests.get(event.attempt) ?? {},
      },
      responseSummary: event.response ?? {},
      error:
        event.phase === "error" ? (event.message ?? event.errorCode ?? "Request failed.") : "",
    };
    byAttempt.set(event.attempt, row);
    rows.push(row);
  };

  return { logger, rows };
}

async function writeRequestLogs(orgId: string, rows: PendingLogRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    await db.insert(gs1RequestLogs).values(
      rows.map((r) => ({
        id: nanoid(24),
        orgId,
        method: r.method.slice(0, 8),
        path: r.path.slice(0, 2000),
        statusCode: r.statusCode,
        durationMs: r.durationMs,
        requestSummary: jsonSafe(r.requestSummary).value,
        responseSummary: jsonSafe(r.responseSummary).value,
        error: r.error.slice(0, 2000),
      })),
    );
  } catch (e) {
    // A log write must never fail the operation it is recording.
    console.error("[gs1] failed to write request log", e);
  }
}

/* ----------------------------------------------------------- save + toggle */

const ConnectionInputSchema = z.object({
  provider: Gs1ProviderSchema,
  baseUrl: z.string().trim().max(500),
  companyPrefix: z.string().trim().max(24),
  authMode: Gs1AuthModeSchema,
  apiKeyHeader: z.string().trim().min(1).max(64),
  timeoutMs: z.number().int().min(1_000).max(60_000),
  paths: Gs1PathsSchema,
});

export type Gs1ConnectionInput = z.infer<typeof ConnectionInputSchema>;

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Save the connection's identity and transport. Never touches the credential
 * columns: a settings save must not be able to blank a stored key.
 */
export async function saveGs1ConnectionAction(input: unknown): Promise<Gs1ActionResult> {
  const user = await requireCapability("gs1.configure");

  const parsed = ConnectionInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue.path.join(".") || "input"}: ${issue.message}` };
  }
  const cfg = parsed.data;

  if (cfg.provider !== "disabled" && cfg.baseUrl !== "" && !isHttpUrl(cfg.baseUrl)) {
    return { ok: false, error: "The base URL must be a full http(s) URL, e.g. https://api.example.com." };
  }
  if (cfg.companyPrefix !== "" && !/^[0-9]{6,12}$/.test(cfg.companyPrefix)) {
    return { ok: false, error: "A GS1 company prefix is 6 to 12 digits." };
  }

  const row = await ensureConnection(user.orgId);

  // Switching the provider to "disabled" turns the connection off with it;
  // leaving it enabled but pointed at nothing would produce a settings screen
  // that claims a live connection and an adapter that answers NOT_CONFIGURED.
  const enabled = cfg.provider === "disabled" ? false : row.enabled;

  await db
    .update(gs1Connections)
    .set({
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      companyPrefix: cfg.companyPrefix,
      enabled,
      updatedAt: new Date(),
    })
    .where(eq(gs1Connections.id, row.id));

  await writeTransport(user.orgId, {
    authMode: cfg.authMode,
    apiKeyHeader: cfg.apiKeyHeader,
    paths: cfg.paths,
    timeoutMs: cfg.timeoutMs,
  });

  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: "gs1.configure",
    entityType: "gs1_connection",
    entityId: row.id,
    detail: {
      provider: cfg.provider,
      // The base URL is not a secret, but a gateway URL can carry a key in its
      // query string, so it is redacted before it reaches the audit trail.
      baseUrl: redactUrl(cfg.baseUrl),
      companyPrefix: cfg.companyPrefix,
      authMode: cfg.authMode,
      timeoutMs: cfg.timeoutMs,
    },
  });

  revalidatePath("/settings/gs1");
  revalidatePath("/settings");
  return { ok: true };
}

export async function setGs1EnabledAction(enabled: boolean): Promise<Gs1ActionResult> {
  const user = await requireCapability("gs1.configure");
  const row = await ensureConnection(user.orgId);

  if (enabled) {
    const transport = await readTransport(user.orgId);
    if (row.provider === "disabled") {
      return { ok: false, error: "Choose a provider before enabling the connection." };
    }
    if (!isHttpUrl(row.baseUrl)) {
      return { ok: false, error: "Set a valid base URL before enabling the connection." };
    }
    if (transport.authMode !== "none" && row.credentialCiphertext === "") {
      return { ok: false, error: "Store a credential before enabling the connection." };
    }
  }

  await db
    .update(gs1Connections)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(gs1Connections.id, row.id));

  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: enabled ? "gs1.enable" : "gs1.disable",
    entityType: "gs1_connection",
    entityId: row.id,
    detail: { provider: row.provider },
  });

  revalidatePath("/settings/gs1");
  revalidatePath("/settings");
  return { ok: true };
}

/* -------------------------------------------------------------- credential */

const CredentialInputSchema = z.object({ credential: z.string().min(1).max(4096) });

/**
 * Store or rotate the credential (§13B "API key rotation").
 *
 * The plaintext exists only inside this function. `keyVersion` counts how many
 * times a credential has been written, and `rotatedAt` is the only timestamp
 * the UI is given — together they are the whole of what an admin can learn
 * about a stored key.
 */
export async function setGs1CredentialAction(
  input: unknown,
): Promise<{ ok: true; rotatedAt: string; keyVersion: number } | { ok: false; error: string }> {
  const user = await requireCapability("gs1.configure");

  const parsed = CredentialInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter the credential to store." };
  const credential = parsed.data.credential.trim();
  if (credential === "") return { ok: false, error: "Enter the credential to store." };

  if (!hasCredentialKey()) {
    return {
      ok: false,
      error:
        "CREDENTIAL_KEY is not set on this deployment, so a credential cannot be encrypted. " +
        "Generate one with `openssl rand -hex 32` and add it to the environment.",
    };
  }

  const sealed = encryptCredential(credential, { aad: credentialAad(user.orgId) });
  if (!sealed.ok) return { ok: false, error: sealed.message };

  const row = await ensureConnection(user.orgId);
  const replacing = row.credentialCiphertext !== "";
  const rotatedAt = new Date();
  // Version 1 is the first credential this connection has held; every
  // replacement moves it on by one, so the number counts rotations rather than
  // writes to the row.
  const keyVersion = replacing ? row.keyVersion + 1 : 1;

  await db
    .update(gs1Connections)
    .set({
      credentialCiphertext: sealed.value.ciphertext,
      credentialIv: sealed.value.iv,
      credentialTag: sealed.value.tag,
      keyVersion,
      rotatedAt,
      // A rotated key invalidates the previous test result; saying "connected"
      // on the strength of a test that used the old key would be a lie.
      lastTestOk: false,
      lastTestDetail: replacing
        ? "The credential was rotated after this test. Run the connection test again."
        : row.lastTestDetail,
      updatedAt: rotatedAt,
    })
    .where(eq(gs1Connections.id, row.id));

  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: replacing ? "gs1.credential_rotate" : "gs1.credential_set",
    entityType: "gs1_connection",
    entityId: row.id,
    detail: { keyVersion, provider: row.provider },
  });

  revalidatePath("/settings/gs1");
  return { ok: true, rotatedAt: rotatedAt.toISOString(), keyVersion };
}

export async function clearGs1CredentialAction(): Promise<Gs1ActionResult> {
  const user = await requireCapability("gs1.configure");
  const row = await ensureConnection(user.orgId);
  if (row.credentialCiphertext === "") return { ok: true };

  await db
    .update(gs1Connections)
    .set({
      credentialCiphertext: "",
      credentialIv: "",
      credentialTag: "",
      // Without a credential the connection cannot authenticate, so it is
      // switched off rather than left enabled and failing on every product.
      enabled: false,
      lastTestOk: false,
      lastTestDetail: "The stored credential was removed.",
      rotatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(gs1Connections.id, row.id));

  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: "gs1.credential_clear",
    entityType: "gs1_connection",
    entityId: row.id,
  });

  revalidatePath("/settings/gs1");
  revalidatePath("/settings");
  return { ok: true };
}

/* --------------------------------------------------------- connection test */

/**
 * `Gs1ConnectionTest` carries a host, never a URL and never a credential — see
 * the note on the schema. It is safe to hand straight back to the browser.
 */
export async function testGs1ConnectionAction(): Promise<
  { ok: true; test: Gs1ConnectionTest } | { ok: false; error: string }
> {
  const user = await requireCapability("gs1.configure");
  const row = await ensureConnection(user.orgId);

  const config = await buildConfig(user.orgId);
  const { logger, rows } = createLogCollector("testConnection");
  const adapter = getAdapter(config, { logger });

  const test = await adapter.testConnection();
  await writeRequestLogs(user.orgId, rows);

  await db
    .update(gs1Connections)
    .set({
      lastTestAt: new Date(test.checkedAt),
      lastTestOk: test.ok,
      lastTestDetail: (test.detail || test.error?.message || "").slice(0, 2000),
      updatedAt: new Date(),
    })
    .where(eq(gs1Connections.id, row.id));

  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: "gs1.test",
    entityType: "gs1_connection",
    entityId: row.id,
    detail: {
      ok: test.ok,
      host: test.host,
      latencyMs: test.latencyMs,
      code: test.error?.code ?? null,
    },
  });

  revalidatePath("/settings/gs1");
  return { ok: true, test };
}

export async function clearGs1LogsAction(): Promise<Gs1ActionResult> {
  const user = await requireCapability("gs1.configure");
  await db.delete(gs1RequestLogs).where(eq(gs1RequestLogs.orgId, user.orgId));
  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: "gs1.logs_clear",
    entityType: "gs1_connection",
    entityId: null,
  });
  revalidatePath("/settings/gs1");
  return { ok: true };
}

/* ------------------------------------------------------------ verify/diff */

/** What the verify screen is given. The remote record's `raw` blob is dropped. */
export type Gs1VerifyOutcome = {
  syncRecordId: string;
  gtin: string;
  verify: Omit<Gs1VerifyResult, "record">;
  record: Omit<Gs1ProductRecord, "raw"> | null;
  diffs: Gs1FieldDiff[];
  attempts: number;
  durationMs: number;
};

const VerifyInputSchema = z.object({
  productId: z.string().min(1).max(32),
  /** Optional override for a product whose GTIN is not yet recorded. */
  gtin: z.string().trim().max(24).optional(),
});

/**
 * Drop the provider's raw payload before the record goes to a browser. It is
 * kept on the sync record for diagnosis; the screen only needs mapped fields.
 */
function stripRaw(record: Gs1ProductRecord): Omit<Gs1ProductRecord, "raw"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-omit: `raw` exists only to be discarded.
  const { raw, ...rest } = record;
  return rest;
}

/**
 * Verify a GTIN with the configured registry and compare what comes back with
 * the local product. Reads only. The returned diff is also persisted on a
 * `gs1_sync_records` row, which is what `acceptGs1FieldsAction` later checks an
 * acceptance against — the browser never gets to choose the value that is
 * written, only which of the rows it was shown may be applied.
 */
export async function verifyProductGtinAction(
  input: unknown,
): Promise<{ ok: true; outcome: Gs1VerifyOutcome } | { ok: false; error: string; detail?: string }> {
  const user = await requireCapability("gs1.sync");

  const parsed = VerifyInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Choose a product to verify." };

  const [product] = await db
    .select({ id: products.id, orgId: products.orgId, partNumber: products.partNumber })
    .from(products)
    .where(and(eq(products.id, parsed.data.productId), eq(products.orgId, user.orgId)))
    .limit(1);
  if (!product) return { ok: false, error: "That product is not in your organisation." };

  const context = await buildProductContext(user.orgId, product.id);
  if (!context) return { ok: false, error: "That product could not be loaded." };

  const candidate =
    (parsed.data.gtin ?? "").trim() ||
    context.identifiers.gtin14 ||
    context.identifiers.gtin13 ||
    context.identifiers.upc12;
  if (candidate === "") {
    return {
      ok: false,
      error: `${product.partNumber || "This product"} has no GTIN or UPC on record. Add one to the product first, or type one below.`,
    };
  }

  const normalized = normalizeGtin(candidate);
  if (!normalized.ok) {
    return { ok: false, error: describeGtinFailure(normalized) };
  }
  const gtin14 = normalized.gtin14;

  const config = await buildConfig(user.orgId);
  const { logger, rows } = createLogCollector("verifyGtin");
  const adapter = getAdapter(config, { logger });

  const verified = await adapter.verifyGtin(gtin14);
  if (!verified.ok) {
    await writeRequestLogs(user.orgId, rows);
    await db.insert(gs1SyncRecords).values({
      id: nanoid(24),
      orgId: user.orgId,
      productId: product.id,
      gtin: gtin14,
      operation: "verify",
      status: "failed",
      error: `${verified.error.code}: ${verified.error.message}`.slice(0, 2000),
    });
    return {
      ok: false,
      error: verified.error.message,
      detail: verified.error.detail || undefined,
    };
  }

  // Some registries answer the verification endpoint with attributes attached;
  // others need a second call. Only ask twice when the first answer was thin.
  let record: Gs1ProductRecord | null = verified.value.record;
  let attempts = verified.attempts;
  let durationMs = verified.durationMs;
  if (record === null && verified.value.status === "verified" && adapter.capabilities.fetchProduct) {
    const fetched = await adapter.fetchProduct(gtin14);
    if (fetched.ok) {
      record = fetched.value;
      attempts += fetched.attempts;
      durationMs += fetched.durationMs;
    }
  }

  await writeRequestLogs(user.orgId, rows);

  const diffs = record === null ? [] : diffRemoteAgainstLocal(record, context);
  const acceptable = diffs.filter((d) => d.acceptable);

  const syncRecordId = nanoid(24);
  await db.insert(gs1SyncRecords).values({
    id: syncRecordId,
    orgId: user.orgId,
    productId: product.id,
    gtin: gtin14,
    operation: "verify",
    // pending = a person still has to decide; no_changes = nothing to decide.
    status: acceptable.length > 0 ? "pending" : "no_changes",
    remotePayload: record === null ? null : jsonSafe(record).value,
    diff: jsonSafe(diffs).value,
    lastSyncedAt: new Date(),
  });

  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: "gs1.verify",
    entityType: "product",
    entityId: product.id,
    detail: {
      gtin: gtin14,
      status: verified.value.status,
      differences: acceptable.length,
      compared: diffs.length,
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-omit: the record travels separately, stripped of `raw`.
  const { record: nested, ...verifySummary } = verified.value;

  return {
    ok: true,
    outcome: {
      syncRecordId,
      gtin: gtin14,
      verify: verifySummary,
      record: record === null ? null : stripRaw(record),
      diffs,
      attempts,
      durationMs,
    },
  };
}

/* ------------------------------------------------------- explicit acceptance */

const AcceptInputSchema = z.object({
  syncRecordId: z.string().min(1).max(32),
  paths: z.array(z.string().min(1).max(120)).min(1).max(64),
});

type ProductPatch = Partial<typeof products.$inferInsert>;

/**
 * Split a GS1 net-content string ("1 KIT", "12 OZ") into the count and unit the
 * product table stores separately. A value with no space is kept whole as the
 * count, because inventing a unit is worse than leaving it blank.
 */
function splitNetContent(value: string): { count: string; uom: string } {
  const m = value.trim().match(/^(\S+)\s+(.+)$/);
  if (!m) return { count: value.trim(), uom: "" };
  return { count: m[1], uom: m[2].slice(0, 16) };
}

const IDENTIFIER_KINDS: Record<string, string> = {
  "identifiers.gtin14": "gtin14",
  "identifiers.sku": "sku",
  "identifiers.gs1CompanyPrefix": "gs1CompanyPrefix",
};

/**
 * Apply the fields a reviewer explicitly accepted.
 *
 * The value written is the one stored on the sync record, not one supplied by
 * the browser, and only rows the diff marked `acceptable` are eligible. The
 * accepted set is first run through `applyAcceptedFields`, which rebuilds the
 * ProductContext and validates it: if the result would not be a valid context,
 * nothing is written at all.
 */
export async function acceptGs1FieldsAction(input: unknown): Promise<
  | { ok: true; applied: string[]; rejected: Array<{ path: string; reason: string }> }
  | { ok: false; error: string }
> {
  const user = await requireCapability("product.write");
  await requireCapability("gs1.sync");

  const parsed = AcceptInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Select at least one field to accept." };

  const [sync] = await db
    .select()
    .from(gs1SyncRecords)
    .where(
      and(
        eq(gs1SyncRecords.id, parsed.data.syncRecordId),
        eq(gs1SyncRecords.orgId, user.orgId),
      ),
    )
    .limit(1);
  if (!sync) return { ok: false, error: "That comparison is no longer available. Run the check again." };
  if (sync.status === "applied") {
    return { ok: false, error: "This comparison has already been applied. Run the check again to see what is left." };
  }

  const diffs = z.array(Gs1FieldDiffSchema).safeParse(sync.diff);
  if (!diffs.success) return { ok: false, error: "The stored comparison is unreadable. Run the check again." };

  const context = await buildProductContext(user.orgId, sync.productId);
  if (!context) return { ok: false, error: "That product could not be loaded." };

  const outcome = applyAcceptedFields(context, diffs.data, parsed.data.paths);
  if (outcome.applied.length === 0) {
    return {
      ok: false,
      error:
        outcome.rejected.length > 0
          ? "None of those fields can be accepted from this comparison. Run the check again."
          : "Nothing was selected.",
    };
  }

  const [row] = await db
    .select({ id: products.id, custom: products.custom, brandId: products.brandId })
    .from(products)
    .where(and(eq(products.id, sync.productId), eq(products.orgId, user.orgId)))
    .limit(1);
  if (!row) return { ok: false, error: "That product is no longer available." };

  const byPath = new Map(diffs.data.map((d) => [d.path, d]));
  const patch: ProductPatch = {};
  const custom = { ...((row.custom ?? {}) as Record<string, string>) };
  const identifierWrites: Array<{ kind: string; value: string }> = [];
  const applied: string[] = [];
  const rejected = [...outcome.rejected].map((r) => ({ path: r.path, reason: r.reason as string }));
  let customTouched = false;
  let brandName: string | null = null;

  for (const path of outcome.applied) {
    const diff = byPath.get(path);
    if (!diff) continue;
    const value = diff.remoteValue;

    if (path in IDENTIFIER_KINDS) {
      identifierWrites.push({ kind: IDENTIFIER_KINDS[path], value });
      applied.push(path);
      continue;
    }
    if (path.startsWith("custom.")) {
      custom[path.slice("custom.".length)] = value;
      customTouched = true;
      applied.push(path);
      continue;
    }
    switch (path) {
      case "brand.name":
        brandName = value;
        applied.push(path);
        break;
      case "description":
        patch.description = value;
        applied.push(path);
        break;
      case "labelDescription":
        patch.labelDescription = value;
        applied.push(path);
        break;
      case "countryOfOrigin":
        patch.countryOfOrigin = value;
        applied.push(path);
        break;
      case "status":
        patch.status = value.slice(0, 24);
        applied.push(path);
        break;
      case "netContent": {
        const { count, uom } = splitNetContent(value);
        patch.netContentCount = count;
        patch.netContentUom = uom;
        applied.push(path);
        break;
      }
      default:
        // A mapped ProductContext path with no column behind it. Reported, not
        // swallowed: the reviewer ticked it and deserves to know it did nothing.
        rejected.push({ path, reason: "no-local-field" });
    }
  }

  if (brandName !== null) {
    const name = brandName.trim().slice(0, 200);
    const [existingBrand] = await db
      .select({ id: brands.id })
      .from(brands)
      .where(and(eq(brands.orgId, user.orgId), eq(brands.name, name)))
      .limit(1);
    if (existingBrand) {
      patch.brandId = existingBrand.id;
    } else {
      const brandId = nanoid(24);
      await db.insert(brands).values({ id: brandId, orgId: user.orgId, name, updatedAt: new Date() });
      patch.brandId = brandId;
    }
  }

  if (customTouched) patch.custom = custom;

  if (Object.keys(patch).length > 0) {
    patch.updatedAt = new Date();
    patch.lastModifiedSource = "gs1";
    await db.update(products).set(patch).where(eq(products.id, row.id));
  }

  for (const write of identifierWrites) {
    const isGtinKind = write.kind.startsWith("gtin");
    const [existing] = await db
      .select({ id: productIdentifiers.id })
      .from(productIdentifiers)
      .where(
        and(
          eq(productIdentifiers.productId, row.id),
          eq(productIdentifiers.kind, write.kind),
          eq(productIdentifiers.orgId, user.orgId),
        ),
      )
      .limit(1);
    const values = {
      value: write.value.slice(0, 64),
      valid: isGtinKind ? isValidGtin(write.value) : true,
      validationNote: `Accepted from GS1 (${sync.gtin}) on ${new Date().toISOString().slice(0, 10)}`,
    };
    if (existing) {
      await db.update(productIdentifiers).set(values).where(eq(productIdentifiers.id, existing.id));
    } else {
      await db.insert(productIdentifiers).values({
        id: nanoid(24),
        orgId: user.orgId,
        productId: row.id,
        kind: write.kind,
        isPrimary: write.kind === "gtin14",
        ...values,
      });
    }
  }

  await db
    .update(gs1SyncRecords)
    .set({
      status: "applied",
      acceptedFields: applied,
      acceptedBy: user.id,
      acceptedAt: new Date(),
    })
    .where(eq(gs1SyncRecords.id, sync.id));

  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: "gs1.accept_fields",
    entityType: "product",
    entityId: row.id,
    detail: {
      gtin: sync.gtin,
      applied: applied.map((path) => {
        const d = byPath.get(path);
        return { path, from: d?.localValue ?? "", to: d?.remoteValue ?? "" };
      }),
      rejected,
    },
  });

  revalidatePath("/settings/gs1/verify");
  revalidatePath(`/products/${row.id}`);
  revalidatePath(`/products/${row.id}/gs1`);
  return { ok: true, applied, rejected };
}

/* ------------------------------------------------------------- read model */

export type Gs1SettingsView = {
  connection: {
    provider: Gs1ConnectionConfig["provider"];
    baseUrl: string;
    companyPrefix: string;
    authMode: Gs1ConnectionConfig["authMode"];
    apiKeyHeader: string;
    timeoutMs: number;
    paths: Gs1ConnectionConfig["paths"];
    enabled: boolean;
  };
  credential: {
    configured: boolean;
    rotatedAt: string | null;
    keyVersion: number;
    /** Whether the deployment can encrypt at all. Nothing about the credential. */
    keyAvailable: boolean;
  };
  lastTest: { at: string | null; ok: boolean; detail: string };
  /** Recent verifications and what was accepted from each — spec §13A's paper trail. */
  syncs: Array<{
    id: string;
    gtin: string;
    partNumber: string;
    productId: string;
    operation: string;
    status: string;
    acceptedFields: string[];
    error: string;
    createdAt: string;
  }>;
  logs: Array<{
    id: string;
    method: string;
    path: string;
    statusCode: number | null;
    durationMs: number | null;
    requestSummary: unknown;
    responseSummary: unknown;
    error: string;
    createdAt: string;
  }>;
};

/**
 * Everything the settings screen may know about the connection.
 *
 * The credential branch carries three booleans and a date; there is no code
 * path from the ciphertext columns to this type, which is the point — the page
 * cannot leak what it is never given.
 */
export async function gs1SettingsViewAction(): Promise<Gs1SettingsView> {
  const user = await requireCapability("gs1.read");
  const row = await readConnection(user.orgId);
  const transport = await readTransport(user.orgId);

  const logs = await db
    .select()
    .from(gs1RequestLogs)
    .where(eq(gs1RequestLogs.orgId, user.orgId))
    .orderBy(desc(gs1RequestLogs.createdAt))
    .limit(50);

  const syncs = await db
    .select({
      id: gs1SyncRecords.id,
      gtin: gs1SyncRecords.gtin,
      productId: gs1SyncRecords.productId,
      partNumber: products.partNumber,
      operation: gs1SyncRecords.operation,
      status: gs1SyncRecords.status,
      acceptedFields: gs1SyncRecords.acceptedFields,
      error: gs1SyncRecords.error,
      createdAt: gs1SyncRecords.createdAt,
    })
    .from(gs1SyncRecords)
    .leftJoin(products, eq(products.id, gs1SyncRecords.productId))
    .where(eq(gs1SyncRecords.orgId, user.orgId))
    .orderBy(desc(gs1SyncRecords.createdAt))
    .limit(10);

  return {
    connection: {
      provider: Gs1ProviderSchema.catch("disabled").parse(row?.provider ?? "disabled"),
      baseUrl: row?.baseUrl ?? "",
      companyPrefix: row?.companyPrefix ?? "",
      authMode: transport.authMode,
      apiKeyHeader: transport.apiKeyHeader,
      timeoutMs: transport.timeoutMs,
      paths: transport.paths,
      enabled: row?.enabled ?? false,
    },
    credential: {
      configured: (row?.credentialCiphertext ?? "") !== "",
      rotatedAt: row?.rotatedAt ? row.rotatedAt.toISOString() : null,
      keyVersion: row?.keyVersion ?? 1,
      keyAvailable: hasCredentialKey(),
    },
    lastTest: {
      at: row?.lastTestAt ? row.lastTestAt.toISOString() : null,
      ok: row?.lastTestOk ?? false,
      detail: row?.lastTestDetail ?? "",
    },
    syncs: syncs.map((s) => ({
      id: s.id,
      gtin: s.gtin,
      productId: s.productId,
      partNumber: s.partNumber ?? "",
      operation: s.operation,
      status: s.status,
      acceptedFields: Array.isArray(s.acceptedFields) ? (s.acceptedFields as string[]) : [],
      error: s.error,
      createdAt: s.createdAt.toISOString(),
    })),
    logs: logs.map((l) => ({
      id: l.id,
      method: l.method,
      path: l.path,
      statusCode: l.statusCode,
      durationMs: l.durationMs,
      requestSummary: l.requestSummary,
      responseSummary: l.responseSummary,
      error: l.error,
      createdAt: l.createdAt.toISOString(),
    })),
  };
}
