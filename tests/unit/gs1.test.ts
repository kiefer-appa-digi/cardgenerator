import { afterEach, describe, expect, it } from "vitest";

import { emptyProductContext } from "@/lib/data/context";
import {
  applyAcceptedFields,
  buildDigitalLinkUri,
  createDisabledAdapter,
  createGs1UsAdapter,
  diffRemoteAgainstLocal,
  getAdapter,
  gtinCheckDigit,
  Gs1ConnectionConfigSchema,
  mapGs1ProductRecord,
  normalizeGtin,
  parseDigitalLinkUri,
  parseRetryAfterMs,
  pendingDiffs,
  backoffDelayMs,
} from "@/lib/gs1";
import type {
  Gs1ConnectionConfig,
  Gs1LogEvent,
  Gs1ProductRecord,
} from "@/lib/gs1/types";
import type { Gs1Fetch, Gs1FetchResponse } from "@/lib/gs1/providers/gs1us";
import {
  decryptCredential,
  encryptCredential,
  hostOf,
  isSensitiveKey,
  REDACTED,
  redact,
  redactString,
  redactToJson,
  redactUrl,
  rotateCredential,
} from "@/server/crypto";

/* ------------------------------------------------------------- fixtures */

/** 64 hex characters. Test-only; the real key comes from CREDENTIAL_KEY. */
const KEY_A = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY_B = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

/** Shaped like a real API key so the "must not leak" assertions are meaningful. */
const SECRET = "gs1_live_sk_9f83b21c4d7e5a06f1c2b3d4e5f60718";

/** UPC-12 from the supplied product export; GTIN-14 form is 00810797030124. */
const UPC12 = "810797030124";
const GTIN14 = "00810797030124";

function makeResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Gs1FetchResponse {
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(headers)) lower.set(k.toLowerCase(), v);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    text: async () => body,
  };
}

type Harness = {
  config: Gs1ConnectionConfig;
  calls: { url: string; method: string; headers: Record<string, string>; body?: string }[];
  delays: number[];
  events: Gs1LogEvent[];
};

function makeConfig(overrides: Partial<Gs1ConnectionConfig> = {}): Gs1ConnectionConfig {
  return Gs1ConnectionConfigSchema.parse({
    provider: "gs1us-verified",
    enabled: true,
    baseUrl: "https://api.gs1us.test/verified",
    authMode: "bearer",
    credential: SECRET,
    timeoutMs: 1_000,
    retry: { maxAttempts: 3, baseBackoffMs: 400, maxBackoffMs: 8_000, jitterRatio: 0.5, maxRetryAfterMs: 60_000 },
    paths: {
      test: "/v1/health",
      verify: "/v1/gtins/{gtin}/verify",
      product: "/v1/gtins/{gtin}",
      publish: "/v1/products",
    },
    ...overrides,
  });
}

/** Builds an adapter over a scripted sequence of responses. No network, no real timers. */
function harness(
  script: (Gs1FetchResponse | Error)[],
  overrides: Partial<Gs1ConnectionConfig> = {},
) {
  const state: Harness = { config: makeConfig(overrides), calls: [], delays: [], events: [] };
  let index = 0;
  const fetchFn: Gs1Fetch = async (url, init) => {
    state.calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const next = script[Math.min(index, script.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  };
  const adapter = createGs1UsAdapter(state.config, {
    fetch: fetchFn,
    logger: (e) => state.events.push(e),
    sleep: async (ms) => {
      state.delays.push(ms);
    },
    // Deterministic jitter: 0 puts every delay at the bottom of its window.
    random: () => 0,
  });
  return { adapter, state };
}

const VERIFIED_BY_GS1_PAYLOAD = {
  gtin: GTIN14,
  brandName: [{ value: "Axle Teknology", language: "en" }],
  productDescription: [
    { value: "PRODUIT GENUINE", language: "fr" },
    { value: "GENUINE AXLETEK 3.5K BEARING L44610/L44649", language: "en" },
  ],
  gpcCategoryCode: "10001714",
  gpcCategoryName: "Vehicle Bearings",
  netContent: [{ value: 2, unitCode: "EA" }],
  targetMarket: ["840"],
  gtinRecordStatus: "ACTIVE",
  productImageUrl: [{ value: "https://cdn.example.test/810797030124.jpg" }],
  licenseeName: "Freedom Trailer Parts, LLC",
  licenseeGLN: "0810797000005",
  gs1Licence: { licenceKey: "081079703", licenceStatus: "ACTIVE" },
  tradeItemMeasurements: {
    width: { value: 4.5, unitCode: "INH" },
    height: { value: 7.25, unitCode: "INH" },
    depth: { value: 1.125, unitCode: "INH" },
    grossWeight: { value: 1.4, unitCode: "LBR" },
  },
};

/* ----------------------------------------------------------------- crypto */

describe("credential crypto", () => {
  const savedKey = process.env.CREDENTIAL_KEY;
  afterEach(() => {
    if (savedKey === undefined) delete process.env.CREDENTIAL_KEY;
    else process.env.CREDENTIAL_KEY = savedKey;
  });

  it("round-trips a credential", () => {
    const enc = encryptCredential(SECRET, { key: KEY_A });
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    expect(enc.value.iv).toHaveLength(24);
    expect(enc.value.tag).toHaveLength(32);
    expect(enc.value.ciphertext).not.toContain(SECRET);

    const dec = decryptCredential(enc.value, { key: KEY_A });
    expect(dec.ok).toBe(true);
    if (!dec.ok) return;
    expect(dec.value).toBe(SECRET);
  });

  it("uses a fresh IV every time, so the same plaintext never repeats a ciphertext", () => {
    const a = encryptCredential(SECRET, { key: KEY_A });
    const b = encryptCredential(SECRET, { key: KEY_A });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.iv).not.toBe(b.value.iv);
    expect(a.value.ciphertext).not.toBe(b.value.ciphertext);
  });

  it("fails cleanly under the wrong key, without throwing or echoing anything", () => {
    const enc = encryptCredential(SECRET, { key: KEY_A });
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;

    const dec = decryptCredential(enc.value, { key: KEY_B });
    expect(dec.ok).toBe(false);
    if (dec.ok) return;
    expect(dec.code).toBe("DECRYPT_FAILED");
    expect(dec.message).not.toContain(SECRET);
    expect(dec.message).not.toContain(KEY_A);
    expect(dec.message).not.toContain(KEY_B);
    expect(dec.message).not.toContain(enc.value.ciphertext);
  });

  it("fails cleanly on a tampered tag", () => {
    const enc = encryptCredential(SECRET, { key: KEY_A });
    if (!enc.ok) throw new Error("setup");
    const flipped = enc.value.tag[0] === "a" ? `b${enc.value.tag.slice(1)}` : `a${enc.value.tag.slice(1)}`;
    const dec = decryptCredential({ ...enc.value, tag: flipped }, { key: KEY_A });
    expect(dec.ok).toBe(false);
    if (!dec.ok) expect(dec.code).toBe("DECRYPT_FAILED");
  });

  it("binds a ciphertext to its AAD, so a row copied between tenants will not open", () => {
    const enc = encryptCredential(SECRET, { key: KEY_A, aad: "gs1:org_alpha" });
    if (!enc.ok) throw new Error("setup");
    expect(decryptCredential(enc.value, { key: KEY_A, aad: "gs1:org_beta" }).ok).toBe(false);
    const same = decryptCredential(enc.value, { key: KEY_A, aad: "gs1:org_alpha" });
    expect(same.ok && same.value).toBe(SECRET);
  });

  it("rejects malformed stored payloads before touching the cipher", () => {
    const bad = decryptCredential({ ciphertext: "zz", iv: "00", tag: "00" }, { key: KEY_A });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("PAYLOAD_MALFORMED");
  });

  it("refuses to encrypt an empty credential", () => {
    const r = encryptCredential("", { key: KEY_A });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PLAINTEXT_EMPTY");
  });

  it("reports a missing or malformed CREDENTIAL_KEY as a typed failure", () => {
    delete process.env.CREDENTIAL_KEY;
    const missing = encryptCredential(SECRET);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("KEY_MISSING");

    process.env.CREDENTIAL_KEY = "abc";
    const malformed = encryptCredential(SECRET);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.code).toBe("KEY_MALFORMED");
  });

  it("reads CREDENTIAL_KEY from the environment when no key is passed", () => {
    process.env.CREDENTIAL_KEY = KEY_A;
    const enc = encryptCredential(SECRET);
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    const dec = decryptCredential(enc.value);
    expect(dec.ok && dec.value).toBe(SECRET);
  });

  it("rotates a credential from one key to another", () => {
    const enc = encryptCredential(SECRET, { key: KEY_A });
    if (!enc.ok) throw new Error("setup");
    const rotated = rotateCredential(enc.value, KEY_A, KEY_B);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(decryptCredential(rotated.value, { key: KEY_A }).ok).toBe(false);
    const dec = decryptCredential(rotated.value, { key: KEY_B });
    expect(dec.ok && dec.value).toBe(SECRET);
  });
});

/* -------------------------------------------------------------- redaction */

describe("redact", () => {
  it("classifies key names without swallowing innocent ones", () => {
    expect(isSensitiveKey("apiKey")).toBe(true);
    expect(isSensitiveKey("x-api-key")).toBe(true);
    expect(isSensitiveKey("API_KEY")).toBe(true);
    expect(isSensitiveKey("Authorization")).toBe(true);
    expect(isSensitiveKey("credentialCiphertext")).toBe(true);
    expect(isSensitiveKey("refresh_token")).toBe(true);
    expect(isSensitiveKey("key")).toBe(true);
    // "auth" is not a substring rule precisely so that these survive.
    expect(isSensitiveKey("author")).toBe(false);
    expect(isSensitiveKey("brandName")).toBe(false);
    expect(isSensitiveKey("gtin")).toBe(false);
  });

  it("replaces secret-named values at any depth and leaves the rest intact", () => {
    const input = {
      gtin: GTIN14,
      author: "Jane",
      apiKey: SECRET,
      nested: { password: "hunter2", brandName: "Axle Teknology" },
      list: [{ token: SECRET }, { sku: "11-500" }],
    };
    const out = redact(input) as Record<string, unknown>;
    expect(out.gtin).toBe(GTIN14);
    expect(out.author).toBe("Jane");
    expect(out.apiKey).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).password).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).brandName).toBe("Axle Teknology");
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  it("does not mutate its input", () => {
    const input = { apiKey: SECRET };
    redact(input);
    expect(input.apiKey).toBe(SECRET);
  });

  it("survives cycles and depth without throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(redactToJson(a)).toContain("[circular]");

    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 12; i++) deep = { child: deep };
    expect(redactToJson(deep)).toContain("[depth-limited]");
  });

  it("scrubs auth schemes, inline assignments and opaque blobs inside free text", () => {
    expect(redactString("Authorization: Bearer abcdefghijklmnopqrst")).not.toContain("abcdefghijklmnopqrst");
    expect(redactString('{"api_key":"abcd1234efgh"}')).not.toContain("abcd1234efgh");
    expect(redactString("A".repeat(40))).toBe(REDACTED);
    expect(redactString("GENUINE AXLETEK 3.5K BEARING L44610/L44649")).toBe(
      "GENUINE AXLETEK 3.5K BEARING L44610/L44649",
    );
  });

  it("redacts secret-looking query values but keeps the rest of a URL loggable", () => {
    const out = redactUrl("https://api.gs1us.test/v1/gtins?apikey=abcd1234efgh&gtin=00810797030124");
    expect(out).not.toContain("abcd1234efgh");
    expect(out).toContain("gtin=00810797030124");
    expect(hostOf("https://api.gs1us.test/verified/v1")).toBe("api.gs1us.test");
  });

  it("keeps a hostile __proto__ key as data instead of letting it replace a prototype", () => {
    // A third-party payload is untrusted input. Plain assignment invokes the
    // `__proto__` setter, which replaced the prototype of the redacted copy
    // with attacker-supplied values and dropped the branch from the audit row.
    const hostile: unknown = JSON.parse('{"__proto__":{"injected":"yes","apiKey":"leak"},"gtin":"1"}');
    const out = redact(hostile) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.injected).toBeUndefined();
    expect(Object.keys(out)).toContain("__proto__");
    expect(redactToJson(hostile)).not.toContain("leak");
    expect(({} as Record<string, unknown>).injected).toBeUndefined();
  });

  it("scrubs registered literal secrets wherever they appear", () => {
    const out = redactToJson({ note: `remote echoed ${SECRET} back at us` }, { secrets: [SECRET] });
    expect(out).not.toContain(SECRET);
    expect(out).toContain(REDACTED);
  });
});

/* ------------------------------------------------------------------ GTIN */

describe("gtin", () => {
  it("computes the mod-10 check digit", () => {
    expect(gtinCheckDigit("0081079703012")).toBe(4);
  });

  it("normalises every accepted length to the 14-digit form", () => {
    const r = normalizeGtin(UPC12);
    expect(r.ok && r.gtin14).toBe(GTIN14);
    expect(normalizeGtin(" 810-797-030124 ").ok).toBe(true);
    expect(normalizeGtin(GTIN14).ok).toBe(true);
  });

  it("rejects bad input with a reason", () => {
    expect(normalizeGtin("")).toMatchObject({ ok: false, reason: "empty" });
    expect(normalizeGtin("81079703012X")).toMatchObject({ ok: false, reason: "non-digit" });
    expect(normalizeGtin("8107970")).toMatchObject({ ok: false, reason: "bad-length" });
    expect(normalizeGtin("810797030125")).toMatchObject({ ok: false, reason: "bad-check-digit" });
    // A leading "-" is a sign, not a separator: a negated spreadsheet cell must
    // not be silently cleaned into a valid identifier.
    expect(normalizeGtin("-810797030124")).toMatchObject({ ok: false, reason: "non-digit" });
    expect(normalizeGtin("810797030124.")).toMatchObject({ ok: false, reason: "non-digit" });
    // Separators between digits are still stripped.
    expect(normalizeGtin("810-797-030124").ok).toBe(true);
  });
});

/* --------------------------------------------------------- digital link */

describe("digital link", () => {
  it("builds the canonical URI from a 12-digit UPC", () => {
    const r = buildDigitalLinkUri({ gtin: UPC12 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.uri).toBe(`https://id.gs1.org/01/${GTIN14}`);
  });

  it("emits path qualifiers in GS1 order and data attributes as query parameters", () => {
    const r = buildDigitalLinkUri({
      gtin: UPC12,
      domain: "https://id.example.test/",
      qualifiers: { serial: "S-9", lot: "ABC123" },
      dataAttributes: { "17": "271231" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.uri).toBe(`https://id.example.test/01/${GTIN14}/10/ABC123/21/S-9?17=271231`);
  });

  it("round-trips through the parser, numeric AIs and short aliases alike", () => {
    const built = buildDigitalLinkUri({ gtin: UPC12, qualifiers: { lot: "ABC123", serial: "S-9" } });
    if (!built.ok) throw new Error("setup");
    const parsed = parseDigitalLinkUri(built.uri);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.gtin14).toBe(GTIN14);
    expect(parsed.value.qualifiers).toEqual({ "10": "ABC123", "21": "S-9" });

    const alias = parseDigitalLinkUri(`https://example.test/resolver/gtin/${GTIN14}`);
    expect(alias.ok && alias.value.gtin14).toBe(GTIN14);
  });

  it("refuses an invalid GTIN or domain instead of emitting a broken URI", () => {
    expect(buildDigitalLinkUri({ gtin: "810797030125" })).toMatchObject({ ok: false, reason: "invalid-gtin" });
    expect(buildDigitalLinkUri({ gtin: UPC12, domain: "not a url" })).toMatchObject({
      ok: false,
      reason: "invalid-domain",
    });
    expect(parseDigitalLinkUri("https://example.test/nothing/here")).toMatchObject({ ok: false, reason: "no-gtin" });
  });
});

/* ------------------------------------------------------- disabled adapter */

describe("disabled adapter", () => {
  it("answers NOT_CONFIGURED for every operation and never throws", async () => {
    const adapter = createDisabledAdapter();
    expect(adapter.provider).toBe("disabled");
    expect(adapter.capabilities).toEqual({
      verify: false,
      fetchProduct: false,
      publish: false,
      digitalLinkResolution: false,
    });

    const test = await adapter.testConnection();
    expect(test.ok).toBe(false);
    expect(test.error?.code).toBe("NOT_CONFIGURED");
    expect(test.host).toBe("");

    for (const result of [
      await adapter.verifyGtin(UPC12),
      await adapter.fetchProduct(UPC12),
      await adapter.publishProduct(mapFixtureRecord()),
    ]) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("NOT_CONFIGURED");
      expect(result.error.retryable).toBe(false);
      expect(result.error.attempts).toBe(0);
    }
  });

  it("has no optional digital-link resolution method (the extension point is unfilled by design)", () => {
    expect(createDisabledAdapter().resolveDigitalLink).toBeUndefined();
  });
});

/* --------------------------------------------------------------- factory */

describe("getAdapter", () => {
  const fetchFn: Gs1Fetch = async () => makeResponse(200, "{}");

  it("degrades to the disabled adapter for every misconfiguration", () => {
    expect(getAdapter(Gs1ConnectionConfigSchema.parse({})).provider).toBe("disabled");
    expect(getAdapter(makeConfig({ enabled: false }), { fetch: fetchFn }).provider).toBe("disabled");
    expect(getAdapter(makeConfig({ baseUrl: "" }), { fetch: fetchFn }).provider).toBe("disabled");
    expect(getAdapter(makeConfig({ credential: "" }), { fetch: fetchFn }).provider).toBe("disabled");
    // A base URL with no scheme would otherwise build a live adapter that fails
    // with NETWORK on every product instead of saying what is wrong once.
    expect(getAdapter(makeConfig({ baseUrl: "api.gs1us.test/verified" }), { fetch: fetchFn }).provider).toBe(
      "disabled",
    );
  });

  it("builds a live adapter when the connection is complete", () => {
    const adapter = getAdapter(makeConfig(), { fetch: fetchFn });
    expect(adapter.provider).toBe("gs1us-verified");
    expect(adapter.capabilities.verify).toBe(true);
    // Verified by GS1 is read-only; publishing belongs to Data Hub.
    expect(adapter.capabilities.publish).toBe(false);
    expect(getAdapter(makeConfig({ provider: "gs1us-datahub" }), { fetch: fetchFn }).capabilities.publish).toBe(true);
  });
});

/* ---------------------------------------------------------- gs1us adapter */

function mapFixtureRecord(): Gs1ProductRecord {
  const record = mapGs1ProductRecord(
    VERIFIED_BY_GS1_PAYLOAD,
    GTIN14,
    "gs1us-verified",
    "2026-08-26T00:00:00.000Z",
    {},
  );
  if (record === null) throw new Error("fixture did not map");
  return record;
}

describe("gs1us adapter — mapping", () => {
  it("maps a Verified-by-GS1 payload to the normalised record", async () => {
    const { adapter, state } = harness([makeResponse(200, JSON.stringify(VERIFIED_BY_GS1_PAYLOAD))]);
    const result = await adapter.fetchProduct(UPC12);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const r = result.value;
    expect(r.gtin).toBe(GTIN14);
    expect(r.brandName).toBe("Axle Teknology");
    // The English entry wins over the French one that comes first in the array.
    expect(r.productDescription).toBe("GENUINE AXLETEK 3.5K BEARING L44610/L44649");
    expect(r.netContent).toBe("2 EA");
    expect(r.status).toBe("ACTIVE");
    expect(r.gpcBrickCode).toBe("10001714");
    expect(r.targetMarkets).toEqual(["840"]);
    expect(r.company).toEqual({
      name: "Freedom Trailer Parts, LLC",
      gs1CompanyPrefix: "081079703",
      licenseStatus: "ACTIVE",
      gln: "0810797000005",
      countryOfLicense: "",
    });
    expect(r.dimensions.height).toEqual({ value: 7.25, unitCode: "INH" });
    expect(r.weights.gross).toEqual({ value: 1.4, unitCode: "LBR" });
    expect(r.weights.net).toBeNull();
    expect(result.attempts).toBe(1);

    // The URL is built from baseUrl + templated path.
    expect(state.calls[0].url).toBe(`https://api.gs1us.test/verified/v1/gtins/${GTIN14}`);
  });

  it("unwraps a provider envelope and tolerates an array payload", () => {
    const wrapped = mapGs1ProductRecord(
      { data: { results: [VERIFIED_BY_GS1_PAYLOAD] } },
      "",
      "custom",
      "2026-08-26T00:00:00.000Z",
      {},
    );
    expect(wrapped?.brandName).toBe("Axle Teknology");
  });

  it("rejects a bad GTIN locally, without sending a request", async () => {
    const { adapter, state } = harness([makeResponse(200, "{}")]);
    const result = await adapter.fetchProduct("810797030125");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_GTIN");
    expect(state.calls).toHaveLength(0);
  });

  it("treats a 404 from verify as a successful 'not licensed' answer", async () => {
    const { adapter } = harness([makeResponse(404, '{"message":"not found"}')]);
    const result = await adapter.verifyGtin(UPC12);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("not-found");
    expect(result.value.gtin).toBe(GTIN14);
  });

  it("treats a 404 from fetchProduct as an error, because the caller wanted data", async () => {
    const { adapter } = harness([makeResponse(404, "{}")]);
    const result = await adapter.fetchProduct(UPC12);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("refuses to publish through a read-only provider", async () => {
    const { adapter, state } = harness([makeResponse(200, "{}")]);
    const result = await adapter.publishProduct(mapFixtureRecord());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNSUPPORTED");
    expect(state.calls).toHaveLength(0);
  });

  it("publishes through Data Hub and reads the receipt", async () => {
    const { adapter, state } = harness(
      [makeResponse(201, '{"id":"rec_991","status":"PENDING","messages":["queued for review"]}')],
      { provider: "gs1us-datahub" },
    );
    const result = await adapter.publishProduct(mapFixtureRecord());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ gtin: GTIN14, accepted: true, remoteId: "rec_991", status: "PENDING" });
    expect(state.calls[0].method).toBe("POST");
    expect(JSON.parse(state.calls[0].body ?? "{}")).toMatchObject({ gtin: GTIN14, brandName: "Axle Teknology" });
  });

  it("reports a non-JSON 200 as BAD_RESPONSE without retrying", async () => {
    const { adapter, state } = harness([makeResponse(200, "<html>maintenance</html>")]);
    const result = await adapter.fetchProduct(UPC12);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("BAD_RESPONSE");
    expect(state.calls).toHaveLength(1);
  });
});

describe("gs1us adapter — retry, backoff and rate limits", () => {
  it("computes equal-jitter backoff inside the expected window", () => {
    const policy = { maxAttempts: 5, baseBackoffMs: 400, maxBackoffMs: 8_000, jitterRatio: 0.5, maxRetryAfterMs: 60_000 };
    expect(backoffDelayMs(1, policy, () => 0)).toBe(200);
    expect(backoffDelayMs(1, policy, () => 1)).toBe(400);
    expect(backoffDelayMs(2, policy, () => 0)).toBe(400);
    expect(backoffDelayMs(9, policy, () => 1)).toBe(8_000);
  });

  it("retries a 5xx up to maxAttempts with exponential backoff, then gives up", async () => {
    const { adapter, state } = harness([makeResponse(503, '{"message":"upstream down"}')]);
    const result = await adapter.fetchProduct(UPC12);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SERVER_ERROR");
    expect(result.error.retryable).toBe(true);
    expect(result.error.attempts).toBe(3);
    expect(state.calls).toHaveLength(3);
    // 400 → 800 base, halved by the deterministic jitter source.
    expect(state.delays).toEqual([200, 400]);
  });

  it("stops immediately on a 4xx: retrying would resend the same bad request", async () => {
    for (const [status, code] of [
      [400, "VALIDATION"],
      [401, "UNAUTHORIZED"],
      [403, "FORBIDDEN"],
      [409, "CONFLICT"],
    ] as const) {
      const { adapter, state } = harness([makeResponse(status, '{"message":"nope"}')]);
      const result = await adapter.fetchProduct(UPC12);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe(code);
      expect(result.error.retryable).toBe(false);
      expect(result.error.attempts).toBe(1);
      expect(state.calls).toHaveLength(1);
      expect(state.delays).toEqual([]);
    }
  });

  it("honours Retry-After on a 429 in place of the computed backoff", async () => {
    const { adapter, state } = harness([
      makeResponse(429, '{"message":"slow down"}', { "Retry-After": "2" }),
      makeResponse(200, JSON.stringify(VERIFIED_BY_GS1_PAYLOAD)),
    ]);
    const result = await adapter.fetchProduct(UPC12);
    expect(result.ok).toBe(true);
    expect(state.calls).toHaveLength(2);
    expect(state.delays).toEqual([2_000]);
  });

  it("caps a hostile Retry-After so one bad header cannot stall a batch job", async () => {
    const { adapter, state } = harness([makeResponse(429, "{}", { "retry-after": "999999" })]);
    const result = await adapter.fetchProduct(UPC12);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RATE_LIMITED");
    expect(state.delays).toEqual([60_000, 60_000]);
  });

  it("parses both Retry-After forms", () => {
    const now = Date.parse("2026-08-26T12:00:00.000Z");
    expect(parseRetryAfterMs("5", now, 60_000)).toBe(5_000);
    expect(parseRetryAfterMs("Wed, 26 Aug 2026 12:00:30 GMT", now, 60_000)).toBe(30_000);
    expect(parseRetryAfterMs("later", now, 60_000)).toBeUndefined();
    expect(parseRetryAfterMs(null, now, 60_000)).toBeUndefined();
  });

  it("retries a thrown network failure and reports it as NETWORK", async () => {
    const { adapter, state } = harness([new Error("connect ECONNREFUSED 10.0.0.1:443")]);
    const result = await adapter.fetchProduct(UPC12);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK");
      expect(result.error.attempts).toBe(3);
    }
    expect(state.calls).toHaveLength(3);
  });

  it("aborts a hanging request at timeoutMs and reports TIMEOUT", async () => {
    const state = { calls: 0, delays: [] as number[] };
    const hanging: Gs1Fetch = (_url, init) => {
      state.calls += 1;
      return new Promise<Gs1FetchResponse>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
      });
    };
    const adapter = createGs1UsAdapter(
      makeConfig({
        timeoutMs: 100,
        retry: { maxAttempts: 2, baseBackoffMs: 400, maxBackoffMs: 8_000, jitterRatio: 0.5, maxRetryAfterMs: 60_000 },
      }),
      {
        fetch: hanging,
        sleep: async (ms) => {
          state.delays.push(ms);
        },
        random: () => 0,
      },
    );

    const result = await adapter.fetchProduct(UPC12);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.retryable).toBe(true);
      expect(result.error.attempts).toBe(2);
    }
    expect(state.calls).toBe(2);
    expect(state.delays).toEqual([200]);
  });

  it("returns a report rather than a rejection from a failed connection test", async () => {
    const { adapter, state } = harness([makeResponse(401, '{"message":"bad token"}')]);
    const test = await adapter.testConnection();
    expect(test.ok).toBe(false);
    expect(test.provider).toBe("gs1us-verified");
    expect(test.host).toBe("api.gs1us.test");
    expect(test.error?.code).toBe("UNAUTHORIZED");
    // A settings screen wants one fast answer, not three attempts over 8 seconds.
    expect(state.calls).toHaveLength(1);
  });
});

/* --------------------------------------------------- credential containment */

describe("gs1us adapter — the credential never escapes", () => {
  it("keeps an encrypted-then-decrypted secret out of every result, log and error", async () => {
    // Full round trip: the adapter is configured from a decrypted credential,
    // exactly as a server action would configure it.
    const enc = encryptCredential(SECRET, { key: KEY_A });
    if (!enc.ok) throw new Error("setup");
    const dec = decryptCredential(enc.value, { key: KEY_A });
    if (!dec.ok) throw new Error("setup");
    expect(dec.value).toBe(SECRET);

    // A hostile-but-realistic remote: it quotes the Authorization header back.
    const body = JSON.stringify({
      error: "invalid_token",
      receivedAuthorization: `Bearer ${dec.value}`,
      hint: `apikey=${dec.value}`,
    });
    const { adapter, state } = harness([makeResponse(401, body)], { credential: dec.value });

    const result = await adapter.fetchProduct(UPC12);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("UNAUTHORIZED");
    expect(JSON.stringify(result.error)).not.toContain(SECRET);
    expect(JSON.stringify(state.events)).not.toContain(SECRET);
    // The header really was sent — the redaction is not passing by accident.
    expect(state.calls[0].headers.authorization).toBe(`Bearer ${SECRET}`);
    // ...and the logged copy of those headers is redacted.
    const requestEvent = state.events.find((e) => e.phase === "request");
    expect(JSON.stringify(requestEvent)).toContain(REDACTED);
    expect(JSON.stringify(requestEvent)).not.toContain(SECRET);
  });

  it("scrubs a secret out of a thrown transport error", async () => {
    const { adapter, state } = harness([new Error(`TLS handshake failed while sending token ${SECRET}`)], {
      retry: { maxAttempts: 1, baseBackoffMs: 400, maxBackoffMs: 8_000, jitterRatio: 0.5, maxRetryAfterMs: 60_000 },
    });
    const result = await adapter.fetchProduct(UPC12);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK");
      expect(JSON.stringify(result.error)).not.toContain(SECRET);
    }
    expect(JSON.stringify(state.events)).not.toContain(SECRET);
  });

  it("keeps the credential out of an api-key header log and out of the stored raw payload", async () => {
    const { adapter, state } = harness(
      [makeResponse(200, JSON.stringify({ ...VERIFIED_BY_GS1_PAYLOAD, apiKeyEcho: SECRET }))],
      { authMode: "api-key", apiKeyHeader: "Ocp-Apim-Subscription-Key" },
    );
    const result = await adapter.fetchProduct(UPC12);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(state.calls[0].headers["Ocp-Apim-Subscription-Key"]).toBe(SECRET);
    expect(JSON.stringify(result.value)).not.toContain(SECRET);
    expect(JSON.stringify(state.events)).not.toContain(SECRET);
  });
});

/* ------------------------------------------------------------------ diff */

describe("diffRemoteAgainstLocal", () => {
  const remote = mapFixtureRecord();

  function localBase() {
    const local = emptyProductContext();
    local.identifiers.gtin14 = UPC12; // stored unpadded on purpose
    local.status = "ACTIVE";
    local.labelDescription = "BEARING KIT 3.5K";
    return local;
  }

  it("flags 'remote has a value, local is empty' as missing-locally", () => {
    const diffs = diffRemoteAgainstLocal(remote, localBase());
    const brand = diffs.find((d) => d.path === "brand.name");
    expect(brand).toMatchObject({
      kind: "missing-locally",
      localValue: "",
      remoteValue: "Axle Teknology",
      overwritesLocal: false,
      acceptable: true,
    });
  });

  it("flags a genuine disagreement as a conflict that would overwrite", () => {
    const local = localBase();
    local.description = "3.5K BEARING KIT — OLD COPY";
    const diffs = diffRemoteAgainstLocal(remote, local);
    const description = diffs.find((d) => d.path === "description");
    expect(description).toMatchObject({
      kind: "conflict",
      localValue: "3.5K BEARING KIT — OLD COPY",
      remoteValue: "GENUINE AXLETEK 3.5K BEARING L44610/L44649",
      overwritesLocal: true,
      acceptable: true,
    });
  });

  it("normalises GTINs before comparing, so padding is not a conflict", () => {
    const diffs = diffRemoteAgainstLocal(remote, localBase());
    expect(diffs.find((d) => d.path === "identifiers.gtin14")?.kind).toBe("match");
    expect(diffs.find((d) => d.path === "status")?.kind).toBe("match");
  });

  it("marks a field the remote left empty as remote-empty and not acceptable", () => {
    const diffs = diffRemoteAgainstLocal(remote, localBase());
    const label = diffs.find((d) => d.path === "labelDescription");
    expect(label).toMatchObject({ kind: "remote-empty", remoteValue: "", acceptable: false });
  });

  it("omits fields that are empty on both sides and can hide matches on request", () => {
    const diffs = diffRemoteAgainstLocal(remote, localBase());
    expect(diffs.find((d) => d.path === "identifiers.sku")).toBeUndefined();
    const actionable = diffRemoteAgainstLocal(remote, localBase(), { includeMatches: false });
    expect(actionable.every((d) => d.kind !== "match")).toBe(true);
    expect(pendingDiffs(diffs).every((d) => d.acceptable)).toBe(true);
  });

  it("never returns anything that mutates the local context", () => {
    const local = localBase();
    const snapshot = structuredClone(local);
    diffRemoteAgainstLocal(remote, local);
    expect(local).toEqual(snapshot);
  });
});

describe("applyAcceptedFields", () => {
  const remote = mapFixtureRecord();

  function localBase() {
    const local = emptyProductContext();
    local.identifiers.gtin14 = UPC12;
    local.description = "3.5K BEARING KIT — OLD COPY";
    local.labelDescription = "BEARING KIT 3.5K";
    return local;
  }

  it("applies exactly the accepted paths and nothing else", () => {
    const local = localBase();
    const diffs = diffRemoteAgainstLocal(remote, local);
    const out = applyAcceptedFields(local, diffs, ["brand.name", "description"]);

    expect(out.applied).toEqual(["brand.name", "description"]);
    expect(out.rejected).toEqual([]);
    expect(out.context.brand.name).toBe("Axle Teknology");
    expect(out.context.description).toBe("GENUINE AXLETEK 3.5K BEARING L44610/L44649");
    // Untouched fields keep their local values.
    expect(out.context.labelDescription).toBe("BEARING KIT 3.5K");
    expect(out.context.netContent).toBe("");
  });

  it("never mutates the local context it was given", () => {
    const local = localBase();
    const snapshot = structuredClone(local);
    const diffs = diffRemoteAgainstLocal(remote, local);
    applyAcceptedFields(local, diffs, ["brand.name", "description"]);
    expect(local).toEqual(snapshot);
  });

  it("rejects a path that is not in the diff, and one the diff says is not acceptable", () => {
    const local = localBase();
    const diffs = diffRemoteAgainstLocal(remote, local);
    const out = applyAcceptedFields(local, diffs, ["identifiers.upc12", "labelDescription", "identifiers.gtin14"]);
    expect(out.applied).toEqual([]);
    expect(out.rejected).toEqual([
      { path: "identifiers.upc12", reason: "not-in-diff" },
      { path: "labelDescription", reason: "not-acceptable" },
      { path: "identifiers.gtin14", reason: "not-acceptable" },
    ]);
    expect(out.context.identifiers.upc12).toBe("");
  });

  it("writes GS1 reference data into the custom bag", () => {
    const local = localBase();
    const diffs = diffRemoteAgainstLocal(remote, local);
    const out = applyAcceptedFields(local, diffs, ["custom.gs1Dimensions", "custom.gs1GpcBrickCode"]);
    expect(out.applied).toHaveLength(2);
    expect(out.context.custom["custom.gs1Dimensions"]).toBeUndefined();
    expect(out.context.custom.gs1Dimensions).toBe("4.5 x 7.25 x 1.125 INH");
    expect(out.context.custom.gs1GpcBrickCode).toBe("10001714");
  });

  it("accepts nothing when given an empty acceptance list — there is no auto-apply", () => {
    const local = localBase();
    const diffs = diffRemoteAgainstLocal(remote, local);
    const out = applyAcceptedFields(local, diffs, []);
    expect(out.applied).toEqual([]);
    expect(out.context).toEqual(local);
  });
});

/* ------------------------------------------------- adversarial regressions */

/**
 * Each case here is a defect that shipped and was fixed. They are grouped
 * because they share one theme: a third party (or a malformed input) must never
 * be able to make this module invent an answer, hang, or write outside itself.
 */
describe("regressions — the adapter must not invent an answer", () => {
  const JUNK_2XX_BODIES = ["", "{}", "[]", "null", '{"data":null}', '"a string"', "123", '{"message":"degraded"}'];

  it("refuses a 2xx that carries no recognisable record instead of fabricating one", async () => {
    for (const body of JUNK_2XX_BODIES) {
      const { adapter } = harness([makeResponse(200, body)]);
      const fetched = await adapter.fetchProduct(UPC12);
      expect(fetched.ok, `fetchProduct should not succeed on body ${JSON.stringify(body)}`).toBe(false);
      if (!fetched.ok) expect(fetched.error.code).toBe("BAD_RESPONSE");
    }
  });

  it("never reports 'verified' on the strength of a 2xx alone", async () => {
    // A GTIN's licence status is a compliance claim. A 200 whose body says
    // nothing about the GTIN does not support it, and answering "verified"
    // there would write a fact into gs1_sync_records that GS1 never stated.
    for (const body of JUNK_2XX_BODIES) {
      const { adapter } = harness([makeResponse(200, body)]);
      const verified = await adapter.verifyGtin(UPC12);
      expect(verified.ok, `verifyGtin should not succeed on body ${JSON.stringify(body)}`).toBe(false);
      if (!verified.ok) expect(verified.error.code).toBe("BAD_RESPONSE");
    }
  });

  it("still maps a payload that has real content but omits the GTIN", async () => {
    // The evidence check must not cost the mapper its tolerance: a record keyed
    // only on descriptive fields is still a record, and takes the requested GTIN.
    const { adapter } = harness([makeResponse(200, JSON.stringify({ brandName: "Axle Teknology" }))]);
    const result = await adapter.fetchProduct(UPC12);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gtin).toBe(GTIN14);
    expect(result.value.brandName).toBe("Axle Teknology");
  });

  it("rejects a record that describes a different GTIN than the one requested", async () => {
    const other = JSON.stringify({ gtin: "00012345678905", brandName: "Someone Else" });
    const { adapter } = harness([makeResponse(200, other)]);
    const result = await adapter.fetchProduct(UPC12);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("BAD_RESPONSE");
    expect(result.error.message).toContain("00012345678905");

    const { adapter: verifier } = harness([makeResponse(200, other)]);
    const verified = await verifier.verifyGtin(UPC12);
    expect(verified.ok).toBe(false);
  });

  it("reports a 1xx/3xx as BAD_RESPONSE, not as a payload the operator should fix", async () => {
    const { adapter } = harness([makeResponse(302, "")]);
    const result = await adapter.fetchProduct(UPC12);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("BAD_RESPONSE");
      expect(result.error.message).toContain("302");
    }
  });

  it("substitutes every {gtin} placeholder in a configured path", async () => {
    const { adapter, state } = harness([makeResponse(200, JSON.stringify(VERIFIED_BY_GS1_PAYLOAD))], {
      paths: { test: "/v1/health", verify: "/v1/gtins/{gtin}", product: "/v1/{gtin}/related/{gtin}", publish: "/v1/products" },
    });
    await adapter.fetchProduct(UPC12);
    expect(state.calls[0].url).toBe(`https://api.gs1us.test/verified/v1/${GTIN14}/related/${GTIN14}`);
  });

  it("enforces timeoutMs itself, even when the fetch implementation ignores the abort signal", async () => {
    // The previous implementation only aborted the controller. A fetch that does
    // not honour `signal` — a polyfill, a gateway wrapper — left the adapter
    // awaiting a promise that never settled, and a batch job hung forever.
    const adapter = createGs1UsAdapter(
      makeConfig({
        timeoutMs: 100,
        retry: { maxAttempts: 1, baseBackoffMs: 1, maxBackoffMs: 2, jitterRatio: 0, maxRetryAfterMs: 100 },
      }),
      { fetch: () => new Promise<Gs1FetchResponse>(() => {}), sleep: async () => {} },
    );
    const outcome = await Promise.race([
      adapter.fetchProduct(UPC12).then((r) => (r.ok ? "ok" : r.error.code)),
      new Promise<string>((resolve) => setTimeout(() => resolve("never-returned"), 2_000)),
    ]);
    expect(outcome).toBe("TIMEOUT");
  });

  it("honours an explicit rejection in a 2xx publish body", async () => {
    const { adapter } = harness([makeResponse(200, '{"accepted":false,"status":"REJECTED","messages":["bad prefix"]}')], {
      provider: "gs1us-datahub",
    });
    const result = await adapter.publishProduct(mapFixtureRecord());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.accepted).toBe(false);
  });
});

describe("regressions — malformed input is a value, never a throw or a hang", () => {
  it("reports a malformed percent-escape in a Digital Link instead of throwing URIError", () => {
    expect(() => parseDigitalLinkUri(`https://id.gs1.org/01/${GTIN14}/10/%E0%A4%A`)).not.toThrow();
    expect(parseDigitalLinkUri(`https://id.gs1.org/01/${GTIN14}/10/%E0%A4%A`)).toMatchObject({
      ok: false,
      reason: "malformed-encoding",
    });
  });

  it("caps path qualifiers at the length GS1 defines for the AI", () => {
    expect(buildDigitalLinkUri({ gtin: UPC12, qualifiers: { serial: "S".repeat(21) } })).toMatchObject({
      ok: false,
      reason: "invalid-qualifier",
    });
    expect(buildDigitalLinkUri({ gtin: UPC12, qualifiers: { serial: "S".repeat(20) } }).ok).toBe(true);
  });

  it("terminates when a registered secret is a substring of the redaction marker", () => {
    // `while (out.includes(secret)) out = out.replace(secret, REDACTED)` spun
    // forever for any secret contained in "[redacted]", pinning a core and
    // blocking the event loop of the whole server.
    for (const secret of ["redacted", "[redacted", "redacted]", "[redacted]"]) {
      const out = redactString(`prefix ${secret} suffix`, { secrets: [secret] });
      expect(out).toBe(`prefix ${REDACTED} suffix`);
    }
  });

  it("rejects an odd-length hex ciphertext rather than silently dropping a nibble", () => {
    const bad = decryptCredential({ ciphertext: "abc", iv: "0".repeat(24), tag: "0".repeat(32) }, { key: KEY_A });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("PAYLOAD_MALFORMED");
  });
});

describe("regressions — diff and apply stay inside the context", () => {
  it("writes each dimension with its own unit when the registry mixes them", () => {
    // Hoisting the first unit onto all three printed a height of 200 mm as
    // "200 INH" — wrong by a factor of 25.4, on a card that goes to press.
    const mixed = mapGs1ProductRecord(
      {
        gtin: GTIN14,
        tradeItemMeasurements: {
          width: { value: 4.5, unitCode: "INH" },
          height: { value: 200, unitCode: "MMT" },
          depth: { value: 1, unitCode: "INH" },
        },
      },
      "",
      "custom",
      "2026-08-26T00:00:00.000Z",
      {},
    );
    if (mixed === null) throw new Error("setup");
    const diffs = diffRemoteAgainstLocal(mixed, emptyProductContext());
    expect(diffs.find((d) => d.path === "custom.gs1Dimensions")?.remoteValue).toBe("4.5 INH x 200 MMT x 1 INH");
    // A consistent set still reads as one measurement with one unit.
    expect(
      diffRemoteAgainstLocal(mapFixtureRecord(), emptyProductContext()).find(
        (d) => d.path === "custom.gs1Dimensions",
      )?.remoteValue,
    ).toBe("4.5 x 7.25 x 1.125 INH");
  });

  it("refuses a path that names a prototype instead of data", () => {
    const local = emptyProductContext();
    const forged = [
      {
        path: "__proto__.polluted",
        label: "forged",
        remoteField: "brandName",
        localValue: "",
        remoteValue: "yes",
        kind: "missing-locally" as const,
        overwritesLocal: false,
        acceptable: true,
      },
    ];
    const out = applyAcceptedFields(local, forged, ["__proto__.polluted"]);
    expect(out.applied).toEqual([]);
    expect(out.rejected).toEqual([{ path: "__proto__.polluted", reason: "unwritable-path" }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
