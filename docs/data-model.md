# Data model

Spec §4. Source of truth: `src/server/db/schema.ts` (Drizzle, PostgreSQL).
28 tables. This document explains what each one is for and why it exists;
the schema file carries the same reasoning next to the column types.

## Conventions that apply everywhere

- **Every physical length is `bigint` micro-points.** 1 in = 72 000 000 µpt.
  Never pixels, never a float. See `src/lib/units.ts` and
  `docs/architecture.md`.
- **Every tenant-scoped table carries `org_id`,** and every query path filters
  on it. There is no row-level-security fallback to lean on; isolation is
  enforced in code, in one place per entity, and asserted with
  `assertSameOrg()`.
- **Ids are 24-character nanoid strings** in a `varchar(32)` primary key. They
  appear in export filenames and manifest rows a prepress operator reads aloud,
  so they are shorter than a UUID and have no hyphens to lose.
- **Timestamps are `timestamptz`.** `created_at` and `updated_at` default to
  `now()`.
- **`jsonb` is used for two things only:** validated documents whose schema
  lives in zod (`revisions.doc`, `card_templates.doc`), and verbatim provenance
  (`products.source_row`, `imports.inspection`). It is never used as a way to
  avoid designing a column.

---

## Tenancy

### `organizations`
The tenant root. `settings` (jsonb) carries the four things a deployment tunes
per press: the black rules (`textBlack`, `richBlack`,
`totalAreaCoverageLimit`, `richBlackMinTextSize`), the preflight profile
thresholds, the output intent (identifier, condition name, base64 ICC), and the
export policy (`treatErrorAsBlocking`, `allowOverride`). They live here rather
than in code because §14 forbids inventing a print profile — a different printer
means different numbers, not a different build.

### `users`
`org_id`, `email` (globally unique), `password_hash`, `role`, `active`.
`preferences` (jsonb) holds per-user editor preferences, which §24 requires.
`failed_login_count` and `locked_until` back login throttling.

`role` is one of `admin` · `designer` · `reviewer` · `viewer` (§25). The role is
a name; the authority is the capability matrix in `src/server/auth/rbac.ts`,
which maps each role to a subset of 18 capabilities
(`design.approve`, `export.override_blocking`, `gs1.configure`, …). Storing the
role and deriving capabilities means a permission change is one table in one
file, not a migration.

### `sessions`
Server-side session rows: `user_id`, `org_id`, `expires_at`, `user_agent`, `ip`.
The signed JWT cookie is a fast path, not the authority — `getCurrentUser()`
re-reads this row on every request, so revoking a session or changing a role
takes effect at once instead of at token expiry.

### `audit_logs`
Append-only. `action`, `entity_type`, `entity_id`, `detail` (jsonb), `ip`.
Indexed on `(org_id, created_at)` and on `(entity_type, entity_id)` so both
"what did this user do" and "what happened to this card" are cheap. §25 requires
audit logs; §21 requires that a blocking-error export override be recorded with
a note, and this is where that lands. The writer never throws — an audit failure
must not take down the operation it is recording, but it does reach the platform
log.

---

## Brand and product

### `brands`
`name` (unique per org), `legal_name`, `statement` — the genuine-parts /
brand-assurance paragraph a card back carries — `logo_asset_id`, and `swatches`
(jsonb, in the `PrintColor` shape) for §14's named brand swatches.

Separate from `organizations` because one organisation legitimately owns several
brands. The supplied workbook proves it: six brand names, including a
TowPro / ProAxle private-label pair that share SKUs.

### `products`
The catalogue row. Beyond the obvious identity fields:

| Column | Why it exists |
| --- | --- |
| `part_number` | The selling SKU. **Unique per org + brand, not globally** — the supplied export reuses 17 SKUs across TowPro and ProAxle, which is a real private-label relationship, not a data error. |
| `product_name`, `description`, `description_short`, `label_description`, `subtitle` | Four descriptive fields because a card back needs a short label line and a long specification line, and GS1 Data Hub exports them as separate columns. |
| `country_of_origin` | §7 requires it on the back. Its own column because it is a compliance statement, not marketing copy. |
| `status` | GS1 lifecycle: `In Use` / `PreMarket` / `Draft` / `Archived`. Kept because generating a card for an Archived part is a mistake worth surfacing. |
| `packaging_level`, `net_content_count`, `net_content_uom` | GS1 packaging hierarchy. Every supplied row is `Each`; the columns exist so a case-level row can arrive later without a migration. |
| `is_purchasable`, `is_variable` | Straight from the GS1 export. |
| `record_type` | `product` · `kit` · `non_sellable`. §5 is explicit: "Do not assume every row represents a sellable product." Two rows in the supplied export are bare internal codes and were imported as `non_sellable`. |
| `target_markets`, `gpc_brick` | GS1 reference data. Both are largely empty in the supplied export, and that emptiness is itself a finding (see `docs/source-audit.md` D15, D16). |
| `default_preset_code` | Which card this part normally ships in, so a card can be generated from a product without asking. |
| `source_import_id`, `source_row` | **Provenance (§5.11).** `source_row` is the entire spreadsheet row, verbatim, keyed by resolved header. It is what makes "never silently correct source data" auditable after the fact: the value the sheet held is still there to compare against. |
| `custom` | A typed-schema escape hatch for fields a deployment cares about and this model does not name. Also where `benchmarkSource` marks the 11-500 seed data. |
| `last_modified_source` | The source system's own modification date, kept distinct from `updated_at`. |

### `product_identifiers`
One row per identifier: `kind` (`gtin14` · `gtin13` · `gtin12` · `gtin8` ·
`sku` · `gs1CompanyPrefix`), `value`, `is_primary`, plus `valid` and
`validation_note` recording the check-digit result at import time.

A separate table rather than columns on `products` for three reasons: a product
legitimately carries several identifiers at once; §21 has to answer "which cards
use an invalid GTIN" across the catalogue, which needs an index
(`pid_value_idx` on `(org_id, kind, value)`); and storing a failed check digit
*with its reason* is only possible if the identifier is a row.

**The value is stored in its own form.** A UPC-12 is 12 digits here, not the
zero-padded GTIN-14, because handing the barcode engine a 14-digit string for a
UPC-A would produce the wrong symbol. Canonicalisation to GTIN-14 happens for
*matching* only and is never written back.

### `alternate_part_numbers`
`value`, `relation` (`competitor` · `superseded` · `oem` · `interchange`),
`note`, `position`. §7 lists alternate part numbers on both card faces.
`relation` exists because "replaces Dexter 031-016-00" and "also sold as
L44649" are different statements and a card may print them differently.

### `product_translations`
`(product_id, locale, field)` unique, `value`. §7 requires multilingual copy on
both faces. Modelled as rows rather than a jsonb bag so a missing translation is
a queryable absence, not a silent fallback to English.

### `fitments`
`kind` (`fits` / `replaces` / free text), `text`, `position`. The
fitment/replacement footer copy.

### `warnings`
`code`, `text`, `position`. **`product_id` is nullable:** a null means an
org-wide warning any template may pull in — a Prop 65 statement belongs to the
organisation, not to one SKU.

### `boms` and `bom_items`
`boms` is the header: `product_id`, `name` (default "Pack contents"),
`revision`, `source_import_id`. `bom_items` is the line:
`component_product_id` (nullable — a component that is itself stocked links to
its product row; one that is not, does not), `position`, `quantity` (**text**,
because a source system that writes "2" and one that writes "2 EA" must both
round-trip), `unit_of_measure`, `name`, `part_number`, `description`.

This is what drives §11's "This Pack Includes" repeating block. The line
`2) Inner Bearing (L44643)` is `quantity`, `name`, `part_number` through a
configurable template.

---

## Packaging geometry

### `package_types`
The physical clamshell: `code`, `name`, `vendor`, `material`, and
`cad_reference` (jsonb) holding the **verbatim CAD callouts** and the source
filename. §2 requires the CAD values be preserved separately from the production
presets, and this is where the clamshell half lives.

### `card_presets`
The card that goes in the clamshell. Every dimension is a `bigint` µpt column,
not a jsonb blob, because these are the numbers a preflight query filters on:
`trim_width`, `trim_height`, `corner_radius`, `bleed_{top,right,bottom,left}`,
`safe_{top,right,bottom,left}`.

`safe_*` are columns rather than a constant because §16 says the safe-area inset
"should be a preset property rather than an unexplained constant". All three
presets currently carry 0.1875 in on all sides; a printer who wants a different
allowance edits the preset.

`cavity` (jsonb) holds the `CavitySpec`: the rect in trim space, the corner
radius, a `provenance` field (`measured-from-dieline` · `supplied` ·
`approximate`), `cornerRadiusIsApproximate`, and the measurement notes. §17
requires that recovered geometry be marked and flagged for verification, and the
UI reads these fields to say so next to the overlay.

`cad_reference` (jsonb) mirrors the drawing's own callouts so
`presetDiscrepancies()` can compare the two and report every disagreement
without either one being edited.

---

## Assets

### `assets`
`filename`, `content_type`, `byte_size`, `storage_key`, `storage_url`,
`thumbnail_url`, `sha256`.

The print-relevant half is why this is a table and not a URL string:
`pixel_width`, `pixel_height`, `declared_dpi`, `color_space`, `has_alpha`,
`icc_profile_name`, `has_icc_profile`. All extracted at upload with sharp, from
the file's own bytes. Preflight computes **effective DPI at placed size** from
`pixel_width` and the element's frame width, which is the only number that means
anything on press — §8 forbids silently upscaling and calling an asset
print-ready.

`content_type` is decided by magic-byte sniffing in `src/server/assets.ts`, not
from the browser's `type` header, which is attacker-controlled (§25).

`scan_status` (`pending` · `clean` · `flagged` · `skipped`) and `scan_detail`
are §25's malware-scanning hook. **They are a hook, not a scanner** — no engine
is wired in, and the default is `skipped`. Stated here rather than implied.

`storage_url` never reaches a browser. Reads go through `/api/assets/[id]`,
which checks the requester's organisation first.

---

## Templates, designs and revisions

### `card_templates`
`brand_id`, `preset_code`, `name`, `doc` (the validated `DesignDoc`),
`version`, `is_master`, `archived`.

A template is a design document with locked regions. §18's "controlled editable
regions" is expressed inside the document — each element carries
`templateLocked` — rather than as a separate permissions table, so locking
travels with the element it protects and cannot get out of sync with it.

`version` increments on save and is copied onto every revision generated from
the template, so a card can say which template version produced it.

### `card_designs`
The card as a *thing*: `product_id`, `brand_id`, `template_id`, `preset_code`,
`name`, `status`, and two pointers — `current_revision_id` (the revision open
for editing) and `approved_revision_id` (the most recent approved one).

Two pointers rather than one status flag because a design in the middle of a
revision after approval has both at once: an approved revision that is still the
one shipping, and a draft that is not yet. A single pointer would force a choice
between showing the operator the artwork on press and showing the designer their
work in progress.

### `revisions`
`design_id`, `revision_number` (unique per design), `status`, and:

| Column | Why |
| --- | --- |
| `doc` | The full validated `DesignDoc` for this revision. |
| `product_snapshot` | **The resolved `ProductContext` this revision was built against.** §20 requires storing the source data version. Without it, regenerating a two-year-old approved card would pick up today's product record and produce different words on the same revision number. |
| `template_version` | Which template version produced it (§20). |
| `notes` | Revision notes (§20). |
| `preflight` | The last stored preflight report, so a reviewer sees the same findings the designer saw. |
| `gs1_sync_state` | GS1 sync state at the time of the revision (§20). |
| `created_by`, `created_at` | Creator and timestamp (§20). |
| `frozen_at` | **Set the moment the revision is approved. A non-null `frozen_at` means the row is never written again.** |

### `approvals`
`revision_id`, `action` (`submitted` · `approved` · `rejected` · `withdrawn`),
`actor_id`, `note`, `preflight_snapshot`.

An event log, not a status column, because "who approved this, when, and what
did preflight say at that moment" is the question a print run gets audited on.
`preflight_snapshot` freezes the findings as they stood at the decision — a
later re-run against a changed profile must not be able to rewrite what the
approver actually saw.

---

## The revision immutability rule

> **Approved revisions are immutable. Editing an approved card creates a new
> revision.** (§20)

Enforced in exactly one place: `src/server/designs.ts`, which is the only code
path that writes a revision.

1. `saveDesignAction()` loads the design and its `current_revision_id`.
2. If that revision's `frozen_at` is set, **it is not written.** A fresh
   revision row is created with `revision_number + 1`, status `draft`, carrying
   the new document; the previous revision's status becomes `superseded`; the
   design's `current_revision_id` moves to the new row.
3. If `frozen_at` is null, the draft is updated in place.
4. `approveDesignAction()` sets `status = "approved"` and stamps `frozen_at`,
   writes an `approvals` row with the actor, the note and the preflight
   snapshot, and points `approved_revision_id` at it.

Two properties this buys:

- **An export can always name the exact bytes it came from.** Every
  `export_artifacts` row carries `revision_id`, and a frozen revision's `doc`
  and `product_snapshot` cannot have changed since.
- **The status vocabulary is complete.** `draft` → `in_review` → `approved` →
  `superseded` (§20), with `superseded` reachable only by a new revision
  displacing an approved one.

`revision_number` is unique per design (`rev_design_num_uq`), so a concurrent
double-save cannot mint two revision 4s — the second insert fails rather than
silently interleaving.

---

## The normalised element projection

> "A card design must never be just an opaque canvas JSON blob. Store enough
> normalized metadata to query, validate, migrate, and regenerate designs
> safely. Canvas serialization may be stored as part of a design revision, but
> critical print/data properties must also exist as validated structured
> fields." (§4)

This is satisfied twice over, at two different levels.

### Level 1 — the document itself is not a canvas blob

`revisions.doc` is not a Fabric or Konva serialisation. It is a
`DesignDocSchema`-validated structure (`src/lib/design/schema.ts`) in which every
element is a normalised record: an explicit `frame` in integer µpt, an explicit
`PrintColor`, an explicit font family and size, an explicit binding path. There
is no free-form renderer state and nothing only a browser knows how to
interpret. A document that fails `DesignDocSchema.parse()` is refused at the
server action — it never reaches the database.

### Level 2 — `design_elements`, the queryable projection

On every save, `projectElements()` deletes and re-inserts one row per element,
per side, in the same transaction as the document write. The row carries the
print- and data-critical facts, flattened:

| Column | Answers the question |
| --- | --- |
| `element_id`, `side`, `kind`, `name`, `z_index` | which element, on which face, in what paint order |
| `x`, `y`, `w`, `h` (bigint µpt), `rotation`, `opacity` | where it sits, exactly |
| `locked`, `hidden`, `required` | is it protected, is it printing, must it resolve |
| `binding_paths` (jsonb) | **which cards reference `identifiers.upc12`** |
| `font_families` (jsonb) | **which cards use Barlow Condensed** |
| `asset_id` | **which cards place this image** — indexed, so an asset cannot be deleted blind |
| `colors` (jsonb, `PrintColor` shape) | **which cards put colour ink on a grayscale back** |
| `barcode_symbology`, `barcode_value`, `barcode_magnification`, `barcode_module_width` | **which cards carry GTIN 00810797030001** — indexed on `(org_id, barcode_value)` |

`binding_paths` comes from `collectBindingPaths()`, the same function the
preflight engine uses, so the projection and the validation cannot disagree
about what a template references.

### What it buys, concretely

1. **Impact analysis without parsing 10 000 JSON blobs.** "A GTIN was
   re-issued — which approved cards carry the old one" is an indexed lookup on
   `de_barcode_idx`, not a full-table scan and a JSON walk.
2. **Referential safety for assets.** Deleting an asset can check
   `de_asset_idx` first. Without it, deletion is a guess and the failure surfaces
   as a missing image on a press-ready PDF.
3. **Migration is inspectable.** When the document schema gains a field, the
   projection tells you which revisions actually use the affected element kinds,
   so a migration can be scoped and verified instead of run blind across every
   row.
4. **Preflight questions can be asked catalogue-wide.** "Which cards use a font
   we are about to stop licensing", "which cards have a binding path that no
   longer exists in the field catalogue", "which cards place a barcode below the
   magnification floor" — all SQL, none of it JSON parsing.
5. **The blob stays authoritative.** The projection is derived and rebuilt from
   the document on every save. It is an index, never a second source of truth,
   so the two can never disagree about what the card is — only about how
   recently the index was rebuilt, and that window is one transaction wide.

---

## Export and preflight

### `export_jobs`
`kind` (`production` · `proof` · `batch`), `status`, `request` (jsonb: product
ids, options, override note), `total_items` / `completed_items` /
`failed_items`, and `manifest` (jsonb).

**The manifest is written incrementally, not at the end.** §19: "Do not allow a
failed card to silently disappear from a batch." A card that fails preflight or
fails to render becomes a manifest row carrying the reason, in the same slice
that tried it — so a job that dies halfway still accounts for everything it
attempted. Manifest rows carry SKU, GTIN/UPC, preset, template, revision,
filename, timestamp and preflight status, which is §19's required field list.

`override_by` and `override_note` record §21's privileged override of a blocking
preflight error. Both are also written to `audit_logs`.

### `export_artifacts`
One row per produced file: `job_id`, `revision_id`, `product_id`, `filename`,
`storage_key`, `byte_size`, `kind`.

`validation` (jsonb) holds the **post-export §22 report** — the checks that were
re-parsed out of the finished bytes, each with its measurement and tolerance.
`preflight` holds the report the artwork passed. `status` is `ok` or `invalid`,
where `invalid` means **the file failed its own post-export check** and is
recorded as produced-and-rejected rather than quietly discarded.

### `preflight_results`
`revision_id`, `product_id`, `profile_name`, `report` (jsonb), `exportable`.
Kept as a history rather than a single current row, indexed on
`(revision_id, created_at)`, so "was this clean when it was approved" is
answerable later. `profile_name` records which thresholds were in force, because
a report is meaningless without the profile that produced it.

---

## GS1

### `gs1_connections`
One row per organisation (`org_id` unique). `provider`
(`gs1us-verified` · `gs1us-datahub` · `custom` · `disabled`), `base_url`,
`company_prefix`, `enabled`.

The credential is **three columns, not one blob**:
`credential_ciphertext`, `credential_iv`, `credential_tag` — AES-256-GCM,
plus `key_version`. Split so a key rotation can be audited column by column and
a malformed row is obvious rather than a decryption failure at request time.
`rotated_at` records the last rotation. `last_test_at` / `last_test_ok` /
`last_test_detail` back §13B's connection test.

Nothing here ever reaches a client component. See `docs/gs1-integration.md`.

### `gs1_sync_records`
`product_id`, `gtin`, `operation` (`verify` · `enrich` · `publish`), `status`,
`remote_payload` (**secrets already redacted before storage**), `diff` (jsonb),
`accepted_fields` (jsonb), `accepted_by`, `accepted_at`, `last_synced_at`.

The `diff` / `accepted_fields` pair is the shape of §13A's rule: "Never
overwrite local data automatically. Show a diff and require explicit
acceptance." A diff sits in this table doing nothing until a human names the
fields they accept. There is no auto-apply path and no acceptance threshold.

### `gs1_request_logs`
`method`, `path`, `status_code`, `duration_ms`, `request_summary`,
`response_summary`, `error`. §13B requires request logging with secrets
redacted; `redact()` in `src/server/crypto.ts` runs before anything is written,
and the credential is additionally registered as a literal secret so a remote
API echoing an `Authorization` header back inside an error body still cannot
leak it.

---

## Import

### `imports`
`filename`, `byte_size`, `sha256`, `storage_key`, and a `status` that walks
`inspecting` → `mapping` → `previewed` → `committed`, with `cancelled` and
`failed` as terminal states (§5.9 requires cancellation before commit).

Four jsonb columns carry the four stages: `inspection` (detected sheets,
headers, row counts, inferred kinds), `mapping` (the user-confirmed column →
field map), `preview` (the diff plus duplicate and validation findings computed
before commit), and `report` (§5.10's post-commit report).
`rows_total` / `rows_created` / `rows_updated` / `rows_skipped` are columns
because they are what the imports list shows.

The current row for the supplied workbook reads: 393 total, 392 created, 0
updated, 1 skipped.

Provenance flows outward from here: `products.source_import_id` points back, and
`products.source_row` holds that product's entire spreadsheet row verbatim. §5.12
"support safe re-import/update" is what those two make possible — a re-import
matches on GTIN first, then on brand + part number, and can tell an unchanged
row from a real edit.

---

## Coverage of the §4 model list

| §4 names | Where it lives |
| --- | --- |
| Organization, User, Role | `organizations`, `users`, `users.role` + `rbac.ts` |
| Brand | `brands` |
| Product | `products` |
| ProductIdentifier, GTIN, UPC, SKU / Part Number | `product_identifiers` (`kind` discriminates) + `products.part_number` |
| AlternatePartNumber | `alternate_part_numbers` |
| ProductDescription | `products.description` / `description_short` / `label_description` |
| ProductTranslation | `product_translations` |
| Fitment | `fitments` |
| CountryOfOrigin | `products.country_of_origin` |
| Warning | `warnings` |
| BOM, BOMItem | `boms`, `bom_items` |
| PackageType | `package_types` |
| CardPreset | `card_presets` |
| CardTemplate | `card_templates` |
| CardDesign | `card_designs` |
| CardSide | `DesignDoc.front` / `.back`; `design_elements.side` |
| DesignElement | `design_elements` + the document's element records |
| Asset | `assets` |
| BarcodeElement, TextElement, ShapeElement, ImageElement, DataFieldElement | `ELEMENT_KINDS` in `src/lib/design/schema.ts`: `barcode`, `text`, `shape`, `image`, `bomList`, `group`. **A "DataFieldElement" is not a separate kind** — any text run or barcode may carry a `Binding`, which is more useful than a distinct element type because a paragraph can mix literal and bound copy. |
| Revision | `revisions` |
| Approval | `approvals` |
| ExportJob | `export_jobs` (+ `export_artifacts` for the files) |
| PreflightResult | `preflight_results` |
| GS1SyncRecord | `gs1_sync_records` (+ `gs1_connections`, `gs1_request_logs`) |

---

## Isolation rules

1. **`org_id` on every tenant-scoped table**, and on every child table too —
   `bom_items` carries it even though it could be reached through `boms`, so a
   query can never accidentally omit the filter by taking a shortcut through a
   join.
2. **Every query filters on `org_id`.** Not RLS, not a default scope: an
   explicit `eq(table.orgId, user.orgId)` in the query. It is visible in review.
3. **`assertSameOrg()` on every fetch by id.** Ids are unguessable, but
   unguessable is not a permission model. The check is a function call with a
   name a reviewer can grep for.
4. **`requireUser()` / `requireCapability()` at the top of every page, server
   action and route handler.** The proxy's cookie check is a redirect for
   signed-out visitors, not a boundary — it does not verify the signature.
5. **Assets are streamed, never linked.** `assets.storage_url` does not reach a
   browser; `/api/assets/[id]` checks the organisation and then streams.
6. **`server-only` on every module that touches the database, the credential
   cipher or a GS1 adapter,** so importing one from a client component is a build
   error rather than a code-review finding.
7. **Credentials are encrypted with AAD bound to the owning row,** so a
   ciphertext copied from one tenant's row into another's fails the GCM tag check
   instead of decrypting. Asserted in `tests/unit/gs1.test.ts` ("binds a
   ciphertext to its AAD, so a row copied between tenants will not open").
