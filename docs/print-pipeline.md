# Print pipeline: what this stack guarantees, and what it does not

This document records what the PDF exporter in `src/lib/pdf/` can actually
promise a printer, and what it cannot. Spec §15 requires that if strict PDF/X
conformance cannot be guaranteed by the chosen stack we generate a high-quality
CMYK production PDF, run a documented preflight, label the compliance status
clearly, and document the remaining step required for certified PDF/X output.
Spec §32 forbids faking CMYK and faking PDF/X compliance. This file is the
"document the remaining step" half of that bargain.

Everything below was verified against the versions this repository pins:

| Component | Version |
| --- | --- |
| `pdf-lib` | 1.17.1 |
| `@pdf-lib/fontkit` | 1.1.1 |
| Output PDF header | `%PDF-1.7` |

## The one-line summary

The exporter produces a **DeviceCMYK, all-vector, subset-font-embedded, correctly
boxed production PDF**. It does **not** produce a certified PDF/X file, it never
says it does, and `complianceStatus.claimsPdfX` is a literal `false` in the type
system so no code path can start claiming otherwise.

`renderProductionPdf()` returns
`{ bytes, complianceStatus, notes, pageBoxes }`. `complianceStatus.level` is one
of:

- `cmyk-production-pdf` — no output intent configured
- `cmyk-production-pdf-with-output-intent` — a real ICC profile is embedded
- `proof-pdf` — the proof exporter's output, never press artwork

`complianceStatus.remainingForPdfX` carries the same list as the
[Getting to certified PDF/X](#getting-to-certified-pdfx) section below, so the
export screen can show it without duplicating prose.

---

## The compliance strings, quoted

These are the exact strings the export screen shows. They are produced by
`mergeStatus()` and `REMAINING_FOR_PDFX` in `src/lib/pdf/production.ts`; this
document does not paraphrase them, so the two cannot drift.

`complianceStatus.label`, one of three, depending on what was actually written:

> "CMYK production PDF. No output intent embedded, and not certified PDF/X."

> "CMYK production PDF with an embedded {ICC colour space} output intent
> ({condition name}). Not certified PDF/X."

> "Proof PDF with non-printing overlay. Not press-ready artwork."

`complianceStatus.remainingForPdfX`, all four entries, verbatim:

1. > "Run the exported file through a PDF/X-4 conversion and verification step
   > (Ghostscript's pdfwrite with a PDF/X definition, callas pdfToolbox, or an
   > Acrobat Preflight profile) — pdf-lib writes no XMP and cannot claim
   > conformance."

2. > "Supply the press's ICC output profile so an OutputIntent can be embedded; a
   > PDF/X file without one is not conforming."

3. > "Convert or replace placed RGB rasters: this exporter embeds them as-is with
   > no ICC transform, and PDF/X-4 requires either a calibrated colour space or
   > the output intent's space."

4. > "Decide the fate of any /Separation (spot) ink: pdf-lib emits only device
   > spaces, so spots are currently flattened to their CMYK alternate."

And from the type itself, in `src/lib/pdf/production.ts`:

```ts
/** Permanently false. Nothing in this exporter may set it true. */
claimsPdfX: false;
```

It is typed as the literal `false`, not `boolean`. There is no assignment a
future code path could make that would compile.

---

## Geometry: integer micro-points end to end

Every physical quantity in this system — page size, element frame, corner
radius, bleed, safe inset, barcode module width, font size, tracking, stroke
weight, baseline — is an **integer number of micro-points**.

```
1 PDF point = 1 000 000 µpt
1 inch      =        72 pt = 72 000 000 µpt
1 mm        =  72/25.4 pt ≈  2 834 645.669 µpt   (rounded on conversion)
```

Defined once in `src/lib/units.ts`. Reasons in full in
`docs/architecture.md`; the two that matter to a printer:

- **µpt → pt is an exact decimal shift.** The exported page geometry is never
  the result of an irrational scale factor. A micron model would put a `25.4/72`
  factor on every coordinate that reaches the page.
- **Integers cannot drift.** Every add and subtract in layout, snapping and
  export is exact, so a card that has been dragged, nudged, grouped and
  re-aligned two hundred times is still on exactly the coordinates arithmetic
  says it should be.

1 µpt = 3.5 × 10⁻⁷ in ≈ 0.35 nm — roughly five orders of magnitude finer than
any imagesetter. Rounding error cannot reach a physical consequence.

Every one of the supplied five-decimal preset dimensions maps to an exact
integer with no remainder: 7.11175 in × 72 000 000 = 512 046 000 µpt.
`tests/unit/units.test.ts` asserts this for all six preset dimensions rather
than assuming it.

### The single coordinate flip

Card space is **origin at the top-left of the bleed box, +x right, +y down** —
the same orientation as the screen and as SVG, so the editor needs no transform
at all. PDF's origin is bottom-left with +y up.

**That flip happens in exactly one place:** `cardSpace()` in
`src/lib/pdf/draw.ts`, which every drawing operation in both the production and
the proof writer goes through. There is no second flip anywhere in the codebase
to get out of sync with it, and no element-level y-negation to forget.

### The pipeline

```
preset (µpt)                 src/lib/geometry/presets.ts
  └─ trimRect / bleedRect / safeRect / cavityRect      still µpt
       └─ planSide()          doc + product → DrawOp[] in bleed space, µpt
            ├─ Artboard       µpt × zoom → SVG user units        (screen only)
            ├─ preflight      measures the plan, in µpt
            └─ PDF writer     cardSpace() → uptToPt() → page coordinates
```

`uptToPt()` is documented in `src/lib/units.ts` as "the only conversion the PDF
writer is allowed to use". Emitted coordinates are rounded to 1e-6 pt so a
rotation matrix cannot vary in its last bit across V8 builds — which is part of
what makes byte-identical re-export possible.

### Rounded trim corners

`roundedRectPath()` in `src/lib/geometry/types.ts` returns the 0.25 in trim
corner as an ordered list of line and cubic-Bézier segments (κ = 0.5522847…).
**The same function** feeds the SVG artboard's trim rule, the proof PDF's trim
overlay and the production PDF's clipping path, so the corner on screen, the
corner on the proof and the corner the RIP clips to are the same curve by
construction, not by agreement.

`clampRadius()` clamps to half the shorter side, which is what both PDF and SVG
renderers do — so a nonsense radius degrades identically in both.

Containment against a rounded rectangle is a real test, not a bounding-box
approximation: `roundedRectContains()` does straight-edge containment plus a
per-corner circle test. Without it, "the barcode is inside the safe area" would
be wrong in exactly the four places a card gets cut.

### Page boxes

```
MediaBox = CropBox = BleedBox = the full-bleed canvas, at the origin
TrimBox                       = the card, inset by the bleed on all four sides
ArtBox                        = absent
```

A RIP that honours TrimBox therefore knows where to cut without being told
separately. The measured values for all three presets are in the table further
down, verified to ±0.001 pt.

---

## The colour model

**Spec §14 is non-negotiable and this is how it is met.**

### CMYK tints are the source of truth

`PrintColor` (`src/lib/color/types.ts`) is a discriminated union:

| Space | Shape | Notes |
| --- | --- | --- |
| `cmyk` | `{ c, m, y, k }` | tints in **tenths of a percent**, 0…1000 |
| `gray` | `{ k }` | ink coverage; 1000 = solid |
| `spot` | `{ name, alternate: cmyk, tint }` | a CMYK alternate is **required**, not optional |
| `none` | `{}` | paints nothing; distinct from 0 % ink |

Tints are stored in tenths of a percent so "38.5 %" round-trips exactly. There
is no float anywhere in a colour value, so an ink recipe cannot drift, and
`C0 M0 Y0 K100` cannot become `K99.9997` through a save cycle.

**No RGB value is ever stored as print data.** The database columns that hold
colour (`design_elements.colors`, `brands.swatches`, the document's element
records) hold `PrintColor` objects. There is no hex string in the print path.

### RGB exists in exactly one direction, for exactly one purpose

`cmykToPreviewRgb()` converts CMYK to sRGB **for the browser, which cannot show
CMYK**. It is the naive multiplicative model, deliberately:

```
r = 255 · (1 − min(1, c·(1−k) + k))     …and the same for g and b
```

It is fast, stable, and — the point — **honest about what it is**. It is not an
ICC transform and the UI never labels its output as a colour-accurate proof.
The conversion is one-way in the render path: nothing reads a pixel back off the
screen and calls it ink.

The reverse direction exists only for *imported* values — a hex swatch a user
pastes, a colour picked out of an uploaded RGB asset. `rgbToCmykEstimate()` uses
simple GCR, and the module comment requires every call site to raise a preflight
warning, because a converted RGB value is an estimate and not a specified ink
recipe.

**Consequence for the brand swatches, stated plainly.** Freedom Blue and Freedom
Red are specified in the identity package as sRGB (`#1D9ED9`, `#E82627`). The
shipped CMYK builds (78/20/0/0 and 0/90/88/0) are *derived* from those, and both
carry `derivedFromRgb: true` with the source hex. **They will not match a press
without vendor-supplied ink values.** See `docs/source-audit.md` D19 and A14.

### What reaches the PDF

`src/lib/pdf/color.ts` is the only module that turns a `PrintColor` into pdf-lib
components, and it **never calls `rgb()`**. Verified structurally rather than by
inspection: `tests/unit/pdf.test.ts` asserts that for an all-CMYK card every
page contains `k`/`K` operators and **zero** `rg`/`RG` operators.

Grayscale defaults to DeviceCMYK `0/0/0/K` rather than DeviceGray. Both are
legal, but a RIP is free to re-separate DeviceGray across all four plates, which
would silently turn a K-only back into a four-colour job. Writing `0/0/0/K` says
exactly what the press should do. A deployment whose RIP is configured the other
way passes `grayPolicy: "device-gray"`.

Spot inks convert to their CMYK alternate and raise a `SPOT_CONVERTED` info note
naming the ink, its tint and the exact build that was written — because pdf-lib
cannot emit a `/Separation` space. The architecture supports spots; the current
writer cannot produce a spot plate, and it says so on every export that has one.

**A CMYK number is not colour management.** Without an output intent those
numbers have no defined appearance. That is why `OUTPUT_INTENT_MISSING` is a
warning on every export until a deployment supplies a real profile.

---

## Black rules

§14 asks for configurable production rules. They live in `BlackRulesSchema`
(`src/lib/color/types.ts`) and are stored per organisation in
`organizations.settings`, because a different press means different numbers, not
a different build.

| Rule | Default | What it does |
| --- | --- | --- |
| `textBlack` | `0/0/0/100` | The production standard for body copy. Single-plate, so small type cannot go out of register. |
| `richBlack` | `60/40/40/100` | The build for large solid black areas, where 100K alone reads brown. Configurable — every printer has an opinion. |
| `totalAreaCoverageLimit` | `3000` (= 300.0 %) | Total ink limit. A common sheetfed coated limit; a web or uncoated job wants less. |
| `richBlackMinTextSize` | `14 000 000 µpt` (= 14 pt) | Below this size, rich black is a registration risk and is flagged. |

`totalAreaCoverage()` sums the four tints of the *effective* CMYK, so it
correctly measures a spot at 60 % tint and a gray, not just a literal CMYK
value.

Four preflight checks enforce them (`src/lib/preflight/checks/color.ts`):

- **`INK_LIMIT`** — a recipe over the limit. Asserted by
  `tests/unit/preflight.test.ts` ("flags a recipe over the ink limit"), and the
  organisation's limit is honoured when it is tighter than the profile's
  ("enforces the organisation's total ink limit when it is tighter than the
  profile's").
- **`RICH_BLACK_SMALL_TEXT`** — rich black on type under the threshold ("flags
  small type set in rich black"). The stricter of the profile and the
  organisation threshold wins.
- **`GRAYSCALE_VIOLATION`** — colour ink on a standard back. §7 requires the
  standard back template to flag non-grayscale content, and §7 equally requires
  that an authorised template be allowed to use colour: the check softens when
  the template permits it ("flags colour ink on a grayscale back and softens it
  when the template allows colour"). `isGrayscale()` is the test, and it treats
  `gray`, `none` and a CMYK value with `c = m = y = 0` as grayscale.
- **`OUTPUT_INTENT_MISSING`** — said once per export, honestly, and silent when
  the deployment supplies a profile.

**What is not done:** the exporter sets no `/OP`, `/op` or `/OPM`. Overprint —
including the usual "small black text overprints" rule — is left to the RIP's
defaults. That is a real gap for a job that depends on it, and it is listed
below under *Other gaps worth stating* rather than glossed.

---

## The barcode pipeline

Barcodes are production-critical (§12) and are **vector from end to end**. There
is no rasterisation step and no image XObject: `renderBarcode()`
(`src/lib/barcode/index.ts`) returns a `BarcodeRender` — a list of `BarModule`
rectangles in µpt plus human-readable text runs plus the four quiet zones — and
both the SVG artboard and the PDF writer draw those same rectangles.

| Symbology | Module | Status |
| --- | --- | --- |
| UPC-A | `upc.ts` | full encodation, guard extensions, HRI placement |
| EAN-13 | `upc.ts` | full, including first-digit-outside-guard placement |
| GS1-128 | `code128.ts` | AI parsing, subset switching, FNC1 separators |
| QR / GS1 Digital Link | `qr.ts` | matrix from `qrcode`, drawn as vector modules |

### Dimensions, and why they are what they are

| Constant | Value | Source |
| --- | --- | --- |
| `NOMINAL_X_UPT` | 936 000 µpt = **0.013 in** | GS1 nominal X-dimension for UPC-A/EAN-13 |
| `NOMINAL_UPCA_BAR_HEIGHT_UPT` | 73 440 000 µpt = **1.02 in** | GS1 nominal bar height |
| `MIN_MAGNIFICATION_BPS` / `MAX_MAGNIFICATION_BPS` | 8 000 / 20 000 = **80 % – 200 %** | the GS1 magnification range |
| `UPCA_QUIET_LEFT_X` / `UPCA_QUIET_RIGHT_X` | 9 X / 9 X | GS1 UPC-A light margins |
| `EAN13_QUIET_LEFT_X` / `EAN13_QUIET_RIGHT_X` | 11 X / 7 X | GS1 EAN-13 light margins |
| `CODE128_QUIET_X` | 10 X | GS1-128 light margin |
| `NOMINAL_X_CODE128_UPT` | 1 403 150 µpt = **0.495 mm** | GS1 General Specifications |
| `NOMINAL_X_QR_UPT` | 1 743 307 µpt = **0.615 mm** | GS1 Digital Link QR nominal |
| `QR_MIN_/QR_MAX_MAGNIFICATION_BPS` | 6 450 / 16 090 | X = 0.3967 mm … 0.9896 mm |
| `QR_QUIET_MODULES` | 4 | QR quiet zone |
| `QR_ERROR_CORRECTION` | `M` | GS1 Digital Link recommendation |

A UPC-A at 100 % magnification is **1.469 in wide including quiet zones**, and
`tests/unit/barcode.test.ts` asserts exactly that number.

### The rules the engine enforces

- **Check digits are validated, never repaired into a different number.** A bad
  check digit is a `BAD_CHECK_DIGIT` error naming the digit it should have been;
  an 11-digit UPC body is accepted with an explicit "the check digit was
  appended" note, so a caller can never mistake one for the other.
- **Magnification scales X strictly.** There is no independent width parameter,
  so §12's "prevent arbitrary horizontal distortion" is structural — a caller
  cannot express a stretched symbol. A requested magnification outside 80–200 %
  is **clamped and reported**, not silently accepted.
- **Quiet zones are part of the symbol box,** so a bar module's `x` is measured
  from the quiet-zone-inclusive left edge. An element frame that fits the symbol
  therefore fits its light margins too.
- **Bar height below nominal renders, with a note.** Truncating a symbol is
  sometimes a deliberate packaging decision; doing it silently is not.
- **An unencodable value paints nothing.** `drawSidePlan()` records a
  `barcodeErrors` entry and the export raises a **blocking**
  `BARCODE_VALUE_INVALID` finding. §32's "never fake" applied to barcodes: a
  symbol made of `undefined` is worse than no symbol.
- **GS1-128 refuses AI data outside GS1 encodable character set 82,** and
  refuses more than 48 data characters.

### What preflight adds on top

`src/lib/preflight/checks/barcode.ts` measures the *placed* symbol on the
*planned* card:

`GTIN_INVALID` · `BARCODE_VALUE_INVALID` · `BARCODE_QUIET_ZONE` ·
`BARCODE_SIZE` · `BARCODE_TRUNCATED_HEIGHT` · `BARCODE_CONTRAST` ·
`BARCODE_CLIPPED` · `SAFE_AREA_BARCODE` · `CAVITY_CONFLICT`.

There is no separate `BARCODE_MAGNIFICATION` code: a magnification outside the
symbology's range, and a magnification the generator had to adjust, are both
reported under `BARCODE_SIZE`.

The quiet-zone check is measured **from the bars, not from the symbol box** — a
caption sitting in the human-readable band is not an intrusion, and a block
painted over the bars is. That distinction has its own regression suite in
`tests/unit/preflight.test.ts` (`describe("barcode quiet zone is measured from
the bars, not the whole symbol box")`).

The contrast check is honest about its own limits: it reports the ink
difference between bar colour and background as an **ink proxy**, not a measured
optical density, and says so in the finding text. A real verification is a
verifier on a printed sample, not arithmetic on a PDF.

### In the PDF

Each bar module is one filled rectangle in DeviceCMYK. `tests/unit/pdf.test.ts`
("draws bar modules as filled rectangles, one per module") counts them, and
`tests/unit/pdf-validate.test.ts` recovers the digits back out of the finished
file through the `/ToUnicode` CMap **in reading order, not paint order**, and
independently counts bar-shaped filled rectangles. Known-answer fixtures for
UPC-A `036000291452` compare the encoding module for module against the
published tables, in both directions.

---

## The font pipeline, end to end

The embedding and subsetting mechanics are below under
[Font embedding and subsetting](#font-embedding-and-subsetting). The parts
either side of that:

**Only shipped fonts can be used.** `src/lib/text/fonts.ts` registers five
families — Inter (5 faces), Archivo (4), Barlow Condensed (4), Oswald (5) and
Bebas Neue (1), **nineteen faces** in all — every one declared **SIL Open Font
Licence 1.1**, which permits embedding and redistribution. §9 requires that fonts
used for export be legally available and embeddable; restricting the picker to
fonts the application ships is how that is guaranteed rather than hoped for.

**One licensing loose end.** The shipped `src/assets/fonts/OFL.txt` carries only
the Inter copyright notice. OFL-1.1 §1 requires each family's own notice to be
redistributed with it, so Archivo, Barlow Condensed, Oswald and Bebas Neue are
currently shipped without theirs. The licence terms are right; the attribution
file is incomplete, and that has not been fixed.

**Metrics come from the same bytes pdf-lib embeds.**
`scripts/gen-font-metrics.ts` reads the shipped TTFs with the same
`@pdf-lib/fontkit` build and writes `src/lib/text/metrics.json`. The layout
engine measures from that file; pdf-lib subsets and embeds those same TTFs.
There is no second font source and no browser measurement anywhere in the path.

**An unknown family is a reported substitution, never a silent one.**
`getFaceMetrics()` falls back to Inter 400 and returns `missing: true`; the plan
records it; preflight raises `FONT_MISSING`; and the exporter raises its own
`FONT_MISSING` finding at **error** severity saying "the layout engine
substituted a shipped face and the PDF was set in that substitute — the copy
will not look as designed". §9's "add preflight errors for missing fonts",
answered in both engines.

**Characters outside the metrics are flagged, not guessed.** The generated
metrics cover Latin-1 plus common typographic punctuation. Anything else falls
back to the space advance and trips the layout engine's `unmappedGlyphs` flag,
which preflight reports — rather than laying out silently wrong.

---

## What pdf-lib CAN guarantee

### DeviceCMYK colour operators

`pdf-lib` exports `cmyk(c, m, y, k)` with 0..1 components, and its
`setFillingColor` / `setStrokingColor` helpers emit the PDF `k` and `K`
operators. `src/lib/pdf/color.ts` is the only place that converts a `PrintColor`
(tints in tenths of a percent, 0..1000) into those components, and it never calls
`rgb()`.

Grayscale inks default to DeviceCMYK `0/0/0/K` rather than DeviceGray. Both are
legal, but a RIP is free to re-separate DeviceGray across all four plates, which
would silently turn a K-only back into a four-colour job. Writing `0/0/0/K` says
exactly what the press should do. Deployments whose RIP is configured the other
way can pass `grayPolicy: "device-gray"`.

Verified in `tests/unit/pdf.test.ts`: for an all-CMYK card, every page contains
`k`/`K` operators and zero `rg`/`RG` operators.

**Caveat that matters:** a CMYK *number* is not colour management. Without an
output intent those numbers have no defined appearance. See
[A real ICC output intent](#a-real-icc-output-intent) and
[Getting to certified PDF/X](#getting-to-certified-pdfx).

### Font embedding and subsetting

`pdfDoc.embedFont(bytes, { subset: true })` with `@pdf-lib/fontkit` registered
produces a Type0/CIDFontType2 font with the program in `/FontFile2` and a
`/ToUnicode` CMap. Only the glyphs actually drawn are included.

Measured on a representative two-page card with six faces:

| Face | Source TTF on disk | Embedded subset |
| --- | ---: | ---: |
| Archivo Bold | 109 kB | 659 B |
| Archivo ExtraBold | 109 kB | 1 295 B |
| Inter Medium | 318 kB | 1 693 B |
| Inter Regular | 317 kB | 2 639 B |
| Barlow Condensed Bold | 85 kB | 6 793 B |
| Barlow Condensed Regular | 79 kB | 9 267 B |

(The Barlow subsets are larger only because this card's BOM list uses more of
that face than the headline faces use of theirs.)

The complete two-page production file with no placed raster is **25 187 bytes**.

Two things `src/lib/pdf/fonts.ts` has to add on top of what pdf-lib does:

1. **Subset tags, unique per subset.** pdf-lib writes
   `/BaseFont /Inter-SemiBold-9742` for a subset. ISO 32000-1 §9.6.4 and every
   part of PDF/X require a subset font name to carry a six-uppercase-letter tag
   and a `+`, and require *different subsets to carry different tags*.
   `finaliseFontSubsets()` prefixes the tag on the Type0 font, the descendant
   CIDFont and the FontDescriptor, after `doc.flush()` has materialised the
   dictionaries — and the FontFile2 program the tag is derived from. pdf-lib's
   own numeric suffix is **kept**, so the finished `/BaseFont` reads e.g.
   `/LNFHQL+Archivo-ExtraBold-8784` — measured out of `409TF-production.pdf` —
   not `/LNFHQL+Archivo-ExtraBold`.

   The tag is a hash of the face key **and the embedded program**, not of the face
   key alone. `PDFContext`'s RNG is seeded, so two cards that use the same
   families embed the same faces in the same sorted order and both receive the
   identical pdf-lib suffix `-9742`; a face-keyed tag would then give two files
   holding *different* glyph sets the identical `/DOGXPG+Inter-SemiBold-9742`.
   Imposition and merge tools de-duplicate fonts by name, so imposing two such
   cards on one press sheet drops glyphs from one of them. Content-addressing the
   tag keeps the export byte-reproducible — identical subsets share a tag — while
   making that collision impossible. Guarded by "two cards with different copy do
   not share a /BaseFont" in `tests/unit/pdf.test.ts`.

2. **Shaping must be switched off.** pdf-lib encodes strings through fontkit's
   `layout()`, which applies the font's default OpenType features. The shared
   layout engine in `src/lib/text/layout.ts` measures per code point with no
   ligatures and no contextual alternates. Left at fontkit's defaults the two
   disagree: Archivo's `liga` collapses "ff", Inter's `calt` turns `->` into an
   arrow glyph, and Archivo's `rvrn` swaps `$` for a variable-font bracket-layer
   variant. The PDF would then set text at different widths than the editor
   measured, and a line that fitted on screen could overrun the safe area on
   press. `PDF_SHAPING_FEATURES` disables every substitution feature.

   **What actually guards this, precisely.** `tests/unit/pdf.test.ts` "does not
   apply OpenType shaping, so PDF advances match the layout engine" sets the one
   string `off->staff` in Archivo 400 and asserts it decodes back one glyph per
   code point — which catches `liga` and `calt` on that face and nothing more. It
   is **not** an exhaustive sweep of character pairs across every face, and
   earlier drafts of this document said it was. The exhaustive per-face check is
   a different test — "every glyph in every embedded face matches the source
   outline" — which does iterate every shipped face over the whole generated
   metrics charset, but compares advance widths and outlines rather than shaping
   decisions.

   The single known exception is U+00AD SOFT HYPHEN, which fontkit's cmap
   handling maps differently from `glyphForCodePoint`. It is absent from the
   generated metrics for most faces and already trips the layout engine's
   `unmappedGlyphs` flag, so preflight reports it rather than the exporter hiding
   it.

### All five page boxes

`PDFPage.setMediaBox` / `setCropBox` / `setBleedBox` / `setTrimBox` /
`setArtBox` are public API. The production exporter sets MediaBox, CropBox and
BleedBox to the full-bleed canvas at the origin, and TrimBox to the card inset by
the bleed on every side.

Verified against the §22 table to within **0.001 pt**:

| Preset | Full bleed | MediaBox / CropBox / BleedBox (pt) | TrimBox (pt) |
| --- | --- | --- | --- |
| 409TF | 4.6175 × 7.36175 in | 332.46 × 530.046 | [9, 9, 323.46, 521.046] |
| 277TF | 4.593 × 6.0375 in | 330.696 × 434.7 | [9, 9, 321.696, 425.7] |
| 206TF | 3.3675 × 6.7275 in | 242.46 × 484.38 | [9, 9, 233.46, 475.38] |

µpt → pt is an exact decimal shift (1 pt = 1 000 000 µpt), so these are exact
decimals in the file; the tolerance only absorbs decimal text being parsed back
through a binary float. 0.001 pt is 1/72000 in, about 0.35 µm — four orders of
magnitude finer than any imagesetter or die can hold.

### Vector output, never a raster of the page

- Text is real text in an embedded subset font, one `drawText` per laid-out span
  at the span's own x and baseline, with the layout engine's tracking applied as
  the text state's `Tc` operator. Nothing is re-laid-out at export time.
- Barcode bars are individual filled rectangles built from
  `renderBarcode()`'s module list.
- Shapes are paths, including the 0.25 in trim corner radius, built from the same
  `roundedRectPath()` the editor draws with.
- Placed rasters are embedded as image XObjects at their original sample data;
  the RIP does the scaling. Cropping is done by clipping, not by resampling.

### A real ICC output intent

pdf-lib has no output-intent API, but its low-level `PDFContext` does everything
required: `context.flateStream(iccBytes, { N: 4 })` for the profile stream and
`context.obj({...})` plus `catalog.set(PDFName.of("OutputIntents"), ...)` for the
dictionary. `applyOutputIntent()` writes `/S /GTS_PDFX` (or `/GTS_PDFA1` on
request) with `/DestOutputProfile` pointing at the embedded profile.

The profile is validated before it is embedded: the `acsp` signature at bytes
36–40, a declared size matching the payload, and a data colour space of CMYK, RGB
or GRAY. A truncated or non-ICC blob throws `InvalidIccProfileError` rather than
being embedded — an output intent that names a printing condition it cannot point
at is a lie that preflight tools believe.

### Deterministic output

`PDFContext` uses a seeded `SimpleRNG` for the pseudo-random resource-name
suffixes, so identical input yields identical bytes. The exporter additionally
pins the Info dictionary (`DETERMINISTIC_TIMESTAMP` by default), embeds faces and
assets in sorted order, and rounds every emitted coordinate to 1e-6 pt so a
rotation matrix cannot vary in its last bit across V8 builds.

Verified byte-for-byte across two runs, including cards with rotation,
transparency and a placed raster.

---

## What pdf-lib CANNOT do

### PDF/X-4 conformance

Not a matter of effort — several required structures simply are not produced, and
`pdf-lib` has no conformance concept at all. Confirmed absent from the output:

| PDF/X-4 requirement | Present? |
| --- | --- |
| Trailer `/ID` file identifier | **No** — pdf-lib writes no `/ID` |
| XMP `/Metadata` with `pdfxid:GTS_PDFXVersion` | **No** — pdf-lib writes no XMP at all |
| `/OutputIntent` with `GTS_PDFX` and a DestOutputProfile | Yes, when a profile is configured |
| All fonts embedded and subset-tagged | Yes |
| `/TrimBox` on every page, inside `/BleedBox`, inside `/MediaBox` | Yes |
| No encryption | Yes |
| Conformance *validation* | **No** |

Without the trailer `/ID` and the XMP identification, the file is not a PDF/X
file, and adding an XMP packet that merely *claims* `PDF/X-4` without validating
the rest would be exactly the renaming §15 forbids.

### ICC-based colour conversion of placed RGB images

pdf-lib embeds a PNG as DeviceRGB (its PNG embedder decodes to raw RGB samples
regardless of what the source declared) and a JPEG in whatever colour space its
SOF marker declares. It performs **no** colour transform. A placed RGB raster
therefore reaches the RIP as RGB and is separated by the RIP's own default, which
is not the colour management the job's output intent describes.

The exporter detects this from the bytes rather than trusting the upload's MIME
type, reports it in `complianceStatus.placedImageColorSpaces`, and raises an
`ASSET_RGB_IN_CMYK` warning. The fix is upstream of the exporter: convert the
asset to CMYK against the press profile before upload, or sign the RIP's
separation off on a contract proof.

### Separation (spot) colour spaces

pdf-lib emits only device colour spaces. There is no way to write a
`/Separation` or `/DeviceN` colour space through its API, so a spot ink cannot
survive this exporter. `PrintColor` models spots properly and requires a CMYK
alternate; the exporter converts to that alternate and raises a
`SPOT_CONVERTED` info note naming the ink, its tint and the exact CMYK build that
was written. If the job runs a real spot plate, the ink name and tint have to
reach the printer separately, or the file has to be routed through a converter
that can create the Separation space.

### Transparency flattening

Element opacity is written as live transparency through an `/ExtGState` with
`ca`/`CA`. pdf-lib cannot flatten it. PDF/X-4 permits live transparency, so this
is only a problem for PDF/X-1a workflows and older RIPs — but it is a real
problem for those, so the exporter raises a `TRANSPARENCY_PRESENT` note whenever
any element is drawn below 100 % alpha.

### Other gaps worth stating

- **Overprint.** The exporter sets no `/OP`, `/op` or `/OPM`. Overprint decisions
  are left to the RIP's defaults.
- **`/CIDSet`.** Not written. PDF/X-1a requires it for subset CIDFonts; PDF/X-4
  does not.
- **Colour-managed preview.** The editor's on-screen colour is the naive
  multiplicative CMYK→sRGB approximation in `src/lib/color/types.ts`. It is not
  an ICC transform and the UI never labels it as a proof.
- **Kerning and OpenType shaping.** Deliberately disabled, as described above, so
  that the PDF and the editor agree. A shaped renderer would set some pairs very
  slightly tighter.

---

## Getting to certified PDF/X

The remaining step is a **conversion-and-verification pass by a tool that
implements PDF/X**, applied to the file this exporter produces. Concretely:

1. **Obtain the press's ICC output profile** and configure it as the deployment's
   output intent. A PDF/X file without an output intent is not conforming, and
   §14 forbids inventing a profile. Until this is done the exporter emits an
   `OUTPUT_INTENT_MISSING` warning on every export.

2. **Resolve placed RGB rasters.** Either convert them to the output intent's
   space before upload, or accept that the conversion happens in the PDF/X
   conversion step below and have the result signed off on a contract proof.

3. **Decide the fate of any spot ink.** Either accept the CMYK build the
   `SPOT_CONVERTED` note records, or produce the Separation space in the
   conversion step.

4. **Run a PDF/X conversion and validation tool.** Options, in decreasing order
   of how well they cover PDF/X-4:

   - **callas pdfToolbox** or **Enfocus PitStop** (commercial). These both
     convert to and validate PDF/X-4, and can be driven from a command line or a
     hot folder, which suits a server-side export job.
   - **Adobe Acrobat Pro Preflight** (commercial, interactive). The usual choice
     when a prepress operator is already in the loop.
   - **Ghostscript `pdfwrite`** with a PDF/X definition file (free). Practical
     for PDF/X-3; its PDF/X-4 support is weaker, and it re-writes the file, so
     the output has to be re-validated rather than trusted.

   Note that there is no free, well-maintained PDF/X validator equivalent to
   veraPDF — veraPDF validates PDF/A, not PDF/X. Budget for a commercial tool if
   certified PDF/X is a contractual requirement.

5. **Re-run the export validation** in `src/lib/pdf/validate.ts` against the
   converted file. A conversion tool can change page boxes, re-encode fonts or
   rasterise transparency; the geometry and font checks must pass on the file
   that actually ships, not on the one that went in.

Until steps 1–5 are done, label the output exactly as
`complianceStatus.label` does: a CMYK production PDF, with or without an embedded
output intent, and not certified PDF/X.

---

## Known defect in the shipped subsetter, and the workaround

**Symptom.** A production PDF set in Inter rendered "12345" as a bare "5".
Reproduced identically in CoreGraphics and in Poppler, so the fault was in the
file, not in a viewer.

**Cause.** `@pdf-lib/fontkit` 1.1.1's TrueType subsetter concatenates each
glyph's raw `glyf` record and records the running offset in `loca`. When it
serialises `loca` it picks the short format whenever the final offset fits in 16
bits, and the short format stores every offset halved:

```js
this.version = this.offsets[this.offsets.length - 1] > 0xffff ? 1 : 0;
if (this.version === 0) for (i) this.offsets[i] >>>= 1;
```

That is lossless only if every offset is even, which is true only if every glyph
record has an even length. The subsetter never pads. A font whose source `loca`
is the **long** format may legally hold odd-length records, and then the subset's
glyph boundaries are silently wrong.

Measured across the shipped faces:

| Family | Source `loca` format | Odd-length glyf records |
| --- | --- | ---: |
| Archivo (4 faces) | short | 0 |
| Barlow Condensed (4 faces) | short | 0 |
| Inter (5 faces) | long | 486 – 507 per face |

Short-format fonts cannot have odd records by construction, which is why only
Inter was affected.

**Workaround.** `alignGlyfRecords()` in `src/lib/pdf/fonts.ts` pads each
odd-length record to an even length and rewrites `loca` in the long format before
the bytes reach pdf-lib. Padding at the end of a glyph record is exactly what a
short-loca font already carries; no outline, metric or composite-component offset
is touched. Fonts that need no padding are returned unchanged, byte for byte.

**Guard.** `tests/unit/pdf.test.ts` embeds the full metrics charset in every
shipped face, extracts `/FontFile2` back out of the finished PDF, and compares
each subset glyph against the same glyph in the source font through the
`/ToUnicode` CMap — advance width exactly, outline bounding box to the nearest
font unit. Removing the workaround makes that test fail on the first Inter face.

**When to remove this.** When `@pdf-lib/fontkit` pads in
`TTFSubset._addGlyph`, or when `loca.preEncode` stops choosing the short format
for odd offsets. Prove it by deleting the call in `readFaceBytes()` and
confirming the guard test still passes.

---

## Operational notes

### Fonts in a serverless bundle

`src/lib/pdf/fonts.ts` reads TTFs from the filesystem with `node:fs`, resolving
`src/assets/fonts` and then `public/fonts` relative to `process.cwd()`. Bytes are
cached per absolute path for the life of the process, so a cold start pays the
read once. A Next.js serverless deployment must trace the font directory into the
function bundle (`outputFileTracingIncludes` in `next.config.ts`); if it is
missing, `FontFileMissingError` names every path that was searched rather than
failing with a generic error.

### File sizes

The vector pipeline is cheap: 25 kB for a complete two-page card with six
embedded subset faces and a UPC-A. Placed rasters dominate everything else — the
900 × 600 test image alone accounts for the difference between 25 kB and 362 kB.
Content streams are Flate-compressed; object streams are deliberately **off** so
the file stays legible to a prepress operator and to the byte-level checks in the
test suite.

### Determinism and timestamps

Identical input produces identical bytes, including the timestamp. Callers that
want real provenance pass their own `timestamp`, and the bytes then differ per
run — by design, not by accident. Proofs take their displayed time as a
pre-rendered string (`ProofInfo.exportedAt`) for the same reason: the proof must
match whatever the approval record says, not whatever the clock said during
rendering.

### Overlays cannot reach production artwork

This is structural, not a convention:

- `src/lib/pdf/draw.ts` paints `DrawOp`s and nothing else, and `SidePlan.ops`
  cannot express a trim line, a safe-area rule, a cavity footprint or a slug.
- `src/lib/pdf/production.ts` has no import path to `src/lib/pdf/proof.ts`.
- The proof's overlay lives inside an Optional Content Group whose `/Usage` sets
  `/PrintState /OFF`, and the proof sheet is larger than the card so the slug sits
  in a margin outside the bleed box.

The test suite decodes all text out of a production PDF through the `/ToUnicode`
CMaps and asserts that every run is copy the plan actually placed, and that none
of "PROOF", "BLEED", "TRIM", "SAFE AREA", "CAVITY", "PREFLIGHT", "REVISION" or
"APPROVAL" appears anywhere.

### Inspecting output by hand

`PDF_ARTIFACT_DIR=/some/dir npx vitest run tests/unit/pdf.test.ts` writes a
production and a proof PDF for all three presets into that directory. §32 forbids
calling print QA complete without inspecting a generated PDF; that hook is how.
