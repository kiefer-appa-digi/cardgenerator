import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

/**
 * DATA MODEL — spec §4.
 *
 * Conventions
 *  - Every physical length is `bigint` micro-points (see lib/units.ts).
 *  - Every tenant-scoped table carries `orgId`; every query path filters on it
 *    (organisation isolation, spec §25).
 *  - Design geometry is stored twice on purpose: the validated `doc` JSON is the
 *    editable document, and the normalised child tables (`designElements`,
 *    `barcodeElements`, …) hold the print/data-critical properties so they can be
 *    queried, validated and migrated without parsing the blob (spec §4).
 */

const id = () => varchar("id", { length: 32 }).primaryKey();
const ref = (name: string) => varchar(name, { length: 32 });
const ts = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" }).notNull().defaultNow();

/* ---------------------------------------------------------------- tenancy */

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  /** Black rules, preflight profile, output intent, export policy. */
  settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

export const ROLES = ["admin", "designer", "reviewer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const users = pgTable(
  "users",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    name: text("name").notNull().default(""),
    passwordHash: text("password_hash").notNull(),
    role: varchar("role", { length: 16 }).notNull().default("viewer"),
    active: boolean("active").notNull().default(true),
    /** Per-user editor preferences (spec §24). */
    preferences: jsonb("preferences").notNull().default(sql`'{}'::jsonb`),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: "date" }),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "date" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email), index("users_org_idx").on(t.orgId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: ref("user_id").notNull(),
    orgId: ref("org_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    userAgent: text("user_agent").notNull().default(""),
    ip: varchar("ip", { length: 64 }).notNull().default(""),
    createdAt: ts("created_at"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    userId: ref("user_id"),
    action: varchar("action", { length: 64 }).notNull(),
    entityType: varchar("entity_type", { length: 48 }).notNull(),
    entityId: varchar("entity_id", { length: 32 }),
    detail: jsonb("detail").notNull().default(sql`'{}'::jsonb`),
    ip: varchar("ip", { length: 64 }).notNull().default(""),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("audit_org_idx").on(t.orgId, t.createdAt),
    index("audit_entity_idx").on(t.entityType, t.entityId),
  ],
);

/* ------------------------------------------------------------------ brand */

export const brands = pgTable(
  "brands",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    name: text("name").notNull(),
    legalName: text("legal_name").notNull().default(""),
    /** Genuine-parts / brand assurance paragraph used on backs. */
    statement: text("statement").notNull().default(""),
    logoAssetId: ref("logo_asset_id"),
    /** Named swatches, in the PrintColor shape. */
    swatches: jsonb("swatches").notNull().default(sql`'[]'::jsonb`),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("brands_org_name_uq").on(t.orgId, t.name)],
);

/* ---------------------------------------------------------------- product */

export const products = pgTable(
  "products",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    brandId: ref("brand_id"),
    /** Selling part number. Unique per org+brand, not globally: the source data
     *  legitimately reuses a SKU across brands (41 cases in the supplied export). */
    partNumber: varchar("part_number", { length: 64 }).notNull().default(""),
    productName: text("product_name").notNull().default(""),
    description: text("description").notNull().default(""),
    descriptionShort: text("description_short").notNull().default(""),
    labelDescription: text("label_description").notNull().default(""),
    subtitle: text("subtitle").notNull().default(""),
    countryOfOrigin: text("country_of_origin").notNull().default(""),
    /** GS1 lifecycle status: In Use / PreMarket / Draft / Archived. */
    status: varchar("status", { length: 24 }).notNull().default("Draft"),
    packagingLevel: varchar("packaging_level", { length: 24 }).notNull().default("Each"),
    netContentCount: text("net_content_count").notNull().default(""),
    netContentUom: varchar("net_content_uom", { length: 16 }).notNull().default(""),
    isPurchasable: boolean("is_purchasable").notNull().default(true),
    isVariable: boolean("is_variable").notNull().default(false),
    /** Is this row a sellable product, a kit parent, or a BOM-only component? */
    recordType: varchar("record_type", { length: 16 }).notNull().default("product"),
    targetMarkets: text("target_markets").notNull().default(""),
    gpcBrick: text("gpc_brick").notNull().default(""),
    /** Which card preset this product normally ships in. */
    defaultPresetCode: varchar("default_preset_code", { length: 16 }),
    /** Provenance: importId + source row, retained verbatim (spec §5). */
    sourceImportId: ref("source_import_id"),
    sourceRow: jsonb("source_row").notNull().default(sql`'{}'::jsonb`),
    custom: jsonb("custom").notNull().default(sql`'{}'::jsonb`),
    lastModifiedSource: text("last_modified_source").notNull().default(""),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("products_org_idx").on(t.orgId),
    index("products_part_idx").on(t.orgId, t.partNumber),
    index("products_brand_idx").on(t.brandId),
  ],
);

export const productIdentifiers = pgTable(
  "product_identifiers",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    productId: ref("product_id").notNull(),
    /** gtin14 | gtin13 | gtin12 | gtin8 | sku | gs1CompanyPrefix */
    kind: varchar("kind", { length: 24 }).notNull(),
    value: varchar("value", { length: 64 }).notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    /** Result of check-digit validation at import time. */
    valid: boolean("valid").notNull().default(true),
    validationNote: text("validation_note").notNull().default(""),
    createdAt: ts("created_at"),
  },
  (t) => [
    index("pid_product_idx").on(t.productId),
    index("pid_value_idx").on(t.orgId, t.kind, t.value),
  ],
);

export const alternatePartNumbers = pgTable(
  "alternate_part_numbers",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    productId: ref("product_id").notNull(),
    value: varchar("value", { length: 64 }).notNull(),
    /** competitor | superseded | oem | interchange */
    relation: varchar("relation", { length: 24 }).notNull().default("interchange"),
    note: text("note").notNull().default(""),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("apn_product_idx").on(t.productId)],
);

export const productTranslations = pgTable(
  "product_translations",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    productId: ref("product_id").notNull(),
    locale: varchar("locale", { length: 12 }).notNull(),
    field: varchar("field", { length: 48 }).notNull(),
    value: text("value").notNull(),
  },
  (t) => [uniqueIndex("ptr_uq").on(t.productId, t.locale, t.field)],
);

export const fitments = pgTable(
  "fitments",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    productId: ref("product_id").notNull(),
    /** "Fits" or "Replaces" or free text. */
    kind: varchar("kind", { length: 24 }).notNull().default("fits"),
    text: text("text").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("fit_product_idx").on(t.productId)],
);

export const warnings = pgTable(
  "warnings",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    /** Null productId = an org-wide warning available to any template. */
    productId: ref("product_id"),
    code: varchar("code", { length: 32 }).notNull().default(""),
    text: text("text").notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("warn_product_idx").on(t.productId)],
);

export const boms = pgTable(
  "boms",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    productId: ref("product_id").notNull(),
    name: text("name").notNull().default("Pack contents"),
    revision: varchar("revision", { length: 32 }).notNull().default(""),
    sourceImportId: ref("source_import_id"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("bom_product_idx").on(t.productId)],
);

export const bomItems = pgTable(
  "bom_items",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    bomId: ref("bom_id").notNull(),
    /** Optional link to a product record when the component is itself stocked. */
    componentProductId: ref("component_product_id"),
    position: integer("position").notNull().default(0),
    quantity: text("quantity").notNull().default("1"),
    unitOfMeasure: varchar("unit_of_measure", { length: 16 }).notNull().default("EA"),
    name: text("name").notNull().default(""),
    partNumber: varchar("part_number", { length: 64 }).notNull().default(""),
    description: text("description").notNull().default(""),
  },
  (t) => [index("bomitem_bom_idx").on(t.bomId)],
);

/* -------------------------------------------------------------- packaging */

export const packageTypes = pgTable("package_types", {
  id: id(),
  orgId: ref("org_id").notNull(),
  code: varchar("code", { length: 32 }).notNull(),
  name: text("name").notNull(),
  vendor: text("vendor").notNull().default(""),
  material: text("material").notNull().default(""),
  notes: text("notes").notNull().default(""),
  /** Verbatim CAD callouts and file provenance. */
  cadReference: jsonb("cad_reference").notNull().default(sql`'{}'::jsonb`),
});

export const cardPresets = pgTable(
  "card_presets",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    packageTypeId: ref("package_type_id"),
    code: varchar("code", { length: 16 }).notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** All µpt. */
    trimWidth: bigint("trim_width", { mode: "number" }).notNull(),
    trimHeight: bigint("trim_height", { mode: "number" }).notNull(),
    cornerRadius: bigint("corner_radius", { mode: "number" }).notNull(),
    bleedTop: bigint("bleed_top", { mode: "number" }).notNull(),
    bleedRight: bigint("bleed_right", { mode: "number" }).notNull(),
    bleedBottom: bigint("bleed_bottom", { mode: "number" }).notNull(),
    bleedLeft: bigint("bleed_left", { mode: "number" }).notNull(),
    safeTop: bigint("safe_top", { mode: "number" }).notNull(),
    safeRight: bigint("safe_right", { mode: "number" }).notNull(),
    safeBottom: bigint("safe_bottom", { mode: "number" }).notNull(),
    safeLeft: bigint("safe_left", { mode: "number" }).notNull(),
    /** CavitySpec: rect in trim space + radius + provenance. */
    cavity: jsonb("cavity").notNull().default(sql`'{}'::jsonb`),
    cadReference: jsonb("cad_reference").notNull().default(sql`'{}'::jsonb`),
    createdAt: ts("created_at"),
  },
  (t) => [uniqueIndex("preset_org_code_uq").on(t.orgId, t.code)],
);

/* ------------------------------------------------------------------ asset */

export const assets = pgTable(
  "assets",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    uploadedBy: ref("uploaded_by"),
    filename: text("filename").notNull(),
    contentType: varchar("content_type", { length: 128 }).notNull(),
    byteSize: integer("byte_size").notNull().default(0),
    /** Blob storage pathname; served through a signed, org-checked route. */
    storageKey: text("storage_key").notNull(),
    storageUrl: text("storage_url").notNull().default(""),
    thumbnailUrl: text("thumbnail_url").notNull().default(""),
    /** Raster metadata; null for vector sources. */
    pixelWidth: integer("pixel_width"),
    pixelHeight: integer("pixel_height"),
    /** Embedded resolution when the file declares one. */
    declaredDpi: integer("declared_dpi"),
    colorSpace: varchar("color_space", { length: 24 }).notNull().default("unknown"),
    hasAlpha: boolean("has_alpha").notNull().default(false),
    iccProfileName: text("icc_profile_name").notNull().default(""),
    hasIccProfile: boolean("has_icc_profile").notNull().default(false),
    sha256: varchar("sha256", { length: 64 }).notNull().default(""),
    /** Malware scanning hook result: pending | clean | flagged | skipped. */
    scanStatus: varchar("scan_status", { length: 16 }).notNull().default("skipped"),
    scanDetail: text("scan_detail").notNull().default(""),
    createdAt: ts("created_at"),
  },
  (t) => [index("assets_org_idx").on(t.orgId, t.createdAt)],
);

/* --------------------------------------------------------------- template */

export const cardTemplates = pgTable(
  "card_templates",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    brandId: ref("brand_id"),
    presetCode: varchar("preset_code", { length: 16 }).notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Validated DesignDoc used as the starting point for generated cards. */
    doc: jsonb("doc").notNull(),
    version: integer("version").notNull().default(1),
    isMaster: boolean("is_master").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    createdBy: ref("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("tpl_org_idx").on(t.orgId), index("tpl_preset_idx").on(t.orgId, t.presetCode)],
);

/* ----------------------------------------------------------------- design */

export const DESIGN_STATUSES = ["draft", "in_review", "approved", "superseded"] as const;

export const cardDesigns = pgTable(
  "card_designs",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    productId: ref("product_id"),
    brandId: ref("brand_id"),
    templateId: ref("template_id"),
    presetCode: varchar("preset_code", { length: 16 }).notNull(),
    name: text("name").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("draft"),
    /** Points at the revision that is currently open for editing. */
    currentRevisionId: ref("current_revision_id"),
    /** Points at the most recent approved revision, if any. */
    approvedRevisionId: ref("approved_revision_id"),
    createdBy: ref("created_by"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [
    index("design_org_idx").on(t.orgId, t.updatedAt),
    index("design_product_idx").on(t.productId),
  ],
);

export const revisions = pgTable(
  "revisions",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    designId: ref("design_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("draft"),
    /** Frozen when the revision is approved; never mutated afterwards. */
    doc: jsonb("doc").notNull(),
    /** Snapshot of the resolved ProductContext this revision was built against. */
    productSnapshot: jsonb("product_snapshot").notNull().default(sql`'{}'::jsonb`),
    templateVersion: integer("template_version"),
    notes: text("notes").notNull().default(""),
    /** Last stored preflight report for this revision. */
    preflight: jsonb("preflight"),
    gs1SyncState: varchar("gs1_sync_state", { length: 24 }).notNull().default("not_synced"),
    createdBy: ref("created_by"),
    createdAt: ts("created_at"),
    /** Set the moment the revision is approved; the row becomes immutable. */
    frozenAt: timestamp("frozen_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    uniqueIndex("rev_design_num_uq").on(t.designId, t.revisionNumber),
    index("rev_design_idx").on(t.designId),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    revisionId: ref("revision_id").notNull(),
    /** submitted | approved | rejected | withdrawn */
    action: varchar("action", { length: 16 }).notNull(),
    actorId: ref("actor_id"),
    note: text("note").notNull().default(""),
    /** Preflight state at the moment of the decision. */
    preflightSnapshot: jsonb("preflight_snapshot"),
    createdAt: ts("created_at"),
  },
  (t) => [index("appr_rev_idx").on(t.revisionId)],
);

/**
 * Normalised print/data-critical element facts, projected from the design doc on
 * every save. These exist so the system can answer "which cards use GTIN X",
 * "which cards have an unresolved binding", "which cards use font Y" without
 * parsing a JSON blob — spec §4.
 */
export const designElements = pgTable(
  "design_elements",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    revisionId: ref("revision_id").notNull(),
    elementId: varchar("element_id", { length: 64 }).notNull(),
    side: varchar("side", { length: 8 }).notNull(),
    kind: varchar("kind", { length: 16 }).notNull(),
    name: text("name").notNull().default(""),
    zIndex: integer("z_index").notNull().default(0),
    x: bigint("x", { mode: "number" }).notNull(),
    y: bigint("y", { mode: "number" }).notNull(),
    w: bigint("w", { mode: "number" }).notNull(),
    h: bigint("h", { mode: "number" }).notNull(),
    rotation: integer("rotation").notNull().default(0),
    opacity: integer("opacity").notNull().default(10_000),
    locked: boolean("locked").notNull().default(false),
    hidden: boolean("hidden").notNull().default(false),
    required: boolean("required").notNull().default(false),
    /** Dotted binding paths referenced anywhere in this element. */
    bindingPaths: jsonb("binding_paths").notNull().default(sql`'[]'::jsonb`),
    fontFamilies: jsonb("font_families").notNull().default(sql`'[]'::jsonb`),
    assetId: ref("asset_id"),
    /** Colours used, in PrintColor shape, for ink and grayscale queries. */
    colors: jsonb("colors").notNull().default(sql`'[]'::jsonb`),
    /** Barcode facts, when kind = 'barcode'. */
    barcodeSymbology: varchar("barcode_symbology", { length: 24 }),
    barcodeValue: varchar("barcode_value", { length: 128 }),
    barcodeMagnification: integer("barcode_magnification"),
    barcodeModuleWidth: bigint("barcode_module_width", { mode: "number" }),
  },
  (t) => [
    index("de_rev_idx").on(t.revisionId),
    index("de_barcode_idx").on(t.orgId, t.barcodeValue),
    index("de_asset_idx").on(t.assetId),
  ],
);

/* ------------------------------------------------------------------ export */

export const exportJobs = pgTable(
  "export_jobs",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    /** production | proof | batch */
    kind: varchar("kind", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("queued"),
    createdBy: ref("created_by"),
    templateId: ref("template_id"),
    presetCode: varchar("preset_code", { length: 16 }),
    /** Job inputs: product ids, options, override note. */
    request: jsonb("request").notNull().default(sql`'{}'::jsonb`),
    totalItems: integer("total_items").notNull().default(0),
    completedItems: integer("completed_items").notNull().default(0),
    failedItems: integer("failed_items").notNull().default(0),
    /** Manifest rows (spec §19). Written incrementally so nothing disappears. */
    manifest: jsonb("manifest").notNull().default(sql`'[]'::jsonb`),
    error: text("error").notNull().default(""),
    /** Blocking-error override, when an Admin forced the run (spec §21). */
    overrideBy: ref("override_by"),
    overrideNote: text("override_note").notNull().default(""),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    createdAt: ts("created_at"),
  },
  (t) => [index("job_org_idx").on(t.orgId, t.createdAt)],
);

export const exportArtifacts = pgTable(
  "export_artifacts",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    jobId: ref("job_id").notNull(),
    revisionId: ref("revision_id"),
    productId: ref("product_id"),
    filename: text("filename").notNull(),
    storageKey: text("storage_key").notNull().default(""),
    storageUrl: text("storage_url").notNull().default(""),
    byteSize: integer("byte_size").notNull().default(0),
    kind: varchar("kind", { length: 16 }).notNull().default("production"),
    /** Result of the post-export PDF inspection (spec §22). */
    validation: jsonb("validation").notNull().default(sql`'{}'::jsonb`),
    preflight: jsonb("preflight"),
    /** ok | invalid — "invalid" means the file failed its own post-export check. */
    status: varchar("status", { length: 24 }).notNull().default("ok"),
    error: text("error").notNull().default(""),
    createdAt: ts("created_at"),
  },
  (t) => [index("art_job_idx").on(t.jobId)],
);

export const preflightResults = pgTable(
  "preflight_results",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    revisionId: ref("revision_id").notNull(),
    productId: ref("product_id"),
    profileName: text("profile_name").notNull().default(""),
    report: jsonb("report").notNull(),
    exportable: boolean("exportable").notNull().default(false),
    createdAt: ts("created_at"),
  },
  (t) => [index("pf_rev_idx").on(t.revisionId, t.createdAt)],
);

/* -------------------------------------------------------------------- GS1 */

export const gs1Connections = pgTable(
  "gs1_connections",
  {
    id: id(),
    orgId: ref("org_id").notNull().unique(),
    /** gs1us-verified | gs1us-datahub | custom | disabled */
    provider: varchar("provider", { length: 32 }).notNull().default("disabled"),
    baseUrl: text("base_url").notNull().default(""),
    companyPrefix: varchar("company_prefix", { length: 24 }).notNull().default(""),
    /** AES-256-GCM ciphertext. Never leaves the server, never sent to a client. */
    credentialCiphertext: text("credential_ciphertext").notNull().default(""),
    credentialIv: varchar("credential_iv", { length: 32 }).notNull().default(""),
    credentialTag: varchar("credential_tag", { length: 32 }).notNull().default(""),
    keyVersion: integer("key_version").notNull().default(1),
    enabled: boolean("enabled").notNull().default(false),
    lastTestAt: timestamp("last_test_at", { withTimezone: true, mode: "date" }),
    lastTestOk: boolean("last_test_ok").notNull().default(false),
    lastTestDetail: text("last_test_detail").notNull().default(""),
    rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: "date" }),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
);

export const gs1SyncRecords = pgTable(
  "gs1_sync_records",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    productId: ref("product_id").notNull(),
    gtin: varchar("gtin", { length: 24 }).notNull(),
    /** verify | enrich | publish */
    operation: varchar("operation", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    /** Remote payload, secrets already redacted. */
    remotePayload: jsonb("remote_payload"),
    /** Field-level diff awaiting explicit acceptance; never auto-applied. */
    diff: jsonb("diff").notNull().default(sql`'[]'::jsonb`),
    acceptedFields: jsonb("accepted_fields").notNull().default(sql`'[]'::jsonb`),
    acceptedBy: ref("accepted_by"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    error: text("error").notNull().default(""),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "date" }),
    createdAt: ts("created_at"),
  },
  (t) => [index("gs1sync_product_idx").on(t.productId, t.createdAt)],
);

export const gs1RequestLogs = pgTable(
  "gs1_request_logs",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    method: varchar("method", { length: 8 }).notNull(),
    path: text("path").notNull(),
    statusCode: integer("status_code"),
    durationMs: integer("duration_ms"),
    /** Redacted request/response summaries — never raw credentials. */
    requestSummary: jsonb("request_summary").notNull().default(sql`'{}'::jsonb`),
    responseSummary: jsonb("response_summary").notNull().default(sql`'{}'::jsonb`),
    error: text("error").notNull().default(""),
    createdAt: ts("created_at"),
  },
  (t) => [index("gs1log_org_idx").on(t.orgId, t.createdAt)],
);

/* ----------------------------------------------------------------- import */

export const imports = pgTable(
  "imports",
  {
    id: id(),
    orgId: ref("org_id").notNull(),
    createdBy: ref("created_by"),
    filename: text("filename").notNull(),
    byteSize: integer("byte_size").notNull().default(0),
    sha256: varchar("sha256", { length: 64 }).notNull().default(""),
    storageKey: text("storage_key").notNull().default(""),
    /** inspecting | mapping | previewed | committed | cancelled | failed */
    status: varchar("status", { length: 16 }).notNull().default("inspecting"),
    /** Detected sheets, headers, row counts, inferred kinds. */
    inspection: jsonb("inspection").notNull().default(sql`'{}'::jsonb`),
    /** User-confirmed column → field mapping per sheet. */
    mapping: jsonb("mapping").notNull().default(sql`'{}'::jsonb`),
    /** Diff preview + duplicate/validation findings, computed before commit. */
    preview: jsonb("preview").notNull().default(sql`'{}'::jsonb`),
    /** Post-commit report (spec §5.10). */
    report: jsonb("report").notNull().default(sql`'{}'::jsonb`),
    rowsTotal: integer("rows_total").notNull().default(0),
    rowsCreated: integer("rows_created").notNull().default(0),
    rowsUpdated: integer("rows_updated").notNull().default(0),
    rowsSkipped: integer("rows_skipped").notNull().default(0),
    error: text("error").notNull().default(""),
    createdAt: ts("created_at"),
    committedAt: timestamp("committed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [index("imports_org_idx").on(t.orgId, t.createdAt)],
);

/* -------------------------------------------------------------- relations */

export const orgRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  products: many(products),
  brands: many(brands),
}));

export const productRelations = relations(products, ({ one, many }) => ({
  org: one(organizations, { fields: [products.orgId], references: [organizations.id] }),
  brand: one(brands, { fields: [products.brandId], references: [brands.id] }),
  identifiers: many(productIdentifiers),
  alternates: many(alternatePartNumbers),
  fitments: many(fitments),
  warnings: many(warnings),
  boms: many(boms),
  designs: many(cardDesigns),
}));

export const bomRelations = relations(boms, ({ one, many }) => ({
  product: one(products, { fields: [boms.productId], references: [products.id] }),
  items: many(bomItems),
}));

export const bomItemRelations = relations(bomItems, ({ one }) => ({
  bom: one(boms, { fields: [bomItems.bomId], references: [boms.id] }),
  component: one(products, {
    fields: [bomItems.componentProductId],
    references: [products.id],
  }),
}));

export const designRelations = relations(cardDesigns, ({ one, many }) => ({
  product: one(products, { fields: [cardDesigns.productId], references: [products.id] }),
  template: one(cardTemplates, {
    fields: [cardDesigns.templateId],
    references: [cardTemplates.id],
  }),
  revisions: many(revisions),
}));

export const revisionRelations = relations(revisions, ({ one, many }) => ({
  design: one(cardDesigns, { fields: [revisions.designId], references: [cardDesigns.id] }),
  approvals: many(approvals),
  elements: many(designElements),
}));
