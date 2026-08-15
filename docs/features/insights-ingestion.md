# Insights ingestion → insight_snapshot

**Status:** live (code) — the scheduled job that pulls Marketing API Insights per
managed campaign and writes normalized snapshots (AIC-6). Live-against-Pisga is
gated on a real System User token + linked campaign.

**Source of truth:**
- Pure metrics: `server/src/meta/insights.ts`
- Client insights: `server/src/meta/client.ts` (`getInsights`, `getDailyInsights`)
- Storage + comparison: `server/src/meta/snapshot-store.ts`
- Orchestration: `server/src/meta/ingestion-service.ts` (`IngestionService`, `runIngestionTick`)
- Scheduling + wiring: `server/src/services/scheduler.ts`, `server/src/meta/scheduled-ingestion.ts`
  (`rollingPeriods`, `todayPeriod`, `dailyPeriod`, `DAILY_LOOKBACK_DAYS`), `server/src/index.ts`

**Lock-in tests:** `server/src/meta/client.test.ts`,
`server/src/meta/insights.test.ts`,
`server/src/meta/ingestion-service.test.ts`,
`server/src/meta/snapshot-store.integration.test.ts`.

See [METRICS.md](../METRICS.md) for the lead/CPL definitions this produces.

---

## How it works today

Every tick writes snapshots down **two parallel paths**, both landing in the same
store (`SnapshotStore.upsert`) — which table a row ends up in is decided purely by
its own period shape (`period_start === period_end` → the disjoint-daily table;
a multi-day span → the overlapping rolling table), not by which path wrote it.

**1. Rolling windows** (`ingestCampaign` → `getInsights`) — the engine's own
evidence. Pulls Insights at all four grains (campaign/adset/ad, deriving
creative from each ad row) for one multi-day window per call: the current
7-complete-day window (`rollingPeriods().current`, what recommendations are
evaluated on), the previous 7 days (for period-over-period comparison), and
`todayPeriod()` (today only, customer-surface display) as an extra window.
`todayPeriod` is itself a single DAY, so its rows land in the disjoint-daily
table as a side effect — the mechanism that incidentally seeds the second
path below with one real day of adset/ad/creative data per tick, before the
dedicated backfill existed.

**2. Disjoint per-day rows** (`ingestDaily` → `getDailyInsights`) — the
customer's day/week/month/allTime range switcher and the audience/per-ad
detail panel (AIC-95) both depend on this: any bounded range the customer
picks is a **sum over whole days**, never over the overlapping rolling
windows above (summing those double-counts — a real bug once read 1 lead as
3). One call per grain (campaign/adset/ad + derived creative, same as
`getInsights`) with `time_increment=1`, over `dailyPeriod()` — a full
`DAILY_LOOKBACK_DAYS` (45) trailing window, refreshed every tick. All four
grains, not campaign-only: an earlier version pulled campaign grain only,
reasoning that per-object daily rows would "multiply the row count for no
gain" — true until the audience panel needed to follow the switcher too,
at which point campaign-only meant that panel could show real per-object
data for **no real account, ever** (confirmed live: real accounts had zero
adset/creative rows in the daily table before this fix). `allTime` does NOT
sum these — the per-day rows only reach back 45 days, so lifetime figures
come from the separately cached `leads_to_date`/`spend_to_date` read instead
(see [METRICS.md](../METRICS.md)).

**Isolation & reliability.** Each campaign's work is wrapped: a Meta error on
any one window (primary, extra, or daily) is caught and logged there; the
primary window's failure skips the rest of that campaign for the tick, but a
failure on an extra/daily window never fails the campaign overall (display-only
data). The tick summary reports `ok/failed/snapshots`. Upserts are idempotent
per `(campaign, grain, object, period)`.

**Scheduling.** `buildIngestionTick(pool)` assembles the real client + stores from
the DB, but returns `null` (scheduler off) unless `META_SYSTEM_USER_TOKEN` is set,
so nothing runs against Meta until it's configured. `index.ts` starts the interval
(default hourly, `INGESTION_INTERVAL_MS`) only when the tick is non-null.

**Normalization.** Spend (currency-unit string) → integer agorot; leads from
the campaign's own configured lead event(s) (AIC-87, `managed_campaigns.lead_event_types`);
CPL = spend/leads (NULL at 0 leads); impressions + link clicks kept internal.
Creative grain derived from ad rows (see METRICS.md).
