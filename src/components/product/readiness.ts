import { narrowGtin } from "@/lib/barcode/gtin";
import { checkIdentifier } from "./identifier-check";

/**
 * CARD READINESS
 *
 * Whether a product can produce a printable card is a property of the product
 * record, not of any particular design, so it is answered here — before anyone
 * spends an hour laying out artwork that preflight will refuse at the end.
 *
 * Every check names the thing that is missing AND what happens on the card
 * without it. A check that only said "missing country of origin" would leave the
 * operator to guess whether that stops the job; saying that the line prints
 * empty does not.
 *
 * Severity is deliberately coarse:
 *  - `blocking`  the card cannot be produced correctly at all;
 *  - `warning`   the card can be produced, but something a template normally
 *                fills will resolve to nothing.
 */

export type ReadinessSeverity = "blocking" | "warning";

export type ReadinessCheck = {
  key: string;
  label: string;
  severity: ReadinessSeverity;
  ok: boolean;
  /** What is wrong, and what it does to the card. Empty when `ok`. */
  problem: string;
  /** What the record holds now — shown whether or not the check passes. */
  evidence: string;
  /** Where the missing data comes from, when there is somewhere to go. */
  remedy?: { label: string; href: string };
};

export type ReadinessInput = {
  upc: string;
  gtin14: string;
  countryOfOrigin: string;
  bomCount: number;
  bomItemCount: number;
  description: string;
  productName: string;
  brandName: string;
  status: string;
};

const IMPORT_REMEDY = { label: "Import product data", href: "/imports/new" } as const;

export function evaluateReadiness(input: ReadinessInput): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [];

  /* ---------------------------------------------------------------- UPC */
  const upc = input.upc.trim();
  if (!upc) {
    // A GTIN-14 whose leading digits are padding narrows to the same UPC. Saying
    // so is more useful than "missing", but the narrowed value is deliberately
    // not adopted: a number nobody reviewed must not reach a scannable symbol.
    const gtin14 = input.gtin14.trim();
    const narrowed = gtin14 ? narrowGtin(gtin14, 12) : null;
    checks.push({
      key: "upc",
      label: "UPC (GTIN-12)",
      severity: "blocking",
      ok: false,
      problem: narrowed
        ? `No GTIN-12 is recorded. GTIN-14 ${gtin14} narrows to ${narrowed}, but a UPC-A is only encoded from a recorded GTIN-12; record that value rather than deriving one at print time.`
        : "No GTIN-12 is recorded, so there is nothing to encode. The UPC-A symbol on the front of the card cannot be drawn and the card cannot be scanned at retail.",
      evidence: "not recorded",
      remedy: IMPORT_REMEDY,
    });
  } else {
    const state = checkIdentifier("gtin12", upc);
    const bad = state.state === "invalid" || state.state === "unusable";
    checks.push({
      key: "upc",
      label: "UPC (GTIN-12)",
      severity: "blocking",
      ok: !bad,
      problem: bad
        ? `${state.note} A symbol encoded from this value would scan to the wrong product, so it is not printed.`
        : "",
      evidence: upc,
    });
  }

  /* --------------------------------------------------- country of origin */
  const coo = input.countryOfOrigin.trim();
  checks.push({
    key: "countryOfOrigin",
    label: "Country of origin",
    severity: "blocking",
    ok: coo.length > 0,
    problem: coo
      ? ""
      : "No country-of-origin statement. Retail packaging sold in the United States has to carry one, and the line on the back of the card prints empty without it.",
    evidence: coo || "not recorded",
    remedy: coo ? undefined : IMPORT_REMEDY,
  });

  /* ---------------------------------------------------------- pack contents */
  const hasBom = input.bomCount > 0 && input.bomItemCount > 0;
  checks.push({
    key: "bom",
    label: "Pack contents",
    severity: "warning",
    ok: hasBom,
    problem: hasBom
      ? ""
      : "No bill of materials. The pack-contents block on the back resolves to nothing and collapses; a single-item pack legitimately has none.",
    evidence: hasBom
      ? `${input.bomItemCount} ${input.bomItemCount === 1 ? "line" : "lines"}`
      : "not recorded",
    remedy: hasBom ? undefined : IMPORT_REMEDY,
  });

  /* ------------------------------------------------------------ description */
  const copy = input.description.trim() || input.productName.trim();
  checks.push({
    key: "description",
    label: "Description",
    severity: "blocking",
    ok: copy.length > 0,
    problem: copy
      ? ""
      : "Neither a description nor a product name is recorded, so the title area of the card has no copy to set.",
    evidence: copy || "not recorded",
    remedy: copy ? undefined : IMPORT_REMEDY,
  });

  /* ------------------------------------------------------------------ brand */
  const brand = input.brandName.trim();
  checks.push({
    key: "brand",
    label: "Brand",
    severity: "warning",
    ok: brand.length > 0,
    problem: brand
      ? ""
      : "No brand record is linked, so the logo and the genuine-parts statement on the front have no source.",
    evidence: brand || "not linked",
  });

  /* ----------------------------------------------------------------- status */
  if (input.status === "Archived") {
    checks.push({
      key: "status",
      label: "Lifecycle status",
      severity: "warning",
      ok: false,
      problem:
        "The product is Archived. Cards are not normally produced for archived products; confirm the reprint is intended before starting one.",
      evidence: input.status,
    });
  }

  return checks;
}

export type ReadinessSummary = {
  blocking: number;
  warnings: number;
  /** True when nothing blocking is outstanding. Warnings may still stand. */
  ready: boolean;
};

export function summariseReadiness(checks: ReadinessCheck[]): ReadinessSummary {
  const blocking = checks.filter((c) => !c.ok && c.severity === "blocking").length;
  const warnings = checks.filter((c) => !c.ok && c.severity === "warning").length;
  return { blocking, warnings, ready: blocking === 0 };
}
