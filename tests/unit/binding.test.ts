import { describe, it, expect } from "vitest";
import { emptyProductContext, type ProductContext } from "@/lib/data/context";
import {
  BomListElementSchema,
  TextElementSchema,
  BarcodeElementSchema,
  type BomListElement,
  type DesignElement,
} from "@/lib/design/schema";
import {
  bindingPreflightCode,
  collectBindingPaths,
  evaluateVisibleWhen,
  getPath,
  isElementVisible,
  makeBinding,
  parseVisibleWhen,
  resolveBinding,
  resolveBindingText,
  resolveTextElementText,
  resolveTokens,
  resolveTokensText,
  templatePaths,
  unknownBindingPaths,
  type BindingIssueCode,
} from "@/lib/data/binding";
import { renderBomBlock, renderBomLines, splitIntoColumns } from "@/lib/data/bom";
import {
  applyFormat,
  applyTextTransform,
  classifyFormat,
  coerceDate,
  coerceNumber,
  formatDate,
  formatNumber,
  stringifyScalar,
} from "@/lib/data/format";

/* ------------------------------------------------------------------ fixture */

/**
 * Modelled on 11-500, the sample card the spec uses as its reproduction
 * benchmark (§23), so the known-answer strings below are the strings a real
 * card sets rather than invented placeholders.
 */
function fixture(): ProductContext {
  const ctx = emptyProductContext();
  ctx.id = "prd_11500";
  ctx.partNumber = "11-500";
  ctx.productName = "Bearing Kit";
  ctx.description = "GENUINE AXLETEK 3.5K BEARING L44610/L44649";
  ctx.subtitle = "L44610 / L44649";
  ctx.countryOfOrigin = "Made in China";
  ctx.status = "In Use";
  ctx.netContent = "4 EA";
  ctx.brand = {
    name: "Axle Teknology",
    legalName: "Axle Teknology, LLC",
    statement: "Genuine AxleTek replacement parts.",
    logoAssetId: null,
  };
  ctx.identifiers = {
    gtin14: "00810797030124",
    gtin13: "0810797030124",
    upc12: "810797030124",
    sku: "11-500",
    gs1CompanyPrefix: "081079703",
  };
  ctx.alternatePartNumbers = ["L44610", "L44649"];
  ctx.fitments = ["Dexter 3.5K axles", "Lippert 3.5K axles"];
  ctx.warnings = [];
  ctx.custom = { promoLine: "" };
  ctx.bom = {
    items: [
      { quantity: 2, quantityText: "2", name: "Inner Bearing", partNumber: "L44643", description: "Inner cone", position: 1, unitOfMeasure: "EA" },
      { quantity: 2, quantityText: "2", name: "Outer Bearing", partNumber: "L44649", description: "Outer cone", position: 2, unitOfMeasure: "EA" },
      { quantity: 2, quantityText: "2", name: "Grease Seal", partNumber: "10-19", description: "Double lip", position: 3, unitOfMeasure: "EA" },
      { quantity: 1, quantityText: "1", name: "Cotter Pin", partNumber: "CP-18", description: "", position: 4, unitOfMeasure: "EA" },
      { quantity: 1, quantityText: "1", name: "Spindle Nut", partNumber: "SN-1", description: "", position: 5, unitOfMeasure: "EA" },
    ],
    packIncludes: "2) Inner Bearing (L44643)",
    itemCount: 5,
  };
  return ctx;
}

function bomEl(over: Partial<BomListElement> = {}): BomListElement {
  return BomListElementSchema.parse({
    id: "bom1",
    kind: "bomList",
    frame: { x: 0, y: 0, w: 10_000_000, h: 10_000_000 },
    ...over,
  });
}

function codes(issues: { code: BindingIssueCode }[]): BindingIssueCode[] {
  return issues.map((i) => i.code);
}

/* -------------------------------------------------------------- resolveBinding */

describe("resolveBinding", () => {
  const ctx = fixture();

  it("resolves a simple field", () => {
    const r = resolveBinding(makeBinding({ path: "partNumber" }), ctx);
    expect(r.text).toBe("11-500");
    expect(r.value).toBe("11-500");
    expect(r.status).toBe("ok");
    expect(r.unknownPath).toBe(false);
    expect(r.usedFallback).toBe(false);
    expect(r.hidden).toBe(false);
    expect(r.issues).toEqual([]);
  });

  it("applies prefix, suffix and transform to the value only", () => {
    const r = resolveBinding(
      makeBinding({ path: "productName", prefix: "P/N ", suffix: " kit", transform: "uppercase" }),
      ctx,
    );
    // The prefix and suffix are copy the designer typed in the case they meant;
    // the transform is aimed at the data.
    expect(r.text).toBe("P/N BEARING KIT kit");
    expect(r.value).toBe("Bearing Kit");
  });

  it("joins a list with the binding's joiner", () => {
    expect(resolveBindingText(makeBinding({ path: "alternatePartNumbers" }), ctx)).toBe("L44610, L44649");
    const piped = resolveBinding(makeBinding({ path: "fitments", joiner: " | " }), ctx);
    expect(piped.text).toBe("Dexter 3.5K axles | Lippert 3.5K axles");
    expect(piped.listCount).toBe(2);
  });

  it("reports an empty list and uses the fallback", () => {
    const r = resolveBinding(makeBinding({ path: "warnings", fallback: "No warnings" }), ctx);
    expect(r.status).toBe("empty");
    expect(r.value).toBe("");
    expect(r.text).toBe("No warnings");
    expect(r.usedFallback).toBe(true);
    expect(codes(r.issues)).toContain("EMPTY_VALUE");
  });

  it("distinguishes empty from missing from resolved", () => {
    expect(resolveBinding(makeBinding({ path: "partNumber" }), ctx).status).toBe("ok");
    expect(resolveBinding(makeBinding({ path: "subtitle" }), emptyProductContext()).status).toBe("empty");
    expect(resolveBinding(makeBinding({ path: "nope.nothing" }), ctx).status).toBe("missing");
  });

  it("reports a path that is not in the field catalogue", () => {
    const missing = resolveBinding(makeBinding({ path: "partNo" }), ctx);
    expect(missing.unknownPath).toBe(true);
    expect(codes(missing.issues)).toEqual(["UNKNOWN_PATH", "MISSING_VALUE"]);
    expect(missing.text).toBe("");
  });

  it("does not call an uncatalogued field the product carries a template defect", () => {
    // `custom.*` is the free-form column set the importer copies over: it is
    // not in FIELD_CATALOG, but a design that binds one is not broken, and
    // BINDING_UNKNOWN_PATH means "this template points at a field that does not
    // exist". The {token} form and the structured form must give one answer.
    const r = resolveBinding(makeBinding({ path: "custom.promoLine" }), ctx);
    expect(r.unknownPath).toBe(false);
    // Present but empty on this product: blank, not a typo.
    expect(r.status).toBe("empty");
    expect(codes(r.issues)).toEqual(["EMPTY_VALUE"]);
    expect(codes(resolveTokens("{custom.promoLine}", ctx).issues)).not.toContain("UNKNOWN_PATH");

    const promo = fixture();
    promo.custom = { promoLine: "Now with 20% more grease" };
    const filled = resolveBinding(makeBinding({ path: "custom.promoLine" }), promo);
    expect(filled.text).toBe("Now with 20% more grease");
    expect(filled.issues).toEqual([]);
    expect(resolveTokensText("{custom.promoLine}", promo)).toBe("Now with 20% more grease");
  });

  it("maps issues onto preflight check codes", () => {
    const r = resolveBinding(makeBinding({ path: "partNo" }), ctx);
    expect(r.issues.map(bindingPreflightCode)).toEqual(["BINDING_UNKNOWN_PATH", "BINDING_UNRESOLVED"]);
  });

  it("returns the fallback for a missing path and still reports it", () => {
    const r = resolveBinding(makeBinding({ path: "nope", fallback: "TBD", transform: "uppercase", prefix: "[", suffix: "]" }), ctx);
    expect(r.text).toBe("[TBD]");
    expect(r.usedFallback).toBe(true);
    expect(codes(r.issues)).toContain("MISSING_VALUE");
  });

  it("renders nothing rather than bare decoration when there is no fallback", () => {
    const r = resolveBinding(makeBinding({ path: "warnings", prefix: "WARNING: " }), ctx);
    expect(r.text).toBe("");
  });

  it("formats numbers and reports a format that cannot apply", () => {
    const r = resolveBinding(makeBinding({ path: "bom.itemCount", format: "0.00" }), ctx);
    expect(r.text).toBe("5.00");

    const bad = resolveBinding(makeBinding({ path: "partNumber", format: "0.00" }), ctx);
    expect(bad.text).toBe("11-500");
    expect(codes(bad.issues)).toContain("BAD_FORMAT");
  });

  it("refuses to flatten a collection or an object into a line of text", () => {
    const coll = resolveBinding(makeBinding({ path: "bom.items" }), ctx);
    expect(coll.text).toBe("");
    expect(codes(coll.issues)).toContain("NOT_TEXT");

    const obj = resolveBinding(makeBinding({ path: "brand" }), ctx);
    expect(obj.text).toBe("");
    expect(codes(obj.issues)).toContain("NOT_TEXT");
  });

  it("hides the element when hideWhenEmpty and nothing filled the slot", () => {
    expect(resolveBinding(makeBinding({ path: "warnings", hideWhenEmpty: true }), ctx).hidden).toBe(true);
    expect(resolveBinding(makeBinding({ path: "warnings", hideWhenEmpty: true, fallback: "—" }), ctx).hidden).toBe(false);
    expect(resolveBinding(makeBinding({ path: "partNumber", hideWhenEmpty: true }), ctx).hidden).toBe(false);
  });

  it("does not walk the prototype chain", () => {
    const r = resolveBinding(makeBinding({ path: "constructor" }), ctx);
    expect(r.text).toBe("");
    expect(r.status).toBe("missing");
    expect(getPath(ctx, "brand.toString")).toBeUndefined();
  });
});

/* --------------------------------------------------------------- token strings */

describe("resolveTokens", () => {
  const ctx = fixture();

  it("substitutes {token} style paths", () => {
    expect(resolveTokensText("P/N {partNumber} — {brand.name}", ctx)).toBe("P/N 11-500 — Axle Teknology");
  });

  it("joins a list token", () => {
    expect(resolveTokensText("Replaces {alternatePartNumbers}", ctx)).toBe("Replaces L44610, L44649");
    expect(resolveTokens("{fitments}", ctx, { joiner: " / " }).text).toBe("Dexter 3.5K axles / Lippert 3.5K axles");
  });

  it("never leaves a literal {token} on the card and reports the miss", () => {
    const r = resolveTokens("A {nope} B", ctx);
    expect(r.text).toBe("A  B");
    expect(r.text).not.toContain("{");
    expect(codes(r.issues)).toEqual(["UNKNOWN_PATH", "UNRESOLVED_TOKEN"]);
    expect(r.unresolvedCount).toBe(1);
    expect(r.tokenCount).toBe(1);
  });

  it("separates an empty value from an unknown one", () => {
    const r = resolveTokens("{subtitle}|{nope}", emptyProductContext());
    expect(r.text).toBe("|");
    expect(codes(r.issues)).toEqual(["EMPTY_VALUE", "UNKNOWN_PATH", "UNRESOLVED_TOKEN"]);
  });

  it("treats {{ and }} as literal braces", () => {
    const r = resolveTokens("{{partNumber}} is literal, {partNumber} is not", ctx);
    expect(r.text).toBe("{partNumber} is literal, 11-500 is not");
    expect(r.issues).toEqual([]);
  });

  it("prints an unbalanced brace literally and reports it", () => {
    const open = resolveTokens("100% pure { not a token", ctx);
    expect(open.text).toBe("100% pure { not a token");
    expect(codes(open.issues)).toEqual(["UNBALANCED_BRACE"]);

    const close = resolveTokens("a } b", ctx);
    expect(close.text).toBe("a } b");
    expect(codes(close.issues)).toEqual(["UNBALANCED_BRACE"]);

    const bare = resolveTokens("{}", ctx);
    expect(bare.text).toBe("");
    expect(codes(bare.issues)).toEqual(["UNRESOLVED_TOKEN"]);
  });

  it("lists the paths a template references, deduped and in order", () => {
    expect(templatePaths("{brand.name} {partNumber} {brand.name}")).toEqual(["brand.name", "partNumber"]);
  });
});

/* ------------------------------------------------------------------ transforms */

describe("transforms and formatting", () => {
  it("applies the four case transforms", () => {
    expect(applyTextTransform("bearing kit", "none")).toBe("bearing kit");
    expect(applyTextTransform("bearing kit", "uppercase")).toBe("BEARING KIT");
    expect(applyTextTransform("BEARING KIT", "lowercase")).toBe("bearing kit");
    expect(applyTextTransform("bearing KIT", "titlecase")).toBe("Bearing Kit");
  });

  it("classifies format hints", () => {
    expect(classifyFormat(undefined)).toBe("none");
    expect(classifyFormat("0.00")).toBe("number");
    expect(classifyFormat("#,##0")).toBe("number");
    expect(classifyFormat("0.00 in")).toBe("number");
    expect(classifyFormat("MMM d, yyyy")).toBe("date");
    expect(classifyFormat("wat")).toBe("unknown");
    expect(classifyFormat("EEEE, MMMM d, yyyy")).toBe("date");
    expect(classifyFormat("'Printed' MMM yyyy")).toBe("date");
  });

  it("formats numbers to a known answer", () => {
    expect(formatNumber(2, "0.00")).toBe("2.00");
    expect(formatNumber(1234.5, "#,##0.0")).toBe("1,234.5");
    expect(formatNumber(1234567, "#,##0")).toBe("1,234,567");
    expect(formatNumber(0.5, "#.##")).toBe("0.5");
    expect(formatNumber(-3.456, "0.00")).toBe("-3.46");
    expect(formatNumber(-0.001, "0.00")).toBe("0.00");
    expect(formatNumber(0.125, "0.0%")).toBe("12.5%");
    expect(formatNumber(7.11175, "0.00000 in")).toBe("7.11175 in");
    expect(formatNumber(4, "000")).toBe("004");
  });

  it("formats dates in UTC to a known answer", () => {
    const d = new Date(Date.UTC(2026, 7, 26, 15, 4, 5));
    expect(formatDate(d, "MMM d, yyyy")).toBe("Aug 26, 2026");
    expect(formatDate(d, "yyyy-MM-dd")).toBe("2026-08-26");
    expect(formatDate(d, "EEEE, MMMM d, yyyy")).toBe("Wednesday, August 26, 2026");
    expect(formatDate(d, "h:mm a")).toBe("3:04 PM");
    expect(formatDate(d, "HH:mm:ss")).toBe("15:04:05");
    expect(formatDate(d, "'Rev' yy")).toBe("Rev 26");
  });

  it("coerces only values it can trust", () => {
    expect(coerceNumber("1,234.5")).toBe(1234.5);
    expect(coerceNumber("11-500")).toBeNull();
    expect(coerceDate("2026-08-26")?.toISOString()).toBe("2026-08-26T00:00:00.000Z");
    expect(coerceDate("August 26 2026")).toBeNull();
  });

  it("never stringifies an object onto a card", () => {
    expect(stringifyScalar({ a: 1 })).toBe("");
    expect(stringifyScalar([1, 2])).toBe("");
    expect(stringifyScalar(-0)).toBe("0");
    expect(stringifyScalar(null)).toBe("");
  });

  it("reports a format hint that is neither a number nor a date pattern", () => {
    const out = applyFormat("11-500", "gibberish");
    expect(out.text).toBe("11-500");
    expect(out.applied).toBe(false);
    expect(out.issue?.kind).toBe("unknown-pattern");
  });
});

/* -------------------------------------------------------- conditional visibility */

describe("visibleWhen", () => {
  const ctx = fixture();

  it("parses the supported forms", () => {
    expect(parseVisibleWhen("warnings")).toEqual({ path: "warnings", op: "truthy", literal: "" });
    expect(parseVisibleWhen("!warnings")).toEqual({ path: "warnings", op: "falsy", literal: "" });
    expect(parseVisibleWhen('status == "In Use"')).toEqual({ path: "status", op: "eq", literal: "In Use" });
    expect(parseVisibleWhen("status != Obsolete")).toEqual({ path: "status", op: "ne", literal: "Obsolete" });
  });

  it("shows an element only when the field has something in it", () => {
    expect(evaluateVisibleWhen("fitments", ctx).visible).toBe(true);
    expect(evaluateVisibleWhen("warnings", ctx).visible).toBe(false);
    expect(evaluateVisibleWhen("!warnings", ctx).visible).toBe(true);
    expect(evaluateVisibleWhen(undefined, ctx).visible).toBe(true);
    expect(evaluateVisibleWhen("", ctx).visible).toBe(true);
  });

  it("compares against a literal", () => {
    expect(evaluateVisibleWhen('status == "In Use"', ctx).visible).toBe(true);
    expect(evaluateVisibleWhen('status == "Obsolete"', ctx).visible).toBe(false);
    expect(evaluateVisibleWhen('status != "Obsolete"', ctx).visible).toBe(true);
  });

  it("reports a rule that points at a field nobody has", () => {
    const d = evaluateVisibleWhen("madeUpField", ctx);
    expect(d.visible).toBe(false);
    expect(codes(d.issues)).toEqual(["UNKNOWN_PATH"]);
  });

  it("decides element visibility from the flag, the rule and the binding", () => {
    const base = {
      frame: { x: 0, y: 0, w: 1_000_000, h: 1_000_000 },
    };
    const hiddenFlag: DesignElement = TextElementSchema.parse({ id: "t1", kind: "text", hidden: true, ...base });
    expect(isElementVisible(hiddenFlag, ctx).reason).toBe("hidden-flag");

    const ruled: DesignElement = TextElementSchema.parse({
      id: "t2",
      kind: "text",
      visibleWhen: "warnings",
      paragraphs: [{ runs: [{ text: "WARNING" }] }],
      ...base,
    });
    expect(isElementVisible(ruled, ctx).visible).toBe(false);

    const emptyBound: DesignElement = TextElementSchema.parse({
      id: "t3",
      kind: "text",
      paragraphs: [{ runs: [{ text: "", binding: { path: "warnings", hideWhenEmpty: true } }] }],
      ...base,
    });
    const d = isElementVisible(emptyBound, ctx);
    expect(d.visible).toBe(false);
    expect(d.reason).toBe("empty-binding");

    const shown: DesignElement = TextElementSchema.parse({
      id: "t4",
      kind: "text",
      paragraphs: [{ runs: [{ text: "", binding: { path: "partNumber" } }] }],
      ...base,
    });
    expect(isElementVisible(shown, ctx).visible).toBe(true);
    expect(resolveTextElementText(TextElementSchema.parse({ id: "t4", kind: "text", paragraphs: [{ runs: [{ text: "P/N " }, { text: "", binding: { path: "partNumber" } }] }], ...base }), ctx).text).toBe("P/N 11-500");
  });
});

/* ------------------------------------------------------------ collectBindingPaths */

describe("collectBindingPaths", () => {
  it("collects run bindings, inline tokens and the visibility rule", () => {
    const el = TextElementSchema.parse({
      id: "t1",
      kind: "text",
      frame: { x: 0, y: 0, w: 1_000_000, h: 1_000_000 },
      visibleWhen: "!warnings",
      paragraphs: [
        { runs: [{ text: "", binding: { path: "partNumber" } }, { text: " {brand.name}" }] },
        { runs: [{ text: "{countryOfOrigin}" }] },
      ],
    });
    expect(collectBindingPaths(el)).toEqual(["brand.name", "countryOfOrigin", "partNumber", "warnings"]);
  });

  it("collects a barcode binding", () => {
    const el = BarcodeElementSchema.parse({
      id: "b1",
      kind: "barcode",
      frame: { x: 0, y: 0, w: 1_000_000, h: 1_000_000 },
      binding: { path: "identifiers.upc12" },
    });
    expect(collectBindingPaths(el)).toEqual(["identifiers.upc12"]);
  });

  it("records row tokens against the collection they iterate", () => {
    const el = bomEl({
      itemTemplate: "{quantity}) {name} ({partNumber}) for {product.partNumber}",
      heading: "{brand.name} PACK INCLUDES:",
    });
    expect(collectBindingPaths(el)).toEqual([
      "bom.items",
      "bom.items[].name",
      "bom.items[].partNumber",
      "bom.items[].quantity",
      "brand.name",
      "partNumber",
    ]);
  });

  it("flags stored paths that no longer exist in the catalogue", () => {
    expect(unknownBindingPaths(["partNumber", "bom.items[].name", "legacyField"])).toEqual(["legacyField"]);
  });
});

/* ------------------------------------------------------------------- BOM lines */

describe("renderBomLines", () => {
  const ctx = fixture();

  it("reproduces the spec's reference line exactly", () => {
    const el = bomEl({ maxItems: 1 });
    expect(renderBomLines(el, ctx)[0]).toBe("2) Inner Bearing (L44643)");
  });

  it("renders every row of the pack", () => {
    expect(renderBomLines(bomEl(), ctx)).toEqual([
      "2) Inner Bearing (L44643)",
      "2) Outer Bearing (L44649)",
      "2) Grease Seal (10-19)",
      "1) Cotter Pin (CP-18)",
      "1) Spindle Nut (SN-1)",
    ]);
  });

  it("supports a reconfigured template, including the parent product", () => {
    const el = bomEl({
      itemTemplate: "{position}. {name} — {partNumber} ({quantityText} {unitOfMeasure}) [{product.partNumber}]",
      maxItems: 1,
    });
    expect(renderBomLines(el, ctx)[0]).toBe("1. Inner Bearing — L44643 (2 EA) [11-500]");
  });

  it("renders a token the row does not have as empty and reports it", () => {
    const el = bomEl({ itemTemplate: "{quantity}) {name} <{colour}>", maxItems: 1 });
    const r = renderBomBlock(el, ctx);
    expect(r.lines[0]).toBe("2) Inner Bearing <>");
    expect(r.lines[0]).not.toContain("{");
    // maxItems trimmed the other four rows, so that finding leads the list.
    expect(codes(r.issues)).toEqual(["TRUNCATED", "UNKNOWN_PATH", "UNRESOLVED_TOKEN"]);
    const unresolved = r.issues.find((i) => i.code === "UNRESOLVED_TOKEN");
    expect(unresolved?.detail).toBe('Row 1: "{colour}" has no value here and printed nothing.');
  });

  it("reports a row field that is present but blank", () => {
    const el = bomEl({ itemTemplate: "{name}: {description}" });
    const r = renderBomBlock(el, ctx);
    expect(r.lines[3]).toBe("Cotter Pin:");
    expect(codes(r.issues)).toContain("EMPTY_VALUE");
  });

  it("treats {{ as a literal brace inside a row template", () => {
    const el = bomEl({ itemTemplate: "{{{quantity}}} {name}", maxItems: 1 });
    expect(renderBomLines(el, ctx)[0]).toBe("{2} Inner Bearing");
  });

  it("truncates at maxItems and reports what is missing", () => {
    const el = bomEl({ maxItems: 2 });
    const r = renderBomBlock(el, ctx);
    expect(r.lines).toEqual(["2) Inner Bearing (L44643)", "2) Outer Bearing (L44649)"]);
    expect(r.sourceCount).toBe(5);
    expect(r.truncatedCount).toBe(3);
    const truncation = r.issues.find((i) => i.code === "TRUNCATED");
    expect(truncation?.detail).toBe(
      "3 of 5 pack-contents rows were dropped by the 2-item limit and are not on the card.",
    );
    expect(bindingPreflightCode({ code: "TRUNCATED", path: "", detail: "" })).toBe("BOM_OVERFLOW");
  });

  it("does not truncate when maxItems is null", () => {
    const r = renderBomBlock(bomEl({ maxItems: null }), ctx);
    expect(r.truncatedCount).toBe(0);
    expect(r.issues.some((i) => i.code === "TRUNCATED")).toBe(false);
  });

  it("handles an empty pack", () => {
    const bare = emptyProductContext();
    const plain = renderBomBlock(bomEl(), bare);
    expect(plain.empty).toBe(true);
    expect(plain.lines).toEqual([]);
    expect(plain.emptyText).toBe("");
    expect(renderBomLines(bomEl(), bare)).toEqual([]);

    const withText = bomEl({ emptyText: "Sold as a single component — {partNumber}" });
    bare.partNumber = "11-500";
    const placeheld = renderBomBlock(withText, bare);
    expect(placeheld.empty).toBe(true);
    expect(placeheld.emptyText).toBe("Sold as a single component — 11-500");
    expect(renderBomLines(withText, bare)).toEqual(["Sold as a single component — 11-500"]);
    expect(placeheld.columns).toEqual([["Sold as a single component — 11-500"]]);
  });

  it("reports a source path that is missing or is not a collection", () => {
    const missing = renderBomBlock(bomEl({ sourcePath: "bom.nothing" }), ctx);
    expect(codes(missing.issues)).toContain("MISSING_VALUE");
    const notList = renderBomBlock(bomEl({ sourcePath: "partNumber" }), ctx);
    expect(codes(notList.issues)).toContain("NOT_A_LIST");
    expect(notList.lines).toEqual([]);
  });

  it("resolves the heading and honours showHeading", () => {
    expect(renderBomBlock(bomEl(), ctx).heading).toBe("THIS PACK INCLUDES:");
    expect(renderBomBlock(bomEl({ heading: "{brand.name} PACK:" }), ctx).heading).toBe("Axle Teknology PACK:");
    expect(renderBomBlock(bomEl({ showHeading: false }), ctx).heading).toBeNull();
  });
});

/* --------------------------------------------------- data hygiene (review) */

/**
 * Regression cover for the defects the adversarial pass found: each of these
 * printed a wrong or machine-dependent answer on a card, or threw, before the
 * fix that sits beside it.
 */
describe("data hygiene", () => {
  const ctx = fixture();

  it("reads a date-time with no offset as UTC, not off the renderer's clock", () => {
    // Date.parse() calls an offset-less stamp LOCAL time, so the same product
    // string set Aug 26 on a UTC export worker and Aug 27 on a designer's
    // machine in Chicago. The instant must not depend on the machine.
    expect(coerceDate("2026-08-26T20:00")?.toISOString()).toBe("2026-08-26T20:00:00.000Z");
    expect(coerceDate("2026-08-26 20:00")?.toISOString()).toBe("2026-08-26T20:00:00.000Z");
    expect(coerceDate("2026-08-26T20:00:00.5")?.toISOString()).toBe("2026-08-26T20:00:00.500Z");
    // An explicit offset still means exactly what it says.
    expect(coerceDate("2026-08-26T20:00:00-05:00")?.toISOString()).toBe("2026-08-27T01:00:00.000Z");
    expect(coerceDate("2026-08-26T20:00:00Z")?.toISOString()).toBe("2026-08-26T20:00:00.000Z");

    const tz = process.env.TZ;
    try {
      for (const zone of ["UTC", "America/Chicago", "Pacific/Kiritimati", "Pacific/Midway"]) {
        process.env.TZ = zone;
        const d = coerceDate("2026-08-26T20:00");
        expect(formatDate(d as Date, "MMM d, yyyy")).toBe("Aug 26, 2026");
      }
    } finally {
      process.env.TZ = tz;
    }
  });

  it("rejects a date that does not exist rather than rolling it forward", () => {
    expect(coerceDate("2026-02-31")).toBeNull();
    expect(coerceDate("2026-13-01")).toBeNull();
    expect(coerceDate("2026-08-26T25:00")).toBeNull();
    expect(coerceDate("26 August 2026")).toBeNull();
  });

  it("reports a number under a date pattern instead of printing 1970", () => {
    const out = applyFormat(5, "MMM d, yyyy");
    expect(out.text).toBe("5");
    expect(out.applied).toBe(false);
    expect(out.issue?.kind).toBe("not-a-date");

    const r = resolveBinding(makeBinding({ path: "bom.itemCount", format: "MMM d, yyyy" }), ctx);
    expect(r.text).toBe("5");
    expect(codes(r.issues)).toContain("BAD_FORMAT");
  });

  it("never throws on a format hint a designer can type", () => {
    // toFixed() accepts 0-100 fraction digits and throws outside them; a pasted
    // pattern must not take the preview or the PDF writer down with it.
    expect(() => applyFormat(1.5, "0." + "#".repeat(120))).not.toThrow();
    expect(() => applyFormat(1.5, "0".repeat(5_000))).not.toThrow();
    expect(applyFormat(1.5, "0." + "0".repeat(120)).text.length).toBeLessThan(140);
  });

  it("prints a number it cannot express in digits plainly, not grouped into gibberish", () => {
    expect(formatNumber(1e21, "#,##0.00")).toBe("1e+21");
    expect(formatNumber(1e307, "0.0%")).toBe("1e+307");
  });

  it("refuses a numeric string whose commas are not group separators", () => {
    expect(coerceNumber("1,234.5")).toBe(1234.5);
    expect(coerceNumber("1,2,3")).toBeNull();
    // A European decimal comma is not 1.23456.
    expect(coerceNumber("1.234,56")).toBeNull();
  });

  it("title-cases a word that opens with an accented letter", () => {
    expect(applyTextTransform("élan vital", "titlecase")).toBe("Élan Vital");
    expect(applyTextTransform("(bearing) kit", "titlecase")).toBe("(Bearing) Kit");
    expect(applyTextTransform("11-500 l44649", "titlecase")).toBe("11-500 L44649");
  });

  it("treats a whitespace-only field as empty", () => {
    // An imported cell holding one space is not content: without this the
    // fallback is skipped, hideWhenEmpty does not fire, and the slot sets as a
    // bare "P/N " with nothing after it.
    const blank = fixture();
    blank.subtitle = "   ";
    const r = resolveBinding(makeBinding({ path: "subtitle", prefix: "P/N ", hideWhenEmpty: true }), blank);
    expect(r.text).toBe("");
    expect(r.value).toBe("");
    expect(r.status).toBe("empty");
    expect(r.hidden).toBe(true);
    expect(codes(r.issues)).toContain("EMPTY_VALUE");

    expect(resolveBindingText(makeBinding({ path: "subtitle", fallback: "TBD" }), blank)).toBe("TBD");
    // The visibility rule already read that field as empty; now they agree.
    expect(evaluateVisibleWhen("subtitle", blank).visible).toBe(false);

    const t = resolveTokens("[{subtitle}]", blank);
    expect(t.text).toBe("[]");
    expect(codes(t.issues)).toEqual(["EMPTY_VALUE"]);
  });

  it("reports a visibility rule with an unclosed quote instead of hiding silently", () => {
    const d = evaluateVisibleWhen('status == "In Use', ctx);
    expect(d.visible).toBe(false);
    expect(codes(d.issues)).toContain("UNRESOLVED_TOKEN");
    // The well-formed rule is unaffected.
    expect(evaluateVisibleWhen('status == "In Use"', ctx).issues).toEqual([]);
  });
});

/* ----------------------------------------------------------------- columns */

describe("splitIntoColumns", () => {
  it("reads down then across with the remainder on the left", () => {
    expect(splitIntoColumns(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b", "c"], ["d", "e"]]);
    expect(splitIntoColumns(["a", "b", "c", "d"], 3)).toEqual([["a", "b"], ["c"], ["d"]]);
    expect(splitIntoColumns(["a", "b", "c"], 1)).toEqual([["a", "b", "c"]]);
    expect(splitIntoColumns([], 2)).toEqual([[], []]);
  });

  it("splits a rendered pack across columns", () => {
    const r = renderBomBlock(bomEl({ columns: 2 }), fixture());
    expect(r.columns).toEqual([
      ["2) Inner Bearing (L44643)", "2) Outer Bearing (L44649)", "2) Grease Seal (10-19)"],
      ["1) Cotter Pin (CP-18)", "1) Spindle Nut (SN-1)"],
    ]);
  });
});
