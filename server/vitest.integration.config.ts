import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Integration tests hit a real Postgres via DATABASE_URL. Run locally against a
// throwaway/dev database; they self-skip when DATABASE_URL is unset (so CI stays
// green until a Neon dev-branch URL is wired in as a secret).
export default defineConfig({
  resolve: {
    alias: {
      "@aic/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
