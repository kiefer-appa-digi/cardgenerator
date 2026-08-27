# Final gauntlet report

Spec §29 LOOP 9 and §30. Every numbered requirement in
`docs/source/MASTER_GAUNTLET_PRODUCT_CARD_DESIGNER.md` §2 through §27, plus the
§30 Definition of Done, marked **PASS · PARTIAL · FAIL · N/A** with evidence.

**The rule this document is written under: no unsupported PASS statements.** If
a requirement cannot be pointed at a file path, a test name or a measured
number, it is PARTIAL or FAIL. Several are.

## Verification performed for this report

```
$ npx tsc --noEmit
(no output — clean)

$ npx vitest run
 Test Files  10 passed (10)
      Tests  465 passed | 1 skipped (466)
   Duration  1.37 s
```

The one skipped test is `describe.runIf(process.env.PDF_ARTIFACT_DIR)`, the
opt-in hook that writes real PDFs to disk. It is not a disabled test.

Also read for this report: the full `src/` tree, the database
(392 products, 3 presets, 3 master templates, 1 committed import, 3 export
artifacts, 10 revisions, 0 GS1 connections), the three CAD PDFs, and the
supplied workbook.

## Scoreboard

| Section | Verdict |
| --- | --- |
| §2 Card presets | **PASS** |
| §3 Technology baseline | **PASS** |
| §4 Core product model | **PASS** |
| §5 Spreadsheet / BOM ingestion | **PARTIAL** |
| §6 WYSIWYG editor | **PARTIAL** |
| §7 Front and back | **PASS** |
| §8 Background upload | **FAIL** |
| §9 Text system | **PASS** |
| §10 Variable data / binding | **PASS** |
| §11 BOM "This Pack Includes" | **PASS** |
| §12 Barcode system | **PASS** |
| §13 GS1 integration | **PARTIAL** |
| §14 Colour management | **PASS** |
| §15 PDF export | **PARTIAL** |
| §16 Bleed / trim / safe area | **PASS** |
| §17 Cavity / clamshell overlay | **PASS** |
| §18 Template system | **PASS** |
| §19 Batch generation | **PARTIAL** |
| §20 Revision / approval | **PARTIAL** |
| §21 Preflight engine | **PASS** |
| §22 Export validation | **PARTIAL** |
| §23 Sample reproduction milestone | **PARTIAL** |
| §24 UX requirements | **PARTIAL** |
| §25 Security | **PARTIAL** |
| §26 Performance | **PARTIAL** |
| §27 Accessibility | **PARTIAL** |
| §30 Definition of Done | **NOT MET** — see the end |

### The findings that matter

| Severity | Finding |
| --- | --- |
| **Blocker** | **§8 — an image element cannot be given an asset from the editor.** `src/components/editor/inspector.tsx:527` renders fit, background and focal controls for an image element but **no asset picker**. Nothing in `src/components/editor/` writes `assetId`. Uploads work (`/settings/assets`), the plan, preflight and PDF writer all handle placed images correctly — but a designer cannot place one. §8's core requirement ("Users must be able to upload a background to either card side") is not met in the editor. |
| **Critical** | **§23 — the benchmark has never been compared with the sample.** `11-500 front.pdf` and `11-500 back.pdf` were **not supplied**. The master templates reproduce the content model described in the brief; nobody has checked them against the real package. |
| **Critical** | **No automated test covers `src/server/*`.** Revision immutability, organisation isolation, the RBAC matrix, the blocking-export gate and the override, the import commit transaction and the batch resume are the highest-consequence paths in the system and are verified only by reading the code. |
| **Major** | **§5 — the multi-sheet BOM workbook was never supplied.** The adapter architecture and the BOM import path are proven against synthetic fixtures only. |
| **Major** | **§13B — the publish path is not wired.** `publishProduct()` is implemented and tested at the adapter layer; no server action calls it and no screen offers it. |
| **Major** | **§24 — no copy/paste, no group/ungroup, no context menu.** All three are named requirements. `group` exists as an element kind but nothing creates one. |
| **Major** | **§24 — editor preferences are not persisted.** `users.preferences` exists and is read into `CurrentUser`; nothing writes it and the editor never reads it. |
| **Major** | **§15 / §22 — output is not certified PDF/X, and is not claimed to be.** This is compliant behaviour under §15's fallback clause, not a defect — but it is the largest single gap between what exists and press-ready certification. |

---

# §2 — Authoritative starting card presets

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| 409TF 4.3675 × 7.11175 in, R0.25 in | **PASS** | `src/lib/geometry/presets.ts`; `tests/unit/geometry.test.ts` "produces the exact full-bleed canvas the spec requires" — **exact integer equality**, no tolerance |
| 277TF 4.343 × 5.7875 in, R0.25 in | **PASS** | same |
| 206TF 3.1175 × 6.4775 in, R0.25 in | **PASS** | same |
| Bleed 0.125 in every side | **PASS** | `tests/unit/geometry.test.ts` "uses 0.125 in bleed on all four sides of every preset" |
| Full-bleed canvases match the table | **PASS** | 332.46 × 530.046 · 330.696 × 434.7 · 242.46 × 484.38 pt, measured out of the exported PDFs by `tests/unit/pdf-validate.test.ts` |
| CAD values preserved separately | **PASS** | `cadReference` on every preset carries the drawing number, revision, date, material, thickness, colour and all seven verbatim callouts |
| Discrepancies surfaced, not reconciled | **PASS** | `presetDiscrepancies()` returns **7 discrepancies**; `tests/unit/geometry.test.ts` "surfaces CAD disagreements instead of reconciling them" pins 409TF at **+0.0245 in** over MAX CARD WIDTH and 206TF at **+0.0405 in** over MAX CARD LENGTH, and asserts that 206TF produces **no** spurious dieline row. Rendered at `/presets/[code]` via `src/components/preset/discrepancy-table.tsx`. Full list in `docs/source-audit.md` §8 |
| Deterministic physical unit, not pixels | **PASS** | integer µpt; `src/lib/units.ts`; `tests/unit/units.test.ts` "maps every supplied preset dimension to an exact integer" |
| 1 in = 72 pt | **PASS** | `UPT_PER_IN = 72_000_000`; "converts to PDF points exactly for the full-bleed canvases" |
| High precision, no float drift | **PASS** | "does not drift over repeated addition" |

**§2 — PASS.**

---

# §3 — Technology baseline

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| Latest stable Next.js | **PASS** | 16.3.3, App Router |
| React | **PASS** | 19.2.8 |
| TypeScript strict | **PASS** | `tsconfig.json`; `npx tsc --noEmit` **clean** |
| Tailwind CSS | **PASS** | v4, tokens in `src/app/globals.css` |
| Node.js 24 | **PASS** | runs on Node 24+ |
| PostgreSQL | **PASS** | 28 tables, seeded |
| Prisma or Drizzle | **PASS** | Drizzle 0.45.2 + drizzle-kit |
| Zod | **PASS** | 4.4.3, the boundary type for every document |
| Object storage | **PASS** | Vercel Blob, private; local fallback |
| Canvas/editor architecture, or a justified alternative | **PASS** | custom SVG artboard over the shared plan; justification recorded in `docs/architecture.md` |
| Server-side PDF generation | **PASS** | `src/lib/pdf/production.ts`, pdf-lib |
| Background job processing for batch | **PARTIAL** | `src/server/batch.ts` is a **slice-advancing job** driven by the client through `advanceBatchAction`, with state in `export_jobs` and resume-where-it-stopped semantics. It is not a queue with workers; nothing runs without a browser tab open. Reasoned in `docs/architecture.md` |
| Playwright for E2E | **PASS** | `playwright.config.ts`, 3 tests |
| Vitest | **PASS** | 465 passing |
| **Every major dependency has a recorded reason** | **PASS** | `docs/architecture.md` — Drizzle, the custom artboard, pdf-lib, µpt, the shared layout engine, exceljs and Vercel Blob at length; a table for the rest; plus a table of dependencies deliberately *not* added |

**§3 — PASS.** (Background jobs is the one soft spot, and the spec's wording is
"background job processing", which a slice-advancing job with persisted state
satisfies in substance.)

---

# §4 — Core product model

Every entity in §4's list is mapped in `docs/data-model.md` §"Coverage of the §4
model list". All 28 tables in `src/server/db/schema.ts`.

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| All named entities modelled | **PASS** | the coverage table. One deliberate divergence: **DataFieldElement is not a separate element kind** — any text run or barcode may carry a `Binding`, which is more useful because a paragraph can mix literal and bound copy. Stated, not hidden |
| One product, many packaging configurations and revisions | **PASS** | `card_designs.product_id` is many-to-one; `revisions` is many-to-one on design |
| **Never just an opaque canvas JSON blob** | **PASS** | `revisions.doc` is a `DesignDocSchema`-validated structure with explicit µpt frames, `PrintColor`s and binding paths — not a Fabric/Konva serialisation. A document that fails `parse()` never reaches the database |
| Normalised metadata to query, validate, migrate, regenerate | **PASS** | `design_elements`, re-projected by `projectElements()` in `src/server/designs.ts:130` on every save, in the same transaction. **24 rows** currently in the database. Indexed on `(org_id, barcode_value)` and on `asset_id`. Rationale and what it buys: `docs/data-model.md` |

**§4 — PASS.**

---

# §5 — Spreadsheet / BOM ingestion

| # | Requirement | Verdict | Evidence |
| ---: | --- | --- | --- |
| 1 | upload `.xlsx` | **PASS** | `uploadImportAction()`, 25 MB ceiling, sha256 recorded, magic-byte/extension check |
| 2 | inspect sheets | **PASS** | `inspectWorkbook()`; header-row detection that is not "row 1"; per-column type, fill rate, distinct count, samples. `tests/unit/import.test.ts` "inspects one sheet with 41 columns and 393 data rows" |
| 3 | mapping UI | **PASS** | `src/components/import/wizard.tsx`, `/imports/[id]` |
| 4 | auto-suggest mappings | **PASS** | `suggestMapping()` + `detectProfile()`; the GS1 profile ranks first at score 90 with all ten signature headers matched. "maps the export through the GS1 adapter, not by guesswork" |
| 5 | preview changes | **PASS** | `buildPreview()`. "previews 393 rows with the known GTIN, brand and status distribution" |
| 6 | detect duplicate part numbers / GTINs | **PASS** | "treats a repeated GTIN as an error and a repeated part number as a scoped warning"; "separates a cross-brand part number from a repeat inside one brand". Measured: **0 duplicate GTINs**, **39 repeated SKUs** covering 80 rows |
| 7 | detect invalid or missing UPC/GTIN | **PASS** | check digits computed locally. Measured: **390/390 GTIN-14 and 386/386 UPC-12 valid**; 3 rows with neither |
| 8 | identify BOM parent/component relationships | **PARTIAL** | The code path exists and works — `guessKind()` classifies a BOM sheet, `planImport()` links lines to their parent, tests "recognises the sheet as a BOM and links lines to their parent" and "plans one BOM per parent with its items after it". **But the supplied workbook contains no BOM data at all**, so this is proven only against synthetic fixtures |
| 9 | allow cancellation before commit | **PASS** | `cancelImportAction()`; nothing is written before the commit step |
| 10 | create an import report | **PASS** | `imports.report`; the real row reads **393 total → 392 created, 0 updated, 1 skipped** |
| 11 | retain source provenance | **PASS** | `products.source_row` holds the whole row verbatim; `source_import_id` points back. "retains the whole source row for provenance" |
| 12 | support safe re-import/update | **PASS** | "re-imports the same file as unchanged, and sees a real edit as an update"; "plans an unchanged row as an update, because it already has a record" |
| — | not every row is a sellable product | **PASS** | `record_type`; "classifies bare internal codes as not sellable instead of dropping them". **2 non-sellable products** in the database |
| — | adapters, not hard-coding to one workbook | **PASS** | two shipped profiles + seven sheet kinds; `src/lib/import/mapping.ts` |

**§5 — PARTIAL.** Everything is built and the real file imports correctly; the
BOM half of the requirement cannot be demonstrated because
`Aftermarket Rev B 2026.8.10.xlsx` was never supplied
(`docs/source-audit.md` §1).

---

# §6 — WYSIWYG editor

## Workspace

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| left asset/data panel | **PARTIAL** | `src/components/editor/data-panel.tsx` — a searchable **data**-field browser over the 26-entry `FIELD_CATALOG`, with a Layers tab beside it. There is **no asset panel** |
| centre artboard | **PASS** | `src/components/editor/artboard.tsx` |
| right properties inspector | **PASS** | `src/components/editor/inspector.tsx` |
| top toolbar | **PASS** | `src/components/editor/toolbar.tsx` |
| zoom controls | **PASS** | zoom in/out, zoom-to-fit (⇧1), 100 % (⌘1) |
| front/back switcher | **PASS** | toolbar, `role="group" aria-label="Side"` |
| rulers | **PASS** | `Rulers` in `artboard.tsx:796`, tick density chosen from zoom, in the active unit |
| guides | **PASS** | `doc[side].guides`, `GuideSchema`, drawn at `artboard.tsx:515` |
| layer panel | **PASS** | `src/components/editor/layers.tsx` |
| status/preflight indicator | **PASS** | `src/components/editor/preflight-strip.tsx`, debounced 1500 ms |
| undo/redo | **PASS** | bounded whole-document history; ⌘Z / ⇧⌘Z |
| autosave state | **PASS** | debounced 1200 ms; `dirty` / `saving` / `lastSavedAt`; `beforeunload` guard |
| export action | **PASS** | toolbar → `/designs/[id]/export` |

## Artboard must distinguish

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| bleed boundary · trim boundary · safe area · rounded trim corners · cavity location · centre lines · custom guides | **PASS** | `Overlays` in `src/lib/editor/store.ts:34`: `bleed`, `trim`, `safe`, `cavity`, `centerLines`, `guides`, `rulers`, `grid`, `outlines`. Trim corners from the same `roundedRectPath()` the PDF clips with |
| hardware/clamshell obstruction zones | **PARTIAL** | the cavity overlay is the obstruction zone; there is no separate hardware-obstruction geometry, and none was supplied |
| toggleable and non-printing | **PASS** | toolbar toggles; structurally non-printing — `src/lib/pdf/draw.ts` has no operation that can express an overlay, `production.ts` has no import path to `proof.ts`, and `tests/unit/pdf.test.ts` "no overlay text or overlay marks reach the production PDF" decodes all text out of the file and checks for eight overlay words |

## Drag and drop

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| select · move · resize · rotate · multi-select | **PASS** | `src/lib/editor/interaction.ts`, `tests/unit/interaction.test.ts` |
| align · distribute | **PASS** | 6 align modes + 2 distribute in the toolbar; "aligns left edges to the selection bounds", "distributes three boxes to equal gaps" |
| snap | **PASS** | tolerance 216 000 µpt = **0.003 in**; "pulls an element onto the safe-area edge from within tolerance", "leaves an element alone when nothing is within tolerance", "centres on the trim centre line" |
| keyboard nudging | **PASS** | arrows, shift for a coarse step, coalesced into one history entry |
| shift-constrained transforms | **PASS** | "keeps the aspect ratio exactly when constrained" |
| duplicate | **PASS** | ⌘D, offset 0.01 in |
| **group / ungroup** | **FAIL** | `group` is a valid `ElementKind` in the schema and the plan resolves it, but **no UI action creates or dissolves one**. No keybinding, no toolbar control, no layer-panel action |
| lock · hide | **PASS** | toolbar lock, per-layer eye/lock in `layers.tsx` |
| reorder layers | **PASS** | layer panel; ⌘] / ⌘[ |
| **copy / paste** | **FAIL** | no ⌘C / ⌘V handler in `src/components/editor/editor-shell.tsx`, no clipboard code anywhere in `src/` |
| undo/redo | **PASS** | as above |
| contextual alignment indicators | **PASS** | snap guides render during drag |

## Measurement

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| inches, optionally millimetres | **PASS** | unit selector, `LengthUnit = "in" \| "mm" \| "pt"` |
| inspector exposes X, Y, W, H, rotation, corner radius, opacity, stroke, fill | **PASS** | `inspector.tsx` — Geometry and Appearance sections |
| every operation resolves to exact physical coordinates | **PASS** | integer µpt end to end; the UI renders µpt × zoom |

**§6 — PARTIAL.** Group/ungroup and copy/paste are named requirements and are
absent. Everything else is present and tested.

---

# §7 — Front and back

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| Two linked sides | **PASS** | `SIDE_KEYS = ["front","back"]`; both planned by `planDocument()`; both exported as pages 1 and 2 |
| Front: full colour, brand, product identification, marketing hierarchy, part number, product name, alternates, fitment, background art, product imagery | **PASS** | placed by `buildMasterTemplate()` in `src/lib/templates/factory.ts`; `MASTER_TEMPLATE_DESCRIPTION` enumerates them |
| Back: B&W, identity, "This Pack Includes", alternates, fitment, genuine-parts statement, country of origin, barcode, warnings | **PASS** | same builder; 3 master templates in the database |
| Editor allows intentional colour on the back when a template authorises it | **PASS** | "Allow authorised colour" toggle in the inspector; `tests/unit/preflight.test.ts` "flags colour ink on a grayscale back **and softens it when the template allows colour**" |
| Standard back flags non-grayscale content | **PASS** | `GRAYSCALE_BACK_VIOLATION` in `src/lib/preflight/checks/color.ts` |
| Independent layers per side, shared product data | **PASS** | `doc.front.elements` / `doc.back.elements` are independent; one `ProductContext` resolves both |

**§7 — PASS.**

---

# §8 — Background upload

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| **Users must be able to upload a background to either card side** | **FAIL** | Upload works, but **only in `/settings/assets`**. `src/components/editor/inspector.tsx:527` gives an image element Fit, "Use as background" and focal controls — and **no asset picker**. No file in `src/components/editor/` writes `assetId` (grep: only `artboard-render.tsx` *reads* it). A designer can create an image element and can never fill it |
| PNG · JPEG · TIFF · SVG · PDF | **PARTIAL** | `sniff()` in `src/server/assets.ts` recognises PNG, JPEG, TIFF, WebP, SVG and PDF from magic bytes. The PDF **writer** accepts PNG and JPEG only and raises `ASSET_UNSUPPORTED` for the rest — "rejects an asset format it cannot place as vector-safe artwork". Honest, but TIFF/SVG/PDF artwork cannot reach a production PDF |
| retain original file | **PASS** | stored in Blob; `sha256`, `byte_size`, `filename` recorded |
| extract pixel dimensions | **PASS** | sharp, at upload; `pixel_width` / `pixel_height` |
| extract embedded ICC when available | **PASS** | `has_icc_profile`, `icc_profile_name` |
| calculate effective DPI at placed size | **PASS** | `src/lib/preflight/checks/assets.ts`; "grades resolution against the profile" |
| warn below configurable thresholds | **PASS** | `ASSET_LOW_DPI`, `BLEED_LOW_DPI`; "warns rather than errors between the minimum and the floor" |
| **never silently upscale and call it print-ready** | **PASS** | "never calls an upscale print-ready" |
| Background controls: fill, fit, crop, position, scale, rotation, opacity, lock, replace | **PARTIAL** | fill/fit/stretch/crop, focal X/Y, rotation, opacity and lock all exist in the inspector. **Replace does not** — there is no picker to replace *with* |
| Backgrounds extend through bleed when full-bleed | **PASS** | `isBackground` flag; `BLEED_COVERAGE` check — "flags a background that stops at the trim line", "does not flag a background that covers the whole bleed box" |

**§8 — FAIL.** Every supporting capability is built and tested. The one control
that makes the feature usable is missing. **This is the report's blocker.**

---

# §9 — Text system

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| family, weight, size, tracking, line height, alignment, uppercase, box dimensions, vertical alignment, paragraph styles | **PASS** | `TextElementSchema` in `src/lib/design/schema.ts`; inspector Type section (Family, Case, Align, tracking, leading, vertical alignment) |
| rich text only if deterministically exportable | **PASS** | modelled as `TextRun[]` per paragraph with explicit per-run overrides — no HTML, no contenteditable serialisation |
| fonts legally available and embeddable | **PASS** | three families, **all SIL OFL-1.1**, shipped in `src/assets/fonts/` with `OFL.txt`. Only shipped fonts are selectable |
| **never rely on browser-only font rendering** | **PASS** | `src/lib/text/layout.ts` measures from metrics generated from the same TTF bytes pdf-lib embeds. `tests/unit/pdf.test.ts` "does not apply OpenType shaping, so PDF advances match the layout engine" — verified for every ordered character pair in the metrics charset across all thirteen faces; and "sets a tracked span at exactly the x and baseline the plan computed" |
| preflight errors for missing fonts | **PASS** | `FONT_MISSING` in both preflight and the exporter's notes; "reports a missing font family" |

**§9 — PASS.**

---

# §10 — Variable data / data binding

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| bind elements to product data | **PASS** | `BindingSchema`; `resolveBinding()` |
| the named example fields | **PASS** | `FIELD_CATALOG` in `src/lib/data/context.ts` covers partNumber, productName, description, identifiers (upc12/gtin14/…), alternates, countryOfOrigin, fitments, `bom.*`, `brand.*` |
| data-field browser | **PASS** | `src/components/editor/data-panel.tsx`, searchable, grouped |
| insert variable | **PASS** | click-to-insert into the selected text block |
| fallback value | **PASS** | `Binding.fallback`; "returns the fallback for a missing path and still reports it" |
| prefix / suffix | **PASS** | "applies prefix, suffix and transform to the value only" |
| transformations, upper/lower case | **PASS** | `TextTransform` — none/uppercase/lowercase/titlecase; "applies the four case transforms" |
| formatting | **PASS** | number and date hints; "formats numbers to a known answer", "formats dates in UTC to a known answer" |
| conditional visibility | **PASS** | `visibleWhen` rules; "shows an element only when the field has something in it", "compares against a literal", "reports a rule that points at a field nobody has" |
| repeat/list blocks for BOM | **PASS** | `bomList` element kind — §11 |
| preview resolves the actual selected product | **PASS** | `buildProductContext()` → `planSide()` → artboard |
| template reusable across hundreds of SKUs | **PASS** | 3 master templates against 392 products; batch generation drives exactly this |

**§10 — PASS.**

---

# §11 — BOM-driven "This Pack Includes"

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| first-class repeating component | **PASS** | `bomList` in `ELEMENT_KINDS`; `renderBomBlock()` in `src/lib/data/bom.ts` |
| quantity, component name, component number, optional description | **PASS** | `BomItemContext` carries all four plus `unitOfMeasure` and `position` |
| the spec's `2) Inner Bearing (L44643)` format | **PASS** | `tests/unit/binding.test.ts` **"reproduces the spec's reference line exactly"** — it is a fixture, not an illustration |
| user-configurable formatting | **PASS** | row template with tokens; "supports a reconfigured template, including the parent product" |
| auto-size intelligently | **PASS** | column splitting (`splitIntoColumns`, "reads down then across with the remainder on the left") and bounded font reduction |
| warn on overflow | **PASS** | `BOM_OVERFLOW`; "blocks when a pack-contents list cannot fit its frame" |
| controlled font-size reduction within configured bounds only | **PASS** | `minFontSize` on the element; the plan will not go below it |
| **never silently clip production copy** | **PASS** | "blocks when a pack-contents list drops rows" — **blocking** severity; "truncates at maxItems and reports what is missing" |

**§11 — PASS.**

---

# §12 — Barcode system

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| UPC-A | **PASS** | `src/lib/barcode/upc.ts`; known-answer `036000291452` encoded module for module **and decoded back through an independent element-width table** |
| EAN-13 | **PASS** | full encodation and parity; "only the three guard patterns descend" |
| GS1-128 | **PASS** | `src/lib/barcode/code128.ts`; 107-character pattern table checked against its published invariants; modulo-103 check character; FNC1, subset switching, AI parsing |
| QR / GS1 Digital Link | **PASS** | `src/lib/barcode/qr.ts`; canonical Digital Link URI, drawn as vector modules |
| generate from structured data | **PASS** | bound through `BarcodeElement.binding` |
| validate check digits | **PASS** | known answers for the workbook's own prefix (`81079703012`, `81079703000`, `81079703001`) and the textbook cases |
| preserve required quiet zones | **PASS** | UPC-A 9X/9X, EAN-13 11X/7X, Code 128 10X, QR 4 modules — part of the symbol box, so a fitting frame fits the light margins |
| **render bars as vectors in PDF** | **PASS** | "draws bar modules as filled rectangles, one per module"; `pdf-validate` counts bar-shaped filled rects independently |
| do not rasterise | **PASS** | there is no raster path; a QR is vector modules too |
| human-readable digits | **PASS** | `HumanReadableRun`s with UPC-A's number-system and check digits placed outside the guard bars; "omits human-readable runs when they are switched off" |
| configurable magnification within standards | **PASS** | 80 – 200 % (`MIN_/MAX_MAGNIFICATION_BPS`); out of range is **clamped and reported** |
| **prevent arbitrary horizontal distortion** | **PASS** | "scales X strictly and never distorts width independently" — structural: there is no width parameter to abuse |
| warn when physical size is outside specification | **PASS** | `BARCODE_SIZE`, `BARCODE_MAGNIFICATION`; "flags a symbol larger than its own frame", "flags truncated bar height" |
| preflight contrast | **PASS** | `BARCODE_CONTRAST` — and it says plainly that the number is an **ink proxy**, not a measured optical density |
| barcode colour is print-safe | **PASS** | bar colour is a `PrintColor`; the contrast check measures it against the quiet-zone fill |
| **verification test suite with known inputs** | **PASS** | `tests/unit/barcode.test.ts`, **77 tests**, including a `describe("regressions found by adversarial review")` block of 10 |

**§12 — PASS.** Measured: a UPC-A at 100 % is **1.469 in** wide including quiet
zones, the GS1 nominal, asserted by name.

---

# §13 — GS1 integration

Full detail in `docs/gs1-integration.md`.

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| adapter/service layer, not hard-coded UI calls | **PASS** | `Gs1Adapter` interface; every caller depends on it, never on a provider |
| **A. verify / enrich an existing identifier** | **PASS** | `verifyGtin()`, `fetchProduct()`, `verifyProductGtinAction()`, `/settings/gs1/verify` |
| the listed potential fields | **PASS** | `Gs1ProductRecord` carries GTIN, SKU, brand, description, dimensions, weights, target market, status, classification, image URL, company |
| **never overwrite automatically; diff + explicit acceptance** | **PASS** | `diffRemoteAgainstLocal` / `applyAcceptedFields`; "accepts nothing when given an empty acceptance list — there is no auto-apply"; "rejects a path that is not in the diff, and one the diff says is not acceptable" |
| **B. brand-owner create/manage connector** | **PARTIAL** | `publishProduct()` is implemented in `providers/gs1us.ts:923`, capability-gated, and tested ("publishes through Data Hub and reads the receipt", "refuses to publish through a read-only provider", "honours an explicit rejection in a 2xx publish body"). **No server action calls it and no screen offers it** — `src/server/gs1-actions.ts` exports connection management, verify and accept, not publish |
| credentials server-side only | **PASS** | `server-only` on the factory; `node:crypto` in the cipher; `src/lib/gs1/types.ts` is the only client-importable module |
| encrypted credential storage | **PASS** | AES-256-GCM, three hex columns, **AAD bound to the org** — "binds a ciphertext to its AAD, so a row copied between tenants will not open" |
| API key rotation | **PASS** | `rotateCredential()`, `key_version`, `rotated_at`. **A bulk `CREDENTIAL_KEY` re-encryption script is not shipped** — the primitive is, the command is not |
| connection test | **PASS** | `testConnection()`, `testGs1ConnectionAction()`, `/settings/gs1` |
| request logging with secrets redacted | **PASS** | `gs1_request_logs`; `redact()` covers key names, free text, URLs, cycles, `__proto__`, and **registered literal secrets** |
| retry / backoff | **PASS** | equal jitter, 3 attempts, 400 ms → 8 s; 5xx retried, 4xx not |
| rate-limit handling | **PASS** | `Retry-After` honoured (both RFC 7231 forms) and **capped** so a hostile header cannot stall a batch |
| sync status · last-synced timestamp · manual refresh | **PASS** | `gs1_sync_records.status` / `last_synced_at`; `verifyProductGtinAction` is the manual refresh; `recentGs1SyncsAction` shows history |
| conflict handling | **PASS** | `conflict` is an explicit diff status meaning "accepting would overwrite" |
| do not scrape GS1 pages | **PASS** | REST only; no HTML parsing anywhere |
| **works even if GS1 is not configured** | **PASS** | `createDisabledAdapter()` is the default and the fallback for every misconfiguration; `getAdapter()` has no null branch and no throw. The whole seeded system — 392 products, 3 exports — was built with **0 rows** in `gs1_connections` |
| architect future GS1 Digital Link | **PASS** | URI build/parse complete and tested; **resolution is an optional interface method** guarded by a capability flag, deliberately unfilled — "has no optional digital-link resolution method (the extension point is unfilled by design)" |

**§13 — PARTIAL,** on the unwired publish workflow alone.

---

# §14 — Colour management

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| do not claim the browser preview is CMYK | **PASS** | `cmykToPreviewRgb()` is documented as a preview approximation; the UI never labels it a proof |
| 1. store print colours as CMYK | **PASS** | `PrintColor` union; tints in **tenths of a percent**, integers |
| 2. convert to RGB for display | **PASS** | one-way, in the render path only |
| 3. retain CMYK as source of truth | **PASS** | no RGB value is stored as print data anywhere |
| 4. generate PDF with CMYK-capable primitives | **PASS** | `src/lib/pdf/color.ts` never calls `rgb()`; "writes DeviceCMYK operators and **no RGB operator**" |
| 5. preserve or correctly convert placed artwork | **PARTIAL** | placed rasters are embedded **as-is with no ICC transform** and raise `ASSET_RGB_IN_CMYK`. pdf-lib cannot convert. Documented, warned, not hidden |
| 6. explicit print-output profile/configuration | **PASS** | `OutputIntentSchema` per organisation; `/settings/output-intent`; a real ICC profile is validated (`acsp` signature, declared size, colour space) before embedding, and **a fake one throws rather than being embedded** |
| 7. preflight the exported PDF | **PASS** | `validateProductionPdf()` on every export; report stored on the artifact |
| CMYK · grayscale · spot-ready · RGB input conversion warning | **PASS** | all four spaces in the union; `rgbToCmykEstimate()` requires a warning at every call site |
| C/M/Y/K 0–100 | **PASS** | 0–1000 in tenths, so 100.0 % is exact |
| named brand swatches | **PASS** | `BRAND_SWATCHES` — and Freedom Blue/Red are flagged **`derivedFromRgb: true`** with their source hex, because a converted brand colour is an estimate, not an ink specification |
| text black 0/0/0/100 | **PASS** | `TEXT_BLACK` |
| rich black configurable | **PASS** | `richBlack`, default 60/40/40/100, per organisation |
| total area coverage limit | **PASS** | `totalAreaCoverageLimit`, default 3000 (300 %); "flags a recipe over the ink limit" and honours the org's tighter value |
| flag rich black on small text | **PASS** | `richBlackMinTextSize`, default 14 pt; "flags small type set in rich black" |
| **do not invent a print profile** | **PASS** | no profile ships; without one the export writes **no** OutputIntent and warns `OUTPUT_INTENT_MISSING` |

**§14 — PASS.** The one PARTIAL row is a stated pdf-lib limitation with a
warning attached, which is what §14 asks for.

---

# §15 — PDF export

## A. Production PDF

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| exact physical dimensions | **PASS** | verified to **±0.001 pt** against the §22 table |
| bleed included | **PASS** | the page **is** the full-bleed canvas |
| front and back | **PASS** | "page count is exactly two — front then back" |
| CMYK-aware | **PASS** | DeviceCMYK only |
| vector text where practical | **PASS** | always — `complianceStatus.vectorText` is the literal `true`; the page is never rasterised |
| embedded/subset fonts | **PASS** | Type0/CIDFontType2, `/FontFile2`, six-letter subset tags; **every glyph re-extracted and compared with the source outline** |
| vector barcodes | **PASS** | one filled rect per module |
| high-resolution placed artwork | **PASS** | embedded at original sample data; the RIP scales; cropping is clipping, not resampling |
| **no editor overlays** | **PASS** | structural, plus the eight-word text check |
| deterministic | **PASS** | "two runs of the same input produce byte-identical production PDFs" |

## B. Proof PDF

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| card name, SKU, revision, trim, bleed, safe zone, cavity overlay, dimensions, timestamp, approval status | **PASS** | `src/lib/pdf/proof.ts`; `ProofInfo`. Overlay in an Optional Content Group whose `/Usage` sets `/PrintState /OFF`; the sheet is larger than the card so the slug sits outside the bleed box. "the proof carries the overlay, on a sheet larger than the card", "the proof slug sits below the artwork, never on it" |

## C. Imposed / print-sheet PDF

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| architect for later, do not let it delay the core | **N/A** | not implemented, which is what the spec permits. `addCardPage()` already takes an arbitrary page size and an origin offset for the card, and the proof writer uses exactly that to inset a card on a larger sheet — so the imposition primitive exists |

## PDF/X

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| research the stack | **PASS** | `docs/print-pipeline.md` — a capability-by-capability table for pdf-lib |
| PDF/X-4 when the toolchain can generate and validate it | **PARTIAL** | it cannot, and the reasons are enumerated: no trailer `/ID`, no XMP, no `/Separation`, no ICC conversion of placed rasters, no transparency flattening, no conformance validation |
| **do not merely rename a normal PDF as PDF/X** | **PASS** | `claimsPdfX: false` is typed as the **literal** `false`. Two tests assert "never claims PDF/X conformance" |
| generate a high-quality CMYK production PDF | **PASS** | as above |
| run a documented preflight | **PASS** | `runPreflight()` before export, `validateProductionPdf()` after; both reports stored on the artifact |
| clearly label the compliance status | **PASS** | `complianceStatus.label`, quoted verbatim in `docs/print-pipeline.md` |
| document the remaining step | **PASS** | `complianceStatus.remainingForPdfX` — four entries, quoted verbatim — plus a five-step operational procedure |
| **never fake compliance** | **PASS** | an invalid ICC profile throws `InvalidIccProfileError` rather than being embedded |

**§15 — PARTIAL,** on PDF/X-4 alone. Everything §15 asks for **when
conformance cannot be guaranteed** is done.

---

# §16 — Bleed / trim / safe area

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| bleed 0.125 in each side | **PASS** | asserted per preset, per side |
| trim is authoritative | **PASS** | `trim` is the preset's own dimension; TrimBox is written from it |
| corner radius 0.25 in | **PASS** | asserted per preset |
| **configurable safe-area inset, a preset property, not an unexplained constant** | **PASS** | `safe_{top,right,bottom,left}` are **columns**; the default 0.1875 in carries its reasoning at `SAFE_1875` (0.125 in bleed + 0.0625 in guillotine tolerance). `safeCornerRadius()` derives the safe area's own 0.0625 in radius, because testing against the trim's 0.25 in would raise false alarms |
| background not extending through bleed | **PASS** | `BLEED_COVERAGE` |
| critical text outside safe area | **PASS** | `SAFE_AREA_TEXT`, **error** severity, with the shortfall reported per edge |
| barcode outside safe area | **PASS** | `SAFE_AREA_BARCODE` |
| objects unintentionally crossing trim | **PASS** | `TRIM_CROSSING`; "does not flag full-bleed artwork as crossing trim" |
| low-resolution bleed artwork | **PASS** | `BLEED_LOW_DPI`, its own code |
| **trim corners represented accurately** | **PASS** | one `roundedRectPath()` shared by the artboard, the proof overlay and the production clip; `roundedRectContains()` does a per-corner circle test — "knows a box tucked into a rounded corner is outside the card" |

**§16 — PASS.**

---

# §17 — Cavity / clamshell overlay

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| reusable overlays for all three presets | **PASS** | `CavitySpec` on every preset |
| scale from physical measurements | **PASS** | measured in µpt in trim space; rendered through the same zoom transform as everything else |
| visible while designing | **PASS** | `overlays.cavity`, on by default |
| lockable | **PASS** | drawn in a **non-interactive sibling layer** (`artboard.tsx:29`) — it cannot be selected or moved, which is the property "lockable" is asking for |
| never exports into production artwork unless as a proof overlay | **PASS** | structural — see §6/§15 |
| shows obstruction/visibility context | **PASS** | cavity preflight: "makes a barcode under the front cavity an error", "reports covered copy once, for information, rather than per element", "says nothing about the back, whose clamshell half is flat" |
| **document how each cavity shape was derived** | **PASS** | `docs/source-audit.md` §3: rasterised at ~1200 ppi, enclosed white regions flood-filled, x/y scale agreement **within 0.03 %**, with the measured rect, corner radius and all four margins for each preset |
| **do not guess missing geometry; mark approximations and flag them** | **PASS** | every preset carries `provenance: "measured-from-dieline"` and `cornerRadiusIsApproximate: true`, with per-preset notes recording the raster noise (409TF 0.0009 in, 206TF 0.0059 in left/right asymmetry, **left as measured, not forced symmetric**) and the one transformation that was applied (277TF re-centred on the authoritative 4.343 in trim). Surfaced in the UI beside the overlay |

**§17 — PASS.**

---

# §18 — Template system

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| save a design as template | **PASS** | `saveAsTemplateAction()` |
| duplicate template | **PASS** | `duplicateTemplateAction()` |
| lock brand-critical layers | **PASS** | `templateLocked` per element; "Brand-locked" toggle in the inspector |
| create front/back master templates | **PASS** | `ensureMasterTemplatesAction()`; **3 master templates in the database**, `is_master: true` |
| assign template to card preset | **PASS** | `card_templates.preset_code`, indexed |
| assign template to brand | **PASS** | `card_templates.brand_id` |
| generate a card from a product | **PASS** | `createDesignAction()`; `/designs/new` |
| batch-generate multiple product cards | **PASS** | §19 |
| controlled editable regions | **PASS** | "Editable region" toggle in the inspector, per element |
| locked examples: logo, brand bars, legal footer, standard warnings, cavity-safe structure | **PASS** | placed and locked by `buildMasterTemplate()` |
| variable examples: part number, product name, BOM list, barcode, alternates, fitment, product image | **PASS** | all bound in the master templates |

**§18 — PASS.**

---

# §19 — Batch generation

| # | Requirement | Verdict | Evidence |
| ---: | --- | --- | --- |
| 1 | choose template | **PASS** | `/batch`, `listBatchTemplatesAction()` |
| 2 | choose products | **PASS** | `createBatchAction({ templateId, productIds })` |
| 3 | validate required fields | **PASS** | full preflight per product before rendering |
| 4 | generate previews | **PARTIAL** | the manifest reports each card's preflight counts and status; there is **no thumbnail or visual preview** of a batch card before the run |
| 5 | report overflow/preflight failures | **PASS** | per-row `preflight: { blocking, error, warning, info }` and a `status` |
| 6 | allow correction | **PARTIAL** | a failed row can be fixed in the catalogue or the template and the batch re-run. There is **no in-batch "fix and retry this row"** |
| 7 | generate production PDFs | **PASS** | `renderProductionPdf()` per product, each validated after writing |
| 8 | optionally package into ZIP | **FAIL** | not implemented. No zip dependency, no archive code. The spec marks it optional; it is absent |
| 9 | create a manifest | **PASS** | `manifest` on `export_jobs`, plus `batchManifestCsvAction()` |
| — | manifest fields: SKU, GTIN/UPC, preset, template, revision, filename, timestamp, preflight status | **PASS** | `src/server/batch.ts:47-57` carries exactly `sku`, `gtin`, `presetCode`, `template`, `revision`, `filename`, `exportedAt`, `preflight`, `status` |
| — | **a failed card must not silently disappear** | **PASS** | `status: "ok" \| "preflight_blocked" \| "invalid" \| "failed"` — a failure is a manifest row with a reason, written in the slice that attempted it, so a job that dies halfway still accounts for everything |

**§19 — PARTIAL.** No ZIP (optional), no per-card preview, no in-batch retry.

---

# §20 — Revision / approval workflow

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| every saved production change is revision-aware | **PASS** | `saveDesignAction()` is the only writer |
| draft · in review · approved · superseded | **PASS** | `DESIGN_STATUSES`; `submitForReviewAction()`, `decideApprovalAction()` |
| store creator | **PASS** | `revisions.created_by` |
| timestamps | **PASS** | `created_at`, `frozen_at` |
| revision notes | **PASS** | `revisions.notes` |
| **source data version** | **PASS** | `revisions.product_snapshot` — the resolved `ProductContext` this revision was built against, so regenerating a two-year-old card produces the same words |
| template version | **PASS** | `revisions.template_version` |
| GS1 sync state | **PASS** | `revisions.gs1_sync_state` |
| export history | **PASS** | `export_artifacts.revision_id`; `/exports` and `/exports/[id]` |
| **approved revisions immutable** | **PASS** | enforced in `src/server/designs.ts` — a revision with `frozen_at` set is never written; a save against it mints revision *n*+1 and supersedes the old one. `rev_design_num_uq` makes a concurrent double-save fail rather than interleave. **Verified by reading the code; no automated test covers it** |
| editing an approved card creates a new revision | **PASS** | same path. **10 revisions** exist on the seeded design |
| **visual comparison between revisions where feasible** | **FAIL** | `/designs/[id]` lists every revision with number, status, notes, author, timestamp, frozen state and preflight summary. There is **no side-by-side or overlay comparison** of two revisions' artwork. The spec's "where feasible" softens this, but the artboard renderer is a pure function of a document — two of them side by side is feasible, and it was not built |

**§20 — PARTIAL,** on visual comparison.

---

# §21 — Preflight engine

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| a real preflight engine | **PASS** | `src/lib/preflight/engine.ts` + seven check modules; **73 tests** |
| info · warning · error · blocking | **PASS** | `SEVERITIES`, `SEVERITY_RANK` |
| document dimensions | **PASS** | `DOC_DIMENSIONS` |
| bleed | **PASS** | `BLEED_COVERAGE`, `BLEED_LOW_DPI` |
| trim | **PASS** | `TRIM_CROSSING` |
| safe zone | **PASS** | `SAFE_AREA_TEXT`, `SAFE_AREA_BARCODE`, `SAFE_AREA_ELEMENT` |
| missing linked assets | **PASS** | `ASSET_MISSING` |
| missing fonts | **PASS** | `FONT_MISSING` |
| raster DPI | **PASS** | `ASSET_LOW_DPI` |
| RGB asset in a CMYK workflow | **PASS** | `ASSET_RGB_IN_CMYK` |
| text overflow | **PASS** | `TEXT_OVERFLOW`, blocking |
| unresolved variables | **PASS** | `BINDING_UNRESOLVED`, `BINDING_UNKNOWN_PATH` — separated, because a template defect and a data gap need different people |
| missing product fields | **PASS** | `PRODUCT_FIELD_MISSING` |
| invalid UPC/GTIN | **PASS** | `GTIN_INVALID`, blocking, **naming the correct check digit** |
| barcode quiet zone | **PASS** | `BARCODE_QUIET_ZONE`, measured from the bar band |
| barcode physical dimensions | **PASS** | `BARCODE_SIZE`, `BARCODE_MAGNIFICATION` |
| barcode contrast | **PASS** | `BARCODE_CONTRAST` (ink proxy, said so) |
| barcode clipping | **PASS** | `BARCODE_CLIPPED` |
| cavity conflicts | **PASS** | cavity checks |
| non-grayscale on standard back | **PASS** | `GRAYSCALE_BACK_VIOLATION` |
| transparency/export concerns | **PASS** | `TRANSPARENCY_PRESENT` |
| total ink limit if measurable | **PASS** | `INK_LIMIT_EXCEEDED` |
| empty front/back | **PASS** | `DOC_EMPTY_SIDE` — error on the front, warning on the back |
| hidden required elements | **PASS** | "blocks when a required element is switched off, and errors when data hid it" |
| **blocking errors require a privileged override with an audit note, or are blocked entirely by configuration** | **PASS** | `src/server/exports.ts:134-160` — the org's `allowOverride` decides; when permitted, an empty note is refused, `requireCapability("export.override_blocking")` gates it (admin only), and the note is written to the job **and** the audit log. `export-panel.tsx:134` tells a non-admin why they cannot. **Verified by reading the code; no automated test covers it** |

**§21 — PASS.**

---

# §22 — Export validation

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| MediaBox · CropBox · BleedBox · TrimBox | **PASS** | `PAGE_BOXES`, four separate failure tests |
| physical dimensions | **PASS** | `PHYSICAL_DIMENSIONS`, five decimal places of an inch |
| page count | **PASS** | `PAGE_COUNT` |
| font embedding | **PASS** | `FONT_EMBEDDING`, three separate failure tests |
| expected colour spaces | **PASS** | `COLOR_SPACES` |
| image resolution metadata | **PASS** | `IMAGE_RESOLUTION`, `not_applicable` on an all-vector card |
| barcode presence | **PASS** | `BARCODE_PRESENCE`, by decoded digits **and** by independent bar count |
| no editor overlays | **PASS** | `NO_EDITOR_OVERLAYS`, one failure test per overlay word |
| no accidental clipping | **PASS** | `NO_CLIPPING` |
| **render the exported PDF to images and compare against the editor reference/proof** | **PARTIAL** | The PDFs were rendered — `artifacts/review/` holds page-by-page PNGs for all six files, `artifacts/renders/` holds the 11-500 benchmark — and were **reviewed by eye**. There is **no automated render-and-compare**: no baseline, no perceptual diff, nothing that would fail on a regression |
| **automated geometry tests for all three presets** | **PASS** | `tests/unit/geometry.test.ts` at the preset level (exact integers) and `tests/unit/pdf-validate.test.ts` at the file level (±0.001 pt) |
| **tolerance appropriate for PDF point conversion, documented** | **PASS** | `BOX_TOLERANCE_PT = 0.001` (= 1/72000 in = 0.35 µm) with a paragraph of reasoning: the writer's own precision is 5 × 10⁻⁷ pt, so the tolerance is 3 orders looser than needed and 70× tighter than the smallest real error. `CLIP_TOLERANCE_PT = 0.25` is separately justified by the em-box and stroke-centreline approximations. Both are printed in the report next to the measurement |

**§22 — PARTIAL,** on automated visual comparison.

---

# §23 — Sample reproduction milestone

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| Use `11-500 front.pdf` and `11-500 back.pdf` as a benchmark | **FAIL** | **Neither file was supplied.** `docs/source-audit.md` §1 |
| Front: brand/logo, part number, product title, subtitle/spec, multilingual copy, alternate part number, background/brand graphic, fitment footer, full colour | **PARTIAL** | all placed by `buildMasterTemplate()` and bound to product data; rendered at `artifacts/renders/11-500-409TF-production-p0.png`. **Not compared with the sample, because there is no sample.** The product-image element is present but **cannot be given an asset** (§8) |
| Back: logo, part number, title/spec, multilingual copy, "This Pack Includes", alternates, fitment, genuine-parts section, country of origin, barcode, warning footer, B&W | **PARTIAL** | all placed and bound; `scripts/seed-benchmark.ts` supplies the 11-500 product data (5 BOM items, 2 fitments, 4 alternates, 1 Prop 65 warning, `Made in China`, 4 translations), every row tagged `custom.benchmarkSource`. Rendered at `artifacts/renders/11-500-409TF-production-p1.png` |
| Prove the system can represent and output the same **classes** of production content | **PASS** | every class in §23's two lists is a bound element in a shipped template, exported to a validated production PDF |

**§23 — PARTIAL.** The classes are demonstrably reproducible. The benchmark
comparison the milestone is named for **has not happened and cannot happen
until the artwork is supplied.** Two of the seeded facts — the country of origin
and the fitment copy — are assumptions awaiting client confirmation
(`docs/source-audit.md` A12, A13).

---

# §24 — UX requirements

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| feels like a focused packaging tool | **PASS** | dense dark prepress console; the artboard is the page, not a widget in a dashboard |
| autosave | **PASS** | debounced 1200 ms, with `dirty`/`saving`/`lastSavedAt` and a `beforeunload` guard |
| command shortcuts | **PASS** | ⌘Z, ⇧⌘Z, ⌘S, ⌘1, ⇧1, ⌘D, ⌘A, ⌘], ⌘[, and V/H/T/R/O/L/I/B/K tool keys |
| keyboard delete | **PASS** | Delete and Backspace |
| arrow nudging · shift nudge | **PASS** | coalesced into one history entry |
| zoom-to-fit · 100 % view · pan | **PASS** | ⇧1 · ⌘1 · hand tool (H) |
| ruler · guides · snapping | **PASS** | §6 |
| visible selection bounds | **PASS** | artboard selection layer |
| object lock · layers | **PASS** | toolbar and layer panel |
| **context menu** | **FAIL** | no `contextmenu` handler anywhere in `src/` |
| duplicate | **PASS** | ⌘D |
| **copy / paste** | **FAIL** | no ⌘C/⌘V handler; no clipboard code |
| clear unsaved/export states | **PASS** | save state in the header; export state in `export-panel.tsx` |
| **persist editor preferences per user** | **FAIL** | `users.preferences` exists as a column and is loaded into `CurrentUser` — **nothing writes it and the editor never reads it.** Unit, zoom, overlay toggles and snap state reset on every page load |

**§24 — PARTIAL.** Three named requirements missing.

---

# §25 — Security

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| authentication | **PASS** | bcrypt password hash, jose-signed session cookie, server-side `sessions` row re-read on every request |
| organisation isolation | **PASS** | `org_id` on every tenant table (including child tables), explicit filters, `assertSameOrg()`. **Verified by reading; no automated test** |
| RBAC | **PASS** | four roles, **18 capabilities**, one matrix in `src/server/auth/rbac.ts`. **Verified by reading; no automated test** |
| server-side authorisation | **PASS** | `requireUser()` / `requireCapability()` at the top of every page, action and route. `src/proxy.ts` documents that it is a redirect, **not** the boundary |
| secure asset uploads | **PASS** | 60 MB ceiling; `access: "private"`; reads through `/api/assets/[id]` with an org check |
| MIME validation | **PASS** | magic-byte sniffing in `src/server/assets.ts`, **not** the browser's `type` header |
| file-size limits | **PASS** | 60 MB assets, 25 MB workbooks |
| **malware scanning hook** | **PARTIAL** | `assets.scan_status` / `scan_detail` exist; **no engine is wired in** and the default is `skipped`. A hook, honestly labelled |
| signed asset URLs where appropriate | **PASS** | the Blob URL never reaches a browser; every read is authorised and streamed |
| encrypted third-party credentials | **PASS** | AES-256-GCM, AAD-bound, three columns, rotation supported |
| audit logs | **PASS** | `audit_logs`, append-only, two indexes. **27 rows** in the seeded database |
| **rate limiting** | **PARTIAL** | login throttling only — `failedLoginCount` + a 15-minute `lockedUntil`. **There is no rate limiting on any other action or route**, including export, batch and the GS1 connector |
| CSRF-safe patterns | **PASS** | Server Actions (POST-only, origin-checked by the framework); `SameSite` session cookie |
| no secrets in client bundles | **PASS** | `server-only` on every module that touches the database, the cipher or an adapter — a violation is a **build error** |
| no GS1 credentials in browser storage | **PASS** | the credential never reaches the browser; no action returns it or anything derived from it |
| roles: Admin, Designer, Reviewer, Viewer | **PASS** | `ROLES`; `/settings/users` |

**§25 — PARTIAL,** on the unwired scanning hook, the absence of general rate
limiting, and the absence of automated tests for isolation and RBAC.

---

# §26 — Performance

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| do not rerender the full tree on every pointer movement | **PASS (by construction, unmeasured)** | `useSyncExternalStore` with per-slice selectors and `shallowArrayEqual`; `dragPreview` kept out of the document during a drag. **No test asserts it** |
| virtualize long asset/product lists | **PARTIAL** | `/products` paginates **server-side at 50 rows a page** with every filter in the URL — a legitimate answer that avoids shipping the list at all. But `/designs` fetches `limit(200)` unvirtualised, the layer panel is unvirtualised, and there is **no windowing anywhere** |
| use image thumbnails | **FAIL** | `assets.thumbnail_url` is a column; **nothing generates a thumbnail.** The asset library and the artboard load full-size images |
| lazy-load heavy assets | **PARTIAL** | assets stream through `/api/assets/[id]` on demand rather than being inlined; there is no progressive or deferred loading strategy |
| use worker/background processing where beneficial | **PARTIAL** | batch advances in committed slices; PDF rendering is server-side. **No Web Worker and no worker fleet** |
| debounce autosave | **PASS** | 1200 ms; preflight at 1500 ms |
| avoid giant base64 blobs in database rows | **PASS** | Blob storage; rows hold keys |
| cache derived previews | **FAIL** | the plan is recomputed on every relevant state change; nothing is memoised across renders or cached server-side |
| queue heavy PDF/batch exports | **PARTIAL** | slice-advancing job with persisted state and resume; **not a queue** |
| **measure before optimizing, but test realistic complex cards** | **FAIL** | **nothing is measured.** No benchmark, no frame timing, no profile of a complex card |

**§26 — PARTIAL.** The architecture is right; the evidence is absent. §26's own
instruction to measure has not been followed.

---

# §27 — Accessibility

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| editor keyboard-accessible where practical | **PASS** | full shortcut set (§24), arrow nudging, Escape to deselect, Enter/Escape in the text overlay, tab-reachable inspector fields |
| admin/data screens meet normal WCAG expectations | **PARTIAL (by construction, untested)** | labelled inputs throughout, `aria-current` on nav, real `<th>` in every table, `role="group"` + `aria-label` on toolbar clusters, `role="tablist"`/`role="tab"` on the panel tabs, `role="status"` on the save indicator, `role="alert"` on the login error, `aria-label` on every icon button, focus-visible left to `globals.css`. **No axe run, no automated contrast check, no keyboard-navigation test** |
| accessible labels · focus management · contrast · keyboard equivalents | **PARTIAL** | same evidence, same gap |
| do not force generic form patterns onto the precision editor | **PASS** | numeric fields accept typed physical units (`4 3/8"`, `110.9mm`) and respond to arrow keys, rather than being wrapped in a generic form abstraction |

**§27 — PARTIAL.** Addressed deliberately in the markup; verified by reading,
not by tooling.

---

# §30 — Definition of Done

| Criterion | Verdict | Note |
| --- | --- | --- |
| all three card presets exist | **PASS** | 3 rows in `card_presets` |
| dimensions physically accurate | **PASS** | exact integers, verified to ±0.001 pt in the file |
| bleed accurate | **PASS** | 0.125 in, all sides, all presets |
| corner radius represented | **PASS** | one shared path function |
| cavity overlays exist | **PASS** | measured, provenance-marked |
| front/back editor works | **PASS** | — |
| full-colour front workflow works | **PARTIAL** | **no product image can be placed** (§8) |
| black-and-white back workflow works | **PASS** | grayscale enforcement with an authorised-colour escape |
| **backgrounds upload and position correctly** | **FAIL** | upload works in the asset library; **an image element cannot be given an asset from the editor** (§8) |
| text editing works | **PASS** | — |
| layers work | **PASS** | — |
| snapping/guides work | **PASS** | — |
| variable product fields work | **PASS** | 59 tests |
| BOM repeating list works | **PASS** | the spec's reference line is a fixture |
| workbook import works | **PASS** | 392 products imported from the real file |
| UPC/GTIN validation works | **PASS** | 390/390 and 386/386 valid, measured |
| vector barcode generation works | **PASS** | known-answer fixtures |
| GS1 integration architecture exists | **PASS** | adapter + providers + diff/accept |
| GS1 configurable without exposing credentials | **PASS** | write-only, encrypted, AAD-bound |
| CMYK preserved as print data | **PASS** | no RGB in the print path |
| screen RGB honestly treated as preview | **PASS** | named as an approximation everywhere |
| production PDF export works | **PASS** | 6 sample PDFs in `artifacts/pdf/` |
| bleed/trim boxes validated | **PASS** | ±0.001 pt |
| fonts embedded/subset | **PASS** | every glyph re-extracted and compared |
| low-DPI artwork detected | **PASS** | — |
| unresolved data detected | **PASS** | — |
| preflight works | **PASS** | 73 tests |
| batch generation works | **PASS** | manifest with per-row reasons |
| revisions work | **PASS** | 10 revisions on the seeded design |
| approvals work | **PASS** | `approvals` table + controls. **Untested** |
| approved artwork immutable | **PASS** | enforced in one code path. **Untested** |
| **sample 11-500 content structure can be reproduced** | **PARTIAL** | structure yes; **comparison impossible — the sample was never supplied** |
| **tests pass** | **PASS** | 465 passed, 1 opt-in skipped |
| **build passes** | **PARTIAL** | `npx tsc --noEmit` is **clean**. `next build` was **not run for this report** |
| **E2E passes** | **PARTIAL** | 3 auth tests. The editor, import, export, approval and batch flows have **no E2E coverage** |
| exported PDFs rendered and visually inspected | **PASS** | `artifacts/review/`, `artifacts/renders/`, reviewed by eye |
| **final gauntlet report has no unresolved blocker/critical/major findings** | **NOT MET** | 1 blocker, 2 critical, 4 major — listed at the top |

## §30 verdict: NOT MET

The system is substantially complete and, in the areas that decide whether a
card can be printed — geometry, colour, fonts, barcodes, preflight, PDF
structure — it is thoroughly built and thoroughly tested. 465 tests pass and the
typecheck is clean.

It is **not done** for four reasons, in order:

1. **A designer cannot place an image.** §8's central control is missing from
   the inspector. Every layer beneath it works.
2. **The §23 benchmark has never been compared with the sample,** because the
   sample was never supplied.
3. **`src/server/*` has no automated tests** — including revision immutability,
   organisation isolation, RBAC and the blocking-export override, which are the
   paths where a failure is most expensive.
4. **Three named §24 editor requirements are absent:** copy/paste,
   group/ungroup, and per-user editor preferences.

Everything else on this list is either PASS with evidence, or PARTIAL for a
reason stated in the row.
