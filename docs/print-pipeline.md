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

1. **Subset tags.** pdf-lib writes `/BaseFont /Inter-SemiBold-9742` for a subset.
   ISO 32000 and every part of PDF/X require a subset font name to carry a
   six-uppercase-letter tag and a `+`. `finaliseFontSubsets()` rewrites the name
   to `ABCDEF+Inter-SemiBold` on the Type0 font, the descendant CIDFont and the
   FontDescriptor, after `doc.flush()` has materialised the dictionaries. The tag
   is derived deterministically from the face key.

2. **Shaping must be switched off.** pdf-lib encodes strings through fontkit's
   `layout()`, which applies the font's default OpenType features. The shared
   layout engine in `src/lib/text/layout.ts` measures per code point with no
   ligatures and no contextual alternates. Left at fontkit's defaults the two
   disagree: Archivo's `liga` collapses "ff", Inter's `calt` turns `->` into an
   arrow glyph, and Archivo's `rvrn` swaps `$` for a variable-font bracket-layer
   variant. The PDF would then set text at different widths than the editor
   measured, and a line that fitted on screen could overrun the safe area on
   press. `PDF_SHAPING_FEATURES` disables every substitution feature. That was
   verified to reproduce the layout engine's glyph selection exactly for every
   ordered pair of characters in the generated metrics charset across all
   thirteen shipped faces.

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
