# Testing

What is tested, what each suite actually proves, and — at the end — what is not
covered. The last section is the important one.

## How to run everything

```bash
npx tsc --noEmit                       # typecheck, strict
npx vitest run                         # the unit/integration suite
npx vitest run tests/unit/pdf.test.ts  # one file
npx vitest --coverage                  # v8 coverage, text + json-summary
npx playwright test                    # E2E, needs the app running on :3000
npx tsx scripts/verify-pdf.ts out.pdf  # validate a PDF that arrived by email
PDF_ARTIFACT_DIR=/tmp/cards npx vitest run tests/unit/pdf.test.ts
                                       # write real PDFs for all three presets
```

npm aliases: `npm test`, `npm run typecheck`, `npm run e2e`.

- **Vitest** — `vitest.config.mts`, node environment, `tests/unit/**/*.test.ts`,
  `@` aliased to `src`. `globals: false`, so every test imports `describe` /
  `it` / `expect` explicitly.
- **Playwright** — `playwright.config.ts`, chromium only, `workers: 1`,
  `fullyParallel: false`, viewport 1600 × 1000. A packaging editor is a desktop
  tool and the suite exercises it at a realistic working size, not a phone
  viewport. Base URL from `E2E_BASE_URL`, default `http://localhost:3000`;
  credentials from `E2E_EMAIL` / `E2E_PASSWORD`.

## Current state, measured

```
$ npx vitest run
 Test Files  12 passed (12)
      Tests  474 passed | 1 skipped (475)
   Duration  ~1.4 s
```

**These counts move.** The suite gained two files and nine tests during the
single review pass that produced this revision; treat the table below as a
snapshot and re-run `npx vitest run` rather than trusting it.

| Suite | Tests | Proves |
| --- | ---: | --- |
| `tests/unit/barcode.test.ts` | 77 | encodation tables, check digits, layout, magnification, GS1-128, QR/Digital Link |
| `tests/unit/preflight.test.ts` | 73 | every check code, at its threshold and either side of it |
| `tests/unit/gs1.test.ts` | 74 | credential crypto, redaction, adapters, retry/backoff, diff/accept, Digital Link |
| `tests/unit/pdf-validate.test.ts` | 62 | the §22 post-export checks, each one broken on purpose to prove it fails |
| `tests/unit/binding.test.ts` | 59 | variable data, transforms, formatting, visibility, BOM rendering |
| `tests/unit/import.test.ts` | 56 | the real workbook, plus awkward and hostile sheets |
| `tests/unit/pdf.test.ts` | 39 (+1 skipped) | geometry, fonts, colour, determinism, overlay exclusion |
| `tests/unit/geometry.test.ts` | 9 | the §2/§22 preset fixtures and rounded-rect maths |
| `tests/unit/interaction.test.ts` | 9 | resize, snap, align, distribute |
| `tests/unit/clipboard.test.ts` | 5 | the copy/paste envelope: "round-trips validated elements", "refuses a payload that is not a design document", "gives every pasted element a new id and offsets the set", "keeps a group pointing at its own copied children, not the originals", "pastes twice without the two copies sharing ids" |
| `tests/unit/units.test.ts` | 7 | the µpt substrate |
| `tests/unit/text-layout.test.ts` | 4 | line breaking on explicit newlines: "breaks where a newline says to, not where the width runs out", "keeps a blank line blank", "does not invent a trailing line for text that ends without a newline", "still wraps a long line that has no newline in it" |
| `tests/e2e/smoke.spec.ts` | 3 | the auth gate |

The one skipped test is `describe.runIf(process.env.PDF_ARTIFACT_DIR)("artifact
dump")`. It is not a disabled test — it is the hook that writes real PDFs to
disk for human inspection, and it runs when you give it a directory. §32 forbids
calling print QA complete without inspecting a generated PDF; that is how you
get the files.

---

## The unit suites, and what each one proves

### `units.test.ts` — the substrate

Seven tests, and they are load-bearing for everything else.

- **"maps every supplied preset dimension to an exact integer"** — every
  five-decimal inch dimension from spec §2 (4.3675, 7.11175, 4.343, 5.7875,
  3.1175, 6.4775, 0.25, 0.125) converts to an integer µpt with **no remainder**.
  This is asserted, not assumed. If it were false, every downstream geometry
  guarantee would be approximate.
- **"converts to PDF points exactly for the full-bleed canvases"** — 332.46,
  530.046, 330.696, 434.7, 242.46, 484.38 pt.
- **"does not drift over repeated addition"** — the property that justifies
  integers over floats.
- **"round-trips millimetres to sub-nanometre precision"**, **"parses the input
  forms a print operator actually types"** (`4.3675`, `4.3675in`, `4 3/8"`,
  `110.9mm`, `12pt`), **"formats without lying about precision"**, **"stores
  angles and percentages as integers"**.

### `geometry.test.ts` — the §2 and §22 fixtures

- **"produces the exact full-bleed canvas the spec requires"** — the §22 table
  (409TF 4.6175 × 7.36175, 277TF 4.593 × 6.0375, 206TF 3.3675 × 6.7275 in) is
  written into the test file **verbatim** and compared with **exact integer
  equality**. There is no tolerance to spend at this stage; tolerance belongs in
  the PDF-parsing layer, not here.
- **"keeps trim, safe and cavity nested inside the bleed canvas"** — bleed ⊃ trim
  ⊃ safe, and trim ⊃ cavity, for all three presets. This is what makes a
  containment-based preflight check meaningful.
- **"uses a 0.25 in trim corner on every preset"** and **"uses 0.125 in bleed on
  all four sides of every preset"** — §16, exactly.
- **"surfaces CAD disagreements instead of reconciling them"** — pins the two
  conflicts that matter to the numbers measured from the drawings: 409TF is
  **+0.0245 in** wider than its clamshell's stated MAX CARD WIDTH, and 206TF is
  **+0.0405 in** longer than its MAX CARD LENGTH. It also asserts that 206TF
  produces **no** dieline-disagreement row, because its authoritative trim
  matches its own dieline exactly — so the test fails if the reporter starts
  inventing discrepancies as well as if it starts hiding them.
- Rounded-rect maths: radius clamping to half the shorter side, a closed path
  with exactly four cubic segments, **"knows a box tucked into a rounded corner
  is outside the card"** (bounding-box containment would get this wrong in
  exactly the four places a card gets cut), and rotated bounding boxes.

### `barcode.test.ts` — known-answer fixtures

77 tests. The core of it is **known-answer testing against published tables**,
not round-tripping our own encoder against itself.

**The encodation tables are checked against the published element widths.**
"set A matches the published element widths" · "every character is 7 modules of
exactly four elements" · "carries the parities the symbology depends on" ·
"set B is set C reversed and set C is set A complemented". These are structural
identities of the EAN/UPC tables; an encoder built on a mistyped table fails
them.

**UPC-A `036000291452`** — the standard published example — is the anchor
fixture:

- **"encodes module for module"** — the full module string is compared against
  the expected pattern.
- **"decodes back to the same digits through the element-width table"** — the
  module string is *decoded* by an independent path (element widths → digits) and
  must come back as `036000291452`. Encoding and decoding through separate
  tables means a symmetrical mistake in one is caught by the other.
- **"descends the guards, the number system character and the check
  character"** — the guard extensions are 5X below the data bars, on exactly the
  right bars.
- **"sets the number system and check digits outside the symbol"** and **"places
  the light margin indicator flush with the outer edge"**.

**Check digits** have their own known answers, each one an `it()` named for the
body it is computing over: `81079703012`, `81079703000`, `81079703001`,
`03600029145`, `590123412345`, `0081079703012`. The first three are the
supplied workbook's own company prefix, so the arithmetic is proven against the
real data as well as against the textbook cases.

**Layout is asserted in physical units.** "is 113 modules wide including quiet
zones, at every magnification" · **"is 1.469 in wide at 100 %, the GS1
nominal"** · "uses an 11X left and 7X right light margin" for EAN-13.

**Magnification cannot distort.** "scales X strictly and never distorts width
independently" — §12's "prevent arbitrary horizontal distortion" is proven to be
structural, not a convention. Out-of-range magnifications are **clamped and
reported**, and a `fitWidth` target that cannot be reached inside the standard
is refused rather than silently exceeded.

**Code 128 / GS1-128** — the pattern table is checked for its published
invariants ("holds 107 characters" · "gives every character 11 modules, and the
stop character 13" · "gives every character an even number of bar modules" ·
"matches the published start and stop module strings"), the check character is a
known-answer modulo-103 computation, and the AI machinery is tested for FNC1
placement, subset switching, GTIN zero-padding into AI (01), and variable- vs
fixed-length separation.

**A whole `describe("regressions found by adversarial review")` block** exists
because these were found by attacking the encoder, not by writing it:
"reports a wrong check digit on a 13/14-digit GTIN as BAD_CHECK_DIGIT, not
BAD_LENGTH" · "never turns a signed number into a valid-looking GTIN" ·
"refuses AI data outside GS1 encodable character set 82" · **"refuses to build a
symbol from an unvalidated value instead of emitting one made of undefined"** ·
"keeps every geometric quantity finite when the font size is not" · "rejects QR
data it cannot hold instead of truncating it".

### `pdf.test.ts` — what the writer actually writes

Every assertion here re-parses the finished bytes. Nothing asks the writer what
it did.

- **Geometry** — page count is exactly two, front then back.
- **Font embedding** — "embeds every face as a tagged subset, with the program
  present"; **"does not apply OpenType shaping, so PDF advances match the layout
  engine"**. Read what that test actually does before leaning on it: it sets the
  single string `off->staff` in Archivo 400 and asserts the decoded text comes
  back with one glyph per code point — enough to prove `liga` and `calt` are off
  on that face, and **not** a sweep of every character pair across every shipped
  face. The exhaustive per-face check is the subset-integrity test below.
- **Subset integrity** — **"every glyph in every embedded face matches the source
  outline"**: `/FontFile2` is extracted back out of the finished PDF and each
  subset glyph is compared with the same glyph in the source font through the
  `/ToUnicode` CMap — advance width exactly, outline bounding box to the nearest
  font unit. This is the guard on the `@pdf-lib/fontkit` `loca` defect
  documented in `docs/print-pipeline.md`; deleting the workaround makes it fail
  on the first Inter face. Also "aligns only the fonts that need it, and leaves
  the rest byte-identical" and "leaves a non-TrueType payload untouched rather
  than guessing".
- **Colour** — "writes DeviceCMYK operators and **no RGB operator** for an
  all-CMYK card"; the device-gray policy is honoured when a deployment asks for
  it; a spot ink converts to its alternate **and says so**.
- **Text positioning** — "sets a tracked span at exactly the x and baseline the
  plan computed" and "places every plan span at its own position, not a
  re-laid-out one". This is the assertion that the editor and the PDF cannot
  disagree.
- **Overlays** — "no overlay text or overlay marks reach the production PDF".
  All text is decoded out of the file through the `/ToUnicode` CMaps and checked
  against the copy the plan placed; none of PROOF, BLEED, TRIM, SAFE AREA,
  CAVITY, PREFLIGHT, REVISION or APPROVAL appears anywhere. The proof's overlay
  is separately asserted to exist, on a sheet larger than the card, with the slug
  below the artwork.
- **Determinism** — "two runs of the same input produce byte-identical
  production PDFs", the same for proofs, and "rotation and transparency stay
  deterministic".
- **Barcodes** — bar modules are individual filled rectangles, one per module.
- **Placed images** — the raster is embedded, its colour space reported, and RGB
  raises a warning; a missing asset throws a **typed error rather than drawing a
  placeholder**; an unplaceable format is rejected.
- **Output intent** — no intent when none is configured, and it says so; a real
  ICC profile embedded when supplied; `GTS_PDFA1` on request; **a profile that is
  not an ICC profile is refused rather than embedded as a fake**.

### `pdf-validate.test.ts` — the §22 checks, each proven to fail

62 tests. The structure is the point: for every check, there is a test that
**breaks the property on purpose and asserts the check catches it**. A validator
nobody has seen fail is not evidence.

| Check | Broken how |
| --- | --- |
| `PAGE_COUNT` | a page removed |
| `PAGE_BOXES` | TrimBox moved by a point · BleedBox dropped · an ArtBox added |
| `PHYSICAL_DIMENSIONS` | the page made the wrong size |
| `FONT_EMBEDDING` | the font program stripped · a required family absent · the right family at the wrong weight |
| `COLOR_SPACES` | RGB reaching a CMYK production file (and passing the same file when RGB is allowed) |
| `IMAGE_RESOLUTION` | a low-resolution placement |
| `BARCODE_PRESENCE` | expected digits absent · no barcode at all · not applicable when none was planned |
| `NO_EDITOR_OVERLAYS` | every overlay word, one at a time — plus "does not fire on ordinary copy containing a longer word" |
| `NO_CLIPPING` | content outside a shrunken MediaBox · an element left hanging off the artboard |

Plus: "identifies a preset from a measured page size", "reads a file saved with
object streams", "reports an embedded output intent when the deployment
configures one", and — twice — **"never claims PDF/X conformance"**, once on the
report object and once on the rendered text.

### `preflight.test.ts` — every check at its threshold

73 tests over every code in `CHECK_CODES`, organised by area: document geometry,
bleed coverage, trim and safe area, cavity, placed assets, text and required
content, variable data, barcodes, colour, and report shape.

The tests that show the engine is calibrated rather than merely present:

- **"grades a corner overrun by whether it actually reaches the cut"** and
  **"grades a stray element by how load-bearing it is"** — severity is a
  judgement about consequence, not a fixed constant per code.
- **"does not flag full-bleed artwork as crossing trim"** and **"does not grade a
  full-bleed background, most of which is bound to overlap"** — the false
  positives that teach an operator to ignore preflight.
- **"tests a rotated element by its rotated bounds"**.
- **"never calls an upscale print-ready"** (§8).
- **"blocks when a required text block resolves empty"** and "blocks when a
  required element is switched off, and errors when data hid it".
- **"separates an unknown template path from an empty product field"** — a
  template defect and a data gap need different people to fix them.
- **"blocks when a pack-contents list drops rows"** and "blocks when a
  pack-contents list cannot fit its frame" — §11's "never silently clip
  production copy".
- **"flags bars that cannot be read, and says the number is an ink proxy"** — the
  contrast check is honest about being arithmetic on a PDF rather than a
  verifier on a printed sample.
- **"says once, honestly, that there is no output intent"**.
- **"returns identical findings for identical input"** — the report is
  deterministic, so a diff between two runs means something changed.

Three regression blocks record defects found by attacking the engine: the
quiet-zone measurement being taken from the bar band rather than the symbol box
(6 tests); an element hidden by design not being a defect; and both the
organisation's and the profile's duplicated thresholds being honoured, with the
stricter one winning.

### `binding.test.ts` — variable data

59 tests. `resolveBinding` distinguishes **resolved / empty / missing / unknown
path** as four different outcomes, because they need four different responses,
and maps each onto a preflight code. It **"does not walk the prototype chain"**,
**"never stringifies an object onto a card"**, and **"refuses to flatten a
collection or an object into a line of text"**.

Token substitution "never leaves a literal `{token}` on the card and reports the
miss", handles `{{` and `}}` as literal braces, and prints an unbalanced brace
literally while reporting it.

`renderBomLines` **"reproduces the spec's reference line exactly"** — §11's
`2) Inner Bearing (L44643)` is a fixture, not an example.

A `describe("data hygiene")` block covers the formatting traps: a date-time with
no offset read as UTC rather than off the renderer's clock; a date that does not
exist rejected rather than rolled forward; a number under a date pattern
reported instead of printing 1970; a numeric string whose commas are not group
separators refused; a word opening with an accented letter title-cased on its
first letter, not its second.

### `import.test.ts` — the real workbook, and hostile ones

56 tests. `describe("GS1 US Data Hub export (docs/source)")` runs against
**the actual supplied file**:

- "inspects one sheet with 41 columns and 393 data rows"
- "maps the export through the GS1 adapter, not by guesswork"
- "previews 393 rows with the known GTIN, brand and status distribution"
- "treats a repeated GTIN as an error and a repeated part number as a scoped
  warning"
- "classifies bare internal codes as not sellable instead of dropping them"
- **"skips only the one row that cannot be identified at all"**
- "keys on the GTIN first and on brand plus part number when there is none"
- **"retains the whole source row for provenance"**
- **"never rewrites a GTIN into its canonical form"**
- "re-imports the same file as unchanged, and sees a real edit as an update"
- "plans deterministically"

The awkward-sheet block uses synthetic fixtures for the shapes real supplier
workbooks have: a header row below a merged banner, blank header cells,
duplicated header names, an empty sheet, a sheet with no identifier column, and
**"keeps a long numeric identifier out of exponent notation"** — the failure
that would destroy a U.P.C.

Nine `describe("regression: …")` blocks record specific defects, including a
`__proto__` column heading, "does not accept a one-cell notice line as a
confident header row", and "reads the sheet the inspection offers, not whichever
sheet is first".

### `gs1.test.ts` — credentials, transport, and never leaking

74 tests. Covered in detail in `docs/gs1-integration.md`. The four groups:

1. **Credential crypto** — round trip, fresh IV per encryption, clean failure
   under a wrong key or tampered tag, **AAD binding so a row copied between
   tenants will not open**, malformed payloads rejected before touching the
   cipher, rotation.
2. **Redaction** — key-name classification, depth, cycles, free text, URLs, a
   hostile `__proto__` key, and **registered literal secrets** so a remote
   echoing the credential back cannot leak it.
3. **Transport** — equal-jitter backoff inside the expected window, 5xx retried
   and 4xx not, `Retry-After` honoured and capped, timeout enforced by the
   adapter itself even when the fetch implementation ignores the abort signal.
4. **Diff and accept** — no auto-apply, no mutation of the local context, and a
   path that is not in the diff or is marked unacceptable is refused.

Three "the adapter must not invent an answer" blocks assert the negative space:
a 2xx with no recognisable record is refused rather than fabricated into one,
"verified" is never reported on the strength of a 2xx alone, and a record
describing a different GTIN than the one requested is rejected.

### `interaction.test.ts` — editor maths

9 tests on the pure rect functions the editor is built from: the dragged edge
moves and the opposite edge does not; a constrained resize keeps the aspect ratio
**exactly**; centre-resize; **"clamps instead of flipping through zero"**;
snapping pulls onto the safe-area edge from within tolerance and leaves an
element alone when nothing is within it; align to selection bounds; distribute to
equal gaps.

---

## E2E

`tests/e2e/smoke.spec.ts`, three tests, all on the auth gate:

1. "signed-out visitors are sent to the login gate" — `/products` redirects to
   `/login`.
2. "bad credentials are rejected without saying which field was wrong" — the
   error says "not recognised" and does not disclose whether the email exists.
3. "the default account can sign in and reach the overview".

A saved storage state is kept at `artifacts/state.json` for reuse.

**This is a smoke suite, and calling it more than that would be dishonest.** It
does not drive the editor, the import wizard, an export or an approval. Those
flows have been exercised by hand and captured as screenshots under
`artifacts/screens/` (login, overview, import mapping, import preview, import
committed, new card, editor front, editor back, 409TF editor front and back,
editor preflight, export) — but a screenshot is a record, not a regression test.
Listed under *Not covered* below.

---

## PDF geometry validation, and its documented tolerance

Three independent layers, deliberately.

### Layer 1 — the presets, exact

`geometry.test.ts` compares full-bleed dimensions against the §22 table with
**integer equality**. No tolerance.

### Layer 2 — the written file, ±0.001 pt

`src/lib/pdf/validate.ts` re-parses the finished bytes and compares each page
box against the §22 table, which is **hard-coded in the validator** rather than
imported from the preset module. That is the point: a validator that reads its
expectations from the same constants the writer used can only prove the two are
consistent with each other. This one proves the exported page matches the
document that specifies the product.

```ts
export const BOX_TOLERANCE_PT = 0.001;
```

**Why 0.001 pt.** It is 1/72000 in = 0.35 µm. µpt → pt is an exact decimal shift
and the writer rounds emitted coordinates to 1e-6 pt, so a correct box lands
within 5 × 10⁻⁷ pt of its target — the tolerance is three orders of magnitude
looser than the writer's own precision, and still far finer than any imagesetter
can address. Any *real* error — a box set from the wrong rect, a missing bleed
allowance — is at least 0.07 pt (0.001 in), and is caught with a margin of 70×.
The tolerance exists only to absorb decimal text being parsed back through a
binary float.

Measured, for all three presets:

| Preset | MediaBox / CropBox / BleedBox (pt) | TrimBox (pt) |
| --- | --- | --- |
| 409TF | 332.46 × 530.046 | `[9, 9, 323.46, 521.046]` |
| 277TF | 330.696 × 434.7 | `[9, 9, 321.696, 425.7]` |
| 206TF | 242.46 × 484.38 | `[9, 9, 233.46, 475.38]` |

Physical dimensions are reported to **five decimal places of an inch**
(`DIMENSION_DECIMALS = 5`), because the supplied presets carry five and
reporting four would round a production dimension in the one place an operator
reads it.

### Layer 3 — clipping, ±0.25 pt

```ts
export const CLIP_TOLERANCE_PT = 0.25;
```

**A different tolerance for a different reason,** and it is stated in the report
rather than buried: 0.25 pt ≈ 0.0035 in covers two measurement artefacts. A text
run's extent is reconstructed as an **em-box** from the font's `/Ascent` and
`/Descent`, so it is slightly larger than the ink; and a stroked path is measured
on its **centreline**, so a hairline can genuinely put ink up to half its line
width past the recorded extent. Content painted exactly to the page edge — which
is what full-bleed artwork is — sits at **0 overhang** and passes.

`inspectPdf()` labels both approximations in its own types rather than
presenting them as exact, and the rendered report prints the reasoning next to
the measurement.

### Every check carries a measurement

There are no bare booleans. "TrimBox correct" is useless in a press-side
argument; "TrimBox 9, 9, 323.46, 521.046 pt; expected 9, 9, 323.46, 521.046 pt;
tolerance ±0.001 pt" settles it. `not_applicable` is a real outcome — a card
with no placed raster has nothing to measure, and saying PASS would imply a
measurement that never happened.

### Where validation runs

1. In `tests/unit/pdf-validate.test.ts`, on fixtures for all three presets.
2. **On every real export.** `src/server/exports.ts` and `src/server/batch.ts`
   validate the bytes after writing them and store the report on
   `export_artifacts.validation`. A file that fails its own check is recorded
   with `status: "invalid"` rather than quietly shipped.
3. By hand: `npx tsx scripts/verify-pdf.ts out.pdf`, which runs the same checks
   on a file that arrived by email, with no database and no running app, and
   exits 1 on failure so it can gate a build.

### What it explicitly is not

Every report carries a `complianceNote` saying so, and the rendered text ends
with it:

> This report verifies PDF structure … It is NOT a PDF/X conformance test — it
> does not evaluate ICC transforms, XMP metadata or ISO 15930 rules, and it never
> asserts PDF/X conformance.

---

## Rendered output, inspected by eye

§32 forbids marking print QA complete without inspecting a generated PDF.

- `artifacts/pdf/` — production and proof PDFs for all three presets, six files
  (plus `artifacts/pdf/review/`, an earlier copy of the same six).
- `artifacts/pdf/png/` — those PDFs rendered to PNG, page by page (14 images).
  **There is no `artifacts/review/` directory**; earlier drafts of this document
  and of `docs/final-gauntlet-report.md` named one that never existed.
- `artifacts/renders/` — 8 PNGs of the 11-500 benchmark card: 409TF production
  and proof, both pages; 206TF production only; 277TF proof only. The set is not
  symmetric, and nothing regenerates it.
- `artifacts/screens/` — 62 application screenshots accumulated over the §29
  review passes.

These are **records of a manual review**, not automated assertions. There is no
visual-regression baseline and no perceptual diff. See below.

---

## What is NOT covered

Stated plainly, because a testing document that only lists strengths is
marketing.

### No visual regression testing
No baseline images, no perceptual diff, no `toHaveScreenshot()`. The screenshots
in `artifacts/` were reviewed by a person once. A CSS change that breaks the
artboard, the inspector or a preflight badge will not fail any test. §29 LOOP 8
lists "visual regression" among the things to re-run; there is nothing to re-run.

### E2E is a smoke test only
Three tests, all on authentication. **Not covered end to end in a browser:**
the editor (drag, resize, rotate, snap, undo/redo, layers, text editing), the
import wizard past the upload screen, background upload, export, approval, batch
generation, the GS1 settings screen. Every one of those has unit coverage of its
pure logic and a manual screenshot; none has a test that would catch a
regression in the wiring between them.

### No test of the server layer against a real database
`src/server/*` — designs, exports, batch, imports, assets, gs1-actions,
templates — has **no automated test at all**. That includes:
- the revision immutability rule (`docs/data-model.md`), which is enforced in
  `src/server/designs.ts` and verified only by reading the code;
- organisation isolation and `assertSameOrg()`;
- the RBAC capability matrix;
- the blocking-preflight export gate and the privileged override;
- the batch slice-advance and resume behaviour;
- the import commit transaction.

These are the highest-consequence code paths in the application and they are
covered by construction and review, not by tests. **This is the single largest
gap.**

### No accessibility test
No axe run, no automated contrast check, no keyboard-navigation test. §27 is
addressed by construction — labelled inputs, `aria-current` on nav, real `<th>`,
`role="group"` on toolbar clusters, `aria-label` on every icon button, focus-visible
left to `globals.css` — and verified by reading, not by tooling.

### No performance test
§26's requirements are met by design (external store with selector
subscriptions, debounced autosave, no base64 blobs in rows, slice-advancing
batch). **Nothing is measured.** There is no benchmark for a complex card, no
frame-timing test, and no assertion that the tree does not re-render on pointer
move — only the architecture that makes it true.

### No load or concurrency test
Two designers editing one card, two concurrent saves racing for the same
revision number, a batch of 400 cards against a real database — none of it is
exercised. The unique index on `(design_id, revision_number)` means the *second*
concurrent save fails rather than interleaving, which is the right outcome, but
that is an argument, not a test.

### No PDF/X conformance test
There is no free, well-maintained PDF/X validator (veraPDF validates PDF/A, not
PDF/X). `validate.ts` checks structure and says explicitly that it is not a
conformance test. Certified output requires a commercial tool; the steps are in
`docs/print-pipeline.md`.

### No colour-accuracy test
The CMYK→sRGB preview is the naive multiplicative model and is never claimed to
be a proof. Nothing measures its ΔE against an ICC transform, because it is not
trying to be one.

### No test against the missing source files
`11-500 front.pdf`, `11-500 back.pdf` and `Aftermarket Rev B 2026.8.10.xlsx`
were never supplied (`docs/source-audit.md` §1). The §23 benchmark is a
structural reproduction that **has never been compared with the real artwork**,
and the multi-sheet BOM import path is proven only against synthetic fixtures.

### No test of the malware-scanning hook
`assets.scan_status` defaults to `skipped` and no engine is wired in. The hook
exists; there is nothing to test.

### The build is typechecked but not built in CI
`npx tsc --noEmit` is clean. `next build` is **not** part of any automated gate
and was not run as part of the verification recorded in
`docs/final-gauntlet-report.md`, so a build-time-only failure (a bad dynamic
import, a missing traced font file) would not be caught.

### Coverage is available but not enforced
`npx vitest --coverage` runs v8 coverage with a text and json-summary reporter.
There is **no threshold configured and no CI gate**, so coverage can fall
without anything failing.
