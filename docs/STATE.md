# docs/STATE.md — dated changelog

Newest first. One `### YYYY-MM-DD — <title>` block per change: **what changed and
why**. Append a block; never edit an existing line. Behaviour is specified in the
owning doc under [features/](features/), not here.

## Changelog

### 2026-08-03 — Meta connection + access-loss detection — AIC-5
Added the Meta client abstraction (`GraphMetaClient` + `FakeMetaClient`), a Graph
error → access-health classifier, the connection store (pg + in-memory), and
`ConnectionService`: verify folds per-asset access into one health, persists
transitions, and raises a single `meta_connection_failure` ops item on loss.
`assertExecutable` throws `AccessHaltedError` unless health is `ok` — the P0.3
execution-halt safety rule. Customer-facing reconnect copy added to `strings.ts`
(plain Hebrew, no Meta jargon; `connectionMessage()` maps every non-ok state to
one prompt). Verified: 8 service + 3 classifier unit tests, and a DB integration
test proving persistence + ops item + halt end-to-end. Live-against-Pisga is
gated on a real System User token (AIC-3 operator steps) and AIC-1.

### 2026-08-03 — Meta setup runbook — AIC-3
Added `docs/META_SETUP.md`: the one-time Meta-side configuration (Business
Portfolio, app, System User + token scopes, partner-asset assignment, token
storage/rotation posture) in the accurate access framing (partner access +
System User, subject to Meta's required Marketing API tier; no customer OAuth in
P0). Added `META_*` env placeholders to `server/.env.example`. The operator steps
(mint token, assign Pisga's ad account) are executed in Meta's UI by a person and
are checklisted in the doc; the app only consumes the resulting token + asset IDs.

### 2026-08-03 — Core data model: 10 P0 entities — AIC-4
Added migrations `002`–`007` creating the ten P0 tables (customers,
subscriptions, meta_connections, ad_accounts, managed_campaigns,
insight_snapshots, recommendations, action_history, lead_quality_feedback,
ops_queue_items) with FKs, indexes, and CHECK-enum columns mirrored in
`shared/src/domain.ts`. Money is integer agorot; `action_history` is append-only;
the snapshot idempotency key is `(campaign, grain, object, period)`. Added the
Pisga dogfood seed (idempotent) and a DB integration test (self-skips without
`DATABASE_URL`). RLS deliberately not adopted (Neon has no PostgREST surface;
rationale in DATA_MODEL.md). Verified against a local Postgres: 7 migrations
apply, seed idempotent, 4/4 integration tests green.

### 2026-08-03 — Stack scaffold (server / web / shared) — AIC-2
Scaffolded the monorepo from Pisga's proven stack: npm workspaces
(`shared` / `server` / `web`), TypeScript throughout, Neon Postgres via a
numbered-migration runner (`001_init.sql` creates the `_migrations` ledger only;
the P0 entities land in AIC-4), an Express API with a root `/health` for Railway
and an `/api` mount point, a Vite + React SPA with the static landing served at
root, the `strings.ts` copy file, `railway.json`, and a GitHub `ci` workflow
(typecheck + build + unit tests). `shared/money.ts` enforces integer-agorot money.
Verified locally: typecheck, build, and 5/5 unit tests green. No DB/e2e in CI yet
(waiting on a Neon dev-branch `DATABASE_URL`).

### 2026-08-02 — Repo bootstrap: governance layer
Created the standalone AI Campaigner repo with its operating rules
([CLAUDE.md](../CLAUDE.md)), the `feature-docs` skill, and the docs system
(INDEX routing table + this changelog + the feature-doc template). Establishes the
docs-travel-with-code and ship discipline before any feature work, so every later
change inherits it. Stack scaffold (server/web/CI/Railway/Neon) lands separately.
