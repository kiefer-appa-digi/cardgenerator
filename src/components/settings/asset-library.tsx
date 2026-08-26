"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Upload } from "lucide-react";
import { Panel, Badge, EmptyState } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { ErrorNote, OkNote } from "@/components/settings/field";
import { deleteAssetAction, uploadAssetAction } from "@/server/assets";
import { cn } from "@/lib/cn";

/**
 * The asset library (spec §8).
 *
 * Every fact shown here was measured from the file at upload — pixel
 * dimensions, the resolution the file declares, its colour space, whether it
 * carries an ICC profile — because preflight computes effective DPI from those
 * numbers at placed size. Nothing is inferred from the filename.
 */

export type AssetRow = {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  pixelWidth: number | null;
  pixelHeight: number | null;
  declaredDpi: number | null;
  colorSpace: string;
  hasAlpha: boolean;
  hasIccProfile: boolean;
  iccProfileName: string;
  scanStatus: string;
  scanDetail: string;
  createdAt: string;
  uploadedBy: string;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const SCAN_TONE: Record<string, "ok" | "info" | "danger" | "neutral"> = {
  clean: "ok",
  pending: "info",
  flagged: "danger",
  skipped: "neutral",
};

function isRaster(contentType: string): boolean {
  return contentType.startsWith("image/");
}

export function AssetLibrary({
  assets,
  canUpload,
}: {
  assets: AssetRow[];
  canUpload: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const upload = (file: File) => {
    setError(null);
    setNotice(null);
    const data = new FormData();
    data.set("file", file);
    start(async () => {
      const res = await uploadAssetAction(data);
      if (res.ok) {
        setNotice(`${res.asset.filename} was added.`);
        router.refresh();
      } else setError(res.error);
    });
  };

  const remove = (id: string) => {
    setError(null);
    setNotice(null);
    start(async () => {
      const res = await deleteAssetAction(id);
      if (res.ok) {
        setConfirmId(null);
        router.refresh();
      } else setError(res.error);
    });
  };

  return (
    <div className="space-y-6">
      {canUpload ? (
        <Panel title="Add artwork" description="PNG, JPEG, TIFF, SVG or PDF, up to 60 MB.">
          <div className="p-4">
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const f = e.dataTransfer.files?.[0];
                if (f) upload(f);
              }}
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center rounded-panel border-2 border-dashed px-6 py-10 text-center transition-colors",
                dragging ? "border-brand-500 bg-brand-600/10" : "border-ink-700 hover:border-ink-600",
              )}
            >
              <Upload size={20} className="mb-2 text-ink-400" aria-hidden />
              <span className="text-sm font-medium text-ink-100">
                {pending ? "Reading file…" : "Drop artwork here, or browse"}
              </span>
              <span className="mt-1 text-[11px] leading-relaxed text-ink-500">
                The file type is decided from the file&rsquo;s own bytes, not its name or the
                browser&rsquo;s content type. SVGs carrying script or external references are
                refused.
              </span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/tiff,image/svg+xml,image/webp,application/pdf"
                className="sr-only"
                disabled={pending}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload(f);
                }}
              />
            </label>
            {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
            {notice ? <div className="mt-3"><OkNote>{notice}</OkNote></div> : null}
          </div>
        </Panel>
      ) : null}

      <Panel
        title="Library"
        description="Measured at upload. Preflight computes effective resolution from these numbers at the size the artwork is placed."
      >
        {assets.length === 0 ? (
          <EmptyState
            title="No assets yet"
            description={
              canUpload
                ? "Upload the brand marks and product photography the templates place. Anything you add here is available to every card in the organisation."
                : "Nothing has been uploaded yet. A designer or an admin can add artwork here."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-800 text-left text-[11px] uppercase tracking-wider text-ink-400">
                  <th scope="col" className="px-4 py-2 font-medium">
                    <span className="sr-only">Preview</span>
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    File
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Pixels
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Declared DPI
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Colour
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Scan
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Size
                  </th>
                  <th scope="col" className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <tr key={a.id} className="border-b border-ink-800/60 last:border-0">
                    <td className="px-4 py-2">
                      <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded border border-ink-800 bg-[#6e6e6e]">
                        {isRaster(a.contentType) ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={`/api/assets/${a.id}`}
                            alt=""
                            className="max-h-10 max-w-10 object-contain"
                          />
                        ) : (
                          <FileText size={16} className="text-ink-700" aria-hidden />
                        )}
                      </div>
                    </td>
                    <th scope="row" className="px-4 py-2 text-left font-normal">
                      <div className="max-w-64 truncate text-[13px] text-ink-100">{a.filename}</div>
                      <div className="text-[11px] text-ink-500">
                        {a.contentType} · {new Date(a.createdAt).toLocaleDateString()}
                        {a.uploadedBy ? ` · ${a.uploadedBy}` : ""}
                      </div>
                    </th>
                    <td className="numeric px-4 py-2 text-[12px] text-ink-300">
                      {a.pixelWidth && a.pixelHeight ? (
                        `${a.pixelWidth} × ${a.pixelHeight}`
                      ) : (
                        <span className="text-ink-600">vector</span>
                      )}
                    </td>
                    <td className="numeric px-4 py-2 text-[12px] text-ink-300">
                      {a.declaredDpi ?? <span className="text-ink-600">none</span>}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap items-center gap-1">
                        <Badge tone={a.colorSpace === "cmyk" ? "ok" : "neutral"}>
                          {a.colorSpace}
                        </Badge>
                        {a.hasIccProfile ? (
                          <Badge tone="info" className="normal-case">
                            ICC
                          </Badge>
                        ) : null}
                        {a.hasAlpha ? <Badge tone="warning">alpha</Badge> : null}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <Badge tone={SCAN_TONE[a.scanStatus] ?? "neutral"}>{a.scanStatus}</Badge>
                    </td>
                    <td className="numeric px-4 py-2 text-right text-[12px] text-ink-400">
                      {formatBytes(a.byteSize)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {canUpload ? (
                        confirmId === a.id ? (
                          <span className="flex items-center justify-end gap-1.5">
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={pending}
                              onClick={() => remove(a.id)}
                            >
                              Delete
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>
                              Cancel
                            </Button>
                          </span>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => setConfirmId(a.id)}>
                            Delete
                          </Button>
                        )
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {assets.some((a) => a.scanStatus === "skipped") ? (
          <p className="border-t border-ink-800 px-4 py-3 text-[11px] leading-relaxed text-ink-500">
            No malware scanner is wired up in this deployment, so uploads are recorded as
            &ldquo;skipped&rdquo; rather than claiming a clean result nobody produced. The scanning
            hook exists; connecting a scanner is a deployment step.
          </p>
        ) : null}
      </Panel>
    </div>
  );
}
