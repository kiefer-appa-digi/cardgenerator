#!/usr/bin/env -S npx tsx
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CARD_PRESETS } from "@/lib/geometry/presets";
import { inspectPdf } from "@/lib/pdf/inspect";
import {
  expectationForPreset,
  formatValidationReport,
  presetForPageSize,
  validateProductionPdf,
  type ExpectedBarcode,
} from "@/lib/pdf/validate";

/**
 * verify-pdf — check an exported PDF by hand (spec §22).
 *
 * Exists so that a prepress operator, or anyone auditing a released file, can
 * run the exact same checks the export pipeline runs, on a file that arrived by
 * email, without a database or a running app.
 *
 *   npx tsx scripts/verify-pdf.ts out.pdf
 *   npx tsx scripts/verify-pdf.ts out.pdf --preset 206TF --barcode 036000291452
 *   npx tsx scripts/verify-pdf.ts out.pdf --face "Inter:400" --face "Archivo:800"
 *
 * Exits 1 when any check fails, so it can gate a build.
 */

const USAGE = `Usage: npx tsx scripts/verify-pdf.ts <file.pdf> [options]

  --preset <409TF|277TF|206TF>  Card preset. Inferred from the page size when omitted.
  --pages <n>                   Expected page count (default 2: front and back).
  --barcode <digits>            A barcode value that must be present. Repeatable.
  --barcode-no-hri <digits>     Same, for a barcode exported without readable digits.
  --face <faceKey>              A face the plan required, e.g. "Inter:600". Repeatable.
  --min-dpi <n>                 Minimum effective resolution for placed art (default 300).
  --allow-rgb                   Do not fail on RGB colour (non-production files).
  --json                        Print the report as JSON instead of text.
  --help                        Show this message.
`;

type Args = {
  file: string;
  preset: keyof typeof CARD_PRESETS | null;
  pages: number | null;
  barcodes: ExpectedBarcode[];
  faces: string[];
  minDpi: number | null;
  allowRgb: boolean;
  json: boolean;
};

function parseArgs(argv: string[]): Args | "help" | null {
  const args: Args = {
    file: "",
    preset: null,
    pages: null,
    barcodes: [],
    faces: [],
    minDpi: null,
    allowRgb: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    switch (a) {
      case "--help":
      case "-h":
        return "help";
      case "--preset": {
        const v = next();
        if (!(v in CARD_PRESETS)) throw new Error(`unknown preset "${v}"`);
        args.preset = v as keyof typeof CARD_PRESETS;
        break;
      }
      case "--pages":
        args.pages = Number(next());
        break;
      case "--barcode":
        args.barcodes.push({ value: next(), humanReadable: true, page: null });
        break;
      case "--barcode-no-hri":
        args.barcodes.push({ value: next(), humanReadable: false, page: null });
        break;
      case "--face":
        args.faces.push(next());
        break;
      case "--min-dpi":
        args.minDpi = Number(next());
        break;
      case "--allow-rgb":
        args.allowRgb = true;
        break;
      case "--json":
        args.json = true;
        break;
      default:
        if (a.startsWith("-")) throw new Error(`unknown option "${a}"`);
        if (args.file) throw new Error("only one file at a time");
        args.file = a;
    }
  }
  if (!args.file) return null;
  return args;
}

async function main(): Promise<number> {
  let parsed: Args | "help" | null;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed === null) {
    process.stderr.write(`No PDF given.\n\n${USAGE}`);
    return 2;
  }
  const args = parsed;

  const abs = path.resolve(process.cwd(), args.file);
  const bytes = new Uint8Array(await readFile(abs));

  let preset = args.preset;
  if (!preset) {
    // Infer from the first page's MediaBox so the tool is useful on a file that
    // arrived with no job ticket. Reported explicitly — never silently assumed.
    const probe = await inspectPdf(bytes);
    const media = probe.pages[0]?.boxes.mediaBox ?? null;
    preset = media ? presetForPageSize(media.width, media.height) : null;
    if (!preset) {
      process.stderr.write(
        `Could not infer a card preset from the page size ` +
          `(${media ? `${media.width} × ${media.height} pt` : "no MediaBox"}). ` +
          `Pass --preset explicitly.\n`,
      );
      return 2;
    }
    // stderr, so `--json` stdout stays machine-parseable.
    const notice = `Inferred preset ${preset} from the page size.\n`;
    if (args.json) process.stderr.write(notice);
    else process.stdout.write(`${notice}\n`);
  }

  const expectation = expectationForPreset(preset, {
    pageCount: args.pages ?? 2,
    requireCmykOnly: !args.allowRgb,
    requiredFaces: args.faces,
    barcodes: args.barcodes,
    ...(args.minDpi !== null ? { minImageDpi: args.minDpi } : {}),
  });

  const report = await validateProductionPdf(bytes, expectation);
  process.stdout.write(
    args.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatValidationReport(report)}\n`,
  );
  return report.passed ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`verify-pdf failed: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 2;
  },
);
