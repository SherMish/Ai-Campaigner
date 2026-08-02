# Data model (P0)

**Status:** live — the 10 P0 entities, created up front so downstream tickets
build against stable tables (AIC-4).

**Source of truth:**
- Migrations: `server/src/db/migrations/002_…` through `007_…`
- Enums (TEXT columns validated in app code): `shared/src/domain.ts`
- Dogfood seed: `server/src/db/seed.ts`

**Lock-in tests:** `server/src/db/schema.integration.test.ts` (all tables present,
integer money, cascade deletes, snapshot idempotency key). Runs via
`npm --workspace server run test:integration` against a real Postgres; self-skips
when `DATABASE_URL` is unset.

---

## Conventions

- **Money is integer agorot**, never floats (`*_agorot` columns). Convert only via
  `shared/src/money.ts`.
- **Enum-like values are `TEXT` + `CHECK`**, mirrored in `shared/src/domain.ts`, so
  adding a value doesn't need a DDL migration.
- **`updated_at`** is maintained by the shared `set_updated_at()` trigger.
- **`action_history` is append-only** — insert, never update.
- **RLS:** not adopted. On Neon there is no PostgREST/public data API, so the
  PIS-26 "anon key exposed every table" failure mode doesn't exist here; the
  load-bearing control is that only the server (holding the connection string)
  can reach the DB. RLS deny-all remains available as optional hardening.

## Entities

| Table | Purpose | Key relations |
| --- | --- | --- |
| `customers` | Business info, offer, contact, onboarding status; `is_test` marks dogfood | — |
| `subscriptions` | Manual billing: setup/monthly agorot, status, next charge | `customer_id` (1:1) |
| `meta_connections` | Partner-access + System User linkage; `access_health` (ok/revoked/invalid/needs_reconnect); per-asset grants | `customer_id` (1:1) |
| `ad_accounts` | Managed ad account under a connection | `connection_id` |
| `managed_campaigns` | The one managed campaign per customer; status, agreed budget (agorot), `automation_enabled` brake | `customer_id` (1:1), `ad_account_id` |
| `insight_snapshots` | Normalized Insights at campaign/adset/ad/creative grain; spend, leads, CPL (agorot); internal impressions/clicks | `campaign_id`; UNIQUE `(campaign_id, grain, meta_object_id, period_start, period_end)` |
| `recommendations` | Proposed action + type + evidence + state machine + expiry | `campaign_id` |
| `action_history` | Append-only audit: what / previous / new / why / who / human / when | `campaign_id`, `recommendation_id` |
| `lead_quality_feedback` | Weekly campaign-level: leads reported, relevant count, customers won | `campaign_id`; UNIQUE `(campaign_id, week_start)` |
| `ops_queue_items` | Needs-attention worklist: type, severity, status | `customer_id`, `campaign_id` |

## Lead & money definitions

- **lead** = `onsite_conversion.messaging_conversation_started` (Click-to-WhatsApp).
  See [METRICS.md](METRICS.md) when ingestion (AIC-6) lands.
- **CPL** = `spend_agorot / leads` (NULL when `leads = 0`).

## Migrations

`001_init` creates the `_migrations` ledger. `002`–`007` create the entities in
FK-safe order (customers → connections → accounts → campaigns → snapshots →
recommendations/history → feedback/ops). Applied in name order by
`server/src/db/migrate.ts`; recorded in `_migrations` so re-runs are no-ops.
