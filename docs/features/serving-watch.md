# Serving watch — an ACTIVE ad set that serves nothing

**Status:** live (AIC-178, 2026-09-02)

**Source of truth:** `server/src/services/serving-watch.ts`, migration
`052_serving_watch.sql`, wired into the hourly generation tick
(`recommendations/generation.ts`, `recordServing` dep).

**Lock-in tests:** `serving-watch.test.ts` (the rule, pure),
`serving-watch.integration.test.ts` (persistence, one-alert-per-spell,
recovery, paused).

---

## Why it exists

On 2026-09-02 a live campaign served **zero impressions for a full day** while:

- Meta reported every ad set and ad `ACTIVE`
- `issues_info` was empty at campaign, ad-set and ad level
- our own `delivery_ok` stayed `true`

Nothing we checked was wrong, because **everything we checked was Meta's own
status** — and Meta's status said healthy the whole time.

`delivery-health` asks Meta *"is this delivering?"* and believes the answer.
This asks our own snapshots *"did anything measurably happen?"*. Those two
disagree exactly when it matters most.

## The rule

An ad set alerts when **all** hold:

| Condition | Why |
| --- | --- |
| impressions = 0 today | the measured signal, not a reported status |
| Meta status is ACTIVE | silence is the *point* of a paused ad set |
| 12h since it last served | `SILENT_HOURS`; below it, normal auction variance |
| no standing alert | one dark spell = one message |

The silence clock runs from `last_served_at`, falling back to
**`first_seen_at`** — the tick at which we first saw the object. A brand-new ad
set has legitimately served nothing (review, learning), and paging an operator
about an ad set created twenty minutes ago is how a channel gets muted.

`alerted_at` is cleared the moment it serves again. A recovery that left the
flag set would make that alert the *last* one this ad set ever produces.

## Impressions, not spend

An ad set can serve real impressions on rounding-error spend. Calling that "not
serving" would be false, so the query reads `impressions` at ad-set grain
directly (`todayImpressionsByAdSet`) rather than widening
`SnapshotStore.adsetRangeStats`, whose two consumers — the dashboard and the
explorer — want neither impressions nor this question.

## Ad-set grain, deliberately

The ad set is what the customer can act on: pause/resume live there and the
dashboard groups by it. A single dark ad inside a serving ad set is usually
Meta's optimizer doing its job, and alerting on it would train everyone to
ignore the channel.

## Delivery

`ads_not_serving` is an ordinary `ops_queue_items` row, so the existing relay
(AIC-118) carries it to Telegram with no new call site. **The relay skips
customers flagged `is_test`** — a real account wrongly flagged is silently
un-alertable, which is exactly what happened to `Liam Aboros` before
2026-09-02. If an alert never arrives, check that flag first.
