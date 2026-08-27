import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // These talk to one database; running files in parallel would have them
    // truncating each other's fixtures.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
