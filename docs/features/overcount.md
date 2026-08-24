# Over-count detection — are the leads inflated?

**Status:** live. Runs on every generation tick. **Operator-first** — it never
shows the customer anything.

**Source of truth:** `server/src/meta/overcount.ts`,
`GraphCampaignAdapter.getPixelEventSources`,
`server/src/services/overcount-monitor.ts`,
`server/src/db/migrations/047_overcount.sql`, the guardrail in
`increaseBudget` (`server/src/recommendations/rules.ts`).

**Lock-in tests:** `server/src/meta/overcount.test.ts`,
`server/src/recommendations/rules.test.ts` (the guardrail, both directions).

---

## Why this is the dangerous one

Every other measurement check assumes **under**-counting: we see fewer leads
than really happened, the engine gets cautious, and the damage is bounded.

Over-counting compounds instead:

```
inflated leads → CPL looks excellent → engine recommends MORE budget
              → more money against conversions that never happened
              → CPL still looks excellent → recommend more again
```

The product would be confidently, expensively wrong while the customer's phone
stays silent.

## Two signals, deliberately unequal

**A — implausible conversion rate (decisive).** `leads ÷ link_clicks` above
**50%**, with at least **20 clicks** to judge.

The ceiling is deliberately wide rather than tuned. The real campaigns on this
account convert at **21.1%** and **14.6%** of link clicks, so 50% sits at 2.4×
the highest observed healthy rate — a page turning half its clicks into leads is
almost always a tracking artefact. Both real rates are pinned in the tests, so a
future tightening of the bound has to consciously break them.

Computed from `insight_snapshot_daily` — the **daily view, never the raw table**,
which mixes per-day rows with overlapping rolling-window rows (migration 030). An
inflated denominator here would *hide* an over-count; an inflated numerator would
*invent* one.

**B — browser and server events on the same pixel (contextual only).** CAPI
alongside the browser pixel is where dedup failures happen — but plenty of CAPI
setups dedupe correctly, so this **never raises an alarm on its own**. It is
fetched only when the rate is already implausible (it costs a Graph call and
contributes nothing on a healthy campaign) and used to name the likely cause:

| Sources | Likely cause named |
| --- | --- |
| browser **and** server | a deduplication failure — `event_id` not matched |
| one source only | the lead event firing on page load rather than form submit, or a duplicate pixel install |

## The guardrail — surgical, not blanket

This is the point of the ticket. While an over-count is suspected,
`increaseBudget` returns null.

It is deliberately **not** the blanket suppression that `tracking_broken`,
`cta_broken`, `account_cannot_spend` and `lead_event_stopped` apply. A *decrease*
on suspect numbers is still safe, and pausing a genuinely weak creative is still
right. **Only the spend-more direction is unsafe.**

That asymmetry is the whole encoding: under-counting makes the engine cautious
(acceptable); over-counting makes it spend (unacceptable). When trust is
uncertain, **fail toward not spending — not toward doing nothing.**

Consequently there is **no `no_rec_reason`** for this state, unlike its four
siblings.

## Operator-first, on purpose

This check implicitly tells a customer *"your numbers are too good to be true."*
That needs verification before it is said out loud — a false accusation is worse
than a day's delay. So it raises a high-severity ops item (reaching Telegram via
the AIC-118 relay) and blocks budget increases, and shows the customer nothing.

## Known gaps

- **No direct dedup verdict.** Meta does not expose whether `event_id` matching
  actually succeeded, only that both sources exist. Signal B is therefore a
  hypothesis about cause, not a measurement of it.
- **A rate below the ceiling is not vindication.** A campaign over-counting by
  2× at a true 10% rate reads 20% and passes. This catches the gross case, which
  is the one that runs away with a budget.
