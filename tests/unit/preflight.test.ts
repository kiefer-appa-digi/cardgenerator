import { describe, expect, it } from "vitest";
import { inToUpt } from "@/lib/units";
import { rectContains, type Rect } from "@/lib/geometry/types";
import { CARD_PRESETS, bleedRect, cavityRect, safeRect, trimRect } from "@/lib/geometry/presets";
import {
  BlackRulesSchema,
  DEFAULT_BLACK_RULES,
  DEFAULT_RICH_BLACK,
  OutputIntentSchema,
  TEXT_BLACK,
  cmykPct,
  type BlackRules,
  type OutputIntent,
  type PrintColor,
} from "@/lib/color/types";
import {
  BarcodeElementSchema,
  BomListElementSchema,
  DesignDocSchema,
  ImageElementSchema,
  ShapeElementSchema,
  TextElementSchema,
  emptyDesign,
  type DesignDoc,
  type DesignElement,
  type SideKey,
} from "@/lib/design/schema";
import { planDocument, type AssetInfo } from "@/lib/design/plan";
import type { SidePlan } from "@/lib/design/render";
import { emptyProductContext, type ProductContext } from "@/lib/data/context";
import { appendCheckDigit } from "@/lib/barcode/gtin";
import { runPreflight } from "@/lib/preflight/engine";
import {
  DEFAULT_PREFLIGHT_PROFILE,
  PreflightProfileSchema,
  type CheckCode,
  type PreflightFinding,
  type PreflightReport,
  type Severity,
} from "@/lib/preflight/types";

/**
 * PREFLIGHT ENGINE TESTS — spec §21.
 *
 * Every check is tripped deliberately and asserted by code and severity, and the
 * geometry cases are asserted against the plan's own numbers rather than against
 * hand-copied constants, so a preset change moves the test with it.
 */

const PRESET = CARD_PRESETS["409TF"];
const CANVAS = bleedRect(PRESET);
const TRIM = trimRect(PRESET);
const SAFE = safeRect(PRESET);
const CAVITY = cavityRect(PRESET);

const IN = inToUpt;
const rect = (x: number, y: number, w: number, h: number): Rect => ({
  x: IN(x),
  y: IN(y),
  w: IN(w),
  h: IN(h),
});

/** A UPC-A whose check digit is correct, computed rather than copied. */
const VALID_UPC = appendCheckDigit("01234567890");
/** The same body with the check digit deliberately wrong by one. */
const BAD_CHECK_DIGIT_UPC = "012345678906";

/* ------------------------------------------------------------- fixtures */

function sampleProduct(overrides: Partial<ProductContext> = {}): ProductContext {
  const base = emptyProductContext();
  return {
    ...base,
    id: "prod-1",
    partNumber: "11-500",
    productName: "Bearing Kit",
    subtitle: "L44610 / L44649",
    countryOfOrigin: "Made in USA",
    ...base.brand,
    ...overrides,
    brand: { ...base.brand, name: "Axle Teknology", ...(overrides.brand ?? {}) },
    identifiers: { ...base.identifiers, upc12: VALID_UPC, ...(overrides.identifiers ?? {}) },
    bom: {
      items: [
        { quantity: 2, quantityText: "2", name: "Inner Bearing", partNumber: "L44643", description: "", position: 1, unitOfMeasure: "EA" },
        { quantity: 2, quantityText: "2", name: "Outer Bearing", partNumber: "L44649", description: "", position: 2, unitOfMeasure: "EA" },
        { quantity: 1, quantityText: "1", name: "Grease Seal", partNumber: "10-19", description: "", position: 3, unitOfMeasure: "EA" },
        { quantity: 1, quantityText: "1", name: "Cotter Pin", partNumber: "10-20", description: "", position: 4, unitOfMeasure: "EA" },
      ],
      packIncludes: "",
      itemCount: 4,
      ...(overrides.bom ?? {}),
    },
  };
}

function textEl(
  id: string,
  frame: Rect,
  text: string,
  extra: Record<string, unknown> = {},
): DesignElement {
  return TextElementSchema.parse({
    id,
    kind: "text",
    frame,
    paragraphs: [{ runs: [{ text }] }],
    fontSize: 12_000_000,
    ...extra,
  });
}

function boundTextEl(
  id: string,
  frame: Rect,
  path: string,
  extra: Record<string, unknown> = {},
): DesignElement {
  return TextElementSchema.parse({
    id,
    kind: "text",
    frame,
    paragraphs: [{ runs: [{ text: "", binding: { path } }] }],
    fontSize: 12_000_000,
    ...extra,
  });
}

function shapeEl(
  id: string,
  frame: Rect,
  fill: PrintColor = TEXT_BLACK,
  extra: Record<string, unknown> = {},
): DesignElement {
  return ShapeElementSchema.parse({ id, kind: "shape", shape: "rect", frame, fill, ...extra });
}

function imageEl(
  id: string,
  frame: Rect,
  assetId: string | null,
  extra: Record<string, unknown> = {},
): DesignElement {
  return ImageElementSchema.parse({ id, kind: "image", frame, assetId, ...extra });
}

function barcodeEl(id: string, frame: Rect, extra: Record<string, unknown> = {}): DesignElement {
  return BarcodeElementSchema.parse({ id, kind: "barcode", frame, value: VALID_UPC, ...extra });
}

function bomEl(id: string, frame: Rect, extra: Record<string, unknown> = {}): DesignElement {
  return BomListElementSchema.parse({ id, kind: "bomList", frame, ...extra });
}

function asset(id: string, extra: Partial<AssetInfo> = {}): [string, AssetInfo] {
  return [
    id,
    {
      id,
      pixelWidth: 3000,
      pixelHeight: 4800,
      colorSpace: "cmyk",
      contentType: "image/png",
      ...extra,
    },
  ];
}

function makeDoc(
  front: DesignElement[],
  back: DesignElement[] = [],
  sideOverrides: Partial<Record<SideKey, Record<string, unknown>>> = {},
): DesignDoc {
  const base = emptyDesign("409TF");
  return DesignDocSchema.parse({
    ...base,
    front: { ...base.front, elements: front, ...(sideOverrides.front ?? {}) },
    back: { ...base.back, elements: back, ...(sideOverrides.back ?? {}) },
  });
}

type RunOptions = {
  product?: ProductContext;
  assets?: Map<string, AssetInfo>;
  profile?: typeof DEFAULT_PREFLIGHT_PROFILE;
  blackRules?: BlackRules;
  outputIntent?: OutputIntent;
  /** Lets a test hand the engine a plan the planner would never produce. */
  mutatePlans?: (plans: Record<SideKey, SidePlan>) => Record<SideKey, SidePlan>;
};

function run(doc: DesignDoc, opts: RunOptions = {}): PreflightReport {
  const product = opts.product ?? sampleProduct();
  const assets = opts.assets ?? new Map<string, AssetInfo>();
  const planned = planDocument({ doc, product, assets });
  const plans = opts.mutatePlans ? opts.mutatePlans(planned) : planned;
  return runPreflight({
    doc,
    plans,
    product,
    profile: opts.profile ?? DEFAULT_PREFLIGHT_PROFILE,
    blackRules: opts.blackRules ?? DEFAULT_BLACK_RULES,
    outputIntent: opts.outputIntent ?? OutputIntentSchema.parse({}),
    assets,
  });
}

function pick(report: PreflightReport, code: CheckCode): PreflightFinding[] {
  return report.findings.filter((f) => f.code === code);
}

function severityOf(report: PreflightReport, code: CheckCode): Severity | undefined {
  return pick(report, code)[0]?.severity;
}

function codes(report: PreflightReport): CheckCode[] {
  return report.findings.map((f) => f.code);
}

/** A card with nothing wrong with it: content in the clear band, valid symbol. */
function cleanDoc(): DesignDoc {
  return makeDoc(
    [textEl("t-front", rect(0.6, 0.4, 3.0, 0.3), "BEARING KIT")],
    [
      textEl("t-back", rect(0.6, 0.4, 3.0, 0.3), "MADE IN USA"),
      barcodeEl("bc", rect(1.5, 5.0, 1.6, 1.3), {
        binding: { path: "identifiers.upc12" },
      }),
    ],
  );
}

/* ------------------------------------------------------------------ tests */

describe("preflight — clean card", () => {
  it("produces no errors and stays exportable", () => {
    const report = run(cleanDoc());
    const bad = report.findings.filter(
      (f) => f.severity === "error" || f.severity === "blocking",
    );
    expect(bad.map((f) => `${f.code}:${f.detail}`)).toEqual([]);
    expect(report.counts.error).toBe(0);
    expect(report.counts.blocking).toBe(0);
    expect(report.counts.warning).toBe(0);
    expect(report.exportable).toBe(true);
  });

  it("gives every finding an element, a rect and a remedy", () => {
    const report = run(
      // Deliberately outside the safe area so at least one element-scoped
      // finding is produced whatever the cavity rules say.
      makeDoc([textEl("t1", rect(0.05, 2.0, 3.0, 0.3), "PAST THE SAFE AREA")]),
    );
    const sided = report.findings.filter((f) => f.elementId !== undefined);
    expect(sided.length).toBeGreaterThan(0);
    for (const f of sided) {
      expect(f.title.length).toBeGreaterThan(0);
      expect(f.remedy).toBeTruthy();
      expect(f.remedy?.toLowerCase()).not.toContain("contact support");
      expect(f.rect).toBeDefined();
      expect(f.elementName).toBeTruthy();
      expect(f.side).toBeDefined();
      expect(f.detail).toMatch(/\d/); // A detail without a number is not a measurement.
    }
  });

  it("sorts findings with the most severe first", () => {
    const report = run(
      makeDoc([
        textEl("overflow", rect(1.0, 0.4, 1.0, 0.15), "A very long line of copy that cannot fit"),
        shapeEl("ghost", rect(1.0, 2.0, 0.5, 0.5), TEXT_BLACK, { opacity: 5_000 }),
      ]),
    );
    const ranks = report.findings.map((f) =>
      ["info", "warning", "error", "blocking"].indexOf(f.severity),
    );
    expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
  });
});

describe("preflight — document geometry", () => {
  it("flags a canvas that is not the preset's full-bleed size", () => {
    const report = run(cleanDoc(), {
      mutatePlans: (plans) => ({
        ...plans,
        front: {
          ...plans.front,
          canvas: { ...plans.front.canvas, w: plans.front.canvas.w + IN(0.1) },
        },
      }),
    });
    expect(severityOf(report, "DOC_DIMENSIONS")).toBe("blocking");
    expect(pick(report, "DOC_DIMENSIONS")[0].measurements?.expectedWidthIn).toBe(4.6175);
    expect(report.exportable).toBe(false);
  });

  it("accepts the exact preset canvas", () => {
    const report = run(cleanDoc());
    expect(pick(report, "DOC_DIMENSIONS")).toHaveLength(0);
    const plan = planDocument({ doc: cleanDoc(), product: sampleProduct(), assets: new Map() });
    expect(plan.front.canvas).toEqual(CANVAS);
  });

  it("flags an empty front as an error and an empty back as a warning", () => {
    const report = run(makeDoc([], []));
    const found = pick(report, "DOC_EMPTY_SIDE");
    expect(found).toHaveLength(2);
    expect(found.find((f) => f.side === "front")?.severity).toBe("error");
    expect(found.find((f) => f.side === "back")?.severity).toBe("warning");
  });

  it("does not count an element that paints no ink as content", () => {
    const report = run(makeDoc([textEl("empty", rect(1, 1, 1, 0.3), "")]));
    expect(severityOf(report, "DOC_EMPTY_SIDE")).toBe("error");
  });
});

describe("preflight — bleed coverage", () => {
  const assets = new Map<string, AssetInfo>([asset("bg")]);

  it("flags a background that stops at the trim line", () => {
    const doc = makeDoc([
      imageEl("bg-el", TRIM, "bg", { isBackground: true, fit: "stretch" }),
    ]);
    const report = run(doc, { assets });
    const found = pick(report, "BLEED_COVERAGE");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].title).toContain("trim line");
    // 0.125 in short on all four sides, which is exactly the bleed allowance.
    expect(found[0].measurements?.shortLeftIn).toBe(0.125);
    expect(found[0].measurements?.shortBottomIn).toBe(0.125);
  });

  it("does not flag a background that covers the whole bleed box", () => {
    const doc = makeDoc([
      imageEl("bg-el", CANVAS, "bg", { isBackground: true, fit: "stretch" }),
    ]);
    const report = run(doc, { assets });
    expect(pick(report, "BLEED_COVERAGE")).toHaveLength(0);
  });

  it("treats a colour block sized to trim as a background", () => {
    const report = run(makeDoc([shapeEl("block", TRIM, cmykPct(10, 0, 0, 0))]));
    expect(severityOf(report, "BLEED_COVERAGE")).toBe("error");
  });

  it("flags low-resolution bleed artwork under its own code", () => {
    const lowRes = new Map<string, AssetInfo>([
      asset("bg", { pixelWidth: 400, pixelHeight: 640 }),
    ]);
    const doc = makeDoc([
      imageEl("bg-el", CANVAS, "bg", { isBackground: true, fit: "stretch" }),
    ]);
    const report = run(doc, { assets: lowRes });
    expect(severityOf(report, "BLEED_LOW_DPI")).toBe("error");
    expect(pick(report, "ASSET_LOW_DPI")).toHaveLength(0);
    expect(pick(report, "BLEED_LOW_DPI")[0].measurements?.effectiveDpi).toBe(87);
  });
});

describe("preflight — trim and safe area", () => {
  it("flags an element straddling the trim line", () => {
    const report = run(makeDoc([shapeEl("edge", rect(4.2, 2.0, 0.4, 1.0))]));
    const found = pick(report, "TRIM_CROSSING");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].measurements?.overRightIn).toBeCloseTo(0.1075, 4);
  });

  it("does not flag full-bleed artwork as crossing trim", () => {
    const assets = new Map<string, AssetInfo>([asset("bg")]);
    const doc = makeDoc([imageEl("bg-el", CANVAS, "bg", { isBackground: true, fit: "stretch" })]);
    expect(pick(run(doc, { assets }), "TRIM_CROSSING")).toHaveLength(0);
  });

  it("flags text outside the safe area", () => {
    const report = run(makeDoc([textEl("t", rect(0.15, 3.0, 2.0, 0.3), "TOO FAR LEFT")]));
    expect(severityOf(report, "SAFE_AREA_TEXT")).toBe("error");
  });

  it("grades a corner overrun by whether it actually reaches the cut", () => {
    // The safe area is the trim shape inset, so its own corner radius is
    // 0.25 - 0.1875 = 0.0625 in. A box laid out to the full safe width has its
    // bounding-box corners exactly on that arc, which is normal and is graded a
    // warning; only type that passes the 0.25 in TRIM corner is an error.
    const doc = makeDoc([textEl("corner", rect(0.33, 0.33, 1.2, 0.22), "CORNER")]);
    const plan = planDocument({ doc, product: sampleProduct(), assets: new Map() }).front;
    const op = plan.ops[0];
    expect(op.op).toBe("text");
    const ink = op.op === "text" ? op.inkBounds : op.frame;

    // The bounding-box test on its own passes: this is only a finding at all
    // because the safe area is a rounded shape.
    expect(rectContains(SAFE, ink)).toBe(true);
    const found = pick(run(doc), "SAFE_AREA_TEXT");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].detail).toContain("still on the card");
    expect(found[0].measurements?.cornerRadiusIn).toBe(0.25);
    expect(found[0].measurements?.safeCornerRadiusIn).toBeCloseTo(0.0625, 4);
  });

  it("makes type outside the safe area an error, with the shortfall per edge", () => {
    // With a 0.1875 in inset against a 0.25 in trim radius the safe rectangle's
    // own corners are always inside the card, so a corner overrun can never also
    // cross the trim on these three presets — the error path is the one where
    // the box leaves the safe rectangle outright.
    const doc = makeDoc([textEl("corner", rect(0.14, 0.14, 1.2, 0.22), "OFF THE CARD")]);
    const found = pick(run(doc), "SAFE_AREA_TEXT");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].detail).toMatch(/at the left/);
    expect(found[0].detail).toMatch(/at the top/);
  });

  it("tests a rotated element by its rotated bounds", () => {
    // Upright the type is comfortably inside the safe area; turned 90° about the
    // frame centre it reaches off the top of the card, and only the rotated
    // bounds show that.
    const frame = rect(0.35, 1.0, 3.2, 0.25);
    const upright = run(makeDoc([textEl("r", frame, "ROTATED COPY")]));
    expect(pick(upright, "SAFE_AREA_TEXT")).toHaveLength(0);
    const turned = run(makeDoc([textEl("r", frame, "ROTATED COPY", { rotation: 90_000 })]));
    expect(severityOf(turned, "SAFE_AREA_TEXT")).toBe("error");
  });

  it("flags a barcode outside the safe area", () => {
    const report = run(makeDoc([], [barcodeEl("bc", rect(3.4, 5.0, 1.6, 1.3))]));
    expect(severityOf(report, "SAFE_AREA_BARCODE")).toBe("error");
  });

  it("grades a stray element by how load-bearing it is", () => {
    const decorative = run(makeDoc([shapeEl("d", rect(0.15, 3.0, 0.3, 0.3))]));
    expect(severityOf(decorative, "SAFE_AREA_ELEMENT")).toBe("info");
    const required = run(
      makeDoc([shapeEl("d", rect(0.15, 3.0, 0.3, 0.3), TEXT_BLACK, { required: true })]),
    );
    expect(severityOf(required, "SAFE_AREA_ELEMENT")).toBe("error");
  });
});

describe("preflight — cavity", () => {
  // The clamshell is clear PVC and the card is seen through it, so overlapping
  // the pocket is not by itself a defect — on a 409TF the cavity covers 87 % of
  // the card. What the pocket does is hold the part, which physically covers
  // what is directly behind it, and put a formed wall in a scanner's way.
  it("makes a barcode under the front cavity an error", () => {
    const report = run(
      makeDoc([barcodeEl("bc", rect(1.0, 2.0, 1.469, 1.2), { value: "810797030124" })]),
    );
    const found = pick(report, "CAVITY_CONFLICT");
    expect(found[0].severity).toBe("error");
    expect(found[0].title).toContain("Barcode");
    expect(found[0].measurements?.cavityWIn).toBeCloseTo(CAVITY.w / 72_000_000, 4);
  });

  it("reports covered copy once, for information, rather than per element", () => {
    const report = run(
      makeDoc([
        textEl("t1", rect(1.0, 2.0, 2.0, 0.3), "UNDER THE PART"),
        textEl("t2", rect(1.0, 2.5, 2.0, 0.3), "ALSO UNDER THE PART"),
        textEl("t3", rect(1.0, 3.0, 2.0, 0.3), "AND THIS ONE"),
      ]),
    );
    const found = pick(report, "CAVITY_CONFLICT");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("info");
    expect(found[0].measurements?.elementsCovered).toBe(3);
  });

  it("says nothing about the back, whose clamshell half is flat", () => {
    const report = run(makeDoc([], [textEl("t", rect(1.0, 2.0, 2.0, 0.3), "ON THE BACK")]));
    expect(pick(report, "CAVITY_CONFLICT")).toHaveLength(0);
  });

  it("does not grade a full-bleed background, most of which is bound to overlap", () => {
    const assets = new Map<string, AssetInfo>([asset("bg")]);
    const doc = makeDoc([imageEl("bg-el", CANVAS, "bg", { isBackground: true, fit: "stretch" })]);
    // A background may appear in the informational summary, but it must never be
    // graded as a defect: covering the cavity is what a background is for.
    for (const f of pick(run(doc, { assets }), "CAVITY_CONFLICT")) {
      expect(f.severity).toBe("info");
    }
  });
});

describe("preflight — placed assets", () => {
  it("flags a linked asset that is not available", () => {
    const report = run(makeDoc([imageEl("img", rect(1, 2, 2, 2), "nope")]));
    expect(severityOf(report, "ASSET_MISSING")).toBe("error");
  });

  it("flags an image element with nothing assigned", () => {
    const report = run(makeDoc([imageEl("img", rect(1, 2, 2, 2), null)]));
    expect(severityOf(report, "ASSET_MISSING")).toBe("warning");
  });

  it("grades resolution against the profile and never calls an upscale print-ready", () => {
    const assets = new Map<string, AssetInfo>([
      asset("small", { pixelWidth: 300, pixelHeight: 200 }),
    ]);
    const report = run(makeDoc([imageEl("img", rect(0.7, 0.35, 3.0, 2.0), "small")]), { assets });
    const dpi = pick(report, "ASSET_LOW_DPI")[0];
    expect(dpi.severity).toBe("error"); // 100 dpi is below the 200 dpi floor.
    expect(dpi.measurements?.effectiveDpi).toBe(100);
    const upscaled = pick(report, "IMAGE_UPSCALED")[0];
    expect(upscaled.severity).toBe("warning");
    expect(upscaled.measurements?.upscalePct).toBe(300);
    expect(upscaled.detail).toContain("not print-ready");
  });

  it("warns rather than errors between the minimum and the floor", () => {
    const assets = new Map<string, AssetInfo>([
      asset("mid", { pixelWidth: 750, pixelHeight: 500 }),
    ]);
    const report = run(makeDoc([imageEl("img", rect(0.7, 0.35, 3.0, 2.0), "mid")]), { assets });
    expect(severityOf(report, "ASSET_LOW_DPI")).toBe("warning");
  });

  it("flags an RGB asset in a CMYK job", () => {
    const assets = new Map<string, AssetInfo>([asset("rgb", { colorSpace: "srgb" })]);
    const report = run(makeDoc([imageEl("img", rect(1, 2, 1, 1.6), "rgb")]), { assets });
    expect(severityOf(report, "ASSET_RGB_IN_CMYK")).toBe("warning");
  });

  it("flags an undeclared colour space at info", () => {
    const assets = new Map<string, AssetInfo>([asset("mystery", { colorSpace: "" })]);
    const report = run(makeDoc([imageEl("img", rect(1, 2, 1, 1.6), "mystery")]), { assets });
    expect(severityOf(report, "ASSET_RGB_IN_CMYK")).toBe("info");
  });

  it("flags a format the PDF writer cannot embed", () => {
    const assets = new Map<string, AssetInfo>([asset("web", { contentType: "image/webp" })]);
    const report = run(makeDoc([imageEl("img", rect(1, 2, 1, 1.6), "web")]), { assets });
    expect(severityOf(report, "ASSET_UNSUPPORTED")).toBe("error");
  });
});

describe("preflight — text and required content", () => {
  it("blocks on overflow and makes the export unavailable", () => {
    const doc = makeDoc([
      textEl(
        "t",
        rect(0.7, 0.35, 1.2, 0.2),
        "This is far more copy than a one-line frame can hold at twelve point, and none of it may be silently clipped.",
      ),
    ]);
    const report = run(doc);
    const found = pick(report, "TEXT_OVERFLOW");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("blocking");
    expect(Number(found[0].measurements?.overflowIn)).toBeGreaterThan(0);
    expect(report.counts.blocking).toBeGreaterThan(0);
    expect(report.exportable).toBe(false);
  });

  it("reports a missing font family", () => {
    const report = run(
      makeDoc([textEl("t", rect(0.7, 0.4, 3, 0.3), "BRANDED", { fontFamily: "Helvetica Neue" })]),
    );
    const found = pick(report, "FONT_MISSING");
    expect(found[0].severity).toBe("error");
    expect(found[0].measurements?.requested).toBe("Helvetica Neue");
  });

  it("blocks when a required text block resolves empty", () => {
    const report = run(
      makeDoc([boundTextEl("t", rect(0.7, 0.4, 3, 0.3), "subtitle", { required: true })]),
      { product: sampleProduct({ subtitle: "" }) },
    );
    expect(severityOf(report, "TEXT_EMPTY_REQUIRED")).toBe("blocking");
    expect(run(makeDoc([])).exportable).toBe(true);
  });

  it("blocks when a required element is switched off, and errors when data hid it", () => {
    const switchedOff = run(
      makeDoc([textEl("t", rect(0.7, 0.4, 3, 0.3), "REQUIRED", { required: true, hidden: true })]),
    );
    expect(severityOf(switchedOff, "HIDDEN_REQUIRED")).toBe("blocking");

    const ruledOut = run(
      makeDoc([
        textEl("t", rect(0.7, 0.4, 3, 0.3), "REQUIRED", {
          required: true,
          visibleWhen: "countryOfOrigin == 'Made in China'",
        }),
      ]),
    );
    expect(severityOf(ruledOut, "HIDDEN_REQUIRED")).toBe("error");
    expect(pick(ruledOut, "HIDDEN_REQUIRED")[0].detail).toContain("visible-when");
  });
});

describe("preflight — variable data", () => {
  it("separates an unknown template path from an empty product field", () => {
    const unknown = run(
      makeDoc([boundTextEl("t", rect(0.7, 0.4, 3, 0.3), "brand.nickname")]),
    );
    expect(severityOf(unknown, "BINDING_UNKNOWN_PATH")).toBe("error");
    expect(pick(unknown, "BINDING_UNKNOWN_PATH")[0].measurements?.path).toBe("brand.nickname");
    // The same path also resolves to nothing; saying so twice would send the
    // operator to populate a field that does not exist.
    expect(pick(unknown, "PRODUCT_FIELD_MISSING")).toHaveLength(0);

    const empty = run(makeDoc([boundTextEl("t", rect(0.7, 0.4, 3, 0.3), "subtitle")]), {
      product: sampleProduct({ subtitle: "" }),
    });
    expect(severityOf(empty, "BINDING_UNRESOLVED")).toBe("error");
  });

  it("reports a field the product record does not carry at all", () => {
    const base = sampleProduct();
    // A product row that predates a catalogued field: the path is known, the
    // value is absent rather than empty. Written through a Record because the
    // context type does not model an absent key.
    const partial = { ...base } as Record<string, unknown>;
    delete partial.subtitle;
    const product = partial as unknown as ProductContext;

    const report = run(makeDoc([boundTextEl("t", rect(0.7, 0.4, 3, 0.3), "subtitle")]), {
      product,
    });
    expect(severityOf(report, "PRODUCT_FIELD_MISSING")).toBe("error");
    expect(pick(report, "PRODUCT_FIELD_MISSING")[0].measurements?.path).toBe("subtitle");
  });

  it("blocks when a pack-contents list drops rows", () => {
    const report = run(makeDoc([bomEl("bom", rect(0.7, 0.35, 3.0, 0.5), { maxItems: 2 })]));
    const found = pick(report, "BOM_OVERFLOW").find((f) => f.title.includes("dropped"));
    expect(found?.severity).toBe("blocking");
    expect(found?.measurements?.droppedRows).toBe(2);
    expect(report.exportable).toBe(false);
  });

  it("blocks when a pack-contents list cannot fit its frame", () => {
    const report = run(
      makeDoc([
        bomEl("bom", rect(0.7, 0.35, 1.0, 0.25), {
          autoFit: { mode: "none", minFontSize: 6_000_000 },
        }),
      ]),
    );
    const found = pick(report, "BOM_OVERFLOW").find((f) => f.title.includes("does not fit"));
    expect(found?.severity).toBe("blocking");
  });

  it("reports an empty pack-contents block", () => {
    const product = sampleProduct();
    const report = run(makeDoc([bomEl("bom", rect(0.7, 0.35, 3.0, 0.4))]), {
      product: { ...product, bom: { items: [], packIncludes: "", itemCount: 0 } },
    });
    expect(severityOf(report, "BOM_EMPTY")).toBe("warning");
  });
});

describe("preflight — barcodes", () => {
  it("blocks a GTIN with a wrong check digit and names the correct one", () => {
    const report = run(
      makeDoc([], [barcodeEl("bc", rect(1.5, 5.0, 1.6, 1.3), { value: BAD_CHECK_DIGIT_UPC })]),
    );
    const found = pick(report, "GTIN_INVALID")[0];
    expect(found.severity).toBe("blocking");
    expect(found.title).toContain("UPC-A");
    expect(found.measurements?.expectedCheckDigit).toBe(5);
    expect(found.detail).toContain("check digit");
    expect(report.exportable).toBe(false);
  });

  it("blocks a barcode with no value", () => {
    const report = run(makeDoc([], [barcodeEl("bc", rect(1.5, 5.0, 1.6, 1.3), { value: "" })]));
    expect(severityOf(report, "GTIN_MISSING")).toBe("blocking");
  });

  it("blocks a non-GTIN symbology that cannot encode its value", () => {
    const report = run(
      makeDoc([], [barcodeEl("bc", rect(1.5, 5.0, 1.6, 1.3), { symbology: "qr", value: "" })]),
    );
    expect(severityOf(report, "BARCODE_VALUE_INVALID")).toBe("blocking");
  });

  it("catches dark artwork intruding into the quiet zone", () => {
    // The intruder sits in the left quiet zone only: it never touches a bar, and
    // it is still an error because a scanner reads it as one.
    const doc = makeDoc(
      [],
      [
        barcodeEl("bc", rect(1.5, 4.0, 1.6, 1.3)),
        shapeEl("blocker", rect(1.45, 4.1, 0.09, 0.5)),
      ],
    );
    const report = run(doc);
    const found = pick(report, "BARCODE_QUIET_ZONE");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].measurements?.intruder).toBe("Rectangle");
    expect(Number(found[0].measurements?.contrast)).toBeLessThan(700);
  });

  it("accepts a light panel behind the symbol", () => {
    const doc = makeDoc(
      [],
      [
        shapeEl("panel", rect(1.4, 3.9, 1.8, 1.5), cmykPct(0, 0, 0, 0)),
        barcodeEl("bc", rect(1.5, 4.0, 1.6, 1.3)),
      ],
    );
    expect(pick(run(doc), "BARCODE_QUIET_ZONE")).toHaveLength(0);
  });

  it("flags magnification outside the profile's bounds", () => {
    const profile = PreflightProfileSchema.parse({ barcodeMinMagnificationBps: 12_000 });
    const report = run(makeDoc([], [barcodeEl("bc", rect(1.5, 5.0, 1.6, 1.3))]), { profile });
    const found = pick(report, "BARCODE_SIZE")[0];
    expect(found.severity).toBe("error");
    expect(found.measurements?.magnificationBps).toBe(10_000);
    expect(found.measurements?.minWidthIn).toBeGreaterThan(0);
  });

  it("flags bars that cannot be read, and says the number is an ink proxy", () => {
    const report = run(
      makeDoc([
        barcodeEl("bc", rect(1.5, 0.35, 1.6, 1.3), { barColor: cmykPct(0, 0, 100, 0) }),
      ]),
    );
    const found = pick(report, "BARCODE_CONTRAST");
    const contrast = found.find((f) => f.title.includes("contrast is"));
    expect(contrast?.severity).toBe("error");
    expect(contrast?.detail).toContain("ink-value proxy");
    expect(contrast?.detail).toContain("ISO/IEC 15416");
    expect(found.some((f) => f.title.includes("more than one ink"))).toBe(true);
  });

  it("flags a symbol that runs off the trimmed card", () => {
    const report = run(makeDoc([], [barcodeEl("bc", rect(4.0, 5.0, 1.6, 1.3))]));
    expect(severityOf(report, "BARCODE_CLIPPED")).toBe("error");
  });

  it("flags a symbol larger than its own frame", () => {
    const report = run(makeDoc([], [barcodeEl("bc", rect(1.5, 5.0, 1.0, 0.6))]));
    const found = pick(report, "BARCODE_CLIPPED")[0];
    expect(found.severity).toBe("warning");
    expect(found.title).toContain("larger than its element frame");
  });

  it("flags truncated bar height", () => {
    const report = run(
      makeDoc([], [barcodeEl("bc", rect(1.5, 5.0, 1.6, 1.3), { barHeight: 30_000_000 })]),
    );
    const found = pick(report, "BARCODE_TRUNCATED_HEIGHT")[0];
    expect(found.severity).toBe("warning");
    expect(found.measurements?.barHeightIn).toBeCloseTo(0.4167, 3);
  });
});

describe("preflight — colour", () => {
  it("flags colour ink on a grayscale back and softens it when the template allows colour", () => {
    const strict = run(
      makeDoc([], [textEl("t", rect(0.7, 0.4, 3, 0.3), "COLOUR", { color: cmykPct(80, 0, 0, 0) })]),
    );
    expect(severityOf(strict, "GRAYSCALE_VIOLATION")).toBe("error");

    const permitted = run(
      makeDoc([], [textEl("t", rect(0.7, 0.4, 3, 0.3), "COLOUR", { color: cmykPct(80, 0, 0, 0) })], {
        back: { allowColorOverride: true },
      }),
    );
    expect(severityOf(permitted, "GRAYSCALE_VIOLATION")).toBe("warning");
  });

  it("flags a recipe over the ink limit", () => {
    const report = run(
      makeDoc([shapeEl("blob", rect(1.0, 0.4, 1.0, 0.4), cmykPct(90, 90, 90, 90))]),
    );
    const found = pick(report, "INK_LIMIT")[0];
    expect(found.severity).toBe("error");
    expect(found.measurements?.totalAreaCoverage).toBe(3_600);
    expect(found.measurements?.overBy).toBe(600);
  });

  it("flags small type set in rich black", () => {
    const report = run(
      makeDoc([
        textEl("t", rect(0.7, 0.4, 3, 0.3), "SMALL PRINT", {
          fontSize: 8_000_000,
          color: DEFAULT_RICH_BLACK,
        }),
      ]),
    );
    const found = pick(report, "RICH_BLACK_SMALL_TEXT")[0];
    expect(found.severity).toBe("warning");
    expect(found.measurements?.fontSizePt).toBe(8);
  });

  it("flags live transparency", () => {
    const report = run(
      makeDoc([shapeEl("ghost", rect(1.0, 0.4, 1.0, 0.4), TEXT_BLACK, { opacity: 4_000 })]),
    );
    expect(severityOf(report, "TRANSPARENCY_PRESENT")).toBe("warning");
    expect(pick(report, "TRANSPARENCY_PRESENT")[0].measurements?.opacityBps).toBe(4_000);
  });

  it("says plainly that a spot colour is converted", () => {
    const spot: PrintColor = {
      space: "spot",
      name: "PMS 300 C",
      alternate: cmykPct(100, 44, 0, 0),
      tint: 1_000,
    };
    const report = run(makeDoc([shapeEl("brandbar", rect(1.0, 0.4, 1.0, 0.4), spot)]));
    const found = pick(report, "SPOT_CONVERTED")[0];
    expect(found.severity).toBe("info");
    expect(found.detail).toContain("Separation colour space");
  });

  it("says once, honestly, that there is no output intent", () => {
    const report = run(cleanDoc());
    const found = pick(report, "OUTPUT_INTENT_MISSING");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("info");
    expect(found[0].detail).toContain("PDF/X");
  });

  it("stays quiet when the deployment supplies a profile", () => {
    const intent = OutputIntentSchema.parse({
      identifier: "FOGRA51",
      conditionName: "PSO Coated v3",
      iccBase64: "AAAA",
    });
    expect(pick(run(cleanDoc(), { outputIntent: intent }), "OUTPUT_INTENT_MISSING")).toHaveLength(0);
  });
});

describe("preflight — report shape", () => {
  it("honours a profile that treats errors as blocking", () => {
    const doc = makeDoc([textEl("t", rect(0.15, 3.0, 2.0, 0.3), "OUTSIDE SAFE")]);
    const lenient = run(doc);
    expect(lenient.counts.error).toBeGreaterThan(0);
    expect(lenient.exportable).toBe(true);

    const strict = run(doc, {
      profile: PreflightProfileSchema.parse({ treatErrorAsBlocking: true }),
    });
    expect(strict.exportable).toBe(false);
  });

  it("records the profile it ran under", () => {
    const profile = PreflightProfileSchema.parse({ name: "Web offset, uncoated" });
    expect(run(cleanDoc(), { profile }).profileName).toBe("Web offset, uncoated");
  });

  it("counts every finding it returns", () => {
    const report = run(
      makeDoc([textEl("t", rect(1.0, 2.0, 2.0, 0.3), "UNDER THE CAVITY")]),
    );
    const total =
      report.counts.info + report.counts.warning + report.counts.error + report.counts.blocking;
    expect(total).toBe(report.findings.length);
    expect(codes(report).length).toBe(report.findings.length);
  });
});

/* --------------------------------------------------------------------------
 * Regressions found by the adversarial review. Each of these fired — or failed
 * to fire — on artwork that was correct, which is the failure mode that trains
 * an operator to stop reading the panel.
 * ------------------------------------------------------------------------ */

describe("preflight — regressions", () => {
  /**
   * `symbolBox` is the symbol box less the render's quiet zones, and for UPC-A
   * the engine reports quietTop = quietBottom = 0 while the symbol's height
   * includes the human-readable band. Treating that box as "the bars" made a
   * caption sitting in the HRI band an error claiming it "changes the widths the
   * scanner measures". It fired on this application's own master template.
   */
  describe("barcode quiet zone is measured from the bars, not the whole symbol box", () => {
    const symbol = () =>
      barcodeEl("bc", rect(1.2, 4.0, 1.6, 1.4), { value: VALID_UPC });

    it("leaves a caption in the human-readable band alone", () => {
      // The bars end 0.11 in above the bottom of the symbol box; this caption's
      // ink sits in that band, below every bar and beside the check digit.
      const caption = textEl("cap", rect(1.3, 5.09, 1.2, 0.09), "0 12345 67890 5", {
        fontSize: 6_000_000,
      });
      const doc = makeDoc([], [symbol(), caption]);

      const plan = planDocument({ doc, product: sampleProduct(), assets: new Map() }).back;
      const bars = plan.ops[0];
      const cap = plan.ops[1];
      if (bars.op !== "barcode" || !bars.render || cap.op !== "text") throw new Error("fixture");
      const barsBottom = bars.quietBox.y + Math.max(...bars.render.bars.map((b) => b.y + b.h));
      // The fixture only proves anything if the caption is genuinely below the
      // bars and genuinely inside the symbol box the old test region used.
      expect(cap.inkBounds.y).toBeGreaterThan(barsBottom);
      expect(cap.inkBounds.y).toBeLessThan(bars.symbolBox.y + bars.symbolBox.h);

      expect(pick(run(doc), "BARCODE_QUIET_ZONE")).toEqual([]);
    });

    it("still catches a block painted over the bars themselves", () => {
      const over = shapeEl("ov", rect(1.5, 4.3, 0.4, 0.3));
      const found = pick(run(makeDoc([], [symbol(), over])), "BARCODE_QUIET_ZONE");
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe("error");
      expect(found[0].title).toContain("over the bars");
    });

    it("still catches dark artwork in the left quiet zone at bar height", () => {
      const blocker = shapeEl("bl", rect(1.15, 4.2, 0.08, 0.5));
      expect(severityOf(run(makeDoc([], [symbol(), blocker])), "BARCODE_QUIET_ZONE")).toBe("error");
    });

    it("says nothing about dark artwork below the human-readable band", () => {
      const footer = shapeEl("ft", rect(1.2, 5.45, 1.4, 0.1));
      expect(pick(run(makeDoc([], [symbol(), footer])), "BARCODE_QUIET_ZONE")).toEqual([]);
    });

    it("measures the bar band, not the symbol box", () => {
      const doc = makeDoc([], [symbol()]);
      const plan = planDocument({ doc, product: sampleProduct(), assets: new Map() }).back;
      const op = plan.ops[0];
      expect(op.op).toBe("barcode");
      if (op.op !== "barcode" || !op.render) throw new Error("no symbol");
      // The gap the old test region wrongly claimed as bars.
      const barsBottom = Math.max(...op.render.bars.map((b) => b.y + b.h));
      expect(op.render.quietTop).toBe(0);
      expect(op.render.quietBottom).toBe(0);
      expect(op.quietBox.h - barsBottom).toBeGreaterThan(0);
    });
  });

  /**
   * `hideWhenEmpty` is a documented feature (§10). Every time it worked, the
   * binding recorded EMPTY_VALUE and preflight graded it an error, so a template
   * could not use conditional visibility without failing its own preflight.
   */
  describe("an element hidden by design is not a defect", () => {
    const hidden = () =>
      TextElementSchema.parse({
        id: "opt",
        kind: "text",
        frame: rect(0.6, 1.0, 2, 0.3),
        fontSize: 12_000_000,
        paragraphs: [{ runs: [{ text: "", binding: { path: "subtitle", hideWhenEmpty: true } }] }],
      }) as DesignElement;

    it("reports hide-when-empty at info, not error", () => {
      const report = run(makeDoc([hidden(), textEl("keep", rect(0.6, 0.4, 2, 0.3), "KEEP")]), {
        product: sampleProduct({ subtitle: "" }),
      });
      const found = pick(report, "BINDING_UNRESOLVED");
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe("info");
      expect(found[0].measurements?.hiddenReason).toBe("empty-binding");
      expect(report.counts.error).toBe(0);
      expect(report.exportable).toBe(true);
    });

    it("still errors when the same field is empty on an element that does print", () => {
      const showing = boundTextEl("shown", rect(0.6, 1.0, 2, 0.3), "subtitle");
      const report = run(makeDoc([showing, textEl("keep", rect(0.6, 0.4, 2, 0.3), "KEEP")]), {
        product: sampleProduct({ subtitle: "" }),
      });
      expect(severityOf(report, "BINDING_UNRESOLVED")).toBe("error");
    });
  });

  /**
   * Both of these thresholds exist in two places. Reading only one made the
   * other a control that silently did nothing — and the organisation's total
   * area coverage limit is the one the seed writes into org settings.
   */
  describe("duplicated thresholds are both honoured", () => {
    it("enforces the organisation's total ink limit when it is tighter than the profile's", () => {
      const doc = makeDoc([shapeEl("blob", rect(1.0, 0.4, 1.0, 0.4), cmykPct(70, 60, 60, 80))]);
      // 270 % — under the profile's 300 %, over the organisation's 240 %.
      expect(pick(run(doc), "INK_LIMIT")).toEqual([]);
      const strict = run(doc, {
        blackRules: BlackRulesSchema.parse({ totalAreaCoverageLimit: 2_400 }),
      });
      const found = pick(strict, "INK_LIMIT");
      expect(found).toHaveLength(1);
      expect(found[0].measurements?.limit).toBe(2_400);
      expect(found[0].detail).toContain("black rules");
    });

    it("enforces the profile's rich-black size threshold when it is stricter", () => {
      const doc = makeDoc([
        textEl("t", rect(0.6, 1.0, 3, 0.3), "BIG RICH BLACK", {
          fontSize: 20_000_000,
          color: DEFAULT_RICH_BLACK,
        }),
      ]);
      expect(pick(run(doc), "RICH_BLACK_SMALL_TEXT")).toEqual([]);
      const strict = run(doc, {
        profile: PreflightProfileSchema.parse({ richBlackMinTextSize: 30_000_000 }),
      });
      const found = pick(strict, "RICH_BLACK_SMALL_TEXT");
      expect(found).toHaveLength(1);
      expect(found[0].measurements?.minimumPt).toBe(30);
    });
  });

  /**
   * `custom.*` and `translations.*` are open record maps on ProductContext, and
   * `isBindablePath()` exists to let a template bind into them. Reporting them as
   * BINDING_UNKNOWN_PATH told the operator "nothing will ever resolve there for
   * any product" — false — and sent them to fix a template that was correct. It
   * fired four times per card on the shipped master template.
   */
  describe("free-form namespaces are product data, not template typos", () => {
    it("reports a missing translation against the product record", () => {
      const el = boundTextEl("ml", rect(0.6, 1.0, 3, 0.3), "translations.es.productName");
      const report = run(makeDoc([el, textEl("keep", rect(0.6, 0.4, 2, 0.3), "KEEP")]));
      expect(pick(report, "BINDING_UNKNOWN_PATH")).toEqual([]);
      const found = pick(report, "PRODUCT_FIELD_MISSING");
      expect(found).toHaveLength(1);
      expect(found[0].measurements?.namespace).toBe("translations.");
      expect(found[0].detail).not.toContain("Nothing will ever resolve");
    });

    it("resolves the same path for a product that carries it", () => {
      const el = boundTextEl("ml", rect(0.6, 1.0, 3, 0.3), "translations.es.productName");
      const report = run(makeDoc([el]), {
        product: sampleProduct({ translations: { es: { productName: "JUEGO DE COJINETES" } } }),
      });
      expect(pick(report, "PRODUCT_FIELD_MISSING")).toEqual([]);
      expect(pick(report, "BINDING_UNKNOWN_PATH")).toEqual([]);
    });

    it("still calls a path under a closed object an unknown path", () => {
      const el = boundTextEl("bn", rect(0.6, 1.0, 3, 0.3), "brand.nickname");
      const report = run(makeDoc([el, textEl("keep", rect(0.6, 0.4, 2, 0.3), "KEEP")]));
      expect(severityOf(report, "BINDING_UNKNOWN_PATH")).toBe("error");
      expect(pick(report, "PRODUCT_FIELD_MISSING")).toEqual([]);
    });
  });

  /** A run set in `none` puts nothing on a plate, whatever its span count says. */
  it("does not count text with no printing colour as content", () => {
    const invisible = textEl("t", rect(1, 1, 2, 0.3), "INVISIBLE", {
      color: { space: "none" },
    });
    expect(severityOf(run(makeDoc([invisible])), "DOC_EMPTY_SIDE")).toBe("error");
  });

  /** The report is stored and compared; only `ranAt` may differ between runs. */
  it("returns identical findings for identical input", () => {
    const doc = makeDoc([textEl("t", rect(0.15, 3, 2, 0.3), "OUTSIDE SAFE")]);
    expect(JSON.stringify(run(doc).findings)).toBe(JSON.stringify(run(doc).findings));
  });
});
