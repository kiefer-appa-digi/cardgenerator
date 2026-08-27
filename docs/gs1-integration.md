# GS1 integration

Spec §13. GS1 is an **optional connected service, never a runtime dependency**.
Everything below is written around that one rule.

## The short version

| | |
| --- | --- |
| Architecture | An adapter interface with pluggable providers. No caller ever depends on a provider. |
| Default state | `disabled`. The whole application works, including card generation and export, with GS1 switched off. |
| Credentials | AES-256-GCM at rest, AAD-bound to the owning organisation, write-only from the browser's point of view, never in a client bundle, never in browser storage. |
| Enrichment | Diff-and-accept. There is no auto-apply path and no acceptance threshold. |
| Publish (§13B) | Implemented and tested at the adapter layer. **Not wired to a UI.** Stated below. |
| Digital Link | URI build and parse are complete and tested. **Resolution is an unfilled extension point**, by design. |
| Scraping | None. §13 forbids it; nothing in this codebase fetches a GS1 web page. |

---

## Adapter architecture

```
                        ┌──────────────────────────────┐
   settings screen ───► │  src/server/gs1-actions.ts   │  "use server"
   product screen  ───► │  decrypt · call · redact ·   │
                        │  log · store · diff          │
                        └──────────────┬───────────────┘
                                       │  Gs1ConnectionConfig (credential in memory only)
                                       ▼
                        ┌──────────────────────────────┐
                        │  getAdapter()  src/lib/gs1/  │  server-only factory
                        └──────────────┬───────────────┘
                       ┌───────────────┴───────────────┐
                       ▼                               ▼
        ┌──────────────────────────┐    ┌──────────────────────────────┐
        │ providers/disabled.ts    │    │ providers/gs1us.ts           │
        │ NOT_CONFIGURED, no I/O   │    │ REST + retry/backoff/timeout │
        └──────────────────────────┘    └──────────────────────────────┘
```

### The interface

`Gs1Adapter` (`src/lib/gs1/adapter.ts`):

| Method | Spec | Notes |
| --- | --- | --- |
| `testConnection()` | §13B | Returns a **report**, not a `Gs1Result` — a failed test is a normal, displayable outcome of the settings screen, not an exception. |
| `verifyGtin(gtin)` | §13A | "Not in the registry" is a *successful* verification with `status: "not-found"`. |
| `fetchProduct(gtin)` | §13A | Full attribute set, normalised to `Gs1ProductRecord`. |
| `publishProduct(record)` | §13B | Only meaningful when `capabilities.publish`; other providers answer `UNSUPPORTED`. |
| `resolveDigitalLink?(uri)` | §13 future | Optional, guarded by `capabilities.digitalLinkResolution`. |

**The contract that makes GS1 optional:** *every method resolves; none of them
reject.* A network failure, a 500, an expired token and "GS1 was never
configured" are all `ok: false` with a typed code from a closed union
(`NOT_CONFIGURED`, `MISCONFIGURED`, `INVALID_GTIN`, `NOT_FOUND`, `UNAUTHORIZED`,
`FORBIDDEN`, `RATE_LIMITED`, `TIMEOUT`, `NETWORK`, `BAD_RESPONSE`,
`SERVER_ERROR`, `CONFLICT`, `VALIDATION`, `UNSUPPORTED`). A caller cannot forget
to handle a failure, and a third party being down cannot crash a page render.
The concrete adapters wrap their whole body in `guarded()`, so the only way one
can throw is a bug.

### Capabilities are declared, not guessed

```ts
verified: { verify: true, fetchProduct: true, publish: false, digitalLinkResolution: false }
datahub:  { verify: true, fetchProduct: true, publish: true,  digitalLinkResolution: false }
custom:   { verify: true, fetchProduct: true, publish: true,  digitalLinkResolution: false }
```

Verified by GS1 is a read-only registry lookup; Data Hub is where a brand owner
manages its own records; a deployment-supplied endpoint is assumed to do
everything until it 404s. The UI reads capabilities rather than switching on a
provider name, so adding a provider changes one record.

### The disabled adapter is the default, and it is exercised

`createDisabledAdapter()` is what `getAdapter()` returns for every organisation
that has not set GS1 up — **and for every one that has set it up wrongly.**
Every misconfiguration degrades to it with a reason a settings screen can
display, rather than throwing:

- no connection row, or `provider: "disabled"`
- the row exists but `enabled` is false
- no base URL
- a base URL that is not a valid `http(s)` URL — said once, rather than
  returning a `NETWORK` error on each of two hundred products in a batch
- an auth mode that needs a credential and none is stored or it will not decrypt
- the stored settings fail `Gs1ConnectionConfigSchema`

There is **no null branch and no throw** in the factory.

The disabled adapter answers `NOT_CONFIGURED` rather than an empty success,
specifically so a caller cannot mistake "we asked nobody" for "GS1 has no data
for this GTIN". It performs no I/O and answers instantly, which means every code
path that touches GS1 is exercised by it in development and in tests. If the
application only worked when GS1 was configured, GS1 would have become a
dependency — the disabled adapter is how that is prevented rather than promised.

`tests/unit/gs1.test.ts`: "answers NOT_CONFIGURED for every operation and never
throws" · "degrades to the disabled adapter for every misconfiguration".

---

## Credential encryption at rest

`src/server/crypto.ts`. **AES-256-GCM**, chosen over CBC because GCM is
authenticated: a wrong key, a truncated ciphertext or a flipped bit fails the
tag check instead of silently producing garbage that then gets sent to a remote
API as if it were a key.

### Storage layout

`gs1_connections` holds the credential as **three hex columns, not one packed
blob**: `credential_ciphertext`, `credential_iv`, `credential_tag`, plus
`key_version` and `rotated_at`. Split so a rotation can be audited column by
column and a malformed row is obvious rather than surfacing as a decryption
failure at request time.

- Key: 32 bytes, supplied as 64 hex characters in `CREDENTIAL_KEY`.
- IV: 12 bytes, the GCM-native size — anything else forces an internal GHASH.
  **A fresh IV per encryption.** Asserted: "uses a fresh IV every time, so the
  same plaintext never repeats a ciphertext".
- Tag: 16 bytes.

### AAD binds a ciphertext to its owner

The additional authenticated data is `gs1:{orgId}`. A ciphertext row copied from
one tenant into another **fails the tag check and does not decrypt**. Asserted:
"binds a ciphertext to its AAD, so a row copied between tenants will not open".

### Nothing in the crypto module can leak

Every failure is a typed result with a fixed, secret-free string —
`KEY_MISSING`, `KEY_MALFORMED`, `PLAINTEXT_EMPTY`, `PAYLOAD_MALFORMED`,
`DECRYPT_FAILED`, `ENCRYPT_FAILED`. No key material, plaintext or ciphertext is
ever put into an error message, so a caller that logs an error cannot
accidentally log a secret. Asserted: "fails cleanly under the wrong key, without
throwing or echoing anything" · "reports a missing or malformed CREDENTIAL_KEY as
a typed failure".

`node:crypto` does not exist in the browser, which is a deliberate second line
of defence behind "never import this from a client component".

### The credential is write-only from the browser's side

`src/server/gs1-actions.ts` states the rule in its header and enforces it:

> The credential is write-only. It arrives from the browser once, is encrypted
> with `CREDENTIAL_KEY` before the row is written, and is decrypted only inside
> the call that needs it. No action returns it, and no action returns anything
> derived from it. The settings screen learns exactly two facts: whether one is
> stored, and when it was last rotated.

- `setGs1CredentialAction()` encrypts and writes. It returns `{ ok }`.
- `gs1SettingsViewAction()` returns the connection's identity plus
  `hasCredential: boolean` and `rotatedAt`. **Not the credential, and nothing
  computed from it** — no prefix, no last-four, no length.
- `clearGs1CredentialAction()` blanks all three columns.
- The credential's lifetime is one server action. It is decrypted, put in the
  adapter's closure, used, and discarded with the request.
- **Nothing is written to browser storage.** §25's "no GS1 credentials in browser
  storage" holds because the credential never reaches the browser at all.

The non-secret transport details (auth mode, header name, endpoint paths,
timeout) live in the organisation's settings blob rather than in
`gs1_connections`, which keeps the credential columns the only secret-bearing
ones by construction.

`src/lib/gs1/types.ts` is pure zod and TypeScript with no `node:crypto` import,
so a client component can import the provider list and the diff shape safely.
The adapters and the factory are separate modules that a client import path
never reaches.

---

## Rotation

`rotateCredential(stored, { fromKey, toKey, aad })` decrypts under the old key
and re-encrypts under the new one in a single call, returning a new
`{ ciphertext, iv, tag }`. It never returns the plaintext. Asserted: "rotates a
credential from one key to another".

Operationally, two rotations are distinct and both are supported:

1. **Rotating the GS1 API key** — the org admin submits the new key; the old
   ciphertext is replaced; `rotated_at` is stamped; the settings screen shows the
   new date. Nothing else changes.
2. **Rotating `CREDENTIAL_KEY` itself** — `key_version` exists so rows encrypted
   under key *n* and key *n+1* can coexist during a migration, and
   `rotateCredential` is the per-row operation that moves one across. A
   migration script that walks `gs1_connections` under both keys is
   **not shipped** — with one connection row per organisation this is a small
   job, but it is honest to say the tooling is the primitive, not a command.

`hasCredentialKey()` lets the settings screen say plainly that GS1 cannot be
configured on this deployment because no `CREDENTIAL_KEY` is set, instead of
failing at save time.

---

## Redacted logging

§13B requires "request logging with secrets redacted". `redact()` in
`src/server/crypto.ts` runs before anything reaches the log sink, and the
adapter builds **every field** of a `Gs1LogEvent` through it — so
`gs1_request_logs` can be written straight from the event without further
filtering.

What redaction actually covers, each with a test:

| Behaviour | Test |
| --- | --- |
| Secret-named keys at any depth (`authorization`, `apiKey`, `token`, `secret`, …) replaced; innocent keys left intact | "classifies key names without swallowing innocent ones" · "replaces secret-named values at any depth and leaves the rest intact" |
| Input never mutated | "does not mutate its input" |
| Cyclic and deeply nested objects survive | "survives cycles and depth without throwing" |
| Auth schemes, inline `key=value` assignments and opaque blobs scrubbed out of **free text** | "scrubs auth schemes, inline assignments and opaque blobs inside free text" |
| Secret-looking query parameters removed from a URL, the rest kept loggable | "redacts secret-looking query values but keeps the rest of a URL loggable" |
| A hostile `__proto__` key stays data and cannot replace a prototype | "keeps a hostile `__proto__` key as data instead of letting it replace a prototype" |
| **The credential registered as a literal secret,** so a remote API echoing the `Authorization` header back inside an error body still cannot leak it | "scrubs registered literal secrets wherever they appear" |

The literal-secret registration is the important one. Key-name redaction only
protects fields you named; registering the credential value itself protects
against a remote that reflects it somewhere you did not anticipate. There is
even a regression test for the degenerate case where a registered secret is a
substring of the redaction marker ("terminates when a registered secret is a
substring of the redaction marker").

Three further tests assert the property end to end rather than per-function:
"keeps an encrypted-then-decrypted secret out of every result, log and error" ·
"scrubs a secret out of a thrown transport error" · "keeps the credential out of
an api-key header log and out of the stored raw payload".

`gs1_request_logs` stores `method`, `path`, `status_code`, `duration_ms`,
`request_summary`, `response_summary` and `error` — a duration and a status code
for rate-limit forensics, and no bodies that were not redacted first.
`clearGs1LogsAction()` lets an admin purge them.

---

## Retry, backoff, timeouts and rate limits

`src/lib/gs1/providers/gs1us.ts`. Defaults from `Gs1RetryPolicySchema`:

| Setting | Default | Reason |
| --- | --- | --- |
| `maxAttempts` | 3 | **Total requests, not retries.** 1 means "never retry". |
| `baseBackoffMs` | 400 | doubled per attempt |
| `maxBackoffMs` | 8 000 | ceiling on the computed delay |
| `jitterRatio` | 0.5 | **equal jitter** — half the delay fixed, half random |
| `maxRetryAfterMs` | 60 000 | ceiling applied to a *server-supplied* `Retry-After` |
| `timeoutMs` | 10 000 | per request |

The jitter comment in the schema says why it is not optional politeness:
without it, a batch run of 200 products retries in lockstep and re-triggers the
same rate limit. Equal jitter keeps progress bounded below while still breaking
up the convoy.

Behaviour, each asserted in `tests/unit/gs1.test.ts`:

- **5xx retries** with exponential backoff up to `maxAttempts`, then gives up.
- **4xx does not retry.** Resending the same bad request is pointless traffic.
- **429 honours `Retry-After`** in place of the computed backoff — both RFC 7231
  forms, delta-seconds and HTTP-date.
- **A hostile `Retry-After` is capped** at `maxRetryAfterMs`, so one bad header
  cannot stall a batch job.
- **A thrown network failure retries** and is reported as `NETWORK`.
- **A hanging request aborts at `timeoutMs`** and is reported as `TIMEOUT` —
  and the adapter enforces the deadline itself rather than trusting the fetch
  implementation to honour the abort signal ("enforces `timeoutMs` itself, even
  when the fetch implementation ignores the abort signal").
- **A non-JSON 200 is `BAD_RESPONSE` without retrying.**
- **A 1xx or 3xx is `BAD_RESPONSE`,** not a payload the operator should try to
  fix.
- Backoff delay is computed by a pure function with an injected random source,
  so the window is asserted rather than timed ("computes equal-jitter backoff
  inside the expected window"). The delay itself is injectable, so the whole
  machine is unit-tested with no network and no real waiting.

The adapter also refuses to invent an answer:

- "refuses a 2xx that carries no recognisable record instead of fabricating one"
- "never reports 'verified' on the strength of a 2xx alone"
- "rejects a record that describes a different GTIN than the one requested"
- "rejects a bad GTIN locally, without sending a request" — a failed check digit
  is decided locally and costs no round trip
- a **404 from `verify`** is a successful "not licensed" answer; a **404 from
  `fetchProduct`** is an error, because the caller wanted data

`fetch` is injected rather than taken from the global scope, which is what makes
all of the above testable; the global is read at call time in production, never
at module scope.

---

## Verify / enrich, with explicit acceptance

> "Never overwrite local data automatically. Show a diff and require explicit
> acceptance." (§13A)

Two pure functions in `src/lib/gs1/diff.ts` with no side effects between them:

```
diffRemoteAgainstLocal(remote, local)   compares and reports. Changes nothing.
applyAcceptedFields(local, diff, paths) changes a COPY, and only for paths a human named.
```

**There is deliberately no "apply all" and no auto-accept threshold.** The
remote registry is authoritative about a GTIN's *licence*; it is not
authoritative about the description a brand manager approved for print, and
quietly replacing on-pack copy with a registry string is exactly the failure
§13A is written to prevent.

### Diff statuses

| Status | Meaning | Acceptable? |
| --- | --- | --- |
| `missing-locally` | remote has a value, local is empty | yes |
| `conflict` | both have a value and they disagree — accepting **would overwrite** | yes, explicitly |
| `remote-empty` | the remote left it blank | **no** |
| `match` | both agree | hidden on request |

GTINs are normalised before comparison, so zero-padding is not reported as a
conflict. Fields empty on both sides are omitted.

### The workflow, as wired

1. **`verifyProductGtinAction(productId)`** — builds the `ProductContext`,
   validates the GTIN locally, calls the adapter, redacts the payload, stores a
   `gs1_sync_records` row with `operation: "verify"` (or `"enrich"`), the
   redacted `remote_payload` and the computed `diff`. **Nothing is written to
   the product.**
2. **`/settings/gs1/verify`** shows the diff field by field: local value, remote
   value, status (`src/components/settings/gs1-verify.tsx`). That screen — not
   the product screen — is where verification lives; `/products/[id]` carries no
   GS1 control at all, which is a UX gap worth closing but is not a correctness
   one.
3. **`acceptGs1FieldsAction({ syncId, paths })`** — writes exactly the fields a
   person ticked, and **only if those fields are still marked acceptable on the
   stored diff**, so a stale acceptance list cannot write a value nobody saw.
   `accepted_by`, `accepted_at` and `accepted_fields` are recorded.
4. `gs1SettingsViewAction()` returns the ten most recent `gs1_sync_records` for
   the organisation — id, GTIN, product, operation, status, accepted fields,
   error, timestamp — and `/settings/gs1` renders them. `revisions.gs1_sync_state`
   carries the state onto a card revision (§20). **There is no per-product sync
   history view**, and no `recentGs1SyncsAction`; earlier drafts of this document
   named one that was never written.

Asserted: "applies exactly the accepted paths and nothing else" · "never mutates
the local context it was given" · "rejects a path that is not in the diff, and
one the diff says is not acceptable" · "accepts nothing when given an empty
acceptance list — there is no auto-apply" · "refuses a path that names a
prototype instead of data".

Reference data that has no home on the product record (registry dimensions,
weights, classification) is written into `products.custom` rather than being
forced into a print field — "writes GS1 reference data into the custom bag".
Mixed-unit dimensions are written unit by unit rather than hoisting the first
unit onto all three, because publishing a width in inches with a height in
millimetres and printing one unit would be wrong by a factor of 25.4.

---

## The brand-owner publish path (§13B)

**Status: implemented and tested at the adapter layer. Not exposed in the UI.**

What exists:

- `Gs1Adapter.publishProduct(record)` in the interface.
- A working Data Hub implementation in `providers/gs1us.ts` that POSTs the
  normalised record, reads the receipt, and **honours an explicit rejection
  inside a 2xx body** rather than treating any 200 as success.
- `capabilities.publish` gating, with read-only providers answering
  `UNSUPPORTED` — "refuses to publish through a read-only provider".
- The `gs1_sync_records.operation` vocabulary already includes `publish`.
- Tests: "publishes through Data Hub and reads the receipt" · "refuses to publish
  through a read-only provider" · "honours an explicit rejection in a 2xx publish
  body".

What does not exist: **no server action calls `publishProduct`, and no screen
offers it.** `src/server/gs1-actions.ts` exports connection management, verify
and accept — not publish. Calling it is a server action away, and the storage,
capability gating, logging and audit trail it would use are all already there,
but it is not a feature a user can reach today. §13B says "architect a
connector"; the connector is architected and proven. The workflow on top of it
is not built, and this document does not pretend otherwise.

`docs/final-gauntlet-report.md` records §13B as PARTIAL for this reason.

---

## GS1 Digital Link

Split deliberately into the half that is fully implementable today and the half
that needs a resolver.

### Implemented: URI construction and parsing

`src/lib/gs1/digital-link.ts`. No I/O.

- Canonical URI from a GTIN: `https://id.gs1.org/01/00810797030001`.
- **Path qualifiers in the GS1-required order** — CPV (AI 22), then lot
  (AI 10), then serial (AI 21). A serial may only follow a lot, which may only
  follow a CPV; anything out of order is not a Digital Link, so the builder
  emits them in that fixed sequence rather than in the order a caller passed
  them.
- Data attributes as query parameters keyed by AI.
- Both numeric AIs and the GS1 short aliases (`gtin`, `cpv`, `lot`, `ser`) parse.
- Round-trips through the parser.
- Refuses an invalid GTIN or an unresolvable domain **instead of emitting a
  broken URI**.
- Caps path qualifiers at the length GS1 defines for the AI.
- A malformed percent-escape is reported as a value, not thrown as a `URIError`.

A Digital Link QR is a first-class barcode symbology
(`gs1-digital-link` in `src/lib/design/schema.ts`), encoded through the same
vector path as every other symbology — so it is drawn as vector modules in the
production PDF, not as a placed image. Tests in `tests/unit/barcode.test.ts`
`describe("QR and GS1 Digital Link")`.

### Architected, not implemented: resolution

Asking a resolver *what links exist* for a GTIN is a provider concern, so it is
an **optional interface method** rather than a stub:

```ts
resolveDigitalLink?(uri: string): Promise<Gs1Result<Gs1DigitalLinkResolution>>;
```

guarded by `Gs1Capabilities.digitalLinkResolution`, with a type guard
(`supportsDigitalLinkResolution()`) that narrows the adapter. The
`Gs1Link` shape (`rel`, `href`, `title`, `type`, `hreflang`) and
`Gs1DigitalLinkConfig` (`resolverDomain`, `resolutionEnabled`) are already
defined.

`digitalLinkResolution` is **false on every shipped provider**, and the disabled
adapter deliberately does not define the method at all — asserted by "has no
optional digital-link resolution method (the extension point is unfilled by
design)". A future provider implements the method and flips the flag; no caller
changes, and **nothing in the codebase throws "not implemented"**.

---

## The whole application works with GS1 disabled

This is the requirement, so here is the evidence rather than the assurance.

1. **The catalogue was built with GS1 switched off.** All 392 products, the
   3 presets, the 3 master templates and the 3 export artifacts were produced
   while `gs1_connections` was empty — no verification, no enrichment and no
   registry lookup contributed to any of them. (A `custom` provider row pointed
   at a local mock server has since been added to exercise the connector; it
   changed no product data, and the one `gs1_sync_records` row it produced is a
   `verify`.) The evidence that GS1 is optional is points 2–7 below, which are
   properties of the code rather than of whatever happens to be in the database
   this week.
2. **GTIN validation is local.** Check digits, length and the GTIN-8/12/13/14
   normalisation are arithmetic in `src/lib/barcode/gtin.ts` and
   `src/lib/gs1/gtin.ts`. Barcode generation never asks a registry anything.
3. **The importer does not consult GS1.** Duplicate detection, check-digit
   validation and identifier normalisation are all offline
   (`src/lib/import/preview.ts`).
4. **Preflight does not consult GS1.** `GTIN_INVALID` is decided from the digits.
5. **Export does not consult GS1.** `renderProductionPdf()` has no network call
   of any kind.
6. **`getAdapter()` cannot fail.** No null branch, no throw; every
   misconfiguration returns the disabled adapter with a displayable reason.
7. **The disabled adapter is what the unit suite runs against by default,** so
   the GS1-off path is the exercised path, not the neglected one.

The only things unavailable with GS1 off are the GS1 features themselves: verify,
enrich and (once wired) publish. Each says `NOT_CONFIGURED` with a sentence
telling the admin where to turn it on.

---

## Configuration

| Setting | Where | Notes |
| --- | --- | --- |
| `CREDENTIAL_KEY` | environment | 64 hex characters = 32 bytes. Without it, GS1 cannot be configured and the settings screen says so. |
| Provider | `gs1_connections.provider` | `disabled` · `gs1us-verified` · `gs1us-datahub` · `custom` |
| Base URL | `gs1_connections.base_url` | must be `http(s)`; validated before any request |
| Company prefix | `gs1_connections.company_prefix` | the supplied export carries one: `081079703` |
| Credential | three encrypted columns | write-only |
| Auth mode / header / paths / timeout | `organizations.settings` | non-secret transport detail; defaults `test: /v1/health`, `verify` and `product: /v1/gtins/{gtin}`, `publish: /v1/products` |
| Retry policy | `organizations.settings` | defaults in the table above |
| Resolver domain | `organizations.settings` | default `https://id.gs1.org` |

Screens: `/settings/gs1` (connection, credential, connection test, request log),
`/settings/gs1/verify` (GTIN lookup).

**GS1 US's published API surface changes.** The endpoint paths are configuration,
not code, precisely so a path change is a settings edit rather than a deploy.
The `{gtin}` placeholder is substituted wherever it appears in a configured path
("substitutes every `{gtin}` placeholder in a configured path").
