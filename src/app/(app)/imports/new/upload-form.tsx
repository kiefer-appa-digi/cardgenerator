"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uploadImportAction } from "@/server/imports";
import {
  ingestAftermarketFromBlobAction,
  uploadAftermarketAction,
} from "@/server/aftermarket-import";
import { upload } from "@vercel/blob/client";
import { cn } from "@/lib/cn";

export function UploadForm({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<string | null>(null);

  // Anything at or above this goes to Blob first: a Server Action body is capped
  // by the platform (4.5 MB on Vercel), and the Aftermarket workbook is 13 MB.
  const DIRECT_UPLOAD_BYTES = 3.5 * 1024 * 1024;

  const submit = (f: File) => {
    setError(null);
    const fd = new FormData();
    fd.set("file", f);
    start(async () => {
      if (f.size >= DIRECT_UPLOAD_BYTES) {
        try {
          setStage("Uploading…");
          // The store is private, so the URL alone never grants a read; the
          // app streams the bytes back through an org-checked route.
          const blob = await upload(`org/${orgId}/upload/${f.name}`, f, {
            access: "private",
            handleUploadUrl: "/api/blob/upload",
            multipart: true,
            onUploadProgress: ({ percentage }) =>
              setStage(`Uploading ${Math.round(percentage)}%`),
          });
          setStage("Reading the workbook…");
          const res = await ingestAftermarketFromBlobAction({
            url: blob.url,
            pathname: blob.pathname,
            filename: f.name,
          });
          if (res.ok) {
            router.push(`/imports/${res.importId}`);
            return;
          }
          setError(res.error);
          setStage(null);
          return;
        } catch (e) {
          setError(
            e instanceof Error
              ? `That file is too large to send through the app and the direct upload failed: ${e.message}`
              : "The upload failed.",
          );
          setStage(null);
          return;
        }
      }
      // Two workbook shapes, told apart by their sheets rather than by asking:
      // a flat product export needs a column mapping, an Aftermarket workbook is
      // block-structured and needs its own reader. Trying the specialised one
      // first costs a parse and saves the operator from mapping a sheet that
      // cannot be mapped.
      const aftermarket = await uploadAftermarketAction(fd);
      if (aftermarket.ok) {
        router.push(`/imports/${aftermarket.importId}`);
        return;
      }
      const res = await uploadImportAction(fd);
      if (res.ok) router.push(`/imports/${res.importId}`);
      else setError(res.error);
    });
  };

  return (
    <div className="p-4">
      <label
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) { setFile(f); submit(f); }
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center rounded-panel border-2 border-dashed px-6 py-12 text-center transition-colors",
          dragging ? "border-brand-500 bg-brand-600/10" : "border-ink-700 hover:border-ink-600",
        )}
      >
        <Upload size={22} className="mb-3 text-ink-400" />
        <span className="text-sm font-medium text-ink-100">
          {stage ?? (pending ? "Reading workbook…" : file ? file.name : "Drop an .xlsx file, or browse")}
        </span>
        <span className="mt-1 text-xs text-ink-500">
          Product export or Aftermarket BOM workbook · up to 40 MB
        </span>
        <input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only"
          disabled={pending}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) { setFile(f); submit(f); }
          }}
        />
      </label>

      {error ? (
        <p role="alert" className="mt-4 rounded-md border border-flag-800 bg-flag-900/30 px-3 py-2 text-sm text-flag-200">
          {error}
        </p>
      ) : null}

      <p className="mt-4 text-xs leading-relaxed text-ink-500">
        The workbook itself is not stored. Its rows are held only until the import
        is committed or cancelled, and the source row for each product is kept on
        the product record for provenance.
      </p>
    </div>
  );
}
