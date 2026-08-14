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

## Lead (AIC-87: per-campaign, not a global constant)

**The lead definition lives on the campaign, not in code.**
`managed_campaigns.lead_event_types` is an ordered priority list of Insights
`action_type` strings; `extractLeads(actions, priority)` walks it and returns
the **first matching type's summed value — never sums across types** (Meta
often reports the same real conversion under several action-type aliases at
once, so summing would multiply one lead into several).

The **default** — used by every campaign that doesn't set its own — is P0's
original Click-to-WhatsApp shape: the messaging-conversation-started event,
preferring the 7-day-attribution variant when present:

- Preferred: `onsite_conversion.messaging_conversation_started_7d`
- Fallback: `onsite_conversion.messaging_conversation_started`

A **Pixel-conversion campaign** (objective `OUTCOME_LEADS`,
`optimization_goal: OFFSITE_CONVERSIONS`) reports a completely different action
type — e.g. `offsite_conversion.fb_pixel_complete_registration` for a
`COMPLETE_REGISTRATION` custom event. Under the old hardcoded constant this
counted as **zero leads regardless of real performance** (confirmed live: a
real ₪205.06/26-registration campaign ingested as ₪205.06/0 before this fix)
— a working campaign rendered as a catastrophically failing one. Setting that
campaign's `lead_event_types` to its real action type fixes it at the source;
no downstream code (snapshot store, readout, features, rules, outcome
measurement, the whole web layer) needed to change, because all of it already
reasons over an abstract `leads` integer.

**Two independent sites turn raw `actions` into a `leads` count, and both
must read the same per-campaign list** (found while wiring this — a classic
"missed consumer" the same way AIC-70/AIC-75 were):
1. Ingestion (`normalizeRow` in `insights.ts`) — writes `insight_snapshots.leads`,
   which backs the rolling/current window, the range switcher, and the engine's evidence.
2. `GraphCampaignAdapter.getLifetimeTotals` — a live, uncached read backing
   `leads_to_date`/`spend_to_date`, the dashboard's "all time" range, and the
   AIC-67 lead-quality watermark.

**Deliberately not threaded:** the operator explorer (`meta/explorer.ts`)
normalizes an entire ad account's rows in one call across potentially several
campaigns, each with its own definition — threading a single list through it
needs a `Map<metaCampaignId, string[]>` built from `managed_campaigns`, which
is disproportionate for an operator-only diagnostic surface. It stays on the
WhatsApp default; a documented gap, not a silent one. The env-gated `probe.ts`
boot check is account-level (no single campaign's definition applies) and is
explicitly commented as such.

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
