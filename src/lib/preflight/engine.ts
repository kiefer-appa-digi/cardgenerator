import type { BlackRules, OutputIntent } from "@/lib/color/types";
import { SIDE_KEYS, type DesignDoc, type SideKey } from "@/lib/design/schema";
import type { SidePlan } from "@/lib/design/render";
import type { AssetInfo } from "@/lib/design/plan";
import type { ProductContext } from "@/lib/data/context";
import {
  summarise,
  type PreflightFinding,
  type PreflightProfile,
  type PreflightReport,
} from "./types";
import { buildContext } from "./checks/context";
import { geometryChecks } from "./checks/geometry";
import { assetChecks } from "./checks/assets";
import { textChecks } from "./checks/text";
import { dataChecks } from "./checks/data";
import { barcodeChecks } from "./checks/barcode";
import { checkOutputIntent, colorChecks } from "./checks/color";

/**
 * THE PREFLIGHT ENGINE — spec §21.
 *
 * Preflight runs on the SidePlan, not on the design document: the plan is what
 * the SVG artboard draws and what the PDF writer writes, so a finding measured
 * here is a finding about the artwork that will exist. Re-deriving geometry or
 * re-laying-out text to check it would produce a second opinion, and a second
 * opinion is exactly what a preflight report must not be.
 *
 * The engine itself only assembles context and concatenates check results. Every
 * judgement — what is an error, what is merely worth saying — lives in the check
 * module for that area, next to the measurement that justifies it. Thresholds
 * live in the PreflightProfile, so a press that runs to different numbers
 * changes the profile rather than the code.
 *
 * Nothing here decides whether an export may proceed. `summarise()` records
 * whether anything is blocking; the export path is what refuses, and an override
 * is a privileged action with an audit note (§21, §20).
 */

export type PreflightInput = {
  doc: DesignDoc;
  /** Both sides, already planned by planDocument(). */
  plans: Record<SideKey, SidePlan>;
  product: ProductContext;
  profile: PreflightProfile;
  blackRules: BlackRules;
  outputIntent: OutputIntent;
  /** Asset metadata by id, the same map planSide() was given. */
  assets: Map<string, AssetInfo>;
  /** Recorded on the report so a stored result can be traced back. */
  designId?: string;
  revisionId?: string;
  productId?: string;
};

/** Per-side checks, in the order their findings are collected. */
const SIDE_CHECKS = [
  geometryChecks,
  assetChecks,
  textChecks,
  dataChecks,
  barcodeChecks,
  colorChecks,
] as const;

export function runPreflight(input: PreflightInput): PreflightReport {
  const findings: PreflightFinding[] = [];

  for (const side of SIDE_KEYS) {
    const plan = input.plans[side];
    if (!plan) continue;
    const ctx = buildContext({
      doc: input.doc,
      side,
      plan,
      product: input.product,
      profile: input.profile,
      blackRules: input.blackRules,
      outputIntent: input.outputIntent,
      assets: input.assets,
    });
    for (const check of SIDE_CHECKS) findings.push(...check(ctx));
  }

  // Document-level: the output intent belongs to the file, not to a side.
  findings.push(...checkOutputIntent(input.outputIntent));

  return summarise(findings, {
    profileName: input.profile.name,
    treatErrorAsBlocking: input.profile.treatErrorAsBlocking,
    designId: input.designId,
    revisionId: input.revisionId,
    productId: input.productId ?? input.product.id ?? undefined,
  });
}

/** Findings for one side only — used by the editor's live side-by-side panel. */
export function runSidePreflight(
  input: Omit<PreflightInput, "plans"> & { side: SideKey; plan: SidePlan },
): PreflightFinding[] {
  const ctx = buildContext({
    doc: input.doc,
    side: input.side,
    plan: input.plan,
    product: input.product,
    profile: input.profile,
    blackRules: input.blackRules,
    outputIntent: input.outputIntent,
    assets: input.assets,
  });
  return SIDE_CHECKS.flatMap((check) => check(ctx));
}

export type { PreflightReport, PreflightFinding } from "./types";
