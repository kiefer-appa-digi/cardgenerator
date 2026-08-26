import { describe, it, expect } from "vitest";
import { emptyProductContext } from "@/lib/data/context";
import { resolveBinding, makeBinding, resolveTokens, evaluateVisibleWhen, parseVisibleWhen, getPath } from "@/lib/data/binding";
import { applyFormat, applyTextTransform, coerceDate, formatNumber, formatDate, classifyFormat, coerceNumber } from "@/lib/data/format";

describe("probe", () => {
  it("A: coerceDate timezone dependence", () => {
    console.log("TZ =", process.env.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone);
    for (const s of ["2026-08-26", "2026-08-26T20:00", "2026-08-26 20:00", "2026-08-26T20:00:00", "2026-08-26T20:00:00Z", "2026-08-26T20:00:00-05:00"]) {
      const d = coerceDate(s);
      console.log(JSON.stringify(s), "->", d ? d.toISOString() : null, "| formatted:", d ? formatDate(d, "MMM d, yyyy HH:mm") : "-");
    }
  });

  it("B: titlecase unicode", () => {
    console.log("titlecase 'élan vital' ->", JSON.stringify(applyTextTransform("élan vital", "titlecase")));
    console.log("titlecase 'ötiker clamp' ->", JSON.stringify(applyTextTransform("ötiker clamp", "titlecase")));
    console.log("titlecase 'ACME  kit' ->", JSON.stringify(applyTextTransform("ACME  kit", "titlecase")));
    console.log("upper 'straße' ->", JSON.stringify(applyTextTransform("straße", "uppercase")));
  });

  it("C: toFixed range", () => {
    const pat = "0." + "#".repeat(120);
    let res: string;
    try { res = formatNumber(1.5, pat); } catch (e) { res = "THREW: " + (e as Error).constructor.name + " " + (e as Error).message; }
    console.log("120-frac pattern ->", res);
    let res2: string;
    try { res2 = applyFormat(1.5, pat).text; } catch (e) { res2 = "THREW: " + (e as Error).message; }
    console.log("applyFormat 120-frac ->", res2);
  });

  it("D: huge / tiny numbers", () => {
    console.log("1e21 #,##0.00 ->", formatNumber(1e21, "#,##0.00"));
    console.log("1e21 0 ->", formatNumber(1e21, "0"));
    console.log("1e300 pct 0.0% ->", formatNumber(1e307, "0.0%"));
    console.log("1e-7 0.00 ->", formatNumber(1e-7, "0.00"));
    console.log("0.5 -> '0' ->", formatNumber(0.5, "0"), " 1.5->", formatNumber(1.5, "0"), " 2.5->", formatNumber(2.5, "0"));
    console.log("coerceNumber('1,2,3') ->", coerceNumber("1,2,3"), " ('1.234,56') ->", coerceNumber("1.234,56"));
  });

  it("H: number under a date pattern", () => {
    const out = applyFormat(5, "MMM d, yyyy");
    console.log("applyFormat(5, 'MMM d, yyyy') ->", JSON.stringify(out));
    const ctx = emptyProductContext();
    ctx.bom.itemCount = 5;
    const r = resolveBinding(makeBinding({ path: "bom.itemCount", format: "MMM d, yyyy" }), ctx);
    console.log("binding itemCount w/ date fmt ->", JSON.stringify({ text: r.text, status: r.status, issues: r.issues.map(i => i.code) }));
    console.log("classifyFormat('EA') ->", classifyFormat("EA"), " ('Made') ->", classifyFormat("Made"), " ('has') ->", classifyFormat("has"));
    console.log("applyFormat('4 EA','EA') ->", JSON.stringify(applyFormat("4 EA", "EA")));
  });

  it("T: whitespace-only field", () => {
    const ctx = emptyProductContext();
    ctx.subtitle = "   ";
    const r = resolveBinding(makeBinding({ path: "subtitle", prefix: "P/N ", hideWhenEmpty: true, fallback: "" }), ctx);
    console.log("ws-only subtitle ->", JSON.stringify({ text: r.text, value: r.value, status: r.status, hidden: r.hidden, issues: r.issues.map(i => i.code) }));
    console.log("visibleWhen subtitle ->", evaluateVisibleWhen("subtitle", ctx).visible);
    const fb = resolveBinding(makeBinding({ path: "subtitle", fallback: "TBD" }), ctx);
    console.log("ws-only with fallback ->", JSON.stringify({ text: fb.text, usedFallback: fb.usedFallback }));
    console.log("token ws-only ->", JSON.stringify(resolveTokens("[{subtitle}]", ctx).text), resolveTokens("[{subtitle}]", ctx).issues.map(i=>i.code));
  });

  it("I: custom.* known-path inconsistency", () => {
    const ctx = emptyProductContext();
    ctx.custom = { promoLine: "Now with 20% more grease" };
    const b = resolveBinding(makeBinding({ path: "custom.promoLine" }), ctx);
    console.log("binding custom.promoLine ->", JSON.stringify({ text: b.text, unknownPath: b.unknownPath, issues: b.issues.map(i => i.code) }));
    const t = resolveTokens("{custom.promoLine}", ctx);
    console.log("token custom.promoLine ->", JSON.stringify({ text: t.text, issues: t.issues.map(i => i.code) }));
    const p = resolveBinding(makeBinding({ path: "packagingLevel" }), ctx);
    console.log("binding packagingLevel (real ctx field, uncatalogued) ->", JSON.stringify({ unknownPath: p.unknownPath, issues: p.issues.map(i=>i.code) }));
  });

  it("Z: array length leak + misc paths", () => {
    const ctx = emptyProductContext();
    ctx.fitments = ["a", "b"];
    console.log("getPath fitments.length ->", getPath(ctx, "fitments.length"));
    console.log("getPath partNumber.length ->", getPath(ctx, "partNumber.length"));
    console.log("parseVisibleWhen('a=b') ->", JSON.stringify(parseVisibleWhen("a=b")));
    console.log("parseVisibleWhen('!warnings') ->", JSON.stringify(parseVisibleWhen("!warnings")));
    console.log("parseVisibleWhen('status != \"a\"') ->", JSON.stringify(parseVisibleWhen('status != "a"')));
    console.log("parseVisibleWhen('!status == \"a\"') ->", JSON.stringify(parseVisibleWhen('!status == "a"')));
    console.log("unquote mismatch ->", JSON.stringify(parseVisibleWhen('status == "In Use')));
  });
});
