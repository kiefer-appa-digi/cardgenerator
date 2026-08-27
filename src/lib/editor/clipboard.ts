import { z } from "zod";
import { DesignElementSchema, type DesignElement, type SideKey } from "@/lib/design/schema";

/**
 * EDITOR CLIPBOARD — spec §6, §24.
 *
 * Elements are copied as validated design-document JSON on a private MIME-ish
 * envelope, written to the system clipboard as text. That buys two things:
 * paste works between two cards in two browser tabs, and a pasted payload is
 * re-validated on the way in, so a malformed or hand-edited clipboard cannot put
 * an element the renderer cannot draw into a production document.
 *
 * The system clipboard is not always reachable — Safari without a user gesture,
 * a denied permission, an insecure origin — so an in-memory fallback keeps
 * copy/paste working inside the session regardless.
 */

const ENVELOPE = "freedom-card-designer/elements@1";

export const ClipboardPayloadSchema = z.object({
  kind: z.literal(ENVELOPE),
  presetCode: z.string(),
  side: z.string(),
  elements: z.array(DesignElementSchema),
});
export type ClipboardPayload = z.infer<typeof ClipboardPayloadSchema>;

let memory: string | null = null;

export function encodeClipboard(
  elements: DesignElement[],
  presetCode: string,
  side: SideKey,
): string {
  return JSON.stringify({ kind: ENVELOPE, presetCode, side, elements } satisfies ClipboardPayload);
}

export async function writeElements(
  elements: DesignElement[],
  presetCode: string,
  side: SideKey,
): Promise<void> {
  const text = encodeClipboard(elements, presetCode, side);
  memory = text;
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    // The in-memory copy already succeeded; the system clipboard is a bonus.
  }
}

export function decodeClipboard(text: string): ClipboardPayload | null {
  try {
    const parsed = ClipboardPayloadSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function readElements(): Promise<ClipboardPayload | null> {
  try {
    const text = await navigator.clipboard?.readText();
    const fromSystem = text ? decodeClipboard(text) : null;
    if (fromSystem) return fromSystem;
  } catch {
    // Fall through to the in-session copy.
  }
  return memory ? decodeClipboard(memory) : null;
}

/**
 * Re-issue every id and offset the whole set, so pasting twice gives two
 * distinct sets of elements rather than two references to one.
 */
export function rekeyForPaste(
  elements: DesignElement[],
  offset: number,
  newId: () => string,
): DesignElement[] {
  const map = new Map<string, string>();
  const idFor = (old: string) => {
    if (!map.has(old)) map.set(old, newId());
    return map.get(old)!;
  };
  for (const el of elements) idFor(el.id);
  return elements.map((el) => {
    const base = {
      ...el,
      id: idFor(el.id),
      frame: { ...el.frame, x: el.frame.x + offset, y: el.frame.y + offset },
      groupId: el.groupId ? idFor(el.groupId) : undefined,
    };
    return el.kind === "group"
      ? { ...base, kind: "group" as const, childIds: el.childIds.map(idFor) }
      : base;
  });
}
