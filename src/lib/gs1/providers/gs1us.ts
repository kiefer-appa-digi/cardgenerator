import { hostOf, redact, redactString, redactUrl } from "@/server/crypto";
import type { Gs1Adapter } from "../adapter";
import { guarded, unsupportedError } from "../adapter";
import { describeGtinFailure, normalizeGtin } from "../gtin";
import type {
  Gs1Capabilities,
  Gs1Company,
  Gs1ConnectionConfig,
  Gs1ConnectionTest,
  Gs1Dimensions,
  Gs1Error,
  Gs1LogEvent,
  Gs1Logger,
  Gs1Measurement,
  Gs1ProductRecord,
  Gs1PublishReceipt,
  Gs1Result,
  Gs1RetryPolicy,
  Gs1VerifyResult,
  Gs1Weights,
} from "../types";
import { emptyGs1ProductRecord, gs1Err, gs1Ok, makeGs1Error, noopGs1Logger } from "../types";

/**
 * GS1 US REST ADAPTER — spec §13A/§13B.
 *
 * Speaks the shape used by Verified by GS1 and GS1 US Data Hub: a JSON REST API
 * behind either a bearer token or an API-key header, with per-deployment base
 * URL and paths. It does not scrape anything (§13 forbids it) and it makes no
 * assumption about which of the two products is on the other end beyond the
 * configured paths.
 *
 * SERVER ONLY. This closure holds the decrypted credential. Constructing it in a
 * client component would put a GS1 key in the browser bundle, which §25
 * forbids outright. `fetch` is injected rather than taken from the global scope
 * so the whole retry/backoff/timeout machine is unit-testable with no network
 * and no timers longer than the test's own timeout.
 *
 * Everything that could carry the credential passes through `redact()` before it
 * reaches the logger or an error: header values are redacted by key name, and
 * the credential itself is registered as a literal secret so that a remote API
 * echoing the Authorization header back inside an error body still cannot leak
 * it.
 */

/**
 * The minimum of `fetch` this adapter uses. Narrower than the DOM lib type on
 * purpose: a test fake needs four members, not the whole Response surface. The
 * global `fetch` is structurally assignable to it.
 */
export type Gs1FetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
};

export type Gs1FetchInit = {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

export type Gs1Fetch = (url: string, init: Gs1FetchInit) => Promise<Gs1FetchResponse>;

export type Gs1UsDeps = {
  fetch: Gs1Fetch;
  /** §13B "request logging with secrets redacted". Receives redacted events only. */
  logger?: Gs1Logger;
  /** Injectable clock so durations are deterministic in tests. */
  now?: () => number;
  /** Injectable delay so backoff can be asserted without waiting for it. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source. */
  random?: () => number;
};

const GS1_US_CAPABILITIES: Record<"verified" | "datahub" | "custom", Gs1Capabilities> = {
  // Verified by GS1 is a read-only registry lookup.
  verified: { verify: true, fetchProduct: true, publish: false, digitalLinkResolution: false },
  // Data Hub is where a brand owner manages its own records.
  datahub: { verify: true, fetchProduct: true, publish: true, digitalLinkResolution: false },
  // A deployment-supplied endpoint is assumed to do everything until it 404s.
  custom: { verify: true, fetchProduct: true, publish: true, digitalLinkResolution: false },
};

function capabilitiesFor(provider: Gs1ConnectionConfig["provider"]): Gs1Capabilities {
  if (provider === "gs1us-verified") return GS1_US_CAPABILITIES.verified;
  if (provider === "gs1us-datahub") return GS1_US_CAPABILITIES.datahub;
  return GS1_US_CAPABILITIES.custom;
}

/* --------------------------------------------------------------- helpers */

/** Substitute every `{gtin}` placeholder; `String.replace` would take only the first. */
function fillGtinPath(template: string, gtin14: string): string {
  return template.split("{gtin}").join(encodeURIComponent(gtin14));
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

/** Path + query for the log line. The host is logged separately. */
function pathForLog(url: string): string {
  try {
    const u = new URL(redactUrl(url));
    return `${u.pathname}${u.search}`;
  } catch {
    return redactString(url);
  }
}

/**
 * Equal-jitter backoff: half the delay is fixed so progress is bounded, half is
 * random so a batch of products does not retry in lockstep and re-trip the same
 * rate limit.
 */
export function backoffDelayMs(
  attempt: number,
  policy: Gs1RetryPolicy,
  random: () => number,
): number {
  const raw = Math.min(policy.maxBackoffMs, policy.baseBackoffMs * 2 ** (attempt - 1));
  const jittered = raw * policy.jitterRatio;
  return Math.max(0, Math.round(raw - jittered + jittered * random()));
}

/** RFC 7231: `Retry-After` is either delta-seconds or an HTTP-date. */
export function parseRetryAfterMs(
  header: string | null,
  nowMs: number,
  capMs: number,
): number | undefined {
  if (header === null) return undefined;
  const raw = header.trim();
  if (raw === "") return undefined;
  if (/^[0-9]+$/.test(raw)) return Math.min(capMs, Number(raw) * 1000);
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.min(capMs, Math.max(0, at - nowMs));
}

type HttpOutcome =
  | { kind: "response"; status: number; body: string; retryAfter: string | null }
  | { kind: "timeout" }
  | { kind: "network"; message: string };

/** Classification table. Anything not listed as retryable is a permanent answer. */
function classifyStatus(status: number): { code: Gs1Error["code"]; retryable: boolean } {
  if (status === 401) return { code: "UNAUTHORIZED", retryable: false };
  if (status === 403) return { code: "FORBIDDEN", retryable: false };
  if (status === 404) return { code: "NOT_FOUND", retryable: false };
  if (status === 408) return { code: "TIMEOUT", retryable: true };
  if (status === 409) return { code: "CONFLICT", retryable: false };
  if (status === 429) return { code: "RATE_LIMITED", retryable: true };
  if (status >= 500) return { code: "SERVER_ERROR", retryable: true };
  // Every other 4xx is the caller's fault: retrying sends the same bad request.
  if (status >= 400) return { code: "VALIDATION", retryable: false };
  // A 1xx or 3xx reaching here means the transport did not follow the exchange
  // to a conclusion. Calling it VALIDATION would tell an operator to fix a
  // payload that the remote never objected to.
  return { code: "BAD_RESPONSE", retryable: false };
}

const STATUS_TEXT: Partial<Record<Gs1Error["code"], string>> = {
  UNAUTHORIZED: "GS1 rejected the credential. Re-enter or rotate the API key.",
  FORBIDDEN: "The GS1 credential is not authorised for this operation.",
  NOT_FOUND: "GS1 has no record for this identifier.",
  TIMEOUT: "The GS1 request timed out.",
  CONFLICT: "GS1 reports a conflicting record for this GTIN.",
  RATE_LIMITED: "GS1 rate limit reached.",
  SERVER_ERROR: "GS1 returned a server error.",
  VALIDATION: "GS1 rejected the request payload.",
};

/* ------------------------------------------------------- payload mapping */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Providers wrap the record differently (`data`, `results[0]`, `gtinRecord`, or
 * nothing). Unwrap one layer at a time until a plain object with a GTIN-ish key
 * is found, rather than hard-coding one vendor's envelope.
 */
function unwrapRecord(payload: unknown): Record<string, unknown> | null {
  let cur: unknown = payload;
  for (let depth = 0; depth < 4; depth++) {
    if (Array.isArray(cur)) {
      if (cur.length === 0) return null;
      cur = cur[0];
      continue;
    }
    const rec = asRecord(cur);
    if (rec === null) return null;
    const looksLikeRecord =
      "gtin" in rec || "gtinNumber" in rec || "brandName" in rec || "productDescription" in rec;
    if (looksLikeRecord) return rec;
    const next = rec.data ?? rec.item ?? rec.gtinRecord ?? rec.results ?? rec.products ?? rec.product;
    if (next === undefined) return rec;
    cur = next;
  }
  return asRecord(cur);
}

/** Language-tagged values are the norm in GS1 payloads: `[{value, language}]`. */
function textOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    for (const entry of value) {
      const rec = asRecord(entry);
      if (rec === null) continue;
      const lang = textOf(rec.language ?? rec.languageCode ?? rec.lang).toLowerCase();
      if (lang.startsWith("en")) return textOf(rec.value ?? rec.text);
    }
    for (const entry of value) {
      const t = textOf(entry);
      if (t !== "") return t;
    }
    return "";
  }
  const rec = asRecord(value);
  if (rec === null) return "";
  if ("value" in rec) return textOf(rec.value);
  if ("text" in rec) return textOf(rec.text);
  return "";
}

function pickText(source: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const t = textOf(source[key]);
    if (t !== "") return t;
  }
  return "";
}

function pickList(source: Record<string, unknown>, keys: readonly string[]): string[] {
  for (const key of keys) {
    const raw = source[key];
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw)) {
      const out = raw.map(textOf).filter((s) => s !== "");
      if (out.length > 0) return out;
      continue;
    }
    const t = textOf(raw);
    if (t !== "") return [t];
  }
  return [];
}

function measurementOf(value: unknown): Gs1Measurement | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return { value, unitCode: "" };
  if (Array.isArray(value)) {
    for (const entry of value) {
      const m = measurementOf(entry);
      if (m !== null) return m;
    }
    return null;
  }
  const rec = asRecord(value);
  if (rec === null) {
    const n = Number(textOf(value));
    return Number.isFinite(n) && textOf(value) !== "" ? { value: n, unitCode: "" } : null;
  }
  const rawValue = rec.value ?? rec.measurementValue ?? rec.amount;
  const n = typeof rawValue === "number" ? rawValue : Number(textOf(rawValue));
  if (!Number.isFinite(n)) return null;
  return {
    value: n,
    unitCode: pickText(rec, ["unitCode", "measurementUnitCode", "unit", "uom"]),
  };
}

function pickMeasurement(
  sources: readonly Record<string, unknown>[],
  keys: readonly string[],
): Gs1Measurement | null {
  for (const source of sources) {
    for (const key of keys) {
      const m = measurementOf(source[key]);
      if (m !== null) return m;
    }
  }
  return null;
}

function formatMeasurement(m: Gs1Measurement | null): string {
  if (m === null) return "";
  return m.unitCode === "" ? String(m.value) : `${m.value} ${m.unitCode}`;
}

const FIELD_KEYS = {
  gtin: ["gtin", "gtinNumber", "gtin14", "globalTradeItemNumber"],
  sku: ["sku", "skuCode", "additionalTradeItemIdentification", "itemReference"],
  brandName: ["brandName", "brand", "brandNameInformation"],
  productDescription: ["productDescription", "tradeItemDescription", "description", "regulatedProductName"],
  labelDescription: ["labelDescription", "functionalName", "descriptionShort", "shortDescription"],
  netContent: ["netContent", "netContentDescription", "netContentStatement"],
  countryOfOrigin: ["countryOfOrigin", "countryOfOriginCode", "countryOfOriginStatement"],
  targetMarkets: ["targetMarket", "targetMarketCountryCode", "countryOfSaleCode", "targetMarkets"],
  status: ["gtinStatusCode", "gtinRecordStatus", "productStatus", "status", "lifecycleStatus"],
  gpcBrickCode: ["gpcCategoryCode", "gpcBrickCode", "globalProductCategoryCode", "gpcBrick"],
  gpcBrickDescription: ["gpcCategoryName", "gpcBrickDescription", "gpcCategoryDefinition"],
  imageUrl: ["productImageUrl", "imageUrl", "productImage", "referencedFileURL"],
  companyName: ["licenseeName", "companyName", "informationProviderName", "brandOwnerName"],
  companyPrefix: ["gs1CompanyPrefix", "companyPrefix", "licenceKey", "licenseKey"],
  licenseStatus: ["licenseStatus", "licenceStatus", "gs1LicenceStatus", "gs1LicenseStatus"],
  gln: ["licenseeGLN", "gln", "informationProviderGLN", "brandOwnerGLN"],
  countryOfLicense: ["licenceCountry", "licenseCountry", "countryOfLicence", "countryOfLicense"],
} as const;

function mapCompany(source: Record<string, unknown>): Gs1Company {
  const nested =
    asRecord(source.gs1Licence) ??
    asRecord(source.gs1License) ??
    asRecord(source.licensee) ??
    asRecord(source.company) ??
    {};
  const scan = [source, nested];
  const first = (keys: readonly string[]): string => {
    for (const s of scan) {
      const t = pickText(s, keys);
      if (t !== "") return t;
    }
    return "";
  };
  return {
    name: first(FIELD_KEYS.companyName),
    gs1CompanyPrefix: first(FIELD_KEYS.companyPrefix),
    licenseStatus: first(FIELD_KEYS.licenseStatus),
    gln: first(FIELD_KEYS.gln),
    countryOfLicense: first(FIELD_KEYS.countryOfLicense),
  };
}

function mapDimensions(sources: readonly Record<string, unknown>[]): Gs1Dimensions {
  return {
    width: pickMeasurement(sources, ["width", "inPackageWidth", "widthMeasurement"]),
    height: pickMeasurement(sources, ["height", "inPackageHeight", "heightMeasurement"]),
    depth: pickMeasurement(sources, ["depth", "inPackageDepth", "depthMeasurement", "length"]),
  };
}

function mapWeights(sources: readonly Record<string, unknown>[]): Gs1Weights {
  return {
    gross: pickMeasurement(sources, ["grossWeight", "grossWeightMeasurement"]),
    net: pickMeasurement(sources, ["netWeight", "netWeightMeasurement"]),
  };
}

/**
 * Provider payload → `Gs1ProductRecord`. Returns null when the payload has no
 * usable identifier, which the caller reports as `BAD_RESPONSE` rather than
 * inventing an empty record.
 */
/**
 * Does this mapped record carry anything the registry actually said? The GTIN
 * alone does not count when it came from `fallbackGtin14`: that value is the
 * caller's own input handed back to it.
 */
function hasRemoteContent(record: Gs1ProductRecord): boolean {
  if (
    record.sku !== "" ||
    record.brandName !== "" ||
    record.productDescription !== "" ||
    record.labelDescription !== "" ||
    record.netContent !== "" ||
    record.countryOfOrigin !== "" ||
    record.status !== "" ||
    record.gpcBrickCode !== "" ||
    record.gpcBrickDescription !== "" ||
    record.imageUrl !== "" ||
    record.targetMarkets.length > 0
  ) {
    return true;
  }
  const c = record.company;
  if (c.name !== "" || c.gs1CompanyPrefix !== "" || c.licenseStatus !== "" || c.gln !== "" || c.countryOfLicense !== "") {
    return true;
  }
  const { width, height, depth } = record.dimensions;
  if (width !== null || height !== null || depth !== null) return true;
  return record.weights.gross !== null || record.weights.net !== null;
}

export function mapGs1ProductRecord(
  payload: unknown,
  fallbackGtin14: string,
  source: Gs1ProductRecord["source"],
  retrievedAt: string,
  redactedRaw: Record<string, unknown>,
): Gs1ProductRecord | null {
  const rec = unwrapRecord(payload);
  if (rec === null) return null;

  const gtinText = pickText(rec, FIELD_KEYS.gtin);
  const normalized = normalizeGtin(gtinText);
  const gtin14 = normalized.ok ? normalized.gtin14 : fallbackGtin14;
  if (gtin14 === "") return null;

  const measurementSources = [
    rec,
    asRecord(rec.tradeItemMeasurements) ?? {},
    asRecord(rec.dimensions) ?? {},
    asRecord(rec.measurements) ?? {},
  ];

  const out = emptyGs1ProductRecord(gtin14, source, retrievedAt);
  out.sku = pickText(rec, FIELD_KEYS.sku);
  out.brandName = pickText(rec, FIELD_KEYS.brandName);
  out.productDescription = pickText(rec, FIELD_KEYS.productDescription);
  out.labelDescription = pickText(rec, FIELD_KEYS.labelDescription);
  // Net content is usually `[{value, unitCode}]`; the measurement form keeps the
  // unit, which the plain text reader would drop.
  const netMeasurement = pickMeasurement([rec], FIELD_KEYS.netContent);
  out.netContent =
    netMeasurement !== null && netMeasurement.unitCode !== ""
      ? formatMeasurement(netMeasurement)
      : pickText(rec, FIELD_KEYS.netContent);
  out.countryOfOrigin = pickText(rec, FIELD_KEYS.countryOfOrigin);
  out.targetMarkets = pickList(rec, FIELD_KEYS.targetMarkets);
  out.status = pickText(rec, FIELD_KEYS.status);
  out.gpcBrickCode = pickText(rec, FIELD_KEYS.gpcBrickCode);
  out.gpcBrickDescription = pickText(rec, FIELD_KEYS.gpcBrickDescription);
  out.imageUrl = pickText(rec, FIELD_KEYS.imageUrl);
  out.company = mapCompany(rec);
  out.dimensions = mapDimensions(measurementSources);
  out.weights = mapWeights(measurementSources);

  // Evidence check. Without it a 200 whose body is `{}`, `{"data":null}` or
  // `{"message":"..."}` maps to a record whose only content is the GTIN the
  // *caller* supplied — an answer the registry never gave, which `verifyGtin`
  // would then report as a licensed GTIN.
  if (!normalized.ok && !hasRemoteContent(out)) return null;

  out.raw = redactedRaw;
  return out;
}

/** `Gs1ProductRecord` → the JSON body a Data Hub-style publish endpoint expects. */
export function buildPublishPayload(record: Gs1ProductRecord): Record<string, unknown> {
  const measurement = (m: Gs1Measurement | null): Record<string, unknown> | null =>
    m === null ? null : { value: m.value, unitCode: m.unitCode };
  return {
    gtin: record.gtin,
    sku: record.sku,
    brandName: record.brandName,
    productDescription: record.productDescription,
    labelDescription: record.labelDescription,
    netContent: record.netContent,
    countryOfOrigin: record.countryOfOrigin,
    targetMarket: record.targetMarkets,
    gtinStatusCode: record.status,
    gpcCategoryCode: record.gpcBrickCode,
    productImageUrl: record.imageUrl,
    gs1CompanyPrefix: record.company.gs1CompanyPrefix,
    tradeItemMeasurements: {
      width: measurement(record.dimensions.width),
      height: measurement(record.dimensions.height),
      depth: measurement(record.dimensions.depth),
      grossWeight: measurement(record.weights.gross),
      netWeight: measurement(record.weights.net),
    },
  };
}

/* --------------------------------------------------------------- adapter */

const BODY_LOG_LIMIT = 400;

export function createGs1UsAdapter(config: Gs1ConnectionConfig, deps: Gs1UsDeps): Gs1Adapter {
  const fetchFn = deps.fetch;
  const log: Gs1Logger = deps.logger ?? noopGs1Logger;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;

  // Registering the credential as a literal secret is the belt to the
  // redact-by-key-name braces: it also catches a remote API that quotes the
  // Authorization header back inside an error body.
  const secrets = config.credential === "" ? [] : [config.credential];
  const redactOpts = { secrets } as const;
  const scrub = (s: string): string => redactString(s, redactOpts);

  const capabilities = capabilitiesFor(config.provider);

  function authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...config.extraHeaders,
    };
    if (config.authMode === "bearer" && config.credential !== "") {
      headers.authorization = `Bearer ${config.credential}`;
    } else if (config.authMode === "api-key" && config.credential !== "") {
      headers[config.apiKeyHeader] = config.credential;
    }
    return headers;
  }

  /**
   * One request, bounded by `timeoutMs`.
   *
   * The signal is passed to the injected fetch AND the outcome is raced against
   * the timer. Aborting alone is not enough: a fetch implementation that ignores
   * `signal` — a polyfill, a gateway wrapper, a test double — would otherwise
   * leave this awaiting a promise that never settles, and `timeoutMs` would be
   * documentation rather than a bound. The race makes the timeout the adapter's
   * own guarantee.
   */
  async function send(url: string, init: Gs1FetchInit): Promise<HttpOutcome> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const attempt: Promise<HttpOutcome> = (async () => {
      try {
        const res = await fetchFn(url, { ...init, signal: controller.signal });
        const body = await res.text();
        return { kind: "response", status: res.status, body, retryAfter: res.headers.get("retry-after") };
      } catch (err) {
        if (controller.signal.aborted) return { kind: "timeout" };
        const message = err instanceof Error ? err.message : String(err);
        return { kind: "network", message: scrub(message) };
      }
    })();
    // The losing side of the race is abandoned, never rejected-and-unhandled.
    attempt.catch(() => undefined);

    const expiry = new Promise<HttpOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: "timeout" });
      }, config.timeoutMs);
    });

    try {
      return await Promise.race([attempt, expiry]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  type RequestOk = { ok: true; status: number; json: unknown; attempts: number; durationMs: number };
  type RequestErr = { ok: false; error: Gs1Error };

  async function request(
    operation: Gs1LogEvent["operation"],
    method: string,
    path: string,
    body: unknown | undefined,
    maxAttempts: number,
  ): Promise<RequestOk | RequestErr> {
    const url = joinUrl(config.baseUrl, path);
    const host = hostOf(url);
    const loggedPath = pathForLog(url);
    const headers = authHeaders();
    const serialisedBody = body === undefined ? undefined : JSON.stringify(body);
    const init: Gs1FetchInit = {
      method,
      headers: serialisedBody === undefined ? headers : { ...headers, "content-type": "application/json" },
      ...(serialisedBody === undefined ? {} : { body: serialisedBody }),
    };

    const startedAll = now();
    let attempt = 0;
    let lastError: Gs1Error = makeGs1Error("NETWORK", "No attempt was made.", { attempts: 0 });

    for (;;) {
      attempt += 1;
      const attemptStart = now();
      log({
        phase: "request",
        operation,
        method,
        path: loggedPath,
        host,
        attempt,
        request: redact({ headers: init.headers, body }, redactOpts),
      });

      const outcome = await send(url, init);
      const durationMs = now() - attemptStart;

      if (outcome.kind === "response") {
        const snippet = outcome.body.slice(0, BODY_LOG_LIMIT);
        log({
          phase: "response",
          operation,
          method,
          path: loggedPath,
          host,
          attempt,
          status: outcome.status,
          durationMs,
          response: redact({ status: outcome.status, body: snippet }, redactOpts),
        });

        if (outcome.status >= 200 && outcome.status < 300) {
          if (outcome.body.trim() === "") {
            return { ok: true, status: outcome.status, json: {}, attempts: attempt, durationMs: now() - startedAll };
          }
          try {
            return {
              ok: true,
              status: outcome.status,
              json: JSON.parse(outcome.body) as unknown,
              attempts: attempt,
              durationMs: now() - startedAll,
            };
          } catch {
            lastError = makeGs1Error("BAD_RESPONSE", "GS1 returned a response that is not JSON.", {
              status: outcome.status,
              retryable: false,
              attempts: attempt,
              detail: scrub(snippet),
            });
            break;
          }
        }

        const { code, retryable } = classifyStatus(outcome.status);
        const retryAfterMs = parseRetryAfterMs(outcome.retryAfter, now(), config.retry.maxRetryAfterMs);
        lastError = makeGs1Error(code, STATUS_TEXT[code] ?? `GS1 returned HTTP ${outcome.status}.`, {
          status: outcome.status,
          retryable,
          attempts: attempt,
          detail: scrub(snippet),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        });
        if (!retryable || attempt >= maxAttempts) break;
        // A server-supplied Retry-After replaces the computed backoff: honouring
        // it is the difference between a rate limit that clears and one that
        // escalates (§13B "rate-limit handling").
        const delay = retryAfterMs ?? backoffDelayMs(attempt, config.retry, random);
        log({
          phase: "retry",
          operation,
          method,
          path: loggedPath,
          host,
          attempt,
          status: outcome.status,
          errorCode: code,
          nextDelayMs: delay,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        });
        await sleep(delay);
        continue;
      }

      if (outcome.kind === "timeout") {
        lastError = makeGs1Error("TIMEOUT", `The GS1 request timed out after ${config.timeoutMs} ms.`, {
          retryable: true,
          attempts: attempt,
        });
      } else {
        lastError = makeGs1Error("NETWORK", "The GS1 endpoint could not be reached.", {
          retryable: true,
          attempts: attempt,
          detail: outcome.message,
        });
      }
      log({
        phase: "error",
        operation,
        method,
        path: loggedPath,
        host,
        attempt,
        durationMs,
        errorCode: lastError.code,
        message: lastError.detail === "" ? lastError.message : lastError.detail,
      });
      if (attempt >= maxAttempts) break;
      const delay = backoffDelayMs(attempt, config.retry, random);
      log({
        phase: "retry",
        operation,
        method,
        path: loggedPath,
        host,
        attempt,
        errorCode: lastError.code,
        nextDelayMs: delay,
      });
      await sleep(delay);
    }

    lastError = { ...lastError, attempts: attempt };
    log({
      phase: "error",
      operation,
      method,
      path: loggedPath,
      host,
      attempt,
      ...(lastError.status === undefined ? {} : { status: lastError.status }),
      durationMs: now() - startedAll,
      errorCode: lastError.code,
      message: lastError.message,
    });
    return { ok: false, error: lastError };
  }

  function redactedRawOf(json: unknown): Record<string, unknown> {
    const red = redact(json, redactOpts);
    return asRecord(red) ?? { value: red };
  }

  /**
   * A response describing a different GTIN than the one asked about is not a
   * usable answer: applied to the local product it would attach another item's
   * brand, description and licence to it. Reported rather than absorbed.
   */
  function gtinMismatch(requested: string, returned: string): Gs1Error | null {
    if (returned === requested) return null;
    return makeGs1Error(
      "BAD_RESPONSE",
      `GS1 answered with a record for ${returned} but ${requested} was requested.`,
      { retryable: false, attempts: 0 },
    );
  }

  function rejectBadGtin(gtin: string): Gs1Error | null {
    const norm = normalizeGtin(gtin);
    if (norm.ok) return null;
    return makeGs1Error("INVALID_GTIN", describeGtinFailure(norm), { retryable: false, attempts: 0 });
  }

  return {
    provider: config.provider,
    capabilities,

    /**
     * Deliberately single-attempt: a settings screen wants a fast answer, and
     * "it failed three times over eight seconds" is not more informative to an
     * operator than "it failed".
     */
    async testConnection(): Promise<Gs1ConnectionTest> {
      const startedAt = now();
      const checkedAt = new Date().toISOString();
      const host = hostOf(joinUrl(config.baseUrl, config.paths.test));
      try {
        const res = await request("testConnection", "GET", config.paths.test, undefined, 1);
        if (res.ok) {
          return {
            ok: true,
            provider: config.provider,
            host,
            detail: `Connected to ${host}.`,
            latencyMs: Math.max(0, now() - startedAt),
            checkedAt,
            error: null,
          };
        }
        return {
          ok: false,
          provider: config.provider,
          host,
          detail: res.error.message,
          latencyMs: Math.max(0, now() - startedAt),
          checkedAt,
          error: res.error,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          provider: config.provider,
          host,
          detail: "The connection test failed unexpectedly.",
          latencyMs: Math.max(0, now() - startedAt),
          checkedAt,
          error: makeGs1Error("NETWORK", "The connection test failed unexpectedly.", {
            retryable: true,
            attempts: 0,
            detail: scrub(message),
          }),
        };
      }
    },

    async verifyGtin(gtin: string): Promise<Gs1Result<Gs1VerifyResult>> {
      return guarded<Gs1VerifyResult>(
        async () => {
          const bad = rejectBadGtin(gtin);
          if (bad !== null) return gs1Err(bad);
          const norm = normalizeGtin(gtin);
          const canonical = norm.ok ? norm.gtin14 : "";
          const startedAt = now();

          const res = await request(
            "verifyGtin",
            "GET",
            fillGtinPath(config.paths.verify, canonical),
            undefined,
            config.retry.maxAttempts,
          );
          const checkedAt = new Date().toISOString();

          if (!res.ok) {
            // A registry answering "no such GTIN" has verified it: the answer is
            // "not licensed", which is exactly what the caller asked about.
            if (res.error.code === "NOT_FOUND") {
              return gs1Ok(
                {
                  gtin: canonical,
                  status: "not-found" as const,
                  checkDigitValid: true,
                  company: { name: "", gs1CompanyPrefix: "", licenseStatus: "", gln: "", countryOfLicense: "" },
                  record: null,
                  checkedAt,
                  detail: "GS1 has no licensed record for this GTIN.",
                },
                res.error.attempts,
                Math.max(0, now() - startedAt),
              );
            }
            return gs1Err(res.error);
          }

          const raw = redactedRawOf(res.json);
          const record = mapGs1ProductRecord(res.json, canonical, config.provider, checkedAt, raw);
          // "The registry returned 2xx" is not the same fact as "the registry
          // says this GTIN is licensed". A 200 carrying an empty body, `null`,
          // or a maintenance notice tells us nothing about the licence, and
          // answering `verified` there would put a fabricated compliance claim
          // on the record.
          if (record === null) {
            return gs1Err(
              makeGs1Error(
                "BAD_RESPONSE",
                "GS1 answered without a usable record, so the licence status of this GTIN is unknown.",
                { status: res.status, retryable: false, attempts: res.attempts },
              ),
            );
          }
          const mismatch = gtinMismatch(canonical, record.gtin);
          if (mismatch !== null) return gs1Err(mismatch);

          const company = record.company;
          const statusText = record.status.toUpperCase();
          const inactive =
            statusText.includes("INACTIVE") ||
            statusText.includes("DISCONTINUED") ||
            company.licenseStatus.toUpperCase().includes("INACTIVE");

          return gs1Ok(
            {
              gtin: canonical,
              status: inactive ? ("inactive" as const) : ("verified" as const),
              checkDigitValid: true,
              company,
              record,
              checkedAt,
              detail: "",
            },
            res.attempts,
            res.durationMs,
          );
        },
        (message) =>
          makeGs1Error("BAD_RESPONSE", "The GS1 verification response could not be processed.", {
            retryable: false,
            attempts: 1,
            detail: scrub(message),
          }),
      );
    },

    async fetchProduct(gtin: string): Promise<Gs1Result<Gs1ProductRecord>> {
      return guarded<Gs1ProductRecord>(
        async () => {
          const bad = rejectBadGtin(gtin);
          if (bad !== null) return gs1Err(bad);
          const norm = normalizeGtin(gtin);
          const canonical = norm.ok ? norm.gtin14 : "";

          const res = await request(
            "fetchProduct",
            "GET",
            fillGtinPath(config.paths.product, canonical),
            undefined,
            config.retry.maxAttempts,
          );
          if (!res.ok) return gs1Err(res.error);

          const retrievedAt = new Date().toISOString();
          const raw = redactedRawOf(res.json);
          const record = mapGs1ProductRecord(res.json, canonical, config.provider, retrievedAt, raw);
          if (record === null) {
            return gs1Err(
              makeGs1Error("BAD_RESPONSE", "GS1 returned a payload with no recognisable product record.", {
                status: res.status,
                retryable: false,
                attempts: res.attempts,
              }),
            );
          }
          const mismatch = gtinMismatch(canonical, record.gtin);
          if (mismatch !== null) return gs1Err(mismatch);
          return gs1Ok(record, res.attempts, res.durationMs);
        },
        (message) =>
          makeGs1Error("BAD_RESPONSE", "The GS1 product response could not be processed.", {
            retryable: false,
            attempts: 1,
            detail: scrub(message),
          }),
      );
    },

    async publishProduct(record: Gs1ProductRecord): Promise<Gs1Result<Gs1PublishReceipt>> {
      return guarded<Gs1PublishReceipt>(
        async () => {
          if (!capabilities.publish) {
            return gs1Err(unsupportedError("publishing product records", config.provider));
          }
          const bad = rejectBadGtin(record.gtin);
          if (bad !== null) return gs1Err(bad);

          const res = await request(
            "publishProduct",
            "POST",
            config.paths.publish,
            buildPublishPayload(record),
            config.retry.maxAttempts,
          );
          if (!res.ok) return gs1Err(res.error);

          const body = asRecord(res.json) ?? {};
          const messages = pickList(body, ["messages", "validationMessages", "warnings"]).map(scrub);
          // A 2xx means the submission was taken. If the body contradicts that
          // — some endpoints answer 200 with `{"accepted":false}` — the body
          // wins, because the receipt is what the operator reads.
          const declined =
            body.accepted === false ||
            /^(REJECTED|FAILED|DECLINED|ERROR)$/i.test(pickText(body, ["status", "gtinStatusCode", "state"]));
          return gs1Ok(
            {
              gtin: record.gtin,
              accepted: !declined,
              remoteId: pickText(body, ["id", "recordId", "productId", "referenceId"]),
              status: pickText(body, ["status", "gtinStatusCode", "state"]),
              submittedAt: new Date().toISOString(),
              messages,
            },
            res.attempts,
            res.durationMs,
          );
        },
        (message) =>
          makeGs1Error("BAD_RESPONSE", "The GS1 publish response could not be processed.", {
            retryable: false,
            attempts: 1,
            detail: scrub(message),
          }),
      );
    },
  };
}
