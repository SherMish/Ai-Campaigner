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
| `managed_campaigns` | The one managed campaign per customer; status, agreed budget (agorot), `automation_enabled` brake, per-account rule-threshold overrides (`threshold_overrides` JSONB, sparse, AIC-77a — see [RULES.md](RULES.md#configurable-thresholds-aic-77a)). Supported shape: **1 campaign → N ad sets → 3–5 creatives** (see note below) | `customer_id` (1:1), `ad_account_id` |
| `insight_snapshots` | Normalized Insights at campaign/adset/ad/creative grain; spend, leads, CPL (agorot); internal impressions/clicks | `campaign_id`; UNIQUE `(campaign_id, grain, meta_object_id, period_start, period_end)` |
| `recommendations` | Proposed action + type + evidence + state machine + expiry | `campaign_id` |
| `action_history` | Append-only audit: what / previous / new / why / who / human / when | `campaign_id`, `recommendation_id` |
| `lead_quality_feedback` | Weekly campaign-level: leads reported, relevant count, customers won | `campaign_id`; UNIQUE `(campaign_id, week_start)` |
| `ops_queue_items` | Needs-attention worklist: type, severity, status | `customer_id`, `campaign_id` |
| `recommendation_outcomes` | AIC-76: before/after CPL comparison for one executed recommendation — window bounds, features, delta, verdict, confound detail. The first engine-computed **table** (every earlier computed cache is a scalar column above) — see [outcome-measurement.md](features/outcome-measurement.md) | `recommendation_id` (1:1, UNIQUE), `campaign_id` |

### Managed-campaign shape (AIC-38)

The supported structure is **1 campaign → N ad sets → 3–5 creatives**. The
single-ad-set ideal ("1 campaign → 1 ad set → 3–5 creatives") is a
**recommendation to the customer during onboarding**, never an assumption the
engine, dashboard, or review may rely on. Real customers' existing campaigns
split by audience routinely (age/gender/geo), and P0 manages the *existing*
campaign (PRD §7) — so multiple ad sets are **normal, not exceptional**. Budgets
are read at the **campaign** level (CBO / Advantage+ distributes across ad sets);
`insight_snapshots` carries the `adset` grain so per-audience performance is
available to the rules and surfaces. See the audience-aware engine (AIC-36) and
surfacing (AIC-37).

- **lead** = `onsite_conversion.messaging_conversation_started` (Click-to-WhatsApp).
  See [METRICS.md](METRICS.md) when ingestion (AIC-6) lands.
- **CPL** = `spend_agorot / leads` (NULL when `leads = 0`).

### The disjoint-daily view (migration 030)

`insight_snapshots` holds **two shapes of row for the same campaign-grain
data**: a rolling 7-day window (`period_start = today-7, period_end = today-1`,
rewritten every ingestion tick) and, since AIC-55, disjoint per-day rows
(`period_start = period_end`, one per calendar day). Both are real rows for
real days — a `SUM()` over a plain window predicate
(`period_start >= $2 AND period_end <= $3`) matches **both**, because the
rolling row's range contains the daily rows underneath it. That's not
hypothetical: it's the exact bug that made 1 real lead read as 3 on the
lead-quality card ([customer-overview.md](features/customer-overview.md#leadstodate-must-never-be-summed-from-insight_snapshots-real-bug-found-live))
and, found again in the same class at a second call site (AIC-75), made 4
real leads read as 8 in the recommendation engine's evidence.

**The fix is structural, not a filter to remember.** `insight_snapshot_daily`
is a view exposing only the disjoint rows:

```sql
CREATE VIEW insight_snapshot_daily AS
  SELECT * FROM insight_snapshots WHERE period_start = period_end;
```

**Rule: any aggregation over a time range reads the view, never the table.**
`PgSnapshotStore.campaignTotals` and `.dailySeries` both read
`insight_snapshot_daily`; a `SUM()` over the view is arithmetically incapable
of double-counting, because the rolling rows it would double-count against
simply aren't in it. `creativeStats`/`adsetStats` are **deliberately
unaffected** — those grains have no daily rows written for them at all (only
`campaign` grain gets the daily `time_increment=1` ingestion call), so they
select rows within a window rather than summing over time, and were never
ambiguous the way a `SUM()` is.

This is the same move as AIC-70's `intentStatus()`/`deliveryStatus()`
accessors: a read-side filter every future consumer has to *remember* is a
landmine; a view makes the right query the only reachable one.

**Not yet done, deliberately deferred:** stopping the *write* of the now-
redundant rolling campaign row (it's still written every tick, just no longer
read for aggregation) — a follow-up ticket, after confirming nothing else
legitimately reads it.

### Enum-shaped TEXT columns need a migration to widen, every time

`managed_campaigns.no_rec_reason` (migration 024) is `TEXT` with a `CHECK`
listing the valid values by name — the convention this schema uses instead
of a DB `ENUM` type, so adding a value doesn't need a DDL type migration...
except the CHECK itself still needs one: `ALTER TABLE ... DROP CONSTRAINT`
then re-`ADD CONSTRAINT` with the wider list (migration 013 did this first,
for `recommendations.type`; migration 032 did it for `no_rec_reason`'s new
`cooling_down` value, AIC-77b; migration 034 widened `recommendations.type`
again for `add_creatives_for_comparison`, migration 035 widened
`no_rec_reason` again for the AIC-85 comparability reasons — a rename
(`single_ad_set` → `no_comparable_audiences`) plus two new values). **Skipping
this migration fails silently** — the app-level write happens inside a
try/catch that logs and continues (`generation.ts`'s `recordNoRecReason`
call), so a forgotten CHECK-widen doesn't crash anything, it just quietly
never persists the new value, forever. A rename is safe with no data
migration: `no_rec_reason` is overwritten every engine tick, not a
historical record.

## Migrations

`001_init` creates the `_migrations` ledger. `002`–`007` create the entities in
FK-safe order (customers → connections → accounts → campaigns → snapshots →
recommendations/history → feedback/ops). Applied in name order by
`server/src/db/migrate.ts`; recorded in `_migrations` so re-runs are no-ops.
