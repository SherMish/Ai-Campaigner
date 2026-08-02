# Repo scaffold

**Status:** live — the monorepo skeleton every feature builds on. Copied from
Pisga's proven stack (AIC-2), adapted to Neon.

**Source of truth:**
- Root: `package.json` (workspaces + scripts), `railway.json`, `.nvmrc`, `.github/workflows/ci.yml`
- `shared/` — `@aic/shared`: cross-cutting types/utils (`src/money.ts`)
- `server/` — `@aic/server`: Express API (`src/app.ts`, `src/index.ts`), Neon pool (`src/db/pool.ts`), migration runner (`src/db/migrate.ts`, `src/db/migrations/`)
- `web/` — `@aic/web`: Vite + React SPA (`src/main.tsx`, `src/App.tsx`), copy file (`src/strings.ts`), API client (`src/api.ts`), `vite.config.ts`
- `landing/index.html` — static public homepage (placeholder; AIC-20 owns the real one)

**Lock-in tests:** `shared/src/money.test.ts` (agorot conversion/format),
`server/src/app.test.ts` (health + `/api` mount smoke).

---

## How it works today

**Workspaces.** Three npm workspaces — `shared`, `server`, `web`. `shared` is
consumed by both others via the `@aic/shared` alias (source at build/test time;
its `dist/index.js` at runtime through the workspace symlink).

**Build.** `npm run build` builds in order: `shared` (tsc → `dist`) → `server`
(tsc → `dist`, then `scripts/copy-migrations.mjs` copies `*.sql` into the build
output) → `web` (`tsc --noEmit` typecheck, then `vite build`). The Vite build
renames the SPA bundle to `dist/app.html` and puts the static landing at
`dist/index.html`, so one origin serves the public homepage at `/` and the SPA
everywhere else.

**Server.** `createApp()` (`src/app.ts`) mounts CORS + JSON, exposes `/health`
at the root (Railway healthcheck — no `/api` prefix needed), and mounts an empty
`/api` router that feature routers hang off of (AIC-16+). `src/index.ts` binds
the port. Split so tests exercise the app without a live port.

**Database.** Neon serverless Postgres. `src/db/pool.ts` is the single `pg.Pool`
(SSL auto-enabled for any non-localhost URL) plus `query()` and `withTx()`. The
migration runner (`src/db/migrate.ts`) applies `migrations/*.sql` in name order,
recording each in the `_migrations` ledger. `001_init.sql` creates only that
ledger; the P0 entity tables land in AIC-4. `npm run release` runs migrations
against prod at deploy time (`railway.json` start command).

**Money.** All amounts are integer agorot. `shared/src/money.ts` holds the only
sanctioned shekel↔agorot conversions and the `formatShekel` display helper.

**CI.** `.github/workflows/ci.yml` runs on push to `master` and PRs:
`npm ci` → typecheck → build → unit tests. No DB or e2e stage yet — that arrives
once a Neon dev-branch `DATABASE_URL` is available as a CI secret.
