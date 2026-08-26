# MASTER GAUNTLET LOOP --- Product Card Designer / Print Packaging Studio

## Mission

Build a production-grade **Product Card Designer** for clamshell/package
insert cards. This is not a generic Canva clone. It is a controlled
packaging-artwork system that combines:

-   exact physical card/dieline templates;
-   WYSIWYG drag-and-drop design;
-   product/BOM data;
-   GS1/GTIN/UPC data;
-   front/back artwork;
-   reusable brand templates;
-   true print-oriented CMYK output;
-   bleed, trim, safe zones, rounded corners, and cavity overlays;
-   vector barcodes;
-   press-ready PDF export;
-   batch card generation;
-   revision history, review, preflight, and approval.

The system must be built with a **Gauntlet Loop**: research -\> inspect
-\> plan -\> parallel implementation -\> specialist review -\> automated
verification -\> visual QA -\> print/prepress QA -\> remediation -\>
repeat until all gates pass.

Do not stop at "the app runs." The finished product must be usable for
real packaging production.

------------------------------------------------------------------------

# 1. SOURCE MATERIALS TO INSPECT FIRST

The project folder contains the source files. Before writing
implementation code, locate, inspect, render, and document them.

Expected source files include:

-   `206TF.pdf`
-   `277TF.pdf`
-   `409TF.pdf`
-   `11-500 front.pdf`
-   `11-500 back.pdf`
-   `Aftermarket Rev B 2026.8.10.xlsx`

Treat the CAD/dieline PDFs as geometry references and the 11-500 artwork
as the first real-world visual/data reference.

The sample 11-500 package demonstrates the intended two-sided workflow:

-   **Front:** full-color branded marketing/product-identification
    artwork.
-   **Back:** primarily black-and-white informational artwork containing
    product identity, package contents, alternate part numbers,
    fitment/replacement information, country-of-origin information,
    barcode, warnings, and other production copy.

The spreadsheet contains product, BOM, GS1, clamshell, inventory,
packaging, and related source data. Do not flatten it into a single
unstructured import. Determine the relationships between product
records, kits, BOM components, packaging/card type, UPC/GTIN,
descriptions, alternate numbers, inventory, and other useful fields.

Create `/docs/source-audit.md` before implementation. Record:

1.  files discovered;
2.  PDF page sizes;
3.  dieline geometry;
4.  spreadsheet sheets and columns;
5.  product/BOM relationships;
6.  GS1/UPC fields;
7.  sample-card content model;
8.  discrepancies or ambiguities;
9.  assumptions that require human confirmation.

Never silently "fix" conflicting source data.

------------------------------------------------------------------------

# 2. AUTHORITATIVE STARTING CARD PRESETS

Implement these three presets first.

## 409TF

**Trim/card dimensions** - Width: `4.3675 in` - Length: `7.11175 in` -
Corner radius: `0.25 in`

**Bleed** - `0.125 in` on every side

**Full bleed canvas** - Width: `4.6175 in` - Length: `7.36175 in`

## 277TF

**Trim/card dimensions** - Width: `4.343 in` - Length: `5.7875 in` -
Corner radius: `0.25 in`

**Bleed** - `0.125 in` on every side

**Full bleed canvas** - Width: `4.593 in` - Length: `6.0375 in`

## 206TF

**Trim/card dimensions** - Width: `3.1175 in` - Length: `6.4775 in` -
Corner radius: `0.25 in`

**Bleed** - `0.125 in` on every side

**Full bleed canvas** - Width: `3.3675 in` - Length: `6.7275 in`

## Important geometry rule

The supplied CAD drawings contain both clamshell/manufacturer dimensions
and card/dieline dimensions. Some values may not be numerically
identical to the production presets above.

**The preset dimensions in this prompt are authoritative for the initial
application templates.**

Preserve the CAD values separately as reference metadata. Surface
discrepancies in the source audit rather than changing production
dimensions without approval.

All dimensions must be stored internally in a deterministic physical
unit such as PDF points or microns. Do not use browser pixels as the
source of truth.

Recommended conversion:

`1 inch = 72 PDF points`

Use high-precision decimal handling. Avoid cumulative floating-point
drift.

------------------------------------------------------------------------

# 3. TECHNOLOGY BASELINE

Unless the existing repository requires otherwise, use:

-   latest stable Next.js;
-   React;
-   TypeScript in strict mode;
-   Tailwind CSS;
-   Node.js 24;
-   PostgreSQL;
-   Prisma or Drizzle;
-   Zod for runtime validation;
-   object storage for uploaded artwork/assets;
-   a robust canvas/editor architecture such as Fabric.js, Konva, or a
    justified alternative;
-   server-side PDF generation;
-   background job processing for large/batch exports;
-   Playwright for E2E;
-   Vitest for unit/integration tests.

Research the current stable versions before implementation.

Do not add a dependency merely because it is popular. Every major
dependency must have a reason recorded in `/docs/architecture.md`.

------------------------------------------------------------------------

# 4. CORE PRODUCT MODEL

At minimum model:

-   Organization
-   User
-   Role
-   Brand
-   Product
-   ProductIdentifier
-   GTIN
-   UPC
-   SKU / Part Number
-   AlternatePartNumber
-   ProductDescription
-   ProductTranslation
-   Fitment
-   CountryOfOrigin
-   Warning
-   BOM
-   BOMItem
-   PackageType
-   CardPreset
-   CardTemplate
-   CardDesign
-   CardSide
-   DesignElement
-   Asset
-   BarcodeElement
-   TextElement
-   ShapeElement
-   ImageElement
-   DataFieldElement
-   Revision
-   Approval
-   ExportJob
-   PreflightResult
-   GS1SyncRecord

Design the schema so a single product can have multiple packaging/card
configurations and multiple revisions.

A card design must never be just an opaque canvas JSON blob. Store
enough normalized metadata to query, validate, migrate, and regenerate
designs safely. Canvas serialization may be stored as part of a design
revision, but critical print/data properties must also exist as
validated structured fields.

------------------------------------------------------------------------

# 5. SPREADSHEET / BOM INGESTION

Build an import workflow for the provided workbook.

The workbook includes data areas such as:

-   Items
-   private packaging data;
-   AxleTek BOM data;
-   TowPro/private-label data;
-   Master Data;
-   GS1;
-   Clam Shells;
-   Inventory;
-   related BOM/inventory sheets.

The import system must:

1.  upload `.xlsx`;
2.  inspect sheets;
3.  show a mapping UI;
4.  auto-suggest mappings;
5.  preview changes;
6.  detect duplicate part numbers/GTINs;
7.  detect invalid or missing UPC/GTIN values;
8.  identify BOM parent/component relationships;
9.  allow import cancellation before commit;
10. create an import report;
11. retain source provenance;
12. support safe re-import/update.

Do not assume every row represents a sellable product.

Create adapters rather than hard-coding the entire application to this
one workbook.

------------------------------------------------------------------------

# 6. WYSIWYG EDITOR

Build a professional desktop-first packaging editor.

## Workspace

Required UI:

-   left asset/data panel;
-   center artboard;
-   right properties inspector;
-   top toolbar;
-   zoom controls;
-   front/back switcher;
-   rulers;
-   guides;
-   layer panel;
-   status/preflight indicator;
-   undo/redo;
-   autosave state;
-   export action.

The artboard must visually distinguish:

-   bleed boundary;
-   trim boundary;
-   safe area;
-   rounded trim corners;
-   cavity location;
-   optional hardware/clamshell obstruction zones;
-   center lines;
-   custom guides.

Overlays must be toggleable and non-printing.

## Drag and drop

Support:

-   select;
-   move;
-   resize;
-   rotate;
-   multi-select;
-   align;
-   distribute;
-   snap;
-   keyboard nudging;
-   shift-constrained transforms;
-   duplicate;
-   group/ungroup;
-   lock;
-   hide;
-   reorder layers;
-   copy/paste;
-   undo/redo.

Add contextual alignment indicators.

## Measurement

Users must be able to work in:

-   inches;
-   optionally millimeters.

The inspector should expose exact:

-   X;
-   Y;
-   width;
-   height;
-   rotation;
-   corner radius;
-   opacity;
-   stroke;
-   fill.

The UI may render in pixels, but every design operation must resolve
back to exact physical coordinates.

------------------------------------------------------------------------

# 7. FRONT AND BACK

Every card starts with two linked sides:

## Front

Default intent: - full color; - branded; - product identification; -
marketing hierarchy; - part number; - product name; -
alternate/reference part numbers where appropriate; -
fitment/replacement copy; - background art; - product imagery or brand
graphics.

## Back

Default intent: - black and white / grayscale; - highly legible; -
product identity; - "This Pack Includes" BOM-derived section; -
alternate part numbers; - fitment/replacement information; -
genuine-parts or brand statements; - country of origin; - barcode; -
warnings; - legal/compliance copy.

The editor must allow intentional color on the back if an authorized
template requires it, but the standard back template should enforce/flag
non-grayscale content.

Provide independent layers for each side while sharing product data.

------------------------------------------------------------------------

# 8. BACKGROUND UPLOAD

Users must be able to upload a background to either card side.

Support at minimum:

-   PNG;
-   JPEG;
-   TIFF if the selected processing pipeline supports it safely;
-   SVG;
-   PDF artwork where feasible.

For uploaded raster artwork:

-   retain original file;
-   extract pixel dimensions;
-   extract embedded ICC profile when available;
-   calculate effective DPI at placed size;
-   warn below configurable print-resolution thresholds;
-   never silently upscale and call the asset print-ready.

Background controls:

-   fill;
-   fit;
-   crop;
-   position;
-   scale;
-   rotation;
-   opacity;
-   lock;
-   replace.

Backgrounds must extend through bleed when configured as full bleed.

------------------------------------------------------------------------

# 9. TEXT SYSTEM

Support:

-   font family;
-   font weight;
-   font size;
-   tracking;
-   line height;
-   alignment;
-   uppercase;
-   text box dimensions;
-   vertical alignment;
-   paragraph styles;
-   rich text only if it can be exported deterministically.

Fonts used for export must be legally available to the application and
embeddable.

Never rely on a browser-only font rendering result that cannot be
reproduced in the exported PDF.

Add preflight errors for missing fonts.

------------------------------------------------------------------------

# 10. VARIABLE DATA / DATA BINDING

A key feature is the ability to bind an element to product data instead
of typing static copy.

Examples:

-   `{partNumber}`
-   `{productName}`
-   `{description}`
-   `{upc}`
-   `{gtin}`
-   `{alternatePartNumbers}`
-   `{countryOfOrigin}`
-   `{fitsOrReplaces}`
-   `{bom.packIncludes}`
-   `{brand.name}`

Provide:

-   data-field browser;
-   insert variable;
-   fallback value;
-   prefix/suffix;
-   transformations;
-   uppercase/lowercase;
-   formatting;
-   conditional visibility;
-   repeat/list blocks for BOM items.

The editor preview must resolve the actual selected product.

A template should therefore be reusable across hundreds of SKUs.

------------------------------------------------------------------------

# 11. BOM-DRIVEN "THIS PACK INCLUDES"

Create a first-class repeating component for BOM contents.

It must be able to render entries such as:

-   quantity;
-   component name;
-   component number;
-   optional description.

Support templates similar to:

`2) Inner Bearing (L44643)`

The user must be able to configure the formatting.

The block must:

-   auto-size intelligently;
-   warn on overflow;
-   allow controlled font-size reduction only within configured bounds;
-   never silently clip production copy.

------------------------------------------------------------------------

# 12. BARCODE SYSTEM

Barcodes are production-critical.

Support at minimum:

-   UPC-A;
-   EAN-13;
-   GS1-128 where required;
-   QR / GS1 Digital Link as an extensible option.

Requirements:

-   generate barcodes from structured data;
-   validate check digits;
-   preserve required quiet zones;
-   render bars as vectors in PDF whenever possible;
-   do not rasterize a barcode unless absolutely unavoidable;
-   allow human-readable digits;
-   allow configurable magnification within standards;
-   prevent arbitrary horizontal distortion;
-   warn when physical size is outside configured specification;
-   preflight contrast;
-   ensure barcode color is print-safe.

Provide a barcode verification test suite with known inputs.

------------------------------------------------------------------------

# 13. GS1 INTEGRATION

Yes: design the application to support GS1 API integration.

Build GS1 as an **adapter/service layer**, not as hard-coded UI calls.

The system should support two major workflows:

## A. Verify / enrich existing identifiers

Given a GTIN/UPC, allow an authorized user to retrieve/verify available
product/company data and compare it with the local product record.

Potential fields include:

-   GTIN;
-   SKU;
-   brand;
-   product description;
-   dimensions;
-   weights;
-   target market;
-   status;
-   product classification;
-   image URL;
-   company/license information where available.

Never overwrite local data automatically. Show a diff and require
explicit acceptance.

## B. Brand-owner create/manage workflow

If the organization has the appropriate GS1 US subscription/API access,
architect a connector for managing its own product records.

Keep credentials server-side only.

Implement:

-   encrypted credential storage;
-   API key rotation;
-   connection test;
-   request logging with secrets redacted;
-   retry/backoff;
-   rate-limit handling;
-   sync status;
-   last-synced timestamp;
-   manual refresh;
-   conflict handling.

Do not scrape GS1 pages.

The integration must work even if GS1 is not configured. GS1 is an
optional connected service, not a hard runtime dependency.

Also architect future support for **GS1 Digital Link** QR
codes/resolution.

------------------------------------------------------------------------

# 14. COLOR MANAGEMENT --- NON-NEGOTIABLE

This application must distinguish **screen preview** from **print color
data**.

A browser display is RGB. Therefore, do not claim the on-screen browser
preview itself is physically "CMYK."

Instead:

1.  store print colors as CMYK values;
2.  convert CMYK to an RGB approximation for WYSIWYG display;
3.  retain original CMYK values as source-of-truth;
4.  generate PDF using CMYK-capable primitives;
5.  preserve or correctly convert placed artwork;
6.  use an explicit print-output profile/configuration;
7.  preflight the exported PDF.

Provide color controls for:

-   CMYK;
-   grayscale;
-   spot-color-ready architecture for future use;
-   RGB input conversion warning.

CMYK fields:

-   C: 0-100
-   M: 0-100
-   Y: 0-100
-   K: 0-100

Provide named brand swatches.

## Black rules

Support configurable production rules such as:

-   text black: `0/0/0/100`;
-   rich black: configurable;
-   total area coverage limit;
-   flag registration/rich black on small text when inappropriate.

Do not invent a print profile. Make ICC/output intent configurable by
deployment/printer.

------------------------------------------------------------------------

# 15. PDF EXPORT

PDF export is a primary product feature.

Create:

### A. Production PDF

-   exact physical dimensions;
-   bleed included;
-   front and back;
-   CMYK-aware output;
-   vector text where practical;
-   embedded/subset fonts;
-   vector barcodes;
-   high-resolution placed artwork;
-   no editor overlays;
-   deterministic output.

### B. Proof PDF

May include:

-   card name;
-   SKU;
-   revision;
-   trim;
-   bleed;
-   safe zone;
-   cavity overlay;
-   dimensions;
-   timestamp;
-   approval status.

### C. Optional imposed/print-sheet PDF

Architect for later multiple-up imposition, but do not let this delay
the core card exporter.

## PDF/X

Research the actual PDF-generation stack and available prepress tooling.

Preferred target: a validated press-ready PDF workflow, ideally
**PDF/X-4** when the selected libraries/toolchain can generate and
validate it correctly.

Do **not** merely rename a normal PDF as PDF/X.

If strict PDF/X-4 conformance cannot be guaranteed by the chosen stack:

-   generate a high-quality CMYK production PDF;
-   run a documented preflight;
-   clearly label the compliance status;
-   document the remaining step required for certified PDF/X output.

Never fake compliance.

------------------------------------------------------------------------

# 16. BLEED / TRIM / SAFE AREA

For all initial presets:

-   bleed = `0.125 in` each side;
-   trim is the authoritative card size;
-   corner radius = `0.25 in`.

Create a configurable safe-area inset. Default to a sensible value, but
make it a preset property rather than an unexplained constant.

Preflight must detect:

-   background not extending through bleed;
-   critical text outside safe area;
-   barcode outside safe area;
-   objects unintentionally crossing trim;
-   low-resolution bleed artwork.

Trim corners must be represented accurately.

------------------------------------------------------------------------

# 17. CAVITY / CLAMSHELL OVERLAY

The supplied CAD files show the clamshell cavity location.

Create reusable non-printing cavity overlays for 409TF, 277TF, and
206TF.

The overlay must:

-   scale from physical measurements;
-   be visible while designing;
-   be lockable;
-   never export into production artwork unless explicitly exported as a
    proof overlay;
-   show obstruction/visibility context.

Document how each cavity shape was derived from the CAD source.

Do not guess missing geometry. If exact geometry cannot be recovered
from source files, create a clearly marked approximation and flag it for
verification.

------------------------------------------------------------------------

# 18. TEMPLATE SYSTEM

Users must be able to:

-   save a design as template;
-   duplicate template;
-   lock brand-critical layers;
-   create front/back master templates;
-   assign template to card preset;
-   assign template to brand;
-   generate a card from a product;
-   batch-generate multiple product cards.

A template should allow controlled editable regions.

Example locked elements:

-   logo;
-   brand bars;
-   legal footer;
-   standard warnings;
-   cavity-safe structure.

Example variable elements:

-   part number;
-   product name;
-   BOM list;
-   barcode;
-   alternate part numbers;
-   fitment;
-   product image.

------------------------------------------------------------------------

# 19. BATCH GENERATION

The spreadsheet/product database implies many product cards.

Build batch workflow:

1.  choose template;
2.  choose products;
3.  validate required fields;
4.  generate previews;
5.  report overflow/preflight failures;
6.  allow correction;
7.  generate production PDFs;
8.  optionally package exports into ZIP;
9.  create manifest.

Manifest fields should include:

-   SKU;
-   GTIN/UPC;
-   card preset;
-   template;
-   revision;
-   file name;
-   export timestamp;
-   preflight status.

Do not allow a failed card to silently disappear from a batch.

------------------------------------------------------------------------

# 20. REVISION / APPROVAL WORKFLOW

Every saved production change must be revision-aware.

Implement:

-   draft;
-   in review;
-   approved;
-   superseded.

Store:

-   creator;
-   timestamps;
-   revision notes;
-   source data version;
-   template version;
-   GS1 sync state;
-   export history.

Approved revisions should be immutable. Editing an approved card creates
a new revision.

Provide visual comparison between revisions where feasible.

------------------------------------------------------------------------

# 21. PREFLIGHT ENGINE

Create a real preflight engine.

Severity levels:

-   info;
-   warning;
-   error;
-   blocking error.

Checks should include:

-   document dimensions;
-   bleed;
-   trim;
-   safe zone;
-   missing linked assets;
-   missing fonts;
-   raster DPI;
-   RGB asset present in CMYK production workflow;
-   text overflow;
-   unresolved variables;
-   missing product fields;
-   invalid UPC/GTIN;
-   barcode quiet zone;
-   barcode physical dimensions;
-   barcode contrast;
-   barcode clipping;
-   cavity conflicts;
-   non-grayscale content on standard back;
-   transparency/export concerns;
-   total ink limit if measurable;
-   empty front/back;
-   hidden required elements.

A production export with blocking errors must require an explicit
privileged override with an audit note, or be blocked entirely depending
on configuration.

------------------------------------------------------------------------

# 22. EXPORT VALIDATION

After creating every PDF, programmatically verify:

-   MediaBox;
-   CropBox;
-   BleedBox where used;
-   TrimBox;
-   physical dimensions;
-   page count;
-   font embedding;
-   expected color spaces;
-   image resolution metadata where available;
-   barcode presence;
-   no editor overlays;
-   no accidental clipping.

Render the exported PDF to images and compare against the editor
reference/proof.

Create automated geometry tests for all three presets.

Expected full-bleed dimensions:

  Preset         Width       Length
  -------- ----------- ------------
  409TF      4.6175 in   7.36175 in
  277TF       4.593 in    6.0375 in
  206TF      3.3675 in    6.7275 in

Use tolerance appropriate for PDF point conversion, and document it.

------------------------------------------------------------------------

# 23. SAMPLE REPRODUCTION MILESTONE

Before calling the editor production-ready, use the provided
`11-500 front.pdf` and `11-500 back.pdf` as a benchmark.

Recreate the functional structure of the sample inside the new editor:

## Front benchmark

Must demonstrate:

-   brand/logo region;
-   part number;
-   product title;
-   product subtitle/specification;
-   multilingual copy;
-   alternate part number;
-   large background/brand graphic;
-   fitment/replacement footer;
-   full-color design.

## Back benchmark

Must demonstrate:

-   logo;
-   part number;
-   title/specification;
-   multilingual copy;
-   "This Pack Includes" BOM list;
-   alternate part number;
-   fitment/replacement section;
-   genuine-parts/brand section;
-   country of origin;
-   barcode;
-   warning/footer;
-   black-and-white design.

The goal is not pixel-for-pixel plagiarism of a PDF. The goal is proving
that the system can represent and output the same classes of production
content.

------------------------------------------------------------------------

# 24. UX REQUIREMENTS

The app should feel like a focused professional packaging tool, not an
admin dashboard with a canvas bolted onto it.

Priorities:

1.  artboard;
2.  product data;
3.  precise dimensions;
4.  fast manipulation;
5.  reliable output.

Required usability:

-   autosave;
-   command shortcuts;
-   keyboard delete;
-   arrow nudging;
-   shift nudge;
-   zoom-to-fit;
-   100% view;
-   pan;
-   ruler;
-   guides;
-   snapping;
-   visible selection bounds;
-   object lock;
-   layers;
-   context menu;
-   duplicate;
-   copy/paste;
-   clear unsaved/export states.

Persist editor preferences per user.

------------------------------------------------------------------------

# 25. SECURITY

Implement:

-   authentication;
-   organization isolation;
-   RBAC;
-   server-side authorization;
-   secure asset uploads;
-   MIME validation;
-   file-size limits;
-   malware scanning hook;
-   signed asset URLs where appropriate;
-   encrypted third-party credentials;
-   audit logs;
-   rate limiting;
-   CSRF-safe patterns;
-   no secrets in client bundles;
-   no GS1 credentials in browser storage.

Roles can begin with:

-   Admin
-   Designer
-   Reviewer
-   Viewer

------------------------------------------------------------------------

# 26. PERFORMANCE

Target smooth editing on normal modern desktop hardware.

Requirements:

-   do not rerender the full React tree on every pointer movement;
-   virtualize long asset/product lists;
-   use image thumbnails;
-   lazy-load heavy assets;
-   use worker/background processing where beneficial;
-   debounce autosave;
-   avoid storing giant base64 blobs in database rows;
-   cache derived previews;
-   queue heavy PDF/batch exports.

Measure before optimizing, but test realistic complex cards.

------------------------------------------------------------------------

# 27. ACCESSIBILITY

The editor itself must remain keyboard-accessible where practical.

Admin/data screens should meet normal WCAG expectations.

Do not sacrifice the precision-editor UX to force inappropriate generic
form patterns, but provide accessible labels, focus management,
contrast, and keyboard equivalents.

------------------------------------------------------------------------

# 28. GAUNTLET AGENT ORGANIZATION

Launch parallel agents/subagents where supported.

Use **maximum-reasoning / maximum-effort** agents for architecture,
print/prepress, data integrity, and final review.

Recommended swarm:

## Agent A --- Repository / Architecture Lead

-   inspect repo;
-   architecture;
-   dependency decisions;
-   data model;
-   integration plan.

## Agent B --- CAD / Geometry Specialist

-   inspect all three CAD PDFs;
-   derive trim/cavity overlays;
-   validate dimensions;
-   build geometry fixtures/tests.

## Agent C --- Packaging / Prepress Specialist

-   CMYK architecture;
-   ICC/output intent;
-   bleed/trim/safe;
-   PDF generation;
-   PDF/X research;
-   font embedding;
-   raster resolution;
-   preflight.

## Agent D --- Editor / Canvas Specialist

-   WYSIWYG;
-   selection;
-   transforms;
-   layers;
-   snapping;
-   rulers/guides;
-   keyboard controls.

## Agent E --- Product Data / BOM Specialist

-   spreadsheet analysis;
-   import;
-   relational schema;
-   BOM list generation;
-   variable data.

## Agent F --- GS1 / Barcode Specialist

-   GS1 API architecture;
-   GTIN validation;
-   barcode generation;
-   quiet zones;
-   GS1 Digital Link future path.

## Agent G --- UI/UX Specialist

-   packaging-tool interface;
-   editor workflow;
-   responsive admin views;
-   design-system consistency.

## Agent H --- Backend / Jobs Specialist

-   persistence;
-   revisions;
-   storage;
-   export queue;
-   batch generation;
-   manifests.

## Agent I --- Security Reviewer

-   auth;
-   RBAC;
-   upload security;
-   credential handling;
-   organization isolation.

## Agent J --- Test Engineer

-   unit;
-   integration;
-   E2E;
-   visual regression;
-   PDF geometry tests;
-   barcode tests.

## Agent K --- Adversarial Reviewer

Assume the implementation is wrong until proven otherwise.

Attempt to break: - dimensions; - exports; - color handling; -
undo/redo; - batch generation; - data binding; - malformed
spreadsheets; - long text; - missing fonts; - missing assets; - invalid
UPCs; - huge images; - concurrent edits; - revision integrity.

## Agent L --- Final Production Reviewer

Review the entire system as though approving artwork for a commercial
print run.

No rubber-stamping.

------------------------------------------------------------------------

# 29. THE GAUNTLET LOOP

Execute this loop until completion.

## LOOP 1 --- Discover

-   inspect repository;
-   inspect source PDFs;
-   inspect workbook;
-   research dependencies;
-   research current GS1 API capabilities;
-   research CMYK/PDF capabilities of candidate libraries;
-   document findings.

Output: - `/docs/source-audit.md` - `/docs/architecture.md` -
`/docs/print-pipeline.md` - `/docs/data-model.md`

## LOOP 2 --- Plan

Create an implementation plan broken into independent workstreams.

Identify shared contracts first:

-   geometry schema;
-   design-document schema;
-   product schema;
-   export interface;
-   barcode interface;
-   GS1 adapter;
-   preflight result schema.

Do not allow parallel agents to invent incompatible schemas.

## LOOP 3 --- Build in Parallel

Fan out implementation.

Each worker: - works within defined ownership; - adds tests; - documents
non-obvious decisions; - does not weaken type safety; - does not bypass
failures.

## LOOP 4 --- Integrate

Merge workstreams.

Run: - formatter; - lint; - typecheck; - unit tests; - integration
tests; - build.

Fix all failures.

## LOOP 5 --- Visual QA

Run application.

Capture screenshots of: - dashboard; - product import; - product
detail; - 409TF editor; - 277TF editor; - 206TF editor; - front; -
back; - background upload; - barcode; - BOM repeat block; - export
dialog; - preflight; - revision view.

Review for: - overlap; - clipping; - broken scaling; - inconsistent
spacing; - poor controls; - unusable editor density.

Fix issues.

## LOOP 6 --- Print QA

Generate test PDFs for all presets.

Programmatically inspect them.

Render them.

Validate physical dimensions.

Inspect CMYK/color-space behavior.

Inspect fonts.

Inspect barcode output.

Inspect bleed.

Inspect trim.

Inspect cavity overlay exclusion.

Fix every failure.

## LOOP 7 --- Adversarial QA

Give the project to the adversarial reviewer with no implementation
assumptions.

Reviewer produces: - blocker; - critical; - major; - minor; - polish.

Every blocker/critical/major issue must be resolved.

## LOOP 8 --- Re-run Everything

After fixes:

-   lint;
-   typecheck;
-   tests;
-   build;
-   E2E;
-   PDF validation;
-   visual regression;
-   security checks;
-   preflight fixtures.

No "it passed before the fix" logic.

## LOOP 9 --- Final Review

Final production reviewer verifies requirements against this prompt one
by one.

Create `/docs/final-gauntlet-report.md`.

For every requirement mark:

-   PASS;
-   PARTIAL;
-   FAIL;
-   NOT APPLICABLE.

No unsupported PASS statements.

------------------------------------------------------------------------

# 30. DEFINITION OF DONE

The project is complete only when all of the following are true:

-   all three card presets exist;
-   dimensions are physically accurate;
-   bleed is accurate;
-   corner radius is represented;
-   cavity overlays exist;
-   front/back editor works;
-   full-color front workflow works;
-   black-and-white back workflow works;
-   backgrounds upload and position correctly;
-   text editing works;
-   layers work;
-   snapping/guides work;
-   variable product fields work;
-   BOM repeating list works;
-   workbook import works;
-   UPC/GTIN validation works;
-   vector barcode generation works;
-   GS1 integration architecture exists;
-   GS1 can be configured without exposing credentials;
-   CMYK values are preserved as print data;
-   screen RGB preview is honestly treated as preview;
-   production PDF export works;
-   bleed/trim boxes are validated;
-   fonts are embedded/subset as supported;
-   low-DPI artwork is detected;
-   unresolved data is detected;
-   preflight works;
-   batch generation works;
-   revisions work;
-   approvals work;
-   approved artwork is immutable;
-   sample 11-500 content structure can be reproduced;
-   tests pass;
-   build passes;
-   E2E passes;
-   exported PDFs have been rendered and visually inspected;
-   final gauntlet report has no unresolved blocker/critical/major
    findings.

------------------------------------------------------------------------

# 31. REQUIRED DELIVERABLES

At completion provide:

1.  working application;
2.  database migrations/schema;
3.  seed data for 409TF, 277TF, 206TF;
4.  source workbook importer;
5.  WYSIWYG editor;
6.  product-data binding;
7.  BOM component;
8.  barcode generator;
9.  GS1 connector interface;
10. production PDF exporter;
11. proof PDF exporter;
12. preflight engine;
13. batch export;
14. revision/approval system;
15. automated test suite;
16. `/docs/source-audit.md`;
17. `/docs/architecture.md`;
18. `/docs/data-model.md`;
19. `/docs/print-pipeline.md`;
20. `/docs/gs1-integration.md`;
21. `/docs/testing.md`;
22. `/docs/final-gauntlet-report.md`;
23. sample exported PDFs for all three presets;
24. sample 11-500 recreation/proof.

------------------------------------------------------------------------

# 32. IMPLEMENTATION RULES

-   Do not ask for permission for routine engineering decisions.
-   Do not stop after scaffolding.
-   Do not replace requested functionality with TODO comments.
-   Do not fake CMYK.
-   Do not fake PDF/X compliance.
-   Do not rasterize the entire card just to simplify PDF export.
-   Do not trust browser pixels as print dimensions.
-   Do not silently clip overflowing copy.
-   Do not silently correct source data.
-   Do not expose API secrets.
-   Do not mark tests passed without running them.
-   Do not mark visual QA complete without viewing rendered output.
-   Do not mark print QA complete without inspecting generated PDFs.
-   Do not delete existing working application functionality unless
    required and documented.
-   Prefer deterministic, testable print behavior over clever UI
    abstractions.

------------------------------------------------------------------------

# 33. FIRST EXECUTION INSTRUCTION

Begin now.

1.  Inspect the repository.
2.  Locate all supplied source files.
3.  Render and inspect the CAD and sample PDFs.
4.  Inspect every relevant workbook sheet.
5.  Write the source audit.
6.  Research the current GS1 API path and print/PDF toolchain.
7.  Establish shared schemas/contracts.
8.  Launch the specialist agent swarm.
9.  Build the smallest end-to-end vertical slice first:

`Product -> 206TF template -> front/back editor -> variable data -> barcode -> CMYK-aware PDF -> preflight -> validated export`

10. Once that vertical slice passes the gauntlet, generalize it to 277TF
    and 409TF.
11. Continue the loop until the Definition of Done is satisfied.

The final answer must include the final gauntlet report summary and
exact locations of generated production sample PDFs.
