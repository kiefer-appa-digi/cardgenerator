import {
  type ImportOperation,
  type ImportPlan,
  type ImportPreview,
  type PreviewRow,
  type UpsertAlternateOp,
  type UpsertBomItemOp,
  type UpsertBomOp,
  type UpsertIdentifierOp,
  type UpsertProductOp,
} from "./types";

/**
 * COMMIT PLANNER — spec §5.9/§5.10.
 *
 * Pure: it turns a preview into an ordered list of typed operations and touches
 * nothing else. No database handle, no clock, no id generation, no randomness —
 * the same preview always produces the same plan, which is what makes a plan
 * reviewable before anyone agrees to run it. The server route is what applies it.
 *
 * Operations are grouped in dependency order — every product, then identifiers,
 * then alternates, then BOMs, then BOM items — so an applier can walk the array
 * once. Products are named by `ref`, a plan-local handle: the applier records the
 * id it created or updated for each `upsertProduct` and resolves every later
 * reference through that, because the plan cannot know database ids.
 */

export type PlanOptions = {
  /** Id of the import record the plan belongs to. Supplied, never generated here. */
  importId: string;
  /** Re-assert rows whose data is identical to what is on record. Off by default. */
  includeUnchanged?: boolean;
  /** Relation recorded for alternate part numbers. Default "interchange". */
  alternateRelation?: string;
};

const PRODUCT_FIELD_PREFIX = "product.";

/** Rows that become a product record. A pure BOM line does not. */
function isProductRow(row: PreviewRow): boolean {
  return row.recordType !== "bom_line";
}

function productRef(row: PreviewRow): string {
  return `p${row.rowNumber}`;
}

function normPart(value: string): string {
  return value.trim().toUpperCase();
}

export function planImport(preview: ImportPreview, options: PlanOptions): ImportPlan {
  const includeUnchanged = options.includeUnchanged ?? false;
  const alternateRelation = options.alternateRelation ?? "interchange";

  const applied = preview.rows.filter(
    (r) =>
      r.classification === "create" ||
      r.classification === "update" ||
      (includeUnchanged && r.classification === "unchanged"),
  );

  const products: UpsertProductOp[] = [];
  const identifiers: UpsertIdentifierOp[] = [];
  const alternates: UpsertAlternateOp[] = [];
  const boms: UpsertBomOp[] = [];
  const bomItems: UpsertBomItemOp[] = [];

  const brands: string[] = [];
  /** Part number -> product ref, so a BOM can point at a product this plan creates. */
  const refByPartNumber = new Map<string, string>();

  for (const row of applied) {
    if (!isProductRow(row)) continue;
    const ref = productRef(row);
    const brandName = row.fields["brand.name"] ?? "";

    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(row.fields)) {
      if (key.startsWith(PRODUCT_FIELD_PREFIX)) values[key] = value;
    }

    products.push({
      op: "upsertProduct",
      ref,
      rowNumber: row.rowNumber,
      // `applied` already excludes skips, so anything not an update is a create.
      mode: row.classification === "update" ? "update" : "create",
      existingId: row.match.existingId,
      match: row.match,
      recordType: row.recordType,
      brandName,
      values,
      custom: { ...row.custom },
      fitments: [...row.fitments],
      warnings: [...row.warnings],
      sourceRow: { ...row.source.cells },
    });

    if (brandName.length > 0 && !brands.includes(brandName)) brands.push(brandName);
    const part = normPart(row.fields["product.partNumber"] ?? "");
    if (part.length > 0 && !refByPartNumber.has(part)) refByPartNumber.set(part, ref);

    for (const id of row.identifiers) {
      identifiers.push({
        op: "upsertIdentifier",
        ref,
        rowNumber: row.rowNumber,
        kind: id.kind,
        value: id.value,
        canonical: id.canonical,
        isPrimary: id.isPrimary,
        valid: id.valid,
        validationNote: id.validationNote,
      });
    }

    row.alternates.forEach((value, position) => {
      alternates.push({
        op: "upsertAlternate",
        ref,
        rowNumber: row.rowNumber,
        value,
        relation: alternateRelation,
        position,
      });
    });
  }

  /* BOMs are keyed by parent part number, so lines spread over many rows collapse
     into one bill with its items in sheet order. */
  const bomIndex = new Map<string, UpsertBomOp>();
  for (const row of applied) {
    const line = row.bom;
    if (line === null) continue;
    const parentKey = normPart(line.parentPartNumber);
    if (parentKey.length === 0) continue;

    let bom = bomIndex.get(parentKey);
    if (bom === undefined) {
      bom = {
        op: "upsertBom",
        bomRef: `b${bomIndex.size + 1}`,
        ref: refByPartNumber.get(parentKey) ?? null,
        parentPartNumber: line.parentPartNumber,
        parentBrandName: row.fields["brand.name"] ?? "",
        name: line.bomName,
        revision: line.revision,
        rowNumbers: [],
      };
      bomIndex.set(parentKey, bom);
      boms.push(bom);
    }
    bom.rowNumbers.push(row.rowNumber);

    const componentKey = normPart(line.partNumber);
    bomItems.push({
      op: "upsertBomItem",
      bomRef: bom.bomRef,
      rowNumber: row.rowNumber,
      position: line.position,
      quantity: line.quantity,
      unitOfMeasure: line.unitOfMeasure,
      name: line.name,
      partNumber: line.partNumber,
      description: line.description,
      componentRef:
        componentKey.length > 0 && componentKey !== parentKey
          ? (refByPartNumber.get(componentKey) ?? null)
          : null,
    });
  }

  const operations: ImportOperation[] = [
    ...products,
    ...identifiers,
    ...alternates,
    ...boms,
    ...bomItems,
  ];

  const skipped = preview.rows
    .filter((r) => r.classification === "skip")
    .map((r) => ({
      rowNumber: r.rowNumber,
      reason:
        r.findings.find((f) => f.severity === "error")?.message ??
        r.findings[0]?.message ??
        "Row was skipped.",
      recordType: r.recordType,
    }));

  const blockingFindings = preview.findings.filter((f) => f.severity === "error");

  return {
    importId: options.importId,
    orgId: preview.orgId,
    sheetName: preview.sheetName,
    profileId: preview.profileId,
    brands,
    operations,
    counts: {
      upsertProduct: products.length,
      upsertIdentifier: identifiers.length,
      upsertAlternate: alternates.length,
      upsertBom: boms.length,
      upsertBomItem: bomItems.length,
      create: preview.summary.create,
      update: preview.summary.update,
      unchanged: preview.summary.unchanged,
      skipped: preview.summary.skip,
    },
    skipped,
    blocked: blockingFindings.length > 0 || operations.length === 0,
    blockingFindings,
  };
}

/**
 * Operations grouped by kind, in the same dependency order the plan uses.
 * Convenience for an applier that batches one statement per table.
 */
export function operationsByKind(plan: ImportPlan): {
  upsertProduct: UpsertProductOp[];
  upsertIdentifier: UpsertIdentifierOp[];
  upsertAlternate: UpsertAlternateOp[];
  upsertBom: UpsertBomOp[];
  upsertBomItem: UpsertBomItemOp[];
} {
  const out = {
    upsertProduct: [] as UpsertProductOp[],
    upsertIdentifier: [] as UpsertIdentifierOp[],
    upsertAlternate: [] as UpsertAlternateOp[],
    upsertBom: [] as UpsertBomOp[],
    upsertBomItem: [] as UpsertBomItemOp[],
  };
  for (const op of plan.operations) {
    switch (op.op) {
      case "upsertProduct":
        out.upsertProduct.push(op);
        break;
      case "upsertIdentifier":
        out.upsertIdentifier.push(op);
        break;
      case "upsertAlternate":
        out.upsertAlternate.push(op);
        break;
      case "upsertBom":
        out.upsertBom.push(op);
        break;
      case "upsertBomItem":
        out.upsertBomItem.push(op);
        break;
    }
  }
  return out;
}
