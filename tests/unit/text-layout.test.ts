import { describe, expect, it } from "vitest";
import { inToUpt } from "@/lib/units";
import { layoutText } from "@/lib/text/layout";

const run = (text: string) => ({
  text,
  fontFamily: "Inter",
  fontWeight: 400,
  italic: false,
  fontSize: inToUpt(0.1),
  tracking: 0,
  color: { space: "gray" as const, k: 1000 },
});

const opts = {
  maxWidth: inToUpt(4),
  maxHeight: inToUpt(4),
  align: "left" as const,
  lineHeightBps: 12_000,
  transform: "none" as const,
};

describe("text layout — explicit line breaks", () => {
  it("breaks where a newline says to, not where the width runs out", () => {
    // A list joined with "\n" is the shape a bound fitment or pack-contents
    // block arrives in; running the entries together reads as one sentence.
    const r = layoutText([{ runs: [run("Fits Dexter\nReplaces AL-KO\nHayes")] }], opts);
    expect(r.lines).toHaveLength(3);
    expect(r.lines.map((l) => l.spans.map((s) => s.text).join(""))).toEqual([
      "Fits Dexter",
      "Replaces AL-KO",
      "Hayes",
    ]);
  });

  it("keeps a blank line blank", () => {
    const r = layoutText([{ runs: [run("one\n\ntwo")] }], opts);
    expect(r.lines).toHaveLength(3);
    expect(r.lines[1].spans.map((s) => s.text).join("")).toBe("");
  });

  it("does not invent a trailing line for text that ends without a newline", () => {
    expect(layoutText([{ runs: [run("just one line")] }], opts).lines).toHaveLength(1);
  });

  it("still wraps a long line that has no newline in it", () => {
    const long = "Fits 3,500 lb trailer axles with 1-1/16 in and 1-3/8 in spindles and more besides";
    const r = layoutText([{ runs: [run(long)] }], { ...opts, maxWidth: inToUpt(1.5) });
    expect(r.lines.length).toBeGreaterThan(2);
  });
});
