import { z } from "zod";

/**
 * GS1 ADAPTER CONTRACT — spec §13.
 *
 * GS1 is an *optional connected service*, never a runtime dependency. Every type
 * here is therefore built around two rules:
 *
 *  1. No method throws for an expected failure. "Not configured", "GTIN not in
 *     the registry", "rate limited" and "the token expired" are all values, so a
 *     caller cannot forget to handle them and cannot crash a render because a
 *     third party is down.
 *  2. No credential is ever representable in a result. `Gs1ConnectionConfig`
 *     carries the decrypted credential and is server-only input; nothing that
 *     comes back out of an adapter has a field that can hold one.
 *
 * This module is pure types plus zod schemas and is safe to import from client
 * code (the settings screen needs the provider list and the diff shape). The
 * *adapters* are not: see the header of `providers/gs1us.ts`.
 */

export const GS1_PROVIDERS = [
  "disabled",
  /** Verified by GS1 — read-only GTIN verification/enrichment (§13A). */
  "gs1us-verified",
  /** GS1 US Data Hub — brand-owner create/manage (§13B). */
  "gs1us-datahub",
  /** Any deployment-supplied endpoint that speaks the same shapes. */
  "custom",
] as const;
export const Gs1ProviderSchema = z.enum(GS1_PROVIDERS);
export type Gs1Provider = z.infer<typeof Gs1ProviderSchema>;

export const GS1_AUTH_MODES = ["none", "bearer", "api-key"] as const;
export const Gs1AuthModeSchema = z.enum(GS1_AUTH_MODES);
export type Gs1AuthMode = z.infer<typeof Gs1AuthModeSchema>;

/* ------------------------------------------------------------------ errors */

export const GS1_ERROR_CODES = [
  /** No connection row, or the row is disabled. The normal state. */
  "NOT_CONFIGURED",
  /** Configured but unusable: no base URL, or an auth mode with no credential. */
  "MISCONFIGURED",
  /** Failed check-digit or wrong length. Decided locally, no request is sent. */
  "INVALID_GTIN",
  "NOT_FOUND",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "RATE_LIMITED",
  "TIMEOUT",
  "NETWORK",
  /** 2xx whose body was not the JSON shape the mapper needs. */
  "BAD_RESPONSE",
  "SERVER_ERROR",
  "CONFLICT",
  /** The remote rejected the payload: 400/422. */
  "VALIDATION",
  /** The configured provider does not offer this operation. */
  "UNSUPPORTED",
] as const;
export const Gs1ErrorCodeSchema = z.enum(GS1_ERROR_CODES);
export type Gs1ErrorCode = z.infer<typeof Gs1ErrorCodeSchema>;

export const Gs1ErrorSchema = z.object({
  code: Gs1ErrorCodeSchema,
  /** Operator-facing text. Guaranteed free of credentials. */
  message: z.string(),
  /** HTTP status, when the failure came from a response rather than the wire. */
  status: z.number().int().optional(),
  /** True when trying again later could plausibly succeed. */
  retryable: z.boolean(),
  /** How many requests were actually sent, including the one that failed. */
  attempts: z.number().int().min(0),
  /** From `Retry-After` on a 429, in milliseconds. */
  retryAfterMs: z.number().int().min(0).optional(),
  /** Redacted body excerpt or wire message. Also credential-free. */
  detail: z.string().default(""),
});
export type Gs1Error = z.infer<typeof Gs1ErrorSchema>;

/**
 * Every adapter method returns this. `attempts` and `durationMs` are on the
 * success branch too so the sync UI can show "3 attempts, 1.4 s" without a
 * second channel.
 */
export type Gs1Result<T> =
  | { ok: true; value: T; attempts: number; durationMs: number }
  | { ok: false; error: Gs1Error };

export function gs1Ok<T>(value: T, attempts: number, durationMs: number): Gs1Result<T> {
  return { ok: true, value, attempts, durationMs };
}

export function gs1Err<T>(error: Gs1Error): Gs1Result<T> {
  return { ok: false, error };
}

export function makeGs1Error(
  code: Gs1ErrorCode,
  message: string,
  extra: Partial<Omit<Gs1Error, "code" | "message">> = {},
): Gs1Error {
  return {
    code,
    message,
    retryable: extra.retryable ?? false,
    attempts: extra.attempts ?? 0,
    detail: extra.detail ?? "",
    ...(extra.status === undefined ? {} : { status: extra.status }),
    ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
  };
}

/* ------------------------------------------------------------ product record */

/**
 * A measurement as GS1 reports it: a number plus the UN/ECE code for its unit.
 * The unit is kept verbatim rather than normalised to µpt — this is third-party
 * reference data about a physical carton, not artboard geometry, and rewriting
 * it would destroy the provenance a reviewer needs when accepting a diff.
 */
export const Gs1MeasurementSchema = z.object({
  value: z.number(),
  /** UN/ECE Rec 20 code as returned, e.g. "INH", "MMT", "GRM", "LBR". */
  unitCode: z.string().default(""),
});
export type Gs1Measurement = z.infer<typeof Gs1MeasurementSchema>;

export const Gs1DimensionsSchema = z.object({
  width: Gs1MeasurementSchema.nullable().default(null),
  height: Gs1MeasurementSchema.nullable().default(null),
  depth: Gs1MeasurementSchema.nullable().default(null),
});
export type Gs1Dimensions = z.infer<typeof Gs1DimensionsSchema>;

export const Gs1WeightsSchema = z.object({
  gross: Gs1MeasurementSchema.nullable().default(null),
  net: Gs1MeasurementSchema.nullable().default(null),
});
export type Gs1Weights = z.infer<typeof Gs1WeightsSchema>;

/** Company / licence block (§13A "company/license information where available"). */
export const Gs1CompanySchema = z.object({
  name: z.string().default(""),
  gs1CompanyPrefix: z.string().default(""),
  /** e.g. "LICENSEE_LICENCE_ACTIVE" / "INACTIVE". Verbatim from the registry. */
  licenseStatus: z.string().default(""),
  /** GLN of the licensee, when published. */
  gln: z.string().default(""),
  countryOfLicense: z.string().default(""),
});
export type Gs1Company = z.infer<typeof Gs1CompanySchema>;

/**
 * The normalised product record. Every provider mapper produces this shape, so
 * the diff engine and the UI never see a provider-specific payload.
 *
 * Text fields default to "" rather than being optional: "GS1 has no value for
 * this" and "we did not ask" are the same thing to a reviewer, and an empty
 * string keeps the diff logic free of undefined checks.
 */
export const Gs1ProductRecordSchema = z.object({
  /** Always stored as the 14-digit form; the mapper zero-pads. */
  gtin: z.string(),
  sku: z.string().default(""),
  brandName: z.string().default(""),
  productDescription: z.string().default(""),
  labelDescription: z.string().default(""),
  netContent: z.string().default(""),
  countryOfOrigin: z.string().default(""),
  /** ISO 3166 alpha-3 or numeric codes as published. */
  targetMarkets: z.array(z.string()).default([]),
  /** GTIN lifecycle status as published, e.g. "ACTIVE" / "DISCONTINUED". */
  status: z.string().default(""),
  gpcBrickCode: z.string().default(""),
  gpcBrickDescription: z.string().default(""),
  imageUrl: z.string().default(""),
  company: Gs1CompanySchema.default({
    name: "",
    gs1CompanyPrefix: "",
    licenseStatus: "",
    gln: "",
    countryOfLicense: "",
  }),
  dimensions: Gs1DimensionsSchema.default({ width: null, height: null, depth: null }),
  weights: Gs1WeightsSchema.default({ gross: null, net: null }),
  /** Which provider produced it, kept for the audit trail. */
  source: Gs1ProviderSchema,
  /** ISO-8601. Drives "last synced" (§13B). */
  retrievedAt: z.string(),
  /**
   * The provider payload as received, already run through `redact()`. Stored so
   * a mapping bug can be diagnosed without re-querying GS1.
   */
  raw: z.record(z.string(), z.unknown()).default({}),
});
export type Gs1ProductRecord = z.infer<typeof Gs1ProductRecordSchema>;

export function emptyGs1ProductRecord(gtin: string, source: Gs1Provider, retrievedAt: string): Gs1ProductRecord {
  return {
    gtin,
    sku: "",
    brandName: "",
    productDescription: "",
    labelDescription: "",
    netContent: "",
    countryOfOrigin: "",
    targetMarkets: [],
    status: "",
    gpcBrickCode: "",
    gpcBrickDescription: "",
    imageUrl: "",
    company: { name: "", gs1CompanyPrefix: "", licenseStatus: "", gln: "", countryOfLicense: "" },
    dimensions: { width: null, height: null, depth: null },
    weights: { gross: null, net: null },
    source,
    retrievedAt,
    raw: {},
  };
}

/* --------------------------------------------------------------- verify */

/**
 * Verification outcomes. Note that "not-found" is a successful *answer*, not an
 * error: the registry replied and the answer is "no such GTIN". `fetchProduct`
 * treats the same 404 as `NOT_FOUND` because there the caller wanted data.
 */
export const GS1_VERIFY_STATUSES = ["verified", "not-found", "inactive"] as const;
export const Gs1VerifyStatusSchema = z.enum(GS1_VERIFY_STATUSES);
export type Gs1VerifyStatus = z.infer<typeof Gs1VerifyStatusSchema>;

export const Gs1VerifyResultSchema = z.object({
  /** The normalised 14-digit GTIN that was checked. */
  gtin: z.string(),
  status: Gs1VerifyStatusSchema,
  /**
   * Local mod-10 result. True on every successful verification — a bad check
   * digit is rejected as `INVALID_GTIN` before a request is sent — and kept on
   * the record so a stored `gs1_sync_records` row states both facts it rests on.
   */
  checkDigitValid: z.boolean(),
  company: Gs1CompanySchema,
  /** Present when the verification endpoint also returned product attributes. */
  record: Gs1ProductRecordSchema.nullable().default(null),
  checkedAt: z.string(),
  detail: z.string().default(""),
});
export type Gs1VerifyResult = z.infer<typeof Gs1VerifyResultSchema>;

/* -------------------------------------------------------------- publish */

export const Gs1PublishReceiptSchema = z.object({
  gtin: z.string(),
  accepted: z.boolean(),
  /** Provider-side identifier for the created/updated record, when returned. */
  remoteId: z.string().default(""),
  status: z.string().default(""),
  submittedAt: z.string(),
  /** Provider validation notes. Redacted before it gets here. */
  messages: z.array(z.string()).default([]),
});
export type Gs1PublishReceipt = z.infer<typeof Gs1PublishReceiptSchema>;

/* ------------------------------------------------------- connection test */

export const Gs1ConnectionTestSchema = z.object({
  ok: z.boolean(),
  provider: Gs1ProviderSchema,
  /**
   * Host only. A full base URL can carry a credential in its query string; a
   * host cannot, so this is the only part of the endpoint the UI ever echoes.
   */
  host: z.string().default(""),
  detail: z.string().default(""),
  latencyMs: z.number().int().min(0).default(0),
  checkedAt: z.string(),
  error: Gs1ErrorSchema.nullable().default(null),
});
export type Gs1ConnectionTest = z.infer<typeof Gs1ConnectionTestSchema>;

/* ----------------------------------------------------------------- diff */

/**
 * Diff outcomes. `missing-locally` and `conflict` are the only two a reviewer can
 * accept; `match` and `remote-empty` are shown so the comparison table is honest
 * about what was checked rather than only listing problems.
 */
export const GS1_DIFF_KINDS = ["missing-locally", "conflict", "match", "remote-empty"] as const;
export const Gs1DiffKindSchema = z.enum(GS1_DIFF_KINDS);
export type Gs1DiffKind = z.infer<typeof Gs1DiffKindSchema>;

export const Gs1FieldDiffSchema = z.object({
  /** Dotted ProductContext path, e.g. "brand.name". The acceptance key. */
  path: z.string(),
  label: z.string(),
  /** Which Gs1ProductRecord field it came from, for the audit row. */
  remoteField: z.string(),
  localValue: z.string(),
  remoteValue: z.string(),
  kind: Gs1DiffKindSchema,
  /** True when accepting would replace a non-empty local value. */
  overwritesLocal: z.boolean(),
  /** True when this row may be passed to `applyAcceptedFields`. */
  acceptable: z.boolean(),
});
export type Gs1FieldDiff = z.infer<typeof Gs1FieldDiffSchema>;

/* -------------------------------------------------------- digital link */

/**
 * GS1 DIGITAL LINK — the documented future path (§13, §12).
 *
 * What exists today is real and complete: `digital-link.ts` builds and parses
 * Digital Link URIs, which is everything the QR symbology in the design schema
 * needs. What does not exist is *resolution* — calling a resolver and getting a
 * link set back — because that requires a resolver a deployment actually owns.
 *
 * The extension point is typed rather than stubbed: `Gs1Adapter.resolveDigitalLink`
 * is an optional method and `Gs1Capabilities.digitalLinkResolution` says whether
 * it is present. A future provider implements the method and flips the flag; no
 * caller has to change, and nothing in the codebase throws "not implemented".
 */
export const Gs1DigitalLinkConfigSchema = z.object({
  /** Canonical GS1 resolver. Used for URIs we generate. */
  resolverDomain: z.string().default("https://id.gs1.org"),
  /** Set once a deployment has a resolver that answers link-set queries. */
  resolutionEnabled: z.boolean().default(false),
});
export type Gs1DigitalLinkConfig = z.infer<typeof Gs1DigitalLinkConfigSchema>;

export const Gs1LinkSchema = z.object({
  /** Link type, e.g. "gs1:pip" (product information page). */
  rel: z.string(),
  href: z.string(),
  title: z.string().default(""),
  type: z.string().default(""),
  hreflang: z.array(z.string()).default([]),
});
export type Gs1Link = z.infer<typeof Gs1LinkSchema>;

export const Gs1DigitalLinkResolutionSchema = z.object({
  uri: z.string(),
  gtin: z.string(),
  /** Application-identifier qualifiers parsed out of the URI, keyed by AI. */
  qualifiers: z.record(z.string(), z.string()).default({}),
  links: z.array(Gs1LinkSchema).default([]),
  resolvedAt: z.string(),
});
export type Gs1DigitalLinkResolution = z.infer<typeof Gs1DigitalLinkResolutionSchema>;

/* --------------------------------------------------------------- config */

/**
 * Endpoint paths. Verified by GS1 and Data Hub do not share a path layout, and a
 * deployment may sit behind a gateway that prefixes everything, so the paths are
 * configuration rather than constants. `{gtin}` is the only placeholder.
 */
export const Gs1PathsSchema = z.object({
  /** Cheap authenticated endpoint used only by `testConnection`. */
  test: z.string().default("/v1/health"),
  verify: z.string().default("/v1/gtins/{gtin}"),
  product: z.string().default("/v1/gtins/{gtin}"),
  publish: z.string().default("/v1/products"),
});
export type Gs1Paths = z.infer<typeof Gs1PathsSchema>;

export const Gs1RetryPolicySchema = z.object({
  /** Total requests, not retries: 1 means "never retry". */
  maxAttempts: z.number().int().min(1).max(10).default(3),
  /** First backoff, doubled per attempt. */
  baseBackoffMs: z.number().int().min(0).max(60_000).default(400),
  maxBackoffMs: z.number().int().min(0).max(300_000).default(8_000),
  /**
   * Fraction of the computed delay that is randomised, 0..1. 0.5 gives the
   * "equal jitter" behaviour: half the delay fixed, half random. Jitter is not
   * optional politeness — without it a batch run of 200 products retries in
   * lockstep and re-triggers the same rate limit.
   */
  jitterRatio: z.number().min(0).max(1).default(0.5),
  /** Ceiling applied to a server-supplied Retry-After, so a bad header cannot stall a job. */
  maxRetryAfterMs: z.number().int().min(0).max(600_000).default(60_000),
});
export type Gs1RetryPolicy = z.infer<typeof Gs1RetryPolicySchema>;

/**
 * SERVER-ONLY. `credential` is the decrypted API key or bearer token. This object
 * must never be constructed in, serialised to, or passed through client code, and
 * must never be written to browser storage (spec §25). It is assembled in a
 * server action from `gs1_connections` + `decryptCredential`, handed to
 * `getAdapter`, and discarded.
 */
export const Gs1ConnectionConfigSchema = z.object({
  provider: Gs1ProviderSchema.default("disabled"),
  enabled: z.boolean().default(false),
  baseUrl: z.string().default(""),
  companyPrefix: z.string().default(""),
  authMode: Gs1AuthModeSchema.default("bearer"),
  /** Decrypted secret. Redacted by key name everywhere it could be logged. */
  credential: z.string().default(""),
  /** Header name for `api-key` mode. GS1 US fronts some APIs with Azure APIM. */
  apiKeyHeader: z.string().default("x-api-key"),
  /** Extra non-secret headers a gateway may require (e.g. a subscription id). */
  extraHeaders: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
  retry: Gs1RetryPolicySchema.default({
    maxAttempts: 3,
    baseBackoffMs: 400,
    maxBackoffMs: 8_000,
    jitterRatio: 0.5,
    maxRetryAfterMs: 60_000,
  }),
  paths: Gs1PathsSchema.default({
    test: "/v1/health",
    verify: "/v1/gtins/{gtin}",
    product: "/v1/gtins/{gtin}",
    publish: "/v1/products",
  }),
  digitalLink: Gs1DigitalLinkConfigSchema.default({
    resolverDomain: "https://id.gs1.org",
    resolutionEnabled: false,
  }),
});
export type Gs1ConnectionConfig = z.infer<typeof Gs1ConnectionConfigSchema>;

/** The "GS1 is off" configuration. Parsing an empty object yields exactly this. */
export const DISABLED_CONNECTION: Gs1ConnectionConfig = Gs1ConnectionConfigSchema.parse({});

/* --------------------------------------------------------------- logging */

/**
 * Request logging (§13B "request logging with secrets redacted"). The adapter
 * builds every field of this through `redact()` before calling the hook, so a
 * sink can write it straight to `gs1_request_logs` without further filtering.
 */
export type Gs1LogPhase = "request" | "response" | "retry" | "error";

export type Gs1LogEvent = {
  phase: Gs1LogPhase;
  operation: "testConnection" | "verifyGtin" | "fetchProduct" | "publishProduct";
  method: string;
  /** Path with any secret-looking query value already replaced. Never the credential. */
  path: string;
  host: string;
  attempt: number;
  status?: number;
  durationMs?: number;
  /** Delay before the next attempt, when phase is "retry". */
  nextDelayMs?: number;
  retryAfterMs?: number;
  errorCode?: Gs1ErrorCode;
  /** Redacted. */
  message?: string;
  /** Redacted request summary: headers and body with secrets stripped. */
  request?: unknown;
  /** Redacted response summary. */
  response?: unknown;
};

export type Gs1Logger = (event: Gs1LogEvent) => void;

/** Discards everything. The default, so a caller that wants no logging says nothing. */
export const noopGs1Logger: Gs1Logger = () => {};

/* ---------------------------------------------------------- capabilities */

/**
 * What the configured provider can actually do. The UI reads this instead of
 * switching on the provider name, so adding a provider does not mean editing
 * every screen.
 */
export type Gs1Capabilities = {
  verify: boolean;
  fetchProduct: boolean;
  publish: boolean;
  /** See the Digital Link note above: false everywhere today, by design. */
  digitalLinkResolution: boolean;
};
