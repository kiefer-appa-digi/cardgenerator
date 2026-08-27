/**
 * One-shot bootstrap for a fresh deployment.
 *
 * Pushes the schema, seeds the organisation, roles, brands and card presets,
 * imports the supplied workbook and seeds the 11-500 benchmark content, against
 * whatever DATABASE_URL is in the environment. Run it against production like
 * this, from a machine that has the Vercel CLI linked:
 *
 *   vercel env pull .env.production --environment=production
 *   npm run bootstrap -- --env .env.production
 *
 * Every step is idempotent, so re-running it is safe.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function loadEnvFile(file: string) {
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
}

const argv = process.argv.slice(2);
const envIndex = argv.indexOf("--env");
if (envIndex >= 0 && argv[envIndex + 1]) {
  const f = path.resolve(argv[envIndex + 1]);
  loadEnvFile(f);
  console.log(`loaded environment from ${f}`);
} else if (fs.existsSync(".env.local")) {
  loadEnvFile(".env.local");
}

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set.\n" +
      "On Vercel, add the Neon integration first:\n" +
      "  vercel integration add neon\n" +
      "then `vercel env pull .env.production --environment=production` and re-run.",
  );
  process.exit(1);
}
if (!process.env.SEED_ADMIN_PASSWORD) {
  console.error("SEED_ADMIN_PASSWORD is not set; refusing to seed an account with no password.");
  process.exit(1);
}

const run = (cmd: string, args: string[]) => {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", env: process.env });
};

run("npx", ["drizzle-kit", "push", "--force"]);
run("npx", ["tsx", "src/server/db/seed.ts"]);

const workbook = process.env.BOOTSTRAP_WORKBOOK ?? "docs/source/ExportAllProducts_20260826220203076.xlsx";
if (fs.existsSync(workbook)) {
  run("npx", ["tsx", "scripts/import-workbook.ts", workbook]);
  run("npx", ["tsx", "scripts/seed-benchmark.ts"]);
} else {
  console.log(`\nno workbook at ${workbook}; skipping the catalogue import`);
}

run("npx", ["tsx", "scripts/seed-templates.ts"]);
run("npx", ["tsx", "scripts/seed-assets.ts"]);

console.log("\nBootstrap complete.");
console.log(`Sign in as ${process.env.SEED_ADMIN_EMAIL ?? "kiefer@towparts.com"}`);
