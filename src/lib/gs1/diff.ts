import type { ProductContext } from "@/lib/data/context";
import { ProductContextSchema, resolvePath } from "@/lib/data/context";
import { normalizeGtin } from "./gtin";
import type { Gs1FieldDiff, Gs1ProductRecord } from "./types";

/**
 * GS1 DIFF — spec §13A: "Never overwrite local data automatically. Show a diff
 * and require explicit acceptance."
 *
 * Two pure functions and no side effects between them:
 *
 *   diffRemoteAgainstLocal  compares and reports. It changes nothing.
 *   applyAcceptedFields     changes a copy, and only for paths a human named.
 *
 * There is deliberately no "apply all" and no auto-accept threshold. The remote
 * registry is authoritative about a GTIN's licence; it is *not* authoritative
 * about the description a brand manager approved for print, and quietly
 * replacing on-pack copy with a registry string is exactly the failure §13A is
 * written to prevent.
 */

type CompareMode = "text" | "gtin" | "exact";

type FieldMapping = {
  /** Dotted ProductContext path. This is the acceptance key. */
  path: string;
  label: string;
  /** Name of the `Gs1ProductRecord` field, for the audit row. */
  remoteField: string;
  /** How to read the value out of the remote record. */
  read: (record: Gs1ProductRecord) => string;
  compare: CompareMode;
};

/** Human-readable dimensions/weights, kept as text because they are reference data. */
function measurementText(m: { value: number; unitCode: string } | null): string {
  if (m === null) return "";
  return m.unitCode === "" ? String(m.value) : `${m.value} ${m.unitCode}`;
}

function dimensionsText(record: Gs1ProductRecord): string {
  const { width, height, depth } = record.dimensions;
  if (width === null && height === null && depth === null) return "";
  const parts = [width, height, depth].map((m) => (m === null ? "?" : String(m.value)));
  const unit = [width, height, depth].find((m) => m !== null && m.unitCode !== "")?.unitCode ?? "";
  return unit === "" ? parts.join(" x ") : `${parts.join(" x ")} ${unit}`;
}

/**
 * The mapping table. Fields GS1 publishes that have no home in ProductContext
 * land under `custom.*`, which is the schema's designated free-form area — that
 * keeps GS1-sourced reference data (dimensions, target markets, the registry's
 * image URL) available to bindings without pretending it is first-class product
 * data the print team maintains.
 */
export const GS1_FIELD_MAPPINGS: readonly FieldMapping[] = [
  {
    path: "identifiers.gtin14",
    label: "GTIN-14",
    remoteField: "gtin",
    read: (r) => r.gtin,
    compare: "gtin",
  },
  { path: "identifiers.sku", label: "SKU", remoteField: "sku", read: (r) => r.sku, compare: "text" },
  {
    path: "identifiers.gs1CompanyPrefix",
    label: "GS1 company prefix",
    remoteField: "company.gs1CompanyPrefix",
    read: (r) => r.company.gs1CompanyPrefix,
    compare: "exact",
  },
  { path: "brand.name", label: "Brand name", remoteField: "brandName", read: (r) => r.brandName, compare: "text" },
  {
    path: "description",
    label: "Description",
    remoteField: "productDescription",
    read: (r) => r.productDescription,
    compare: "text",
  },
  {
    path: "labelDescription",
    label: "Label description",
    remoteField: "labelDescription",
    read: (r) => r.labelDescription,
    compare: "text",
  },
  { path: "netContent", label: "Net content", remoteField: "netContent", read: (r) => r.netContent, compare: "text" },
  {
    path: "countryOfOrigin",
    label: "Country of origin",
    remoteField: "countryOfOrigin",
    read: (r) => r.countryOfOrigin,
    compare: "text",
  },
  { path: "status", label: "Status", remoteField: "status", read: (r) => r.status, compare: "text" },
  {
    path: "custom.gs1GpcBrickCode",
    label: "GPC brick code",
    remoteField: "gpcBrickCode",
    read: (r) => r.gpcBrickCode,
    compare: "exact",
  },
  {
    path: "custom.gs1GpcBrickDescription",
    label: "GPC brick description",
    remoteField: "gpcBrickDescription",
    read: (r) => r.gpcBrickDescription,
    compare: "text",
  },
  {
    path: "custom.gs1TargetMarkets",
    label: "Target markets",
    remoteField: "targetMarkets",
    read: (r) => r.targetMarkets.join(", "),
    compare: "text",
  },
  {
    path: "custom.gs1ImageUrl",
    label: "GS1 image URL",
    remoteField: "imageUrl",
    read: (r) => r.imageUrl,
    compare: "exact",
  },
  {
    path: "custom.gs1LicenseeName",
    label: "Licensee name",
    remoteField: "company.name",
    read: (r) => r.company.name,
    compare: "text",
  },
  {
    path: "custom.gs1LicenseStatus",
    label: "Licence status",
    remoteField: "company.licenseStatus",
    read: (r) => r.company.licenseStatus,
    compare: "exact",
  },
  {
    path: "custom.gs1Dimensions",
    label: "Dimensions (W x H x D)",
    remoteField: "dimensions",
    read: dimensionsText,
    compare: "text",
  },
  {
    path: "custom.gs1GrossWeight",
    label: "Gross weight",
    remoteField: "weights.gross",
    read: (r) => measurementText(r.weights.gross),
    compare: "text",
  },
  {
    path: "custom.gs1NetWeight",
    label: "Net weight",
    remoteField: "weights.net",
    read: (r) => measurementText(r.weights.net),
    compare: "text",
  },
];

/** Read a mapped path out of the local context as display text. */
function readLocal(local: ProductContext, path: string): string {
  const value = resolvePath(local, path);
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : String(v))).join(", ");
  return "";
}

/** Case- and whitespace-insensitive equality for prose fields. */
function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * GTINs compare on their canonical 14-digit form, so a local `810797030124` and
 * a remote `00810797030124` are a match rather than a conflict a reviewer has to
 * dismiss on every product.
 */
function sameGtin(a: string, b: string): boolean {
  const na = normalizeGtin(a);
  const nb = normalizeGtin(b);
  if (na.ok && nb.ok) return na.gtin14 === nb.gtin14;
  return a.trim() === b.trim();
}

function valuesEqual(mode: CompareMode, local: string, remote: string): boolean {
  switch (mode) {
    case "gtin":
      return sameGtin(local, remote);
    case "exact":
      return local.trim() === remote.trim();
    case "text":
      return sameText(local, remote);
  }
}

export type DiffOptions = {
  /** Include rows where local and remote already agree. Default true. */
  includeMatches?: boolean;
  /** Restrict the comparison to these ProductContext paths. */
  onlyPaths?: readonly string[];
};

/**
 * Compare a remote GS1 record against the local product. Pure: it reads both
 * inputs and returns rows. It never writes, never calls back, never decides.
 *
 * Rows where both sides are empty are omitted — there is nothing to review.
 */
export function diffRemoteAgainstLocal(
  remote: Gs1ProductRecord,
  local: ProductContext,
  options: DiffOptions = {},
): Gs1FieldDiff[] {
  const includeMatches = options.includeMatches ?? true;
  const only = options.onlyPaths === undefined ? null : new Set(options.onlyPaths);
  const out: Gs1FieldDiff[] = [];

  for (const mapping of GS1_FIELD_MAPPINGS) {
    if (only !== null && !only.has(mapping.path)) continue;

    const remoteValue = mapping.read(remote).trim();
    const localValue = readLocal(local, mapping.path).trim();
    if (remoteValue === "" && localValue === "") continue;

    let kind: Gs1FieldDiff["kind"];
    if (remoteValue === "") kind = "remote-empty";
    else if (localValue === "") kind = "missing-locally";
    else if (valuesEqual(mapping.compare, localValue, remoteValue)) kind = "match";
    else kind = "conflict";

    if (kind === "match" && !includeMatches) continue;

    out.push({
      path: mapping.path,
      label: mapping.label,
      remoteField: mapping.remoteField,
      localValue,
      remoteValue,
      kind,
      overwritesLocal: kind === "conflict",
      acceptable: kind === "missing-locally" || kind === "conflict",
    });
  }

  return out;
}

/** The rows a reviewer actually has to decide about. */
export function pendingDiffs(diffs: readonly Gs1FieldDiff[]): Gs1FieldDiff[] {
  return diffs.filter((d) => d.acceptable);
}

export function hasPendingDiffs(diffs: readonly Gs1FieldDiff[]): boolean {
  return diffs.some((d) => d.acceptable);
}

export type ApplyRejection = {
  path: string;
  reason: "not-in-diff" | "not-acceptable" | "unwritable-path";
};

export type ApplyAcceptedFieldsResult = {
  /** A new context. The input is never mutated. */
  context: ProductContext;
  /** Paths that were written, in the order they were supplied. */
  applied: string[];
  rejected: ApplyRejection[];
};

/**
 * Write exactly the accepted paths into a copy of the local context.
 *
 * `acceptedPaths` is an explicit allow-list supplied by the caller after a human
 * ticked boxes. A path that is not in `diffs`, or is in `diffs` but not
 * acceptable (a match, or a field the remote left empty), is rejected rather
 * than applied — so a stale acceptance list from a previous fetch cannot write
 * values the reviewer never saw.
 */
export function applyAcceptedFields(
  local: ProductContext,
  diffs: readonly Gs1FieldDiff[],
  acceptedPaths: readonly string[],
): ApplyAcceptedFieldsResult {
  const byPath = new Map(diffs.map((d) => [d.path, d]));
  const wanted = new Set(acceptedPaths);
  const next = structuredClone(local);
  const applied: string[] = [];
  const rejected: ApplyRejection[] = [];

  for (const path of wanted) {
    const diff = byPath.get(path);
    if (diff === undefined) {
      rejected.push({ path, reason: "not-in-diff" });
      continue;
    }
    if (!diff.acceptable) {
      rejected.push({ path, reason: "not-acceptable" });
      continue;
    }
    if (!writeStringPath(next, path, diff.remoteValue)) {
      rejected.push({ path, reason: "unwritable-path" });
      continue;
    }
    applied.push(path);
  }

  // Final guard: an accepted value must still produce a valid ProductContext.
  // If it does not, nothing is applied — a half-written context is worse than a
  // rejected acceptance.
  const parsed = ProductContextSchema.safeParse(next);
  if (!parsed.success) {
    return {
      context: local,
      applied: [],
      rejected: [...rejected, ...applied.map((path) => ({ path, reason: "unwritable-path" as const }))],
    };
  }

  return { context: parsed.data, applied, rejected };
}

/**
 * Set a dotted path to a string. Only walks through objects that already exist,
 * so an accepted path can never invent a new branch of the context, and only
 * writes over a string or an absent key (`custom.*` starts out absent).
 */
function writeStringPath(target: ProductContext, path: string, value: string): boolean {
  const parts = path.split(".");
  if (parts.length === 0) return false;

  let cursor: Record<string, unknown> = target as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = cursor[parts[i]];
    if (next === null || typeof next !== "object" || Array.isArray(next)) return false;
    cursor = next as Record<string, unknown>;
  }

  const leaf = parts[parts.length - 1];
  const existing = cursor[leaf];
  if (existing !== undefined && typeof existing !== "string") return false;
  cursor[leaf] = value;
  return true;
}
