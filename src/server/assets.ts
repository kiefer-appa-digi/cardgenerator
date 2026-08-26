"use server";

import sharp from "sharp";
import { nanoid } from "nanoid";
import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { assets, db } from "@/server/db";
import { assertSameOrg, requireCapability, requireUser } from "@/server/auth/current";
import { audit } from "@/server/audit";
import { putAsset, deleteAsset } from "@/server/storage";

/**
 * Asset upload (spec §8, §25).
 *
 * MIME is decided from the file's own magic bytes, not from the browser's
 * `type`, because that header is attacker-controlled. Raster metadata —
 * dimensions, declared resolution, colour space, ICC presence — is extracted at
 * upload so the preflight engine can compute an honest effective DPI later
 * instead of guessing.
 */

const MAX_BYTES = 60 * 1024 * 1024;

type Sniffed = { contentType: string; kind: "raster" | "vector" | "pdf" } | null;

function sniff(bytes: Uint8Array, filename: string): Sniffed {
  const b = bytes;
  const startsWith = (sig: number[], offset = 0) =>
    sig.every((v, i) => b[offset + i] === v);

  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { contentType: "image/png", kind: "raster" };
  if (startsWith([0xff, 0xd8, 0xff])) return { contentType: "image/jpeg", kind: "raster" };
  if (startsWith([0x49, 0x49, 0x2a, 0x00]) || startsWith([0x4d, 0x4d, 0x00, 0x2a]))
    return { contentType: "image/tiff", kind: "raster" };
  if (startsWith([0x25, 0x50, 0x44, 0x46])) return { contentType: "application/pdf", kind: "pdf" };
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8))
    return { contentType: "image/webp", kind: "raster" };

  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(b.subarray(0, 512))
    .trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) {
    if (/<svg[\s>]/i.test(head) || /\.svg$/i.test(filename)) {
      return { contentType: "image/svg+xml", kind: "vector" };
    }
  }
  return null;
}

/**
 * SVG is accepted because packaging artwork is frequently vector, but an SVG is
 * a document that can carry script and external references. It is only ever
 * rendered inside an <img>, which blocks both, and these patterns are rejected
 * outright so a hostile file never reaches storage.
 */
function svgIsSafe(bytes: Uint8Array): { ok: true } | { ok: false; reason: string } {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (/<script[\s>]/i.test(text)) return { ok: false, reason: "it contains a <script> element" };
  if (/\son\w+\s*=/i.test(text)) return { ok: false, reason: "it contains inline event handlers" };
  if (/<foreignObject[\s>]/i.test(text))
    return { ok: false, reason: "it contains a <foreignObject> element" };
  if (/(href|xlink:href)\s*=\s*["']\s*(javascript|data:text\/html)/i.test(text))
    return { ok: false, reason: "it contains a scripted link" };
  if (/<!ENTITY/i.test(text)) return { ok: false, reason: "it declares XML entities" };
  return { ok: true };
}

export async function uploadAssetAction(formData: FormData) {
  const user = await requireCapability("asset.upload");
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false as const, error: "No file was uploaded." };
  if (file.size > MAX_BYTES) {
    return { ok: false as const, error: `Files must be ${MAX_BYTES / 1024 / 1024} MB or smaller.` };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniff(bytes, file.name);
  if (!sniffed) {
    return {
      ok: false as const,
      error: "That file type is not supported. Upload PNG, JPEG, TIFF, SVG or PDF artwork.",
    };
  }
  if (sniffed.contentType === "image/svg+xml") {
    const safe = svgIsSafe(bytes);
    if (!safe.ok) {
      return { ok: false as const, error: `That SVG was rejected because ${safe.reason}.` };
    }
  }

  let pixelWidth: number | null = null;
  let pixelHeight: number | null = null;
  let declaredDpi: number | null = null;
  let colorSpace = "unknown";
  let hasAlpha = false;
  let hasIcc = false;
  let iccName = "";

  if (sniffed.kind === "raster") {
    try {
      const meta = await sharp(Buffer.from(bytes)).metadata();
      pixelWidth = meta.width ?? null;
      pixelHeight = meta.height ?? null;
      declaredDpi = meta.density ?? null;
      colorSpace = meta.space ?? "unknown";
      hasAlpha = Boolean(meta.hasAlpha);
      hasIcc = Boolean(meta.icc);
      iccName = meta.icc ? `embedded (${meta.icc.length} bytes)` : "";
    } catch (e) {
      return {
        ok: false as const,
        error: `That image could not be decoded: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  const stored = await putAsset(user.orgId, file.name, bytes, sniffed.contentType);

  const id = nanoid(24);
  await db.insert(assets).values({
    id,
    orgId: user.orgId,
    uploadedBy: user.id,
    filename: file.name,
    contentType: sniffed.contentType,
    byteSize: bytes.byteLength,
    storageKey: stored.key,
    storageUrl: stored.url,
    pixelWidth,
    pixelHeight,
    declaredDpi,
    colorSpace,
    hasAlpha,
    hasIccProfile: hasIcc,
    iccProfileName: iccName,
    sha256: stored.sha256,
    // The malware-scanning hook the spec asks for. No scanner is wired up in
    // this deployment, so the state is recorded as "skipped" rather than
    // claiming a clean result nobody produced.
    scanStatus: "skipped",
    scanDetail: "No malware scanner is configured for this deployment.",
  });

  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: "asset.upload",
    entityType: "asset",
    entityId: id,
    detail: { filename: file.name, bytes: bytes.byteLength, contentType: sniffed.contentType },
  });

  revalidatePath("/settings/assets");
  return {
    ok: true as const,
    asset: {
      id,
      filename: file.name,
      contentType: sniffed.contentType,
      pixelWidth,
      pixelHeight,
      declaredDpi,
      colorSpace,
    },
  };
}

export async function listAssetsAction() {
  const user = await requireUser();
  return db
    .select()
    .from(assets)
    .where(eq(assets.orgId, user.orgId))
    .orderBy(desc(assets.createdAt))
    .limit(500);
}

export async function deleteAssetAction(assetId: string) {
  const user = await requireCapability("asset.upload");
  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.orgId, user.orgId)))
    .limit(1);
  if (!asset) return { ok: false as const, error: "Asset not found." };
  assertSameOrg(user, asset.orgId);

  await deleteAsset(asset.storageUrl || asset.storageKey);
  await db.delete(assets).where(eq(assets.id, assetId));
  await audit({
    orgId: user.orgId,
    userId: user.id,
    action: "asset.delete",
    entityType: "asset",
    entityId: assetId,
    detail: { filename: asset.filename },
  });
  revalidatePath("/settings/assets");
  return { ok: true as const };
}
