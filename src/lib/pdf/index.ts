/**
 * PDF EXPORT — public surface (spec §15, §22).
 *
 *   production.ts  the press file: two pages, full-bleed canvas, no overlays
 *   proof.ts       the same artwork on a larger sheet, plus a non-printing
 *                  overlay layer and a slug
 *   draw.ts        the shared op painter and the one and only y-flip
 *   color.ts       PrintColor → PDF colour operators
 *   fonts.ts       TTF loading, subsetting, embedding and subset tagging
 *   inspect.ts     re-opens a finished PDF and reports what is really in it
 *   validate.ts    turns an inspection into PASS/FAIL export validation (§22)
 *
 * The split is deliberate: `production.ts` has no import path to `proof.ts`, and
 * `draw.ts` cannot paint a trim line, so editor furniture is structurally
 * incapable of reaching a production PDF.
 */
export * from "./color";
export * from "./draw";
export * from "./fonts";
export * from "./inspect";
export * from "./production";
export * from "./proof";
export * from "./validate";
