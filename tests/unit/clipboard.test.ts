import { describe, expect, it } from "vitest";
import { nanoid } from "nanoid";
import { inToUpt } from "@/lib/units";
import { ShapeElementSchema, GroupElementSchema, type DesignElement } from "@/lib/design/schema";
import { decodeClipboard, encodeClipboard, rekeyForPaste } from "@/lib/editor/clipboard";

const shape = (id: string, x: number): DesignElement =>
  ShapeElementSchema.parse({
    id,
    kind: "shape",
    shape: "rect",
    frame: { x: inToUpt(x), y: inToUpt(1), w: inToUpt(1), h: inToUpt(1) },
  });

describe("editor clipboard", () => {
  it("round-trips validated elements", () => {
    const text = encodeClipboard([shape("a", 1), shape("b", 2)], "409TF", "front");
    const back = decodeClipboard(text);
    expect(back?.elements).toHaveLength(2);
    expect(back?.presetCode).toBe("409TF");
  });

  it("refuses a payload that is not a design document", () => {
    expect(decodeClipboard("hello")).toBeNull();
    expect(decodeClipboard(JSON.stringify({ kind: "something/else" }))).toBeNull();
    // Right envelope, element that does not validate.
    expect(
      decodeClipboard(
        JSON.stringify({
          kind: "freedom-card-designer/elements@1",
          presetCode: "409TF",
          side: "front",
          elements: [{ id: "x", kind: "shape", frame: { x: 0, y: 0, w: -5, h: 1 } }],
        }),
      ),
    ).toBeNull();
  });

  it("gives every pasted element a new id and offsets the set", () => {
    const src = [shape("a", 1), shape("b", 2)];
    const out = rekeyForPaste(src, inToUpt(0.01), () => nanoid(12));
    expect(out.map((e) => e.id)).not.toEqual(["a", "b"]);
    expect(new Set(out.map((e) => e.id)).size).toBe(2);
    expect(out[0].frame.x).toBe(inToUpt(1.01));
    expect(out[1].frame.x).toBe(inToUpt(2.01));
  });

  it("keeps a group pointing at its own copied children, not the originals", () => {
    const group = GroupElementSchema.parse({
      id: "g1",
      kind: "group",
      childIds: ["a", "b"],
      frame: { x: 0, y: 0, w: inToUpt(3), h: inToUpt(1) },
    });
    const out = rekeyForPaste(
      [group, { ...shape("a", 1), groupId: "g1" }, { ...shape("b", 2), groupId: "g1" }],
      0,
      () => nanoid(12),
    );
    const pastedGroup = out[0];
    expect(pastedGroup.kind).toBe("group");
    const childIds = pastedGroup.kind === "group" ? pastedGroup.childIds : [];
    expect(childIds).toEqual([out[1].id, out[2].id]);
    expect(out[1].groupId).toBe(pastedGroup.id);
    // And nothing still refers to the originals.
    expect(childIds).not.toContain("a");
  });

  it("pastes twice without the two copies sharing ids", () => {
    const src = [shape("a", 1)];
    const first = rekeyForPaste(src, 0, () => nanoid(12));
    const second = rekeyForPaste(src, 0, () => nanoid(12));
    expect(first[0].id).not.toBe(second[0].id);
  });
});
