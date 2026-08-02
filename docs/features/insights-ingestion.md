# Insights ingestion → insight_snapshot

**Status:** live (code) — the scheduled job that pulls Marketing API Insights per
managed campaign and writes normalized snapshots (AIC-6). Live-against-Pisga is
gated on a real System User token + linked campaign.

**Source of truth:**
- Pure metrics: `server/src/meta/insights.ts`
- Client insights: `server/src/meta/client.ts` (`getInsights`)
- Storage + comparison: `server/src/meta/snapshot-store.ts`
- Orchestration: `server/src/meta/ingestion-service.ts` (`IngestionService`, `runIngestionTick`)
- Scheduling + wiring: `server/src/services/scheduler.ts`, `server/src/meta/scheduled-ingestion.ts`, `server/src/index.ts`

**Lock-in tests:** `server/src/meta/insights.test.ts`,
`server/src/meta/ingestion-service.test.ts`,
`server/src/meta/snapshot-store.integration.test.ts`.

See [METRICS.md](../METRICS.md) for the lead/CPL definitions this produces.

---

## How it works today

**Per tick** (`runIngestionTick`), for every managed campaign that is not
`unmanaged` and has automation enabled:
1. Run the connection health check (AIC-5 `ConnectionService.verify`) — isolated;
   a failure is logged, not fatal.
2. If the campaign is linked to a Meta campaign, pull Insights at all four grains
   (`getInsights`), normalize each row (`normalizeRow`), and **upsert** into
   `insight_snapshots`.

**Isolation & reliability.** Each campaign's work is wrapped: a Meta error is
caught and logged, the tick continues, and the tick summary reports `ok/failed/
snapshots`. Upserts are idempotent per `(campaign, grain, object, period)`.

**Scheduling.** `buildIngestionTick(pool)` assembles the real client + stores from
the DB, but returns `null` (scheduler off) unless `META_SYSTEM_USER_TOKEN` is set,
so nothing runs against Meta until it's configured. `index.ts` starts the interval
(default hourly, `INGESTION_INTERVAL_MS`) only when the tick is non-null.

**Normalization.** Spend (currency-unit string) → integer agorot; leads from the
messaging-conversation action; CPL = spend/leads (NULL at 0 leads); impressions +
link clicks kept internal. Creative grain derived from ad rows (see METRICS.md).
