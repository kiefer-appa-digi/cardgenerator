import {
  colorsEqual,
  formatColor,
  isGrayscale,
  toCmyk,
  totalAreaCoverage,
  type BlackRules,
  type OutputIntent,
  type PrintColor,
} from "@/lib/color/types";
import type { PreflightFinding } from "../types";
import { isGrayscaleSpace } from "./assets";
import {
  at,
  bpsPct,
  describeColor,
  finding,
  inches,
  opColors,
  opPaintBounds,
  opPaintsInk,
  pct,
  ptNum,
  sideWord,
  type PreflightContext,
} from "./context";

/**
 * COLOUR CHECKS — spec §7, §14, §21.
 *
 * Ink values are the only colour this application treats as real, so these
 * checks are arithmetic on the recipes in the document rather than on anything
 * sampled from a screen. Where a limitation is structural — a spot that the PDF
 * writer cannot emit as a separation, an output intent nobody supplied — the
 * finding states it plainly instead of letting the export imply compliance it
 * does not have.
 */

/**
 * A built black: the organisation's configured rich black, or any recipe that
 * boosts near-solid K with another ink. Matching only the configured swatch
 * would miss the one a designer mixed by hand, which registers exactly as badly.
 */
function isRichBlack(color: PrintColor, rules: BlackRules): boolean {
  if (colorsEqual(color, rules.richBlack)) return true;
  const k = toCmyk(color);
  if (!k) return false;
  return k.k >= 850 && k.c + k.m + k.y >= 100;
}

/**
 * TWO KNOBS, ONE LIMIT.
 *
 * Total ink is configurable in two places: `PreflightProfile.inkLimit`, which
 * belongs to the press, and `BlackRules.totalAreaCoverageLimit`, which belongs
 * to the organisation and is what §14 calls the "total area coverage limit" —
 * it is persisted in the org's settings by the seed. Reading only one of them
 * meant the other was a control that did nothing: an organisation that told the
 * system it runs to 260 % was still checked at the profile's 300 %.
 *
 * Neither one is authoritative over the other, and a limit is a ceiling, so the
 * lower number wins and the finding names which of the two set it.
 */
function inkLimitFor(ctx: PreflightContext): { limit: number; source: string } {
  const org = ctx.blackRules.totalAreaCoverageLimit;
  const press = ctx.profile.inkLimit;
  return org < press
    ? { limit: org, source: "the organisation's black rules" }
    : { limit: press, source: `the "${ctx.profile.name}" profile` };
}

/**
 * Same shape of problem for the rich-black size threshold: the black rules and
 * the preflight profile both carry one. A threshold is a floor below which type
 * must not be built black, so the LARGER size is the stricter setting and wins.
 */
function richBlackMinSizeFor(ctx: PreflightContext): { size: number; source: string } {
  const rules = ctx.blackRules.richBlackMinTextSize;
  const press = ctx.profile.richBlackMinTextSize;
  return press > rules
    ? { size: press, source: `the "${ctx.profile.name}" profile` }
    : { size: rules, source: "the black rules" };
}

export function colorChecks(ctx: PreflightContext): PreflightFinding[] {
  const out: PreflightFinding[] = [];
  const grayscaleSide = ctx.cardSide.colorIntent === "grayscale";
  const ink = inkLimitFor(ctx);
  const richMin = richBlackMinSizeFor(ctx);
  const seenInk = new Set<string>();
  const seenGray = new Set<string>();
  const seenSpot = new Set<string>();
  const seenRich = new Set<string>();

  for (const op of ctx.plan.ops) {
    if (!opPaintsInk(op)) continue;
    const bounds = opPaintBounds(op);

    /* ------------------------------------------------------ transparency */

    if (op.opacity < 10_000) {
      out.push(
        finding({
          code: "TRANSPARENCY_PRESENT",
          severity: "warning",
          title: `Element is set to ${bpsPct(op.opacity)} opacity`,
          detail:
            `Live transparency at ${bpsPct(op.opacity)} covers ${inches(bounds.w)} × ${inches(bounds.h)} ` +
            `at (${inches(bounds.x)}, ${inches(bounds.y)}). Transparency has to be flattened somewhere ` +
            `between here and the plate, and where it is flattened decides what the edges of the blend ` +
            `look like — a PDF/X-1a workflow flattens it, a PDF/X-4 one does not.`,
          remedy:
            `Confirm with the press which PDF/X level they want. If it is X-1a, flatten this deliberately ` +
            `— replace the blend with the flat ink recipe it resolves to — rather than letting a RIP decide.`,
          ...at(ctx, op.elementId, bounds),
          measurements: { opacityBps: op.opacity },
        }),
      );
    }

    /* --------------------------------------------- grayscale-only side */

    if (grayscaleSide && op.op === "image") {
      const info = op.assetId === null ? undefined : ctx.assets.get(op.assetId);
      if (info && info.colorSpace && !isGrayscaleSpace(info.colorSpace)) {
        out.push(
          finding({
            code: "GRAYSCALE_VIOLATION",
            severity: ctx.cardSide.allowColorOverride ? "warning" : "error",
            title: `Colour image on a grayscale ${sideWord(ctx.side)}`,
            detail:
              `Asset "${op.assetId}" is ${info.colorSpace || "of an undeclared colour space"} and the ` +
              `${sideWord(ctx.side)} is set to print grayscale. Placing it would either put colour plates ` +
              `on a job costed for one, or be converted to gray by whoever notices first.`,
            remedy: ctx.cardSide.allowColorOverride
              ? "The side allows a colour override, so confirm the press is expecting four plates on this side and that the job is costed for them."
              : "Convert the image to grayscale and re-upload it, or set the side's colour intent to process if this card really is printing in colour.",
            ...at(ctx, op.elementId, bounds),
            measurements: { colorSpace: info.colorSpace || "unknown", assetId: op.assetId ?? "" },
          }),
        );
      }
    }

    for (const use of opColors(op)) {
      const color = use.color;
      if (color.space === "none") continue;
      const key = `${op.elementId}|${use.role}|${JSON.stringify(color)}`;

      /* ------------------------------------------------------ grayscale */

      if (grayscaleSide && !isGrayscale(color) && !seenGray.has(key)) {
        seenGray.add(key);
        const cmyk = toCmyk(color);
        out.push(
          finding({
            code: "GRAYSCALE_VIOLATION",
            severity: ctx.cardSide.allowColorOverride ? "warning" : "error",
            title: `Colour ink on a grayscale ${sideWord(ctx.side)}`,
            detail:
              `The ${use.role} is ${describeColor(color)}, which needs ` +
              `${[cmyk && cmyk.c > 0 ? "cyan" : null, cmyk && cmyk.m > 0 ? "magenta" : null, cmyk && cmyk.y > 0 ? "yellow" : null]
                .filter(Boolean)
                .join(", ")} in addition to black. The ${sideWord(ctx.side)}'s colour intent is grayscale` +
              (ctx.cardSide.allowColorOverride ? ", with a colour override allowed by the template." : "."),
            remedy: ctx.cardSide.allowColorOverride
              ? "The template permits colour here; confirm the press is expecting four plates on this side, because the standard back for this product line is one."
              : `Set the ${use.role} to a gray or a K-only value, or change the side's colour intent to process and have the extra plates costed.`,
            ...at(ctx, op.elementId, bounds),
            measurements: {
              color: formatColor(color),
              c: cmyk?.c ?? 0,
              m: cmyk?.m ?? 0,
              y: cmyk?.y ?? 0,
              k: cmyk?.k ?? 0,
            },
          }),
        );
      }

      /* ------------------------------------------------------ ink limit */

      const tac = totalAreaCoverage(color);
      if (tac > ink.limit && !seenInk.has(key)) {
        seenInk.add(key);
        out.push(
          finding({
            code: "INK_LIMIT",
            severity: "error",
            title: `Total ink is ${pct(tac)} where the limit is ${pct(ink.limit)}`,
            detail:
              `The ${use.role} is ${describeColor(color)}, totalling ${pct(tac)} area coverage — ` +
              `${pct(tac - ink.limit)} over the ${pct(ink.limit)} set by ${ink.source}. Above the limit the ` +
              `sheet stops absorbing: the ink sets slowly, offsets onto the back of the next sheet and can ` +
              `pick when the pile is cut.`,
            remedy:
              `Reduce the recipe to ${pct(ink.limit)} or less — usually by taking cyan, magenta ` +
              `and yellow down and leaving K where it is — or ask the press to confirm a higher limit for ` +
              `this stock and raise it in ${ink.source} rather than in the artwork.`,
            ...at(ctx, op.elementId, bounds),
            measurements: {
              totalAreaCoverage: tac,
              limit: ink.limit,
              limitSource: ink.source,
              profileInkLimit: ctx.profile.inkLimit,
              blackRulesInkLimit: ctx.blackRules.totalAreaCoverageLimit,
              overBy: tac - ink.limit,
              color: formatColor(color),
            },
          }),
        );
      }

      /* ------------------------------------------- rich black, small type */

      if (
        use.fontSize !== null &&
        use.fontSize < richMin.size &&
        isRichBlack(color, ctx.blackRules)
      ) {
        const richKey = `${op.elementId}|${use.fontSize}|${JSON.stringify(color)}`;
        if (!seenRich.has(richKey)) {
          seenRich.add(richKey);
          out.push(
            finding({
              code: "RICH_BLACK_SMALL_TEXT",
              severity: "warning",
              title: `${ptNum(use.fontSize)} pt text is set in rich black`,
              detail:
                `Text at ${ptNum(use.fontSize)} pt is set in ${describeColor(color)}, a built black, and ` +
                `${richMin.source} flags rich black below ${ptNum(richMin.size)} pt. ` +
                `Small type in three or four inks shows every unit of misregistration as a coloured fringe ` +
                `on the letterforms, and it is the first thing to look wrong on a press sheet.`,
              remedy:
                `Set this text in ${formatColor(ctx.blackRules.textBlack)} — flat black type traps ` +
                `cleanly at any size. Keep rich black for large solids where the extra density shows.`,
              ...at(ctx, op.elementId, bounds),
              measurements: {
                fontSizePt: ptNum(use.fontSize),
                minimumPt: ptNum(richMin.size),
                minimumSource: richMin.source,
                color: formatColor(color),
                totalAreaCoverage: tac,
              },
            }),
          );
        }
      }

      /* ----------------------------------------------------------- spot */

      if (color.space === "spot" && !seenSpot.has(color.name)) {
        seenSpot.add(color.name);
        out.push(
          finding({
            code: "SPOT_CONVERTED",
            severity: "info",
            title: `Spot colour "${color.name}" is converted to CMYK on export`,
            detail:
              `"${color.name}" is used as the ${use.role} at ${pct(color.tint)} tint. The PDF writer in ` +
              `this build cannot emit a Separation colour space, so the spot is written as its CMYK ` +
              `alternate ${describeColor(color)}. The exported file therefore contains a process ` +
              `simulation of the spot, not the spot itself — it is labelled that way rather than being ` +
              `presented as a spot-colour PDF.`,
            remedy:
              `If the run is genuinely printing ${color.name} as a fifth unit, hand the press the ink ` +
              `specification separately and have them build the separation, and check the CMYK alternate ` +
              `matches the ink book before approving the proof.`,
            ...at(ctx, op.elementId, bounds),
            measurements: { spot: color.name, tint: color.tint, alternate: formatColor(color) },
          }),
        );
      }
    }
  }

  return out;
}

/* -------------------------------------------------------- output intent */

/**
 * Document-level, and INFO rather than a defect: an absent output intent does
 * not damage the artwork, it means the file cannot claim PDF/X compliance. The
 * honest position is to say so once, clearly, instead of shipping a PDF that
 * implies a print condition nobody specified.
 */
export function checkOutputIntent(intent: OutputIntent): PreflightFinding[] {
  if (intent.iccBase64 && intent.iccBase64.length > 0) return [];
  return [
    finding({
      code: "OUTPUT_INTENT_MISSING",
      severity: "info",
      title: "The export carries no output intent",
      detail:
        `No ICC profile is configured for this deployment (identifier "${intent.identifier}", condition ` +
        `"${intent.conditionName}"), so the exported PDF has no OutputIntent dictionary. Without one the ` +
        `file cannot be PDF/X-1a or PDF/X-4 whatever else is correct about it, and the CMYK numbers in it ` +
        `describe no particular press condition — they are ink percentages, not colour.`,
      remedy:
        "Ask the printer which characterisation they run to (GRACoL 2013, FOGRA51, SWOP, or their own), load that ICC profile into the deployment's output intent, and re-export. Until then, treat the PDF as device CMYK and approve colour from a press proof rather than from the file.",
      measurements: { identifier: intent.identifier, conditionName: intent.conditionName },
    }),
  ];
}
