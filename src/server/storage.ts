import { put, del, head, get } from "@vercel/blob";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * ASSET STORAGE
 *
 * Vercel Blob in every deployed environment; a directory under `.data/blob` when
 * `BLOB_READ_WRITE_TOKEN` is absent, so a developer or a CI run can exercise the
 * whole upload → place → export path with no cloud credentials.
 *
 * The Blob store is PRIVATE. Customer packaging artwork must not be readable by
 * anyone who guesses a URL, so nothing is public and every read goes through
 * /api/assets/[id], which checks the requester's organisation before streaming
 * bytes. The storage URL itself never reaches a browser (spec §25).
 */

export type StoredBlob = {
  key: string;
  url: string;
  size: number;
  sha256: string;
};

const LOCAL_ROOT = path.join(process.cwd(), ".data", "blob");

export function storageMode(): "vercel-blob" | "local" {
  return process.env.BLOB_READ_WRITE_TOKEN ? "vercel-blob" : "local";
}

export async function putAsset(
  orgId: string,
  filename: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<StoredBlob> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const safeName = filename.replace(/[^\w.\-]+/g, "_").slice(0, 120);
  const key = `org/${orgId}/${sha256.slice(0, 16)}-${safeName}`;

  if (storageMode() === "vercel-blob") {
    const res = await put(key, Buffer.from(bytes), {
      access: "private",
      contentType,
      // The pathname already carries a content hash, so two uploads of the same
      // bytes collapse onto one blob instead of accumulating copies.
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return { key, url: res.url, size: bytes.byteLength, sha256 };
  }

  const dest = path.join(LOCAL_ROOT, key);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, bytes);
  return {
    key,
    url: `file://${dest}`,
    size: bytes.byteLength,
    sha256,
  };
}

export async function readAsset(keyOrUrl: string): Promise<Uint8Array | null> {
  if (keyOrUrl.startsWith("file://")) {
    try {
      return new Uint8Array(await fs.readFile(keyOrUrl.slice("file://".length)));
    } catch {
      return null;
    }
  }
  if (keyOrUrl.startsWith("http")) {
    // A private blob is not fetchable with a bare GET; the SDK signs the read
    // with the store token, which only ever exists on the server.
    try {
      const res = await get(keyOrUrl, { access: "private" });
      if (!res || res.statusCode !== 200) return null;
      return new Uint8Array(await new Response(res.stream).arrayBuffer());
    } catch {
      return null;
    }
  }
  const dest = path.join(LOCAL_ROOT, keyOrUrl);
  try {
    return new Uint8Array(await fs.readFile(dest));
  } catch {
    return null;
  }
}

export async function deleteAsset(keyOrUrl: string): Promise<void> {
  if (storageMode() === "vercel-blob" && keyOrUrl.startsWith("http")) {
    await del(keyOrUrl);
    return;
  }
  const p = keyOrUrl.startsWith("file://")
    ? keyOrUrl.slice("file://".length)
    : path.join(LOCAL_ROOT, keyOrUrl);
  await fs.rm(p, { force: true });
}

export async function assetExists(url: string): Promise<boolean> {
  if (storageMode() === "vercel-blob" && url.startsWith("http")) {
    try {
      await head(url);
      return true;
    } catch {
      return false;
    }
  }
  const p = url.startsWith("file://") ? url.slice("file://".length) : path.join(LOCAL_ROOT, url);
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
