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

## Campaign grain: nothing is spending at all (AIC-182)

A second, sharper check at campaign grain, with a **3-hour** fuse instead of 12.

| Condition | Why |
| --- | --- |
| campaign-wide impressions = 0 | measured, not reported |
| at least one ACTIVE ad set | something is *supposed* to run; all-paused is not a fault |
| 09:00–22:00 Israel time | a campaign quiet at 3am is not news, and a monitor that pages then gets muted before it catches anything real |
| the clock counts **daytime hours only** | see below — this is the unit, and getting it wrong fires an alert every morning |
| 3h since it last served | one quiet ad set is ordinary; a whole campaign is not |

**Why it exists, and why AIC-72 could not do the job.** On 2026-09-02 a
customer's credit card declined charges for 19 hours. Meta reported
`account_status: 1` (ACTIVE) and `disable_reason: 0` for the entire outage —
the account-health check built for exactly this failure never fired, because
Meta only moves that status after its own billing retry cycle, long after
delivery stops. **Meta never exposes "your last charge was declined."**

So the config read cannot see it and the symptom is the only signal. The alert
carries the account state alongside it (`accountContext`, read from the cache
AIC-72 already keeps — no extra Meta call), deliberately including the case
where Meta says the account is fine: that read was ACTIVE while the card was
failing, so the copy says so rather than implying billing is ruled out.

## Delivery

`ads_not_serving` is an ordinary `ops_queue_items` row, so the existing relay
(AIC-118) carries it to Telegram with no new call site. **The relay skips
customers flagged `is_test`** — a real account wrongly flagged is silently
un-alertable, which is exactly what happened to `Liam Aboros` before
2026-09-02. If an alert never arrives, check that flag first.

## The clock counts daytime hours, not wall-clock (AIC-183)

The window guard alone was not enough, and the first morning proved it. A
campaign last served at 02:20 Israel; at 09:20 the window opened, the guard
let the check run, and it reported *"silent 7 hours"* — every one of those
hours overnight. Every campaign in the system alerted at once. Two ad-set
alerts fired at 07:20, outside the window entirely, because the ad-set grain
had no window at all.

**Wall-clock elapsed time is the wrong unit.** Nobody expects delivery at 4am —
the customer's own hourly data shows this campaign serving 13:00–22:00 and
nothing overnight — so those hours are not evidence of anything.

`daytimeHoursBetween` counts only hours inside the window. A campaign that
stops at 20:00 has accumulated 2 hours by 22:00 and is still at 2 when the next
day opens; it must be dark through real business hours before the alert says
anything. It walks hour by hour rather than doing DST arithmetic — Israel
shifts twice a year and an off-by-one there is a false page.

Both grains use the same window and the same clock. A monitor that fires every
morning is a monitor nobody reads by the second morning.
