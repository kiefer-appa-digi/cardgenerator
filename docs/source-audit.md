# Source audit

Spec §1. Written before implementation and kept current as measurements were
re-derived. Every number below was read out of the supplied files or out of the
code that encodes them; nothing here is estimated from memory.

**Reproduce the workbook statistics:**

```
npx tsx -e 'import {inspectWorkbook} from "./src/lib/import/inspect";
  import {readFileSync} from "node:fs";
  console.log(JSON.stringify(await inspectWorkbook(
    readFileSync("docs/source/ExportAllProducts_20260826220203076.xlsx")), null, 2))'
```

or run the suite that asserts them: `npx vitest run tests/unit/import.test.ts`
(`describe("GS1 US Data Hub export (docs/source)")`).

---

## 1. Files discovered — and the two that were not supplied

The spec's §1 list names **six** source files. **Four** were found in the
project folder, and one of those four is not the workbook the spec names.

| Spec expected | Supplied? | Location used |
| --- | --- | --- |
| `206TF.pdf` | Yes | `docs/source/dielines/206TF.pdf` (193 102 bytes) |
| `277TF.pdf` | Yes | `docs/source/dielines/277TF.pdf` (195 595 bytes) |
| `409TF.pdf` | Yes | `docs/source/dielines/409TF.pdf` (200 803 bytes) |
| `11-500 front.pdf` | **No** | — |
| `11-500 back.pdf` | **No** | — |
| `Aftermarket Rev B 2026.8.10.xlsx` | **No** | — |
| *(not in the spec list)* `ExportAllProducts_20260826220203076.xlsx` | Supplied instead | `docs/source/ExportAllProducts_20260826220203076.xlsx` (82 647 bytes) |

Also present in the repository root and used as brand reference, not as spec
source material: `Branding/SVG`, `Branding/PDF`, `Branding/PNG` (Freedom Trailer
Parts identity marks in eleven colourways).

### What was done in place of the missing files

**`11-500 front.pdf` / `11-500 back.pdf` — the sample-card benchmark (§23).**
No artwork was available to measure, so nothing was traced. Instead the
*content model* the spec describes in §23 was implemented directly as three
master templates — one per preset — built by
`src/lib/templates/factory.ts` (`buildMasterTemplate()`), and the product data
those templates bind to was seeded as ordinary catalogue rows by
`scripts/seed-benchmark.ts`. Both files say so in their header comments. Every
row that script writes is tagged `custom.benchmarkSource` on the product so it
can be told apart from imported data and deleted if the real artwork arrives.

The consequence, stated plainly: **the §23 milestone is a structural
reproduction, not a comparison against the sample.** Nobody has checked the
generated card against the real 11-500 package, because the real package was
never supplied. The classes of content are all present and bound; the visual
match is unverified. See `docs/final-gauntlet-report.md` §23.

**`Aftermarket Rev B 2026.8.10.xlsx` — the multi-sheet workbook.** The spec
(§5) describes a workbook with data areas for Items, private packaging,
AxleTek BOM, TowPro/private-label, Master Data, GS1, Clam Shells and Inventory.
**None of that was supplied.** The workbook that was supplied is a single-sheet
GS1 US Data Hub product export with no BOM, no packaging, no inventory and no
fitment columns at all.

The importer was therefore built as a **profile/adapter system** rather than
against one file (§5 "Create adapters rather than hard-coding the entire
application to this one workbook"). `src/lib/import/mapping.ts` ships two
profiles — `gs1-us-datahub-export` and a `generic-product-bom` fallback — and
the sheet-kind classifier in `src/lib/import/inspect.ts` recognises
`products`, `bom`, `identifiers`, `inventory`, `packaging`, `unknown` and
`empty`. The BOM and multi-sheet paths are exercised by synthetic fixtures in
`tests/unit/import.test.ts` (`describe("BOM sheets")`, `describe("awkward
sheets")`), **not** by a real supplied file. That is a gap in evidence, not a
gap in code, and it is recorded as such.

---

## 2. PDF page sizes

All three CAD PDFs are two-page US Letter landscape, produced by "Microsoft:
Print To PDF" from a Word document (`/Title (Microsoft Word - Document2)`).

| File | Pages | MediaBox (pt) | Physical | CropBox |
| --- | ---: | --- | --- | --- |
| `206TF.pdf` | 2 | `[0, 0, 792, 612]` | 11.0000 × 8.5000 in | same as MediaBox |
| `277TF.pdf` | 2 | `[0, 0, 792, 612]` | 11.0000 × 8.5000 in | same as MediaBox |
| `409TF.pdf` | 2 | `[0, 0, 792, 612]` | 11.0000 × 8.5000 in | same as MediaBox |

Page 1 of each file is the clamshell manufacturing drawing (dimensioned
elevation and section, with the callout table). Page 2 is the card dieline plus
a "Cavity Location" diagram.

**Consequence for measurement:** these are *drawings on a letter sheet*, not
1:1 artwork. Nothing on the page is at its true physical size, so no dimension
could be taken by reading a PDF coordinate. Every measured value in §3 below
came from rasterising the page and scaling by a known reference dimension.

---

## 3. Dieline geometry as measured

### Method

1. Page 2 of each CAD PDF was **rasterised at approximately 1200 ppi**.
2. The enclosed white regions of the card outline and the cavity footprint were
   **flood-filled** to recover their pixel bounding boxes.
3. The pixel-to-inch scale was solved independently on each axis from the card
   outline against the card size labelled on the same sheet. **The x and y
   scales agreed to within 0.03 %**, which is what justifies trusting a single
   scale for the cavity measurements that follow. A disagreement larger than
   that would have meant the drawing was anisotropically scaled and no
   measurement from it would have been usable.
4. Cavity corner radii were recovered from the raster edge profile. They are
   therefore **approximate** and every preset carries
   `cavity.cornerRadiusIsApproximate: true` so the UI can say so next to the
   overlay (§17: "If exact geometry cannot be recovered from source files,
   create a clearly marked approximation and flag it for verification").

Everything measured lives in `src/lib/geometry/presets.ts`; the verbatim CAD
callouts are preserved beside it in `cadReference` and are never used to change
a production dimension.

### Authoritative production presets (spec §2)

These are the spec's numbers, not measurements. They win over the CAD sheets.

| Preset | Trim W | Trim H | Corner R | Bleed (all sides) | Full-bleed canvas | Full bleed in pt |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| 409TF | 4.3675 in | 7.11175 in | 0.25 in | 0.125 in | 4.6175 × 7.36175 in | 332.46 × 530.046 |
| 277TF | 4.343 in | 5.7875 in | 0.25 in | 0.125 in | 4.593 × 6.0375 in | 330.696 × 434.7 |
| 206TF | 3.1175 in | 6.4775 in | 0.25 in | 0.125 in | 3.3675 × 6.7275 in | 242.46 × 484.38 |

Stored internally as integer micro-points: 409TF trim is `314460000 × 512046000`
µpt, 277TF `312696000 × 416700000`, 206TF `224460000 × 466380000`. Every one of
the supplied five-decimal inch dimensions maps to an exact integer with no
remainder — asserted by `tests/unit/units.test.ts` ("maps every supplied preset
dimension to an exact integer").

**Safe area** is 0.1875 in in from trim on all four sides, and it is a *preset
property*, not a constant buried in code (§16). The reasoning is recorded at the
`SAFE_1875` definition: 0.125 in of bleed plus a 0.0625 in guillotine tolerance.
The safe area's own corner radius is 0.0625 in — insetting a rounded rect by
*d* shrinks its radius by *d*, and testing containment against the trim's
0.25 in radius would raise false alarms (`safeCornerRadius()`).

### CAD reference data, preserved verbatim

| | 409TF | 277TF | 206TF |
| --- | --- | --- | --- |
| Drawing rev / date | 0 · 10-SEP-19 | 1 · 05-SEP-17 | 1 · 01-SEP-17 |
| Material | PVC, 0.020 in, CLEAR | PVC, 0.020 in, CLEAR | PVC, 0.020 in, CLEAR |
| A — overall length | 8.250 in [209.55 mm] | 7.000 in [177.80 mm] | 7.437 in [188.90 mm] |
| B — overall width | 4.938 in [125.41 mm] | 5.000 in [127.00 mm] | 3.625 in [92.08 mm] |
| C — cavity height | *5.563 in [141.30 mm] | 4.250 in [107.95 mm] | *4.688 in [119.06 mm] |
| D — cavity width | *3.188 in [80.98 mm] | 3.875 in [98.43 mm] | *2.313 in [58.74 mm] |
| E — depth | 1.625 in [41.28 mm] | 2.000 in [50.80 mm] | 1.313 in [33.34 mm] |
| F — max card length | 7.125 in [180.98 mm] | 5.750 in [146.05 mm] | 6.437 in [163.50 mm] |
| H — max card width | 4.343 in [110.31 mm] | 4.343 in [110.31 mm] | 3.140 in [79.76 mm] |
| Card size labelled on dieline sheet | 4.3675 × 7.1175 in, R0.25 | 4.3575 × 5.7875 in, R0.25 | 3.1175 × 6.4775 in, R0.25 |

`*` on the drawing means "to theoretical sharp corners".

### Cavity footprints as measured

Expressed in **trim space**: origin at the top-left corner of the trim box.

| Preset | x | y | w | h | Corner R (approx) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 409TF | 0.3017 in | 0.7908 in | 3.7655 in | 6.194 in | 0.4329 in |
| 277TF | 0.0939 in | 1.1066 in | 4.1552 in | 4.5527 in | 0.2242 in |
| 206TF | 0.1647 in | 1.0995 in | 2.7818 in | 5.1088 in | 0.6171 in |

Resulting margins from the card edge:

| Preset | Left | Right | Top | Bottom |
| --- | ---: | ---: | ---: | ---: |
| 409TF | 0.3017 in | 0.3003 in | 0.7908 in | 0.12695 in |
| 277TF | 0.0939 in | 0.0939 in | 1.1066 in | 0.1282 in |
| 206TF | 0.1647 in | 0.171 in | 1.0995 in | 0.2692 in |

Per-preset notes carried in the code and shown in the UI:

- **409TF** — measured left/right margins were 0.3017 / 0.3008 in. The 0.0009 in
  asymmetry is raster noise and was left as measured rather than forced
  symmetric. CAD callouts D (`*3.188`) and C (`*5.563`) describe the **cavity
  floor to theoretical sharp corners**, not this flange opening; the thermoform
  draft angle accounts for the difference. The two are not the same measurement
  and were not reconciled.
- **277TF** — the dieline sheet draws the card 4.3575 in wide, but the
  authoritative trim is 4.343 in. Measured margins were 0.1011 / 0.1018 in
  against the drawn width; the cavity was **re-centred** on the authoritative
  width, giving 0.0939 in each side. Vertical geometry is untouched (top
  1.1066 in, bottom 0.1282 in). This is the one place a measured number was
  transformed, and it is a re-centring, not a correction of source data.
- **206TF** — measured margins left 0.1647, right 0.1706, top 1.0995, bottom
  0.2701 in. The 0.0059 in left/right asymmetry is within raster noise and was
  left as measured.

Cavity overlays are non-printing by construction: they exist only in the SVG
artboard and in the proof PDF's Optional Content Group, and `src/lib/pdf/draw.ts`
has no operation that could express one. See `docs/print-pipeline.md`.

---

## 4. The spreadsheet: one sheet, 41 columns

`ExportAllProducts_20260826220203076.xlsx` — 82 647 bytes,
**one worksheet** named `ExportAllProducts`, 394 worksheet rows, header on
**row 1** (detected with `high` confidence), **393 data rows**, **41 columns**
(A…AO). Classified `kind: "products"` at confidence 90; the profile detector
ranks `gs1-us-datahub-export` first at score 90 with all ten of its signature
headers matched, and `generic-product-bom` second at 25.

Fill rate is the count of non-empty cells over the 393 data rows.

| # | Col | Header | Type | Filled | Fill rate | Distinct | Max len | Notes |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | A | GS1 Company Prefix | text | 390 | 99.2 % | 1 | 9 | always `081079703` |
| 2 | B | GTIN | text | 390 | 99.2 % | 390 | 14 | GTIN-14 |
| 3 | C | GTIN-8 | empty | 0 | 0.0 % | 0 | 0 | empty in every row |
| 4 | D | GTIN-12 (U.P.C.) | text | 386 | 98.2 % | 386 | 12 | |
| 5 | E | GTIN-13 (EAN) | empty | 0 | 0.0 % | 0 | 0 | empty in every row |
| 6 | F | Brand Name | text | 393 | 100.0 % | 6 | 17 | see §5 |
| 7 | G | Brand 1 Language | text | 393 | 100.0 % | 1 | 2 | always `en` |
| 8 | H | Product Description | text | 393 | 100.0 % | 386 | 200 | the only descriptive field |
| 9 | I | Desc 1 Language | text | 393 | 100.0 % | 1 | 2 | always `en` |
| 10 | J | Product Industry | text | 393 | 100.0 % | 1 | 7 | always `General` |
| 11 | K | Packaging Level | text | 393 | 100.0 % | 1 | 4 | always `Each` |
| 12 | L | Is Variable | text | 393 | 100.0 % | 2 | 1 | `N` 389 / `Y` 4 |
| 13 | M | Is Purchasable | text | 393 | 100.0 % | 2 | 1 | `Y` 389 / `N` 4 |
| 14 | N | Status Label | text | 393 | 100.0 % | 4 | 9 | see §5 |
| 15 | O | Height | empty | 0 | 0.0 % | 0 | 0 | |
| 16 | P | Width | empty | 0 | 0.0 % | 0 | 0 | |
| 17 | Q | Depth | empty | 0 | 0.0 % | 0 | 0 | |
| 18 | R | Dimension Measure | empty | 0 | 0.0 % | 0 | 0 | |
| 19 | S | Gross Weight | empty | 0 | 0.0 % | 0 | 0 | |
| 20 | T | Net Weight | empty | 0 | 0.0 % | 0 | 0 | |
| 21 | U | Weight Measure | empty | 0 | 0.0 % | 0 | 0 | |
| 22 | V | SKU | text | 388 | 98.7 % | 347 | 9 | the part number |
| 23 | W | Sub-brand Name | empty | 0 | 0.0 % | 0 | 0 | |
| 24 | X | Product Description-Short | empty | 0 | 0.0 % | 0 | 0 | |
| 25 | Y | Label Description | empty | 0 | 0.0 % | 0 | 0 | |
| 26 | Z | Net Content 1 Count | text | 1 | 0.3 % | 1 | 1 | one row (`60-030`) |
| 27 | AA | Net Content 1 Unit of Measure | text | 1 | 0.3 % | 1 | 2 | `1N` on that same row |
| 28 | AB | Net Content 2 Count | empty | 0 | 0.0 % | 0 | 0 | |
| 29 | AC | Net Content 2 Unit of Measure | empty | 0 | 0.0 % | 0 | 0 | |
| 30 | AD | Net Content 3 Count | empty | 0 | 0.0 % | 0 | 0 | |
| 31 | AE | Net Content 3 Unit of Measure | empty | 0 | 0.0 % | 0 | 0 | |
| 32 | AF | Brand Name 2 | empty | 0 | 0.0 % | 0 | 0 | |
| 33 | AG | Brand 2 Language | empty | 0 | 0.0 % | 0 | 0 | |
| 34 | AH | Description 2 | empty | 0 | 0.0 % | 0 | 0 | |
| 35 | AI | Desc 2 Language | empty | 0 | 0.0 % | 0 | 0 | |
| 36 | AJ | GPC Brick | text | 19 | 4.8 % | 1 | 35 | all `99999999 - Temporary Classification` |
| 37 | AK | GPC Attribute : GPC Attribute Value | empty | 0 | 0.0 % | 0 | 0 | |
| 38 | AL | Image URL | empty | 0 | 0.0 % | 0 | 0 | |
| 39 | AM | Image URL Validation | empty | 0 | 0.0 % | 0 | 0 | |
| 40 | AN | Target Markets | text | 89 | 22.6 % | 1 | 2 | always `US` when present |
| 41 | AO | Last Modified Date | text | 393 | 100.0 % | 48 | 10 | `2017-10-27` … `2026-08-10` |

**22 of 41 columns (54 %) are empty in every row.** The inspection reports each
one as a `COLUMN_ENTIRELY_EMPTY` note rather than dropping it, because a column
that exists and is empty is a fact about the export.

### Value distributions

| Column | Distribution |
| --- | --- |
| Brand Name | Axle Teknology 216 · TowPro 149 · ProAxle 19 · Carry On Trailers 4 · Axle Tek 3 · AxleTek 2 |
| Status Label | In Use 361 · PreMarket 25 · Archived 4 · Draft 3 |
| Is Variable | N 389 · Y 4 |
| Is Purchasable | Y 389 · N 4 |
| Target Markets | `US` 89 · blank 304 |
| GPC Brick | populated 19 · blank 374 |
| GTIN-14 leading pair | `00…` 386 · `90…` 4 |

---

## 5. Product / BOM relationships

**There is no BOM data in the supplied workbook.** No parent/component columns,
no quantity column, no kit membership. §5's instruction to "identify BOM
parent/component relationships" cannot be satisfied from this file. What was
built instead:

- The relational model exists in full — `boms` and `bom_items` in
  `src/server/db/schema.ts`, with `bom_items.component_product_id` linking a
  line to a stocked product where one exists.
- The importer can recognise a BOM sheet and link lines to their parent
  (`guessKind()` in `src/lib/import/inspect.ts`; `planImport()` in
  `src/lib/import/commit.ts`), proven against synthetic fixtures in
  `tests/unit/import.test.ts` `describe("BOM sheets")`.
- The one real BOM in the database (5 line items) was seeded by
  `scripts/seed-benchmark.ts` for the 11-500 benchmark product.

What the workbook *does* establish about product structure:

- **Every row is `Packaging Level: Each`.** There is not a single case row, so
  no packaging hierarchy can be derived. This is consistent with the four
  `90…`-prefixed GTIN-14s being the only rows with a non-zero indicator digit —
  and all four of those are `Archived`, `Is Purchasable: N`, `Is Variable: Y`.
- **SKU is not unique.** 347 distinct SKUs across 388 populated cells; 39 SKU
  values repeat, covering 80 rows.
  - **17 SKUs are reused across two brands** — every one of them a `60-xxx`
    number shared between `TowPro` and `ProAxle`. This is a legitimate
    private-label relationship, so `products.part_number` is unique per
    org + brand, *not* globally. The schema comment records this.
  - **22 SKUs repeat within a single brand.** These are genuine duplicates of
    identity — for example `12-808` appears 3 times, `19-115`, `11-860`,
    `11-865`, `12-805`, `18-125`, `12-807`, `21-205`, `11-310`, `11-315` twice
    each. The importer treats a repeated part number as a **scoped warning**,
    not an error, and a repeated GTIN as a blocking error
    (`tests/unit/import.test.ts`, "separates a cross-brand part number from a
    repeat inside one brand").
- **7 descriptions appear on more than one row**, e.g. `GENUINE AXLETEK GREASE
  SEALS, PAK/2` on rows 6 and 10, and `Hydraulic Brake 12" x 2"; Free Backing,
  Right Hand` on rows 50 and 391. Some of these pairs are an In-Use row and its
  Archived predecessor; others are not. They were not merged.

### Import outcome, as actually committed

`imports` table, one row: `ExportAllProducts_20260826220203076.xlsx`,
status `committed`, **393 rows total → 392 created, 0 updated, 1 skipped**.

The skipped row is **row 4**: no GTIN, no UPC, no SKU, `Product Description`
is the bare string `H-150-09`. It cannot be identified by any key, so it was
left out and the reason recorded, rather than being invented into a product.

Current catalogue: 392 products (390 `product`, 2 `non_sellable`),
1 554 identifiers (390 `gtin14`, 386 `gtin12`, 388 `sku`, 390
`gs1CompanyPrefix`), 7 brands (the workbook's 6 plus `Freedom Trailer Parts`
for the benchmark), 4 alternate part numbers, 2 fitments, 1 warning, 1 BOM with
5 items, 4 translations.

---

## 6. GS1 / UPC fields

| Field | Column | Finding |
| --- | --- | --- |
| GS1 Company Prefix | A | Single prefix `081079703` on 390 rows. 3 rows blank. |
| GTIN (GTIN-14) | B | 390 populated, **390 distinct — no duplicates**. **All 390 pass the mod-10 check digit.** |
| GTIN-12 (U.P.C.) | D | 386 populated, 386 distinct. **All 386 pass the check digit.** |
| GTIN-8 | C | Empty throughout. |
| GTIN-13 (EAN) | E | Empty throughout. |

**Cross-field agreement:** for all 386 rows carrying both, the GTIN-14 is exactly
`"00" + ` the UPC-12. **Zero mismatches.** The four rows whose GTIN-14 starts
`90` have no UPC-12, which is correct — a non-zero indicator digit means the
GTIN is not a UPC-A candidate.

**Rows lacking identifiers:** 3 rows have neither GTIN nor UPC (rows 2, 3, 4 —
all `Draft`). 4 rows have a GTIN but no UPC (the four `90…` archived rows).
5 rows have no SKU (rows 4, 40, 41, 44, 46).

The check-digit arithmetic is the same function the barcode engine uses
(`hasValidCheckDigit()` in `src/lib/barcode/gtin.ts`), with known-answer fixtures
in `tests/unit/barcode.test.ts` `describe("GTIN check digits")`.

**Nothing was corrected.** `tests/unit/import.test.ts` asserts "never rewrites a
GTIN into its canonical form" — the source form is stored, and the zero-padded
GTIN-14 is computed separately for matching only.

---

## 7. Sample-card content model

Derived from the §1/§7/§23 description of the 11-500 package, because the
artwork PDFs were not supplied.

**Front — full colour:** brand/logo region · part number · product title ·
subtitle/specification line · multilingual copy · alternate part number ·
large background/brand graphic · fitment/replacement footer.

**Back — black and white:** logo · part number · title/specification ·
multilingual copy · "This Pack Includes" BOM list · alternate part numbers ·
fitment/replacement section · genuine-parts/brand statement · country of
origin · barcode · warning/footer.

Every one of those is a bindable field on `ProductContext`
(`src/lib/data/context.ts`) or a first-class element kind
(`src/lib/design/schema.ts`: `text`, `image`, `shape`, `barcode`, `bomList`,
`group`). The three master templates in `src/lib/templates/factory.ts` place all
of them; `MASTER_TEMPLATE_DESCRIPTION` enumerates the list. Brand-critical
elements are `templateLocked`.

**The gap between the source data and this model.** The workbook supplies only
identity: brand, description, SKU, GTIN, UPC, status. It carries **no** product
name distinct from description, no subtitle, no country of origin, no
alternates, no fitment, no warnings, no translations, no BOM and no images. All
of that had to come from somewhere else, and for the benchmark product it came
from `scripts/seed-benchmark.ts`, tagged `custom.benchmarkSource`. For the other
391 products those fields are empty, and preflight reports them as
`PRODUCT_FIELD_MISSING` / `BINDING_UNRESOLVED` rather than printing a blank
where copy belongs.

---

## 8. Discrepancies

Surfaced, never reconciled (§2, §32). Produced by `presetDiscrepancies()` in
`src/lib/geometry/presets.ts` and shown in the UI; asserted by
`tests/unit/geometry.test.ts` ("surfaces CAD disagreements instead of
reconciling them").

### D1–D7 — geometry

| # | Preset | Field | Authoritative | CAD | Δ (in) | Severity |
| --- | --- | --- | ---: | ---: | ---: | --- |
| D1 | 409TF | trim length vs dieline sheet | 7.11175 | 7.1175 | −0.00575 | info |
| D2 | 409TF | trim width vs clamshell MAX CARD WIDTH (H) | 4.3675 | 4.343 | **+0.0245** | warning |
| D3 | 409TF | trim length vs clamshell MAX CARD LENGTH (F) | 7.11175 | 7.125 | −0.01325 | warning |
| D4 | 277TF | trim width vs dieline sheet | 4.343 | 4.3575 | −0.0145 | warning |
| D5 | 277TF | trim length vs clamshell MAX CARD LENGTH (F) | 5.7875 | 5.75 | **+0.0375** | warning |
| D6 | 206TF | trim width vs clamshell MAX CARD WIDTH (H) | 3.1175 | 3.14 | −0.0225 | warning |
| D7 | 206TF | trim length vs clamshell MAX CARD LENGTH (F) | 6.4775 | 6.437 | **+0.0405** | warning |

**D2, D5 and D7 are the ones that matter.** In each, the authoritative card is
*larger* than the clamshell drawing's stated maximum — by 0.0245 in on 409TF
width, 0.0375 in on 277TF length and 0.0405 in on 206TF length. If the drawings
are right, those cards do not fit the flange. **This needs the clamshell
vendor's answer before a production run.** The system prints the card at the
authoritative size and displays the discrepancy; it does not silently shrink it.

### D8 — cavity callout vs measured flange opening

On 409TF and 206TF the CAD cavity callouts carry `*` ("to theoretical sharp
corners") and describe the cavity **floor**, while the measurement in §3 is the
**flange opening** at the card plane. On 409TF, callout D is 3.188 in against a
measured 3.7655 in opening. These are different features and were not
reconciled; the thermoform draft angle explains the direction of the difference.
277TF's callouts have no `*` and are closer, but were still not substituted for
the measurement.

### D9 — the source file list

The spec names six files; four were supplied, and the workbook supplied is not
the one named. See §1.

### D10 — brand name collapses to six spellings of what may be four brands

`Axle Teknology` (216), `Axle Tek` (3) and `AxleTek` (2) are plausibly one
brand spelled three ways. They were imported as **three separate brand rows**,
because merging them is a business decision, not a data-cleaning one. The
database currently holds 7 brands for this reason.

### D11 — 39 repeated SKUs

17 across brands (private-label, legitimate) and 22 within one brand
(genuine duplicate identity). See §5. Neither was deduplicated.

### D12 — 5 descriptions end in the literal word "Copy"

Rows 2, 3, 298, 303, 355 — e.g. `… Wheel Nuts, PRE GREASED Copy`. Two are
`Draft`; **three are `In Use`** (SKUs `12-839`, `12-843`, `19-138`). This looks
like a Data Hub "duplicate record" artefact leaking into the description. If it
is, and one of those descriptions reaches a printed card, the word "Copy" prints
with it. Not stripped.

### D13 — 3 descriptions are bare part numbers

Rows 4 (`H-150-09`), 44 (`H-100-09`), 46 (`H-151-09`). The description field
contains an internal code, not a description. Row 4 was the skipped row; 44 and
46 imported with `recordType: non_sellable` (the 2 non-sellable products in the
database) because a bare internal code is not a sellable product name.

### D14 — 22 empty columns including every dimension and weight

Height, Width, Depth, Dimension Measure, Gross Weight, Net Weight, Weight
Measure, Sub-brand, Description-Short, Label Description, Net Content 2 & 3,
Brand 2, Description 2, GPC Attribute, Image URL, Image URL Validation, GTIN-8,
GTIN-13. Anything a card needs from these has to come from elsewhere.

### D15 — `Target Markets` blank on 272 of 361 In-Use rows

75 % of live products have no target market. GS1 treats target market as part of
a complete record.

### D16 — `GPC Brick` is `99999999 - Temporary Classification` on all 19 rows that have one

374 rows have no classification at all, and the 19 that do carry the temporary
placeholder. There is effectively no product classification in this export.

### D17 — one row has net content, 392 do not

SKU `60-030`, `1 / 1N`. Not enough to drive anything.

### D18 — `Last Modified Date` spans 2017-10-27 to 2026-08-10

Nearly nine years. Older rows may not reflect current packaging.

### D19 — brand swatches are derived, not specified

`BRAND_SWATCHES` in `src/lib/color/types.ts` carries Freedom Blue and Freedom
Red as CMYK converted from the identity package's sRGB values (`#1D9ED9`,
`#E82627`). Both are flagged `derivedFromRgb: true`. **A converted RGB brand
colour is an estimate, not an ink specification**, and it will not match a press
without vendor-supplied values.

---

## 9. Assumptions requiring human confirmation

Nothing in this list has been decided. Each needs an answer from the client,
the clamshell vendor or the printer.

| # | Assumption in force | Who confirms | Consequence if wrong |
| --- | --- | --- | --- |
| A1 | The spec's preset dimensions override the CAD drawings, including where the card is larger than the stated MAX CARD size (D2, D5, D7). | Clamshell vendor (Sinclair & Rush) | Cards do not fit the clamshell. A whole run is scrap. |
| A2 | The measured flange opening, not the `*`-marked CAD cavity callout, is the right cavity for design guidance (D8). | Clamshell vendor | Cavity overlay misplaced; artwork hidden behind the flange or wrongly flagged. |
| A3 | Cavity corner radii recovered from a raster edge profile are close enough for a non-printing guide. | Prepress + vendor | Overlay corners misleading. Marked `cornerRadiusIsApproximate` in the data. |
| A4 | 277TF's cavity may be re-centred on the 4.343 in authoritative trim rather than the 4.3575 in drawn width. | Clamshell vendor | Cavity offset by ~0.007 in per side. |
| A5 | Safe area = 0.1875 in for all three presets. | Printer | Copy too near the cut, or unnecessarily cramped. It is a preset property and is editable. |
| A6 | `Axle Teknology` / `Axle Tek` / `AxleTek` are three brands, not one. | Client | Wrong brand mark, wrong legal name on packaging. |
| A7 | A SKU repeated across TowPro and ProAxle is one private-labelled part. | Client | Two different parts share a part number on their cards. |
| A8 | A SKU repeated *within* one brand is a genuine duplicate that a human must resolve. | Client | A card generated from the wrong row. |
| A9 | The word "Copy" in three In-Use descriptions is an export artefact (D12). | Client | "Copy" prints on a production card. |
| A10 | Rows whose description is a bare internal code are not sellable products (D13). | Client | Real products missing from the catalogue. |
| A11 | Product name, subtitle, country of origin, alternates, fitment, warnings and BOM come from a system that was not supplied. | Client | Cards cannot be generated for the other 391 products; the fields resolve empty and preflight blocks. |
| A12 | 11-500 benchmark content in `scripts/seed-benchmark.ts` is representative of the real package. | Client | The §23 milestone proves the wrong structure. **The real artwork was never supplied — this is unverified.** |
| A13 | `Made in China` on the benchmark product is correct. | Client | A false country-of-origin statement is a customs and labelling offence. |
| A14 | Freedom Blue / Freedom Red CMYK conversions are acceptable until the brand supplies ink values (D19). | Brand owner + printer | Brand colour off on press. |
| A15 | Text black is 0/0/0/100, rich black 60/40/40/100, total ink limit 300 %, rich-black minimum type size 14 pt. | Printer | Registration problems on small type; ink limit exceeded. All four are per-organisation settings. |
| A16 | No ICC output intent is configured, so exported CMYK numbers are not tied to a printing condition. | Printer | Colour is whatever the RIP decides. The exporter warns `OUTPUT_INTENT_MISSING` on every export. |
| A17 | UPC-A at the GS1 nominal X of 0.013 in, magnification clamped to 80–200 %. | Printer + scanning | Symbol out of specification or unreadable at the shelf. |
| A18 | The GS1 export's single company prefix `081079703` belongs to this organisation. | Client | Publishing against a prefix the org does not license. |
| A19 | The workbook is a point-in-time export, not a live feed; re-import is the update path. | Client | Catalogue drifts from the source system. |

**Never silently fix conflicting source data.** Every item above is surfaced in
the application — geometry discrepancies on the preset screen, identifier and
duplicate findings in the import preview, missing product fields in preflight.
