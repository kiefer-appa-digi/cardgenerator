# Architecture

Spec §3 requires that "every major dependency must have a reason recorded in
`/docs/architecture.md`". That is the bulk of this document. The module map and
the request/render flow follow.

---

## Stack

| Layer | Choice | Version pinned |
| --- | --- | --- |
| Framework | Next.js App Router (Server Components, Server Actions) | 16.3.3 |
| UI runtime | React | 19.2.8 |
| Language | TypeScript, `strict` | 5.x |
| Styling | Tailwind CSS v4 (`@tailwindcss/postcss`), design tokens in `src/app/globals.css` | 4.x |
| Runtime | Node.js 24+ | — |
| Database | PostgreSQL | — |
| ORM / migrations | Drizzle ORM + drizzle-kit | 0.45.2 / 0.31.10 |
| Validation | Zod | 4.4.3 |
| PDF | pdf-lib + @pdf-lib/fontkit | 1.17.1 / 1.1.1 |
| Spreadsheets | exceljs | 4.4.0 |
| Object storage | Vercel Blob (private), local filesystem fallback | 2.8.0 |
| Raster metadata | sharp | 0.35.4 |
| Auth | jose (JWT session cookie) + bcryptjs | 6.2.10 / 3.0.3 |
| Tests | Vitest, Playwright | 4.1.11 / 1.62.1 |

---

## Recorded reasons for every major dependency

### Drizzle, not Prisma

The spec allows either (§3). Drizzle was chosen for four reasons that are
specific to this application, not general preference:

1. **`bigint` micro-points are the whole geometry model.** Every physical length
   in this system is an integer number of µpt (`src/lib/units.ts`), and Postgres
   `bigint` is the only honest column for it. Drizzle maps `bigint({ mode:
   "number" })` to a plain JS number with no wrapper type, so a query result is
   already the value the geometry code operates on. Prisma returns `BigInt`,
   which does not survive `JSON.stringify`, cannot be arithmetic-mixed with
   `number` without an explicit cast, and would leak a conversion boundary into
   every layout function.
2. **No separate query engine binary.** Prisma ships a Rust engine that has to be
   traced into a serverless function bundle. This app already has to trace font
   files and an ICC profile into the bundle for PDF export
   (`outputFileTracingIncludes`); adding a platform-specific binary to that list
   is a deployment failure mode nobody needs.
3. **The schema file is the documentation.** `src/server/db/schema.ts` is
   ordinary TypeScript, so every column carries a comment explaining *why* it
   exists next to the type. `docs/data-model.md` quotes it. A `.prisma` schema
   would be a second artefact to keep in sync.
4. **Two deployment shapes, one handle.** `src/server/db/client.ts` picks
   `drizzle-orm/neon-http` when `DATABASE_URL` points at Neon and
   `drizzle-orm/node-postgres` otherwise. Both are first-class Drizzle drivers
   with identical query builders, so serverless HTTP and a local pooled socket
   are one line apart.

**Cost accepted:** Drizzle's relational query API is thinner than Prisma's, so
`src/server/products.ts` assembles the `ProductContext` with six explicit
queries rather than one nested include. That is visible work rather than hidden
work, which suits a module whose output has to be reproducible years later.

### A custom SVG artboard, not Fabric.js or Konva

The spec names Fabric.js and Konva and permits "a justified alternative" (§3).
This is the justification.

Both libraries are **canvas-first scene graphs whose source of truth is browser
pixels**. This application's source of truth is integer micro-points, and §32
says outright: "Do not trust browser pixels as print dimensions." Building on
either would mean maintaining a two-way sync between a float pixel scene graph
and the µpt document, and every round trip through that sync is a place a
0.0001 in error is born.

Worse, neither library can be the thing the PDF writer renders. A packaging tool
that lays out text in the browser and re-lays it out in the exporter has two
layout engines, and the exported card is not the card the designer approved.

What was built instead:

- **One resolved plan, two serialisations.** `planSide()`
  (`src/lib/design/plan.ts`) turns a validated design document plus a product
  into a flat, ordered list of `DrawOp`s in bleed space (µpt, y down). The SVG
  artboard maps ops to SVG nodes; the PDF writer maps the *same* ops to PDF
  operators. Neither one re-decides a line break or a barcode size. The preview
  is faithful because it is not a second implementation — it is a second
  serialisation.
- **SVG, not `<canvas>`.** Vector-to-vector needs no rasterisation step, the DOM
  gives real focusable and labellable nodes for §27 accessibility, and a
  Playwright screenshot of the artboard is a vector render rather than a
  resampled bitmap.
- **A hand-rolled external store** (`src/lib/editor/store.ts`,
  `useSyncExternalStore`) so a pointer move repaints the artboard and the X/Y
  fields and nothing else — §26 forbids re-rendering the tree on every pointer
  movement. History is a bounded stack of whole documents, because a card
  document is tens of kilobytes and snapshotting is cheaper and far harder to
  get subtly wrong than inverse patches.

**Cost accepted:** selection, resize, rotate, snap, align and distribute are all
written by hand (`src/lib/editor/interaction.ts`). They are pure functions on
rects and are unit-tested (`tests/unit/interaction.test.ts`), which a library's
internal transform stack would not have been.

### pdf-lib, not Puppeteer/Chromium, not PDFKit, not a headless print

Three candidates were considered against one requirement: **DeviceCMYK output
with no rasterisation** (§14, §15, §32 "Do not fake CMYK", "Do not rasterize the
entire card just to simplify PDF export").

| Candidate | Verdict |
| --- | --- |
| Headless Chromium (`page.pdf()`) | **Rejected outright.** Chromium's PDF output is RGB. There is no CMYK path. It would also make the browser the layout authority, which is exactly the failure §9 warns about. |
| PDFKit | Has a CMYK fill API, but its font handling and page-box control are less direct, and it is a document *builder* — it does not open and inspect an existing PDF, which §22 requires for post-export validation. |
| **pdf-lib** | **Chosen.** `cmyk()` fills emit real `k`/`K` operators; `setMediaBox`/`setCropBox`/`setBleedBox`/`setTrimBox`/`setArtBox` are public API; `embedFont(bytes, { subset: true })` with fontkit produces Type0/CIDFontType2 with `/FontFile2`; and its low-level `PDFContext` is exposed, which is what makes a real `/OutputIntent` with an embedded ICC profile possible (`applyOutputIntent()` in `src/lib/pdf/production.ts`). |

The decisive extra: **pdf-lib can read a PDF back.** `src/lib/pdf/inspect.ts`
re-parses the finished bytes — page boxes, `/FontFile2` programs, colour-space
operators, image XObjects, decoded text through `/ToUnicode`, and the device-space
extent of every painted mark — so `src/lib/pdf/validate.ts` grades the file that
will actually be sent to press rather than asking the writer what it thinks it
did. One library covers writing and verifying.

**Limits accepted and documented, not hidden:** pdf-lib writes no XMP and no
trailer `/ID`, cannot emit `/Separation` colour spaces, cannot ICC-convert a
placed RGB raster, and cannot flatten transparency. `complianceStatus.claimsPdfX`
is typed as the literal `false` so no code path can start claiming otherwise, and
`complianceStatus.remainingForPdfX` carries the concrete remaining work. Full
detail in `docs/print-pipeline.md`.

One shipped defect in `@pdf-lib/fontkit` 1.1.1's TrueType subsetter (odd-length
`glyf` records corrupted by short-format `loca`) is worked around in
`src/lib/pdf/fonts.ts` and guarded by a test that re-extracts every subset glyph
from the finished PDF and compares it to the source outline. Also in
`docs/print-pipeline.md`.

### Integer micro-points, not floats, not pixels, not microns

`1 pt = 1 000 000 µpt`, `1 in = 72 000 000 µpt`. Defined in `src/lib/units.ts`.

- **PDF's native unit is the point,** so µpt → pt is an exact decimal shift. The
  exported page geometry is never the result of an irrational scale. A micron
  model would put a `25.4/72` factor on every single coordinate that reaches the
  page.
- **Integers cannot drift.** Every add and subtract in layout, snapping and
  export is exact. `tests/unit/units.test.ts` ("does not drift over repeated
  addition") holds the line.
- **The supplied dimensions land exactly.** 7.11175 in × 72 000 000 =
  512 046 000 µpt, an integer with no remainder. Every preset dimension in §2
  does the same — asserted, not assumed.
- **Precision is absurd on purpose.** 1 µpt = 3.5 × 10⁻⁷ in ≈ 0.35 nm, roughly
  five orders of magnitude finer than any imagesetter. Rounding error can never
  reach a physical consequence.
- **Range is safe.** A 100 in artboard is 7.2 × 10⁹ µpt, well inside
  `Number.MAX_SAFE_INTEGER` (9.007 × 10¹⁵), so plain JS numbers work and
  `bigint` columns store them losslessly.
- Angles are millidegrees and percentages are basis points, for the same reason.

Millimetre entry rounds to the nearest µpt, i.e. to within 0.35 nm — a user
convenience over an exact substrate, which is the right way round.

### A shared text-layout engine, not browser measurement

`src/lib/text/layout.ts` measures and breaks text from metrics generated from
the exact TTF bytes pdf-lib later embeds (`src/lib/text/metrics.json`, produced
by `scripts/gen-font-metrics.ts`).

§9 is explicit: "Never rely on a browser-only font rendering result that cannot
be reproduced in the exported PDF." A browser's `measureText` depends on the
platform's font stack, hinting and subpixel rounding. Two designers on different
machines would get different line breaks from the same document, and neither
would match the PDF. On a card where a line overrunning the safe area is a
scrapped print run, that is not a cosmetic difference.

So the browser is never asked to make a layout decision. The engine returns line
breaks, advance widths and baselines in µpt; the artboard pins each span to the
measured x and width, and the PDF writer draws each span at exactly that x and
baseline with the same tracking as a `Tc` operator. **Nothing is re-laid-out at
export time.**

Two deliberate limitations, stated rather than hidden:

- **Advance widths only** — no kerning pairs, no OpenType shaping. "AV" sets
  very slightly wider than a shaped renderer would. It sets *identically* in the
  editor and in the PDF, which is the property that matters. `PDF_SHAPING_FEATURES`
  in `src/lib/pdf/fonts.ts` switches fontkit's default features off so pdf-lib
  cannot silently apply `liga`/`calt`/`rvrn` and disagree with the engine.
- **Latin-1 plus common typographic punctuation.** A character outside the
  generated metrics falls back to the space advance and raises the layout
  engine's `unmappedGlyphs` flag, which preflight reports — rather than laying
  out silently wrong.

Only the three shipped OFL-1.1 families (Inter, Archivo, Barlow Condensed) can be
used, because only a font the application ships can be guaranteed embeddable.
An unknown family falls back to Inter 400 and raises `FONT_MISSING`.

### exceljs, not SheetJS

- **Licence.** exceljs is MIT. SheetJS's community build moved off npm and its
  maintained distribution is commercially licensed. A packaging system a client
  operates should not carry that question.
- **Cell fidelity is the job.** The importer has to distinguish a *number* from
  *text that looks like a number*, because a 12-digit U.P.C. read as a number and
  stringified naively becomes `8.10797030001e+11` and the identifier is
  destroyed. exceljs exposes a typed `cell.value` (string / number / Date /
  boolean / rich text / hyperlink / formula-with-result / error) and
  `cell.isMerged`. `cellToParsed()` in `src/lib/import/inspect.ts` handles each
  case explicitly and writes long integers with `toFixed(0)`. There is a
  regression test for exactly this ("keeps a long numeric identifier out of
  exponent notation").
- **Merged cells are reported,** which is what lets the header-row detector tell
  a merged group banner from a real header row.
- **Streaming is available** if a workbook ever outgrows the current 25 MB
  upload ceiling.

**Cost accepted:** exceljs is heavier and slower than SheetJS. It is only ever
loaded in a server action, never in a client bundle.

### Vercel Blob, not S3, not database bytes

- **§26 forbids "storing giant base64 blobs in database rows."** Packaging
  artwork is 10–60 MB TIFFs and PDFs. They belong in object storage.
- **Zero-configuration on the target platform.** The app deploys to Vercel;
  `BLOB_READ_WRITE_TOKEN` is the only setting, against an S3 bucket policy, an
  IAM role, a region and a CORS configuration.
- **Private by default, and actually private.** Every object is written with
  `access: "private"`. The storage URL never reaches a browser. Reads go through
  `/api/assets/[id]`, which resolves the asset, checks the requester's
  organisation, and only then streams bytes (§25 "signed asset URLs where
  appropriate", "organization isolation"). A guessed URL gets nothing.
- **A local fallback keeps the pipeline testable.** With no token,
  `src/server/storage.ts` writes to `.data/blob` under the project. A developer
  or a CI run exercises the whole upload → place → export path with no cloud
  credentials, so the storage boundary is never the untested one.

**Cost accepted:** vendor coupling. It is contained to one 119-line module with
four functions (`putAsset`, `readAsset`, `deleteAsset`, `storageMode`). Swapping
in S3 is a rewrite of that file and nothing else.

### The rest, briefly

| Dependency | Reason |
| --- | --- |
| **zod** 4 | Named in §3. It is the boundary type for the design document, the product context, the preflight profile, black rules, output intent, GS1 config and every import mapping. `DesignDocSchema.parse()` is what makes "never just an opaque canvas blob" (§4) enforceable rather than aspirational. |
| **@pdf-lib/fontkit** | The only fontkit build pdf-lib registers for TrueType subsetting. Also used by `scripts/gen-font-metrics.ts`, so the metrics the layout engine uses and the glyphs the PDF embeds come from one parser. |
| **sharp** | Reads pixel dimensions, declared resolution, colour space and ICC presence from an upload so preflight can compute an honest effective DPI instead of guessing (§8: "never silently upscale and call the asset print-ready"). libvips handles TIFF, which the browser cannot. |
| **jose** | Session cookie signing. Web Crypto based, so it runs in the Node runtime and in the proxy/edge runtime unchanged. The JWT is a fast-path check only — `getCurrentUser()` re-reads the session row on every request so a revoked session or a role change takes effect immediately. |
| **bcryptjs** | Password hashing with no native build step, which keeps `npm ci` working on every platform and in every CI image. Pure-JS bcrypt is slower than a native binding; login is not a hot path. |
| **@neondatabase/serverless** | Postgres over HTTP so a serverless invocation never holds a socket from a pool it cannot drain. Selected automatically by `DATABASE_URL`. |
| **pg** | The local and CI driver. Same Drizzle query builders. |
| **nanoid** | 24-character URL-safe ids. Not UUIDv4: ids appear in export filenames and manifest rows a prepress operator reads and retypes, and 24 nanoid characters are shorter and less error-prone than 36 characters of hyphenated hex. |
| **qrcode** | QR symbol matrix generation for GS1 Digital Link (§12, §13). Used only for the module matrix; the modules are then drawn as vector rects by the same code path as every other symbology, so a QR is never a rasterised image in the PDF. |
| **server-only** | Compile-time failure when a module that touches the database, the credential cipher or a GS1 adapter is imported from a client component. §25 forbids secrets in client bundles; this makes that a build error rather than a review question. |
| **clsx + tailwind-merge** | One 7-line `cn()` helper. tailwind-merge is what lets a component accept a `className` override without a specificity fight. |
| **lucide-react** | Icons, tree-shaken per import. Every icon in the editor toolbar carries a real `aria-label`; the icon set is decoration on top of a labelled control, never the control itself. |
| **Vitest** | Named in §3. Native ESM and TypeScript with no separate transform config, and it runs the geometry, barcode, PDF and preflight suites in about 1.3 s, which is what makes them usable as a gate. |
| **Playwright** | Named in §3. Also drives the screenshot capture in `shot.mjs` / `shot-editor.mjs` for the §29 LOOP 5 visual QA pass. |
| **drizzle-kit** | Migration generation from the schema file. |
| **tsx** | Runs the seed, import, font-metrics and PDF-verification scripts as TypeScript with the app's own path aliases, so a script and the app cannot drift. |

### Dependencies deliberately not added

| Not used | Why not |
| --- | --- |
| A canvas library (Fabric/Konva) | See above. Pixels cannot be the source of truth. |
| A state library (Redux/Zustand/Jotai) | A 360-line `useSyncExternalStore` store with selector subscriptions does exactly what §26 needs. A library would add a dependency and not a capability. |
| A form library | Server Actions plus zod. The forms are small and the validation already exists on the server. |
| A component library (MUI/Chakra/shadcn) | The design is a dense dark prepress console with its own tokens in `globals.css`. A general-purpose library would be fought, not used. |
| A job queue (BullMQ/Inngest) | §3 asks for "background job processing for large/batch exports". Batch runs as a **slice-advancing job**: `exportJobs` holds the state, and `advanceBatchAction` processes a slice and commits before returning, so the client drives it to completion and an interrupted run resumes where it stopped. No Redis, no worker fleet, and no serverless timeout. A real queue is the right answer at a much larger scale and would slot in behind the same `exportJobs` table. |
| An ICC transform library (lcms bindings) | §14 forbids inventing a print profile. Converting RGB artwork against a profile the deployment has not supplied would be exactly that. The exporter detects and reports RGB instead. |
| A PDF/X validator | There is no free, well-maintained one — veraPDF validates PDF/A, not PDF/X. Faking the check would be worse than not having it. See `docs/print-pipeline.md`. |

---

## Module map

```
src/
  lib/                        pure, no I/O, no DOM, unit-tested
    units.ts                  µpt / millidegrees / basis points; parse and format
    geometry/
      types.ts                Rect, Insets, rounded-rect paths, rotation, containment
      presets.ts              CARD_PRESETS, cavity specs, CAD reference, presetDiscrepancies()
    color/types.ts            PrintColor (cmyk|gray|spot|none), black rules, output intent,
                              brand swatches, CMYK→sRGB *preview* approximation
    text/
      fonts.ts                the three shipped OFL families and their faces
      metrics.json            generated from the shipped TTFs
      layout.ts               THE layout engine — line breaking, advances, baselines
    barcode/
      gtin.ts upc.ts code128.ts qr.ts index.ts types.ts
                              UPC-A, EAN-13, GS1-128, QR / GS1 Digital Link → bar rects in µpt
    design/
      schema.ts               the zod DesignDoc: sides, elements, bindings, paragraphs
      plan.ts                 planSide() / planDocument() — doc + product → DrawOp[]
      render.ts               the DrawOp union and SidePlan shape
    data/
      context.ts              ProductContext + FIELD_CATALOG — the binding contract
      binding.ts              resolveBinding, token substitution, visibility rules
      bom.ts                  "This Pack Includes" line rendering
      format.ts               number/date/case transforms
    preflight/
      types.ts                severities, CHECK_CODES, PreflightProfile, report shape
      engine.ts               assembles context, concatenates check modules
      checks/                 geometry · assets · text · data · barcode · color · context
    pdf/
      color.ts                PrintColor → DeviceCMYK operators; gray policy; spot conversion
      fonts.ts                embed + subset, subset tags, the fontkit loca workaround
      draw.ts                 DrawOp → PDF operators. Cannot express an overlay.
      production.ts           the production PDF (§15A) + ComplianceStatus
      proof.ts                the proof PDF (§15B), overlay in a non-printing OCG
      inspect.ts              re-parse a finished PDF: boxes, fonts, colour, text, extents
      validate.ts             the §22 checks, each with a measurement and a tolerance
    import/
      inspect.ts              xlsx → grid → header detection → SheetInspection
      mapping.ts              source profiles, header aliases, suggestMapping()
      preview.ts              diff, duplicate and identifier findings before commit
      commit.ts               pure ImportPlan
      types.ts                shared shapes
    gs1/
      types.ts                pure contract — safe to import from a client component
      adapter.ts              the Gs1Adapter interface
      index.ts                getAdapter() — server-only factory, always returns an adapter
      providers/disabled.ts   the default: answers NOT_CONFIGURED, never throws
      providers/gs1us.ts      REST adapter with retry, backoff, timeouts, redacted logging
      diff.ts                 diffRemoteAgainstLocal / applyAcceptedFields
      digital-link.ts         GS1 Digital Link URI build and parse
    editor/
      store.ts                external store, selector subscriptions, bounded history
      interaction.ts          resize, snap, align, distribute — pure rect maths
    templates/factory.ts      the three 11-500-structure master templates

  server/                     everything that touches the database, storage or a secret
    db/{schema,client,index,seed}.ts
    auth/{session,password,current,rbac,actions}.ts
    crypto.ts                 AES-256-GCM credential cipher + log redaction
    storage.ts                Vercel Blob / local filesystem
    assets.ts                 upload: magic-byte sniffing, sharp metadata, scan hook
    products.ts               buildProductContext() — the one place the model is flattened
    imports.ts import-apply.ts
    designs.ts                save / submit / approve; revision immutability lives here
    templates.ts              master template seeding, save-as-template, generate-from-product
    render.ts                 shared asset map + org settings for anything that renders
    exports.ts                production + proof export, preflight gate, post-export validation
    batch.ts                  slice-advancing batch job with a manifest
    audit.ts                  append-only audit trail

  app/
    (auth)/login              the gate
    (app)/                    the shell: overview, products, designs, templates,
                              presets/dielines, imports, batch, exports, settings
    api/                      health · assets/[id] · artifacts/[id] · designs/[id]/preflight

  components/
    ui/{panel,button}.tsx     PageHeader / Panel / EmptyState / Stat / Badge / Button
    app-shell.tsx             sidebar, aria-current nav
    editor/                   artboard, toolbar, inspector, layers, data panel,
                              preflight strip, text overlay
    import/wizard.tsx         upload → inspect → map → preview → commit
    design/                   export panel, approval controls, batch runner
```

**The dependency rule.** `lib/` never imports from `server/` or `app/`. Every
module under `lib/` is a pure function of its inputs: no database, no
filesystem, no DOM, no clock. That is what makes the export deterministic and
the test suite fast — and it is why preflight, the artboard and the PDF writer
cannot drift apart, because none of them can reach for a second source of truth.

---

## Request and render flow

### Editing a card

```
GET /designs/[id]/edit          Server Component
  requireCapability("design.read")            src/server/auth/current.ts
  load design + current revision + product    org-scoped queries
  buildProductContext(orgId, productId)       src/server/products.ts
  loadAssetMap(orgId) · loadOrgSettings()     src/server/render.ts
        │
        ▼
  <EditorShell doc product assets preset/>    client component
        │
        ├── store.commit(mutate)              bounded history, coalesced
        ├── planSide(doc, side, product)      lib/design/plan.ts  ── DrawOp[]
        │       └── layoutText()              lib/text/layout.ts   (µpt line breaks)
        │       └── renderBarcode()           lib/barcode          (bar rects in µpt)
        ├── <Artboard/>                       DrawOp → SVG, CMYK→sRGB preview only
        ├── autosave, debounced 1200 ms ─────► saveDesignAction()
        └── preflight, debounced 1500 ms ────► POST /api/designs/[id]/preflight
```

`saveDesignAction()` (`src/server/designs.ts`) parses the document with
`DesignDocSchema`, refuses to write a frozen revision, writes the `doc` JSON, and
re-projects the normalised element rows (`designElements`) in the same
transaction. Both halves of §4's "store enough normalized metadata" rule are
therefore written by one code path and cannot disagree.

### Exporting a production PDF

```
POST  exportProductionAction(designId, …)     src/server/exports.ts
  requireCapability("export.production")
  load revision + product + assets + org settings
        │
  planDocument(doc, product, assets)          → { front: SidePlan, back: SidePlan }
        │
  runPreflight({ doc, plans, product, … })    lib/preflight/engine.ts
        │      severity blocking?  ──── yes ──► refuse, unless an Admin supplies an
        │                                       override note → audit log + job row
        ▼ no
  renderProductionPdf({ plans, outputIntent, assetBytes, … })
        embedFaces()          subset + six-letter tag + the fontkit loca fix
        embedPlanAssets()     image XObjects, original samples, no resampling
        addCardPage()         MediaBox = CropBox = BleedBox = full-bleed canvas
        setCardBoxes()        TrimBox = the card, inset by the bleed
        drawSidePlan()        DrawOp → PDF operators, DeviceCMYK only
        applyOutputIntent()   only if a real ICC profile is configured
        │
        ▼  { bytes, complianceStatus, notes, pageBoxes }
  validateProductionPdf(bytes, expectation)   lib/pdf/validate.ts
        re-parses the bytes — boxes, physical size, fonts, colour spaces,
        image resolution, barcode presence, overlay vocabulary, clipping
        │
  putAsset() → Blob (private)
  exportArtifacts row: filename, size, validation report, preflight report, status
```

The gap between `pageBoxes` (what the writer says it wrote) and
`validateProductionPdf` (what a re-parse of the bytes finds) is deliberate: a
writer that grades its own homework proves nothing.

### Importing a workbook

```
upload .xlsx ──► uploadImportAction()         25 MB ceiling, sha256 recorded
      inspectWorkbook()                       header-row detection, per-column samples,
                                              sheet-kind guess, profile ranking
      suggestMapping()                        alias scoring against the ranked profile
      ── mapping UI, user edits ──
      buildPreview()                          diff vs catalogue, duplicate GTIN (error),
                                              duplicate part number (scoped warning),
                                              check-digit validation, per-row reason
      ── user reviews, may cancel ──
      planImport()                            a pure ImportPlan
      applyImportPlan()                        one transaction; sourceRow retained verbatim
      import report                            created / updated / skipped, with reasons
```

Nothing is written before the commit step, and the preview a user approves is
produced by the same pure functions that build the plan — so the preview and the
write cannot disagree.

### Batch generation

`src/server/batch.ts`. One template, many products. Each product is planned,
preflighted, rendered and validated independently, and **every** outcome —
success, preflight failure, render failure — becomes a manifest row with a
reason. §19 is explicit that a failed card must not silently disappear. The job
advances in slices, each committed before the next begins, so a serverless
invocation cannot time out on a 400-card run and an interrupted batch resumes
where it stopped.

### Authorisation, on every path

`src/proxy.ts` redirects a request with no session cookie to `/login`. It checks
only that a cookie is *present* — verification needs the auth secret and a
database read, and doing that on every asset request would be wasteful. **It is
not the security boundary.** Real authorisation is `requireUser()` /
`requireCapability()` inside every page, server action and route handler, and
`assertSameOrg()` on every entity fetched by id. Nothing relies on the UI having
hidden a button.
