import { config } from "dotenv";

// Load env from the repo-root .env regardless of where the process was launched
// (server dev runs with cwd = server/, so the root .env is at ../.env). In
// production Railway injects real env vars and no .env file exists, so dotenv
// silently no-ops and never overrides an already-set variable.
//
// NOTE: only the runtime entrypoints (index/migrate/seed) import this. Tests
// import pool/services directly and never load a .env, so a stray prod
// DATABASE_URL in .env can never leak into the test suite — tests must get
// DATABASE_URL explicitly from the shell (and should point at a dev branch).
config({ path: ["../.env", ".env"] });
