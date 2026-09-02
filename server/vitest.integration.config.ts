import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Integration tests hit a real Postgres via DATABASE_URL. They self-skip when it
// is unset, so a developer without a database still gets a green run.
//
// AIC-109: CI now provides that database itself (a throwaway postgres:16 service
// container — see .github/workflows/ci.yml), so these are no longer invisible.
// The old note here said CI stayed green "until a Neon dev-branch URL is wired
// in as a secret"; no secret turned out to be needed.
export default defineConfig({
  resolve: {
    alias: {
      "@aic/shared": path.resolve(__dirname, "../shared/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    // AIC-84 — refuse the whole run if DATABASE_URL is not a disposable
    // database. server/.env holds the PRODUCTION url (the server needs it),
    // and this suite reads the same variable, so without this the default
    // outcome of running it in a checkout is ~460 tests writing to prod.
    globalSetup: ["src/db/integration-setup.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // SEQUENTIAL, and this is not a performance concession — it is correctness.
    // Every one of these files talks to the SAME database. Run in parallel they
    // interfere: one file's rows land inside another file's query, a global
    // aggregate sees a neighbour's fixtures, and a cleanup DELETE races a
    // concurrent INSERT. That produced failures that vanish when the file is run
    // alone — which is exactly what "flaky" means, and why several were written
    // off this week as "known pre-existing" rather than investigated.
    //
    // Verified: customer-recommendations.integration.test.ts fails under
    // parallel execution against a FRESH database and passes on its own.
    fileParallelism: false,
  },
});
