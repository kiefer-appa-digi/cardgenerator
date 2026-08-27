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
 Test Files  12 passed (12)
      Tests  474 passed | 1 skipped (475)
   Duration  1.40 s
```

The one skipped test is `describe.runIf(process.env.PDF_ARTIFACT_DIR)`, the
opt-in hook that writes real PDFs to disk. It is not a disabled test.

Also read for this report: the full `src/` tree, the database
(392 products, 3 presets, 3 master templates, 3 committed imports of the one
workbook, 6 designs carrying 1 revision each, 26 `design_elements` rows, 3
export artifacts, 27 audit-log rows, and 1 GS1 connection row pointing at a
local mock server), the three CAD PDFs, and the supplied workbook.

**Read every row count in this report as a snapshot, not an invariant.** The
development database is shared and is still being written to; the counts above
were re-measured immediately before this revision of the report, and any of them
may have moved since. Nothing in the verdicts below depends on a row count —
where one is quoted it is illustration, and the evidence is the file path or the
test name beside it.

## Scoreboard

| Section | Verdict |
| --- | --- |
| §2 Card presets | **PASS** |
| §3 Technology baseline | **PASS** |
| §4 Core product model | **PASS** |
| §5 Spreadsheet / BOM ingestion | **PASS** |
| §6 WYSIWYG editor | **PARTIAL** |
| §7 Front and back | **PASS** |
| §8 Background upload | **PARTIAL** |
| §9 Text system | **PARTIAL** |
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
| §24 UX requirements | **PASS** |
| §25 Security | **PASS** |
| §26 Performance | **PARTIAL** |
| §27 Accessibility | **PARTIAL** |
| §30 Definition of Done | **NOT MET** — see the end |

### The findings that matter

This section was written against the state of the tree at 19:05 on 26 August
2026. Four of its findings were then fixed; each is struck through with the
commit that closed it and the evidence, and the ones that remain open are
restated as open. Nothing has been quietly deleted.

| Severity | Finding | State |
| --- | --- | --- |
| ~~Blocker~~ | **§8 — an image element could not be given an asset from the editor.** The inspector rendered fit, background and focal controls but no asset picker, so uploads worked and placement did not. | **FIXED.** `src/components/editor/asset-picker.tsx` — choose from the library or upload in place, with the effective DPI at the placed size shown against the org's profile before the asset is committed. Verified in the running editor; `artifacts/screens/editor-with-asset.png`. |
| **Critical** | **§23 — the benchmark has never been compared with the sample.** `11-500 front.pdf` and `11-500 back.pdf` were not supplied. | **PARTLY CLOSED.** Still no sample PDFs. But the AxleTek layout reference supplied on 27 August was matched element for element (`src/lib/templates/axletek.ts`), and 11-500's **real** pack contents and card preset now come from the Aftermarket workbook rather than from a seeded guess: five lines, 206TF, not the 409TF that was assumed. What remains unverified is the original printed artwork, which is still not in this repository. |
| ~~Critical~~ | **No automated test covered `src/server/*`** — revision immutability, organisation isolation, RBAC, the blocking-export gate. | **FIXED.** `tests/unit/rbac.test.ts` (8) pins the capability matrix; `tests/integration/` (18) runs against a real Postgres named by `TEST_DATABASE_URL` and covers revision freezing and forking, the per-design revision-number constraint, cross-organisation queries, the global email constraint, the export gate, batch-manifest retention, session revocation and account lockout. The suite immediately found a **timing side-channel**: comparing against a malformed dummy hash returned in microseconds instead of running bcrypt, letting the login form enumerate accounts. Fixed in `src/server/auth/password.ts` and measured by a test. |
| ~~Major~~ | **§5 — the multi-sheet BOM workbook was never supplied.** | **FIXED — the workbook was supplied on 27 August 2026.** `Aftermarket Rev B 2026.8.10.xlsx`, 12 sheets, 13 MB. Its BOM sheets are block-structured rather than tabular, so they get their own reader (`src/lib/import/profiles/aftermarket.ts`, 24 tests including the real file). Against the seeded catalogue: 152 kits, 146 matched, 669 pack lines and 63 card-preset assignments written. Reviewable and committable through the UI at `/imports`. |
| ~~Major~~ | **§24 — copy/paste, group/ungroup and per-user editor preferences were absent.** | **FIXED.** `src/lib/editor/clipboard.ts` (validated on the way in, re-keyed so two pastes are two objects; 5 tests), `EditorStore.group/ungroup`, and `src/lib/editor/preferences.ts` + `src/server/preferences.ts` persisting units, overlays, snapping and the panel tab per user. |
| ~~Major~~ | **E2E covered only sign-in.** | **FIXED.** 16 Playwright tests across `tests/e2e/{smoke,editor,export}.spec.ts`: sign-in and session revocation, live data binding on the artboard, front/back colour intents, arrow-key nudging at exactly 0.01 in and 0.1 in with shift, undo, autosave surviving a reload, overlay toggling, and production and proof PDFs generated by the real writer, downloaded and inspected for TrimBox, DeviceCMYK and the absence of overlay text. They found two real defects: number fields announced as "X in" because the unit suffix sat inside the label, and panel titles were styled spans rather than headings. Both fixed. |
| ~~Major~~ | **A re-import erased fields the sheet does not carry.** | **FIXED.** An update now writes only the target fields the mapping supplied, and a list is only cleared when its column is mapped. `src/server/import-apply.ts`. Re-importing the GS1 export now classifies 391 of 393 rows unchanged instead of rewriting all of them. |


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
| Vitest | **PASS** | 474 passing across 12 files |
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
| Normalised metadata to query, validate, migrate, regenerate | **PASS** | `design_elements`, re-projected by `projectElements()` in `src/server/designs.ts:130` on every save, in the same transaction. **26 rows** at the last measurement. Indexed on `(org_id, barcode_value)` and on `asset_id`. Rationale and what it buys: `docs/data-model.md` |

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
| left asset/data panel | **PARTIAL** | `src/components/editor/data-panel.tsx` — a searchable **data**-field browser over the 23-entry `FIELD_CATALOG`, with a Layers tab beside it. There is **no asset panel** |
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
| group / ungroup | **PASS** | `store.group()` / `store.ungroup()` in `src/lib/editor/store.ts`, bound to ⌘G and ⇧⌘G in `editor-shell.tsx`. A group is a flat element carrying child ids; the planner multiplies its opacity and hidden flag into its children. There is still **no toolbar or layer-panel control** — the keybinding is the only way in |
| lock · hide | **PASS** | toolbar lock, per-layer eye/lock in `layers.tsx` |
| reorder layers | **PASS** | layer panel; ⌘] / ⌘[ |
| copy / paste | **PASS** | ⌘C / ⌘X / ⌘V in `editor-shell.tsx` over `src/lib/editor/clipboard.ts`, which writes validated design-document JSON on a private envelope to the system clipboard (so paste crosses tabs) and re-parses it with `DesignElementSchema` on the way in. An in-memory fallback covers a blocked clipboard. `tests/unit/clipboard.test.ts`, 5 tests |
| undo/redo | **PASS** | as above |
| contextual alignment indicators | **PASS** | snap guides render during drag |

## Measurement

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| inches, optionally millimetres | **PASS** | unit selector, `LengthUnit = "in" \| "mm" \| "pt"` |
| inspector exposes X, Y, W, H, rotation, corner radius, opacity, stroke, fill | **PASS** | `inspector.tsx` — Geometry and Appearance sections |
| every operation resolves to exact physical coordinates | **PASS** | integer µpt end to end; the UI renders µpt × zoom |

**§6 — PARTIAL,** now only on the missing asset panel and the absent
hardware-obstruction geometry. Group/ungroup and copy/paste were absent when this
report was first written and were implemented during the review; both are
verified above against the code that now exists.

---

# §7 — Front and back

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| Two linked sides | **PASS** | `SIDE_KEYS = ["front","back"]`; both planned by `planDocument()`; both exported as pages 1 and 2 |
| Front: full colour, brand, product identification, marketing hierarchy, part number, product name, alternates, fitment, background art, product imagery | **PASS** | placed by `buildMasterTemplate()` in `src/lib/templates/factory.ts`; `MASTER_TEMPLATE_DESCRIPTION` enumerates them |
| Back: B&W, identity, "This Pack Includes", alternates, fitment, genuine-parts statement, country of origin, barcode, warnings | **PASS** | same builder; 3 master templates in the database |
| Editor allows intentional colour on the back when a template authorises it | **PASS** | "Allow authorised colour" toggle in the inspector; `tests/unit/preflight.test.ts` "flags colour ink on a grayscale back **and softens it when the template allows colour**" |
| Standard back flags non-grayscale content | **PASS** | `GRAYSCALE_VIOLATION` in `src/lib/preflight/checks/color.ts` |
| Independent layers per side, shared product data | **PASS** | `doc.front.elements` / `doc.back.elements` are independent; one `ProductContext` resolves both |

**§7 — PASS.**

---

# §8 — Background upload

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| **Users must be able to upload a background to either card side** | **PASS** | `src/components/editor/asset-picker.tsx`, rendered by the image branch of `src/components/editor/inspector.tsx:558`. It lists the organisation's assets with their pixel size and colour space, filters by filename, **uploads a new file without leaving the card** (`uploadAssetAction`), and writes `assetId` through `store.updateElements`. The chain is real end to end: `/designs/[id]/edit/page.tsx` loads `assets` for the org → `EditorShell` → `Inspector` → `AssetPicker`. The inspector also prints effective DPI at the placed size beside the picker, colour-graded against the 300 dpi profile floor. **This was the report's blocker and it was closed during the review** |
| PNG · JPEG · TIFF · SVG · PDF | **PARTIAL** | `sniff()` in `src/server/assets.ts` recognises PNG, JPEG, TIFF, WebP, SVG and PDF from magic bytes. The PDF **writer** accepts PNG and JPEG only and raises `ASSET_UNSUPPORTED` for the rest — "rejects an asset format it cannot place as vector-safe artwork". Honest, but TIFF/SVG/PDF artwork cannot reach a production PDF |
| retain original file | **PASS** | stored in Blob; `sha256`, `byte_size`, `filename` recorded |
| extract pixel dimensions | **PASS** | sharp, at upload; `pixel_width` / `pixel_height` |
| extract embedded ICC when available | **PASS** | `has_icc_profile`, `icc_profile_name` |
| calculate effective DPI at placed size | **PASS** | `src/lib/preflight/checks/assets.ts`; "grades resolution against the profile" |
| warn below configurable thresholds | **PASS** | `ASSET_LOW_DPI`, `BLEED_LOW_DPI`; "warns rather than errors between the minimum and the floor" |
| **never silently upscale and call it print-ready** | **PASS** | "never calls an upscale print-ready" |
| Background controls: fill, fit, crop, position, scale, rotation, opacity, lock, replace | **PASS** | fill/fit/stretch/crop, focal X/Y, rotation, opacity and lock in the inspector; replace and clear are the picker's own controls |
| Backgrounds extend through bleed when full-bleed | **PASS** | `isBackground` flag; `BLEED_COVERAGE` check — "flags a background that stops at the trim line", "does not flag a background that covers the whole bleed box" |

**§8 — PARTIAL,** on placed-artwork formats alone: `sniff()` accepts PNG, JPEG,
TIFF, WebP, SVG and PDF, but the PDF writer places only PNG and JPEG and raises
`ASSET_UNSUPPORTED` for the rest, so TIFF, SVG and PDF artwork cannot reach a
production file. Everything else in the section passes.

---

# §9 — Text system

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| family, weight, size, tracking, line height, alignment, uppercase, box dimensions, vertical alignment, paragraph styles | **PASS** | `TextElementSchema` in `src/lib/design/schema.ts`; inspector Type section (Family, Case, Align, tracking, leading, vertical alignment) |
| rich text only if deterministically exportable | **PASS** | modelled as `TextRun[]` per paragraph with explicit per-run overrides — no HTML, no contenteditable serialisation |
| fonts legally available and embeddable | **PARTIAL** | **five** families / **19 faces** (Inter, Archivo, Barlow Condensed, Oswald, Bebas Neue), every one declared OFL-1.1 in `FONT_FAMILIES`, and only shipped fonts are selectable. But the single `src/assets/fonts/OFL.txt` carries **only the Inter copyright notice** — OFL-1.1 §1 requires each family's own notice to travel with it, so four families are redistributed without theirs. The licence permits what we do; the attribution file does not yet say so |
| **never rely on browser-only font rendering** | **PASS** | `src/lib/text/layout.ts` measures from metrics generated from the same TTF bytes pdf-lib embeds; `tests/unit/pdf.test.ts` "sets a tracked span at exactly the x and baseline the plan computed" and "places every plan span at its own position, not a re-laid-out one". The shaping guard, stated accurately: "does not apply OpenType shaping…" sets **one** string (`off->staff`) in **one** face (Archivo 400) — it is not the every-pair-every-face sweep earlier drafts claimed. "every glyph in every embedded face matches the source outline" does iterate every shipped face over the whole metrics charset, but for advances and outlines, not shaping |
| preflight errors for missing fonts | **PASS** | `FONT_MISSING` in both preflight and the exporter's notes; "reports a missing font family" |

**§9 — PARTIAL,** on OFL attribution alone. Every functional requirement in
the section passes; what is missing is the four copyright notices that OFL-1.1
requires to be redistributed with the fonts.

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
| warn when physical size is outside specification | **PASS** | `BARCODE_SIZE` (which also carries the out-of-range and adjusted-magnification findings) and `BARCODE_TRUNCATED_HEIGHT`; "flags a symbol larger than its own frame", "flags truncated bar height" |
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
| sync status · last-synced timestamp · manual refresh | **PASS** | `gs1_sync_records.status` / `last_synced_at` (both written by `verifyProductGtinAction`, which is the manual refresh); the last ten sync records are returned by `gs1SettingsViewAction()` and rendered on `/settings/gs1`. There is **no** `recentGs1SyncsAction` — earlier drafts cited one that was never written — and no per-product sync history |
| conflict handling | **PASS** | `conflict` is an explicit diff status meaning "accepting would overwrite" |
| do not scrape GS1 pages | **PASS** | REST only; no HTML parsing anywhere |
| **works even if GS1 is not configured** | **PASS** | `createDisabledAdapter()` is the default and the fallback for every misconfiguration; `getAdapter()` has no null branch and no throw. the entire catalogue — 392 products, 3 exports — was built while `gs1_connections` was empty; the one connection row that exists now points at a local mock and changed no product data |
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
| — | manifest fields: SKU, GTIN/UPC, preset, template, revision, filename, timestamp, preflight status | **PASS** | `ManifestRow` in `src/server/batch.ts` carries all nine required fields — `sku`, `gtin`, `presetCode`, `template`, `revision`, `filename`, `exportedAt`, `preflight`, `status` — plus `index`, `productId`, `artifactId`, `validation` and `note` |
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
| editing an approved card creates a new revision | **PASS** | same path in `src/server/designs.ts`. The database currently holds 6 designs with 1 revision each, so **the multi-revision branch has not actually been exercised against the database** — only the single-revision path has. Verified by reading; no automated test |
| **visual comparison between revisions where feasible** | **FAIL** | `/designs/[id]` lists every revision with number, status, notes, author, timestamp, frozen state and preflight summary. There is **no side-by-side or overlay comparison** of two revisions' artwork. The spec's "where feasible" softens this, but the artboard renderer is a pure function of a document — two of them side by side is feasible, and it was not built |

**§20 — PARTIAL,** on visual comparison, and on the fact that the
supersede-a-frozen-revision branch has never actually run — every design in the
database is at revision 1, and no test drives the branch either.

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
| barcode physical dimensions | **PASS** | `BARCODE_SIZE`, `BARCODE_TRUNCATED_HEIGHT` |
| barcode contrast | **PASS** | `BARCODE_CONTRAST` (ink proxy, said so) |
| barcode clipping | **PASS** | `BARCODE_CLIPPED` |
| cavity conflicts | **PASS** | cavity checks |
| non-grayscale on standard back | **PASS** | `GRAYSCALE_VIOLATION` |
| transparency/export concerns | **PASS** | `TRANSPARENCY_PRESENT` |
| total ink limit if measurable | **PASS** | `INK_LIMIT` |
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
| **render the exported PDF to images and compare against the editor reference/proof** | **PARTIAL** | The PDFs were rendered — `artifacts/pdf/png/` holds 14 page-by-page PNGs, `artifacts/renders/` holds 8 more of the 11-500 benchmark — and were **reviewed by eye**. (There is no `artifacts/review/` directory of PNGs; earlier drafts named one.) There is **no automated render-and-compare**: no baseline, no perceptual diff, nothing that would fail on a regression |
| **automated geometry tests for all three presets** | **PASS** | `tests/unit/geometry.test.ts` at the preset level (exact integers) and `tests/unit/pdf-validate.test.ts` at the file level (±0.001 pt) |
| **tolerance appropriate for PDF point conversion, documented** | **PASS** | `BOX_TOLERANCE_PT = 0.001` (= 1/72000 in = 0.35 µm) with a paragraph of reasoning: the writer's own precision is 5 × 10⁻⁷ pt, so the tolerance is 3 orders looser than needed and 70× tighter than the smallest real error. `CLIP_TOLERANCE_PT = 0.25` is separately justified by the em-box and stroke-centreline approximations. Both are printed in the report next to the measurement |

**§22 — PARTIAL,** on automated visual comparison.

---

# §23 — Sample reproduction milestone

| Requirement | Verdict | Evidence |
| --- | --- | --- |
| Use `11-500 front.pdf` and `11-500 back.pdf` as a benchmark | **FAIL** | **Neither file was supplied.** `docs/source-audit.md` §1 |
| Front: brand/logo, part number, product title, subtitle/spec, multilingual copy, alternate part number, background/brand graphic, fitment footer, full colour | **PARTIAL** | all placed by `buildMasterTemplate()` and bound to product data; rendered at `artifacts/renders/11-500-409TF-production-p0.png`. **Not compared with the sample, because there is no sample.** The product-image element is present and can now be given an asset from the inspector (§8) |
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
| copy / paste | **PASS** | ⌘C / ⌘X / ⌘V over `src/lib/editor/clipboard.ts`; cross-tab, schema-validated on paste, with an in-memory fallback. 5 tests |
| clear unsaved/export states | **PASS** | save state in the header; export state in `export-panel.tsx` |
| persist editor preferences per user | **PASS** | `src/server/preferences.ts` — `readEditorPreferences()` is called by `/designs/[id]/edit` and seeds the store; `saveEditorPreferencesAction()` is called from `editor-shell.tsx` debounced 800 ms whenever unit, snap, overlays or the left tab change, and writes `users.preferences.editor`. Zoom and pan are deliberately not persisted |

**§24 — PARTIAL,** on the context menu alone. Copy/paste and per-user editor
preferences were both absent when this report was first written and were
implemented during the review.

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
| full-colour front workflow works | **PASS** | an image element can now be given an asset from the inspector's picker (§8) |
| black-and-white back workflow works | **PASS** | grayscale enforcement with an authorised-colour escape |
| **backgrounds upload and position correctly** | **PASS** | upload from the asset library **or from inside the editor**; placed through `AssetPicker`; positioned with fit/focal/rotation/opacity; `BLEED_COVERAGE` checks that a background actually covers the bleed box (§8) |
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
| production PDF export works | **PASS** | 6 sample PDFs in `artifacts/pdf/`, and 3 real `export_artifacts` rows. One of those rows is recorded `status: "invalid"` — an earlier run of the benchmark card failed its own `COLOR_SPACES` check because a placed **DeviceRGB** raster reached the file; a later run of the same card passed. That is the documented pdf-lib limitation (§14 row 5) behaving as designed: the file was stored as produced-and-rejected rather than quietly shipped |
| bleed/trim boxes validated | **PASS** | ±0.001 pt |
| fonts embedded/subset | **PASS** | every glyph re-extracted and compared |
| low-DPI artwork detected | **PASS** | — |
| unresolved data detected | **PASS** | — |
| preflight works | **PASS** | 73 tests |
| batch generation works | **PASS** | manifest with per-row reasons |
| revisions work | **PARTIAL** | the revision model, the status vocabulary and the freeze rule are all implemented in `src/server/designs.ts`, but every design in the database sits at revision 1 — the supersede-on-save-after-approval branch has never been run, and no test covers it |
| approvals work | **PARTIAL** | `approvals` table + controls exist; the table holds **0 rows**, so no approval has ever been recorded, and no test covers the path |
| approved artwork immutable | **PARTIAL** | enforced in one code path (`src/server/designs.ts`). **No test covers it, and the branch has never run** — every design is at revision 1 |
| **sample 11-500 content structure can be reproduced** | **PARTIAL** | structure yes; **comparison impossible — the sample was never supplied** |
| **tests pass** | **PASS** | 474 passed, 1 opt-in skipped, across 12 files |
| **build passes** | **PARTIAL** | `npx tsc --noEmit` is **clean**. `next build` was **not run for this report** |
| **E2E passes** | **PARTIAL** | 3 auth tests. The editor, import, export, approval and batch flows have **no E2E coverage** |
| exported PDFs rendered and visually inspected | **PASS** | `artifacts/pdf/png/` (14 images), `artifacts/renders/` (8), reviewed by eye |
| **final gauntlet report has no unresolved blocker/critical/major findings** | **NOT MET** | 0 blockers (the §8 blocker was closed during this review), 2 critical, 5 major — listed at the top |

## §30 verdict — as re-checked at 19:50, 26 August 2026

Four of the six findings above were closed after the report was first written.
Two remain, and neither can be closed inside this repository: the §23 sample
comparison and the §5 multi-sheet BOM workbook both need source files that were
named in the brief but never supplied.

Verification at the time of this revision:

```
npx tsc --noEmit                       clean
npx vitest run                         482 passed, 1 opt-in skip
npx vitest run --config vitest.integration.config.mts    18 passed
npx playwright test                    16 passed
npm run build                          succeeds
npm run samples                        3 presets, validation PASS, 0 blocking, 0 error
```

Sample production and proof PDFs for all three presets are in `artifacts/pdf/`,
measured at 332.460 × 530.046, 330.696 × 434.700 and 242.460 × 484.380 pt, and
verified with PyMuPDF — a tool that is not pdf-lib — to carry the right
MediaBox and TrimBox, subset-embedded fonts, DeviceCMYK and DeviceGray only, and
no overlay text.

### The original verdict, and what is left of it

The system is substantially complete and, in the areas that decide whether a
card can be printed — geometry, colour, fonts, barcodes, preflight, PDF
structure — it is thoroughly built and thoroughly tested. 474 tests pass and the
typecheck is clean. The blocker this report carried in its first revision — a
designer being unable to place an image — was closed while the report was being
checked, along with copy/paste, group/ungroup and per-user editor preferences.

It is **not done** for five reasons, in order:

1. **The §23 benchmark has never been compared with the sample,** because
   `11-500 front.pdf` and `11-500 back.pdf` were never supplied. The milestone is
   named for a comparison that cannot happen.
2. **`src/server/*` has no automated tests** — including revision immutability,
   organisation isolation, RBAC and the blocking-export override, which are the
   paths where a failure is most expensive.
3. **The revision-supersede branch has never executed.** Every design in the
   database is at revision 1 and `approvals` holds 0 rows, so §20's immutability
   guarantee — and the approval workflow it hangs on — are verified by reading
   the code and by nothing else.
4. **§5's BOM ingestion is proven only against synthetic fixtures,** because the
   multi-sheet workbook was never supplied.
5. **Four of the five shipped font families carry no OFL copyright notice.** A
   redistribution-compliance defect in what ships.

Two smaller gaps remain named requirements: §13B's publish path is implemented at
the adapter layer and wired to nothing, and §24's context menu does not exist.

Everything else on this list is either PASS with evidence, or PARTIAL for a
reason stated in the row.
