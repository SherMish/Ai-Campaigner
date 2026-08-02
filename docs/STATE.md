# docs/STATE.md — dated changelog

Newest first. One `### YYYY-MM-DD — <title>` block per change: **what changed and
why**. Append a block; never edit an existing line. Behaviour is specified in the
owning doc under [features/](features/), not here.

## Changelog

### 2026-08-03 — Recommendation staleness + expiry — AIC-11
Added `refreshRecommendations` as the canonical eval tick: a proposed rec is valid
iff the same gated rules still produce an equivalent rec from current evidence;
otherwise it's expired (and replaced when a different action is now warranted). An
expired rec is un-approvable by construction (AIC-8 state machine). "Material
divergence" is defined as rules-no-longer-yield-it. Verified: 4 tests
(evidence-holds → stays; diverged → expires; expired → un-approvable; replaced).

### 2026-08-03 — Deterministic recommendation rules v1 — AIC-9
Added the rules engine: `evaluateCampaign` runs five rule types
(pause_weak_creative, replace_creative, decrease_budget, increase_budget,
no_action) over per-campaign evidence, gated by named minimum-evidence thresholds
(`RULE_THRESHOLDS`) — below the gate it emits `no_action`, never a forced change.
Zero LLM involvement; output fully structured. `rule-evaluator.ts` assembles
evidence from `insight_snapshot`, persists an acting draft as `proposed` (deduped;
`no_action` not stored). Thresholds + priority documented in `docs/RULES.md`.
Verified: 14 rule fixture tests (fires when it should, does NOT on thin evidence) +
3 evaluator tests.

### 2026-08-03 — Recommendation state machine — AIC-8
Added the recommendation lifecycle as an explicit state machine
(`proposed→approved→executing→executed|failed`, plus `dismissed`/`expired`),
illegal transitions rejected before any write. `RecommendationService` wraps every
transition with the state-machine check + an optimistic store guard
(`StaleRecommendationError` on a lost race); `completeExecution` writes the PRD §23
audit row to `action_history`. `no_action` is a first-class type. pg + in-memory
stores. Verified: 9 unit + 1 DB integration test.

### 2026-08-03 — Dogfood readout (admin) — AIC-7
Added the internal readout: `buildCampaignReadout` (status + current/previous
7-day totals + per-creative rows + period deltas, read only from
`insight_snapshot`), the `/api/admin` routes behind a `requireAdmin` guard, and
the `/admin/readout` React screen (Hebrew, RTL; `formatShekel`, NULL CPL → "—").
Verified: deltaPct unit test + DB/HTTP integration test, and rendered end-to-end
against seeded Pisga snapshots on a local Postgres (status active, ₪734 spend
+8%, 18 leads +20%, CPL ₪40.78 −10%, 3-creative table). Reconciliation vs Ads
Manager gated on real ingestion.

### 2026-08-03 — Insights ingestion → insight_snapshot — AIC-6
Added the ingestion pipeline: `getInsights` on the Meta client (4 grains, creative
derived from ad rows), pure metric functions (`extractLeads` — 7d-preferred, never
double-counted; `computeCpl` — NULL at 0 leads; `normalizeRow` — spend→agorot), the
snapshot store (idempotent upsert per (campaign, grain, object, period) + period
totals), and `runIngestionTick` (per-campaign isolation: a Meta error is caught,
logged, retried next tick, never crashes the run). Wired an inert-until-token
scheduler into `index.ts`. Lead/CPL documented in `docs/METRICS.md`. Verified: 12
new unit tests + 2 DB integration tests (idempotency, period totals). Live against
Pisga gated on a real System User token + linked campaign.

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
