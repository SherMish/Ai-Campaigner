# Metrics definitions

**Status:** live — the lead + CPL definitions every recommendation and every
customer-facing number depend on (AIC-6). Get these right here and the engine is
trustworthy; get them wrong and the whole product's judgment is silently corrupt.

**Source of truth:** `server/src/meta/insights.ts` (extract/compute/normalize),
`server/src/meta/snapshot-store.ts` (storage + period comparison).
**Lock-in tests:** `server/src/meta/insights.test.ts`,
`server/src/meta/ingestion-service.test.ts`,
`server/src/meta/snapshot-store.integration.test.ts`.

---

## Lead

P0 campaigns are **Leads-objective, Click-to-WhatsApp**. The countable lead is the
**messaging-conversation-started** event from Insights `actions`:

- Preferred action type: `onsite_conversion.messaging_conversation_started_7d`
- Fallback: `onsite_conversion.messaging_conversation_started`

We take the **7-day variant when present, else the base type — never both** (summing
both would double-count). No WhatsApp reading, no individual-lead tracking (PRD
forbids both). If a campaign's lead mechanism differs (e.g. Instant Forms in P1),
that's out of scope for P0 ingestion.

## Cost per lead (CPL)

`CPL = spend / leads`, in **agorot**. When `leads = 0`, CPL is **NULL** — an honest
"no data yet," never a misleading 0 or a divide-by-zero.

## What we store, per grain, per period

At campaign / ad-set / ad / creative grain: `spend_agorot`, `leads`, `cpl_agorot`,
`delivery_status`, plus `impressions` and `link_clicks` kept **internal-only** to
*explain* a recommendation later — never surfaced to the customer (PRD §14). The
full raw row is kept in `raw` JSONB.

### Creative grain

Meta Insights has no native "creative" level. In the standard P0 structure
(1 campaign → 1 ad set → 3–5 ads, each ad = one creative) we **derive** the creative
grain from ad-level rows, labelling by ad name. If a structure ever puts multiple
creatives under one ad, this mapping is revisited.

## Period-over-period

`campaignTotals(campaignId, start, end)` sums campaign-grain rows in a window;
`IngestionService.periodComparison` returns current vs previous (default: the last
complete 7-day window vs the 7 days before it — `rollingPeriods()`).

## Ingestion reliability

The scheduled tick (`runIngestionTick`) processes each managed campaign in
isolation: a Meta error is **caught, logged, and skipped** — a missed pull is
retried next tick, never lost, and never crashes the run. Upserts are **idempotent
per `(campaign, grain, object, period)`**, so a re-run updates in place instead of
duplicating. The scheduler stays **inert until `META_SYSTEM_USER_TOKEN` is set**
(`buildIngestionTick` returns null), so no background job runs against an API it
can't reach.

## Not verified against live yet

The "runs green against Pisga's live campaign, producing real snapshots" criterion
needs a real System User token + a linked campaign (AIC-3 operator steps, AIC-1
access result). The normalization, math, idempotency, and error handling are
covered by unit + DB tests with fixtures; swapping `GraphMetaClient` in with a real
token is the remaining step. Reconciliation vs Ads Manager is tracked in
[features/dogfood-readout.md](features/dogfood-readout.md) (AIC-7).
