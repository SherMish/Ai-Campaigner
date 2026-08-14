# Outcome measurement (AIC-76)

**Status:** live — ships unexercised in production (zero recommendations have
ever executed on the one live account), verified by a seeded end-to-end run
against the real DB instead. See [Live status](#live-status-honest-note) below.

**Source of truth:**
- `server/src/recommendations/outcomes.ts` — pure verdict logic: windows,
  due-ness, features, delta, classification. No DB, no clock — every input is
  passed in, same split as [FEATURES.md](../FEATURES.md).
- `server/src/services/outcome-measurement.ts` — the IO half: the due-query,
  confound detection, snapshot reads, the insert.
- `server/src/db/migrations/033_recommendation_outcomes.sql` — the table.
- `server/src/index.ts` — the tick, wired as step 3 of the engine loop.

**Lock-in tests:** `outcomes.test.ts` (pure, 24 tests — window math, due-ness,
**the invariant** below, every verdict path and its precedence),
`outcome-measurement.integration.test.ts` (12 DB tests — the due-query, the
`executed_at`-on-failed-path trap, confound detection, a full measured run,
tick idempotency), `recommendation-oversight.integration.test.ts` (the ops
console reads a measured outcome and the fleet aggregate correctly).

---

## The question this answers

Every prior engine ticket made the recommendation **fire correctly**. None of
them ever checked whether firing **helped**. AIC-75 made the evidence honest,
[AIC-77a](../RULES.md#configurable-thresholds-aic-77a) made the gates tunable,
[AIC-77b](../RULES.md#precedence--cooldown-aic-77b) stopped the engine
re-proposing its own executed work. Up to this ticket the loop was still open:
propose → approve → execute → **nothing ever looked back**.

**Attribution is correlation, never causation.** Meta's own optimisation,
seasonality, budget edits, and competitor activity all move CPL. Nothing in
this module, and nothing built on it, may claim the recommendation *caused*
the delta — every verdict name and every piece of UI copy describes a CPL
**movement in a window**, not a mechanism. Enforced in the Hebrew strings
(`web/src/strings.ts`'s `recsOversight.outcome`/`outcomeSummary` blocks each
carry an explicit disclaimer line) and in code comments throughout
`outcomes.ts`.

## The measurement grain is campaign-level — by design, not compromise

Per-day snapshot rows exist at **campaign grain only** (`time_increment=1` is
fetched at `level=campaign`); `creativeStats`/`adsetStats` can't safely
aggregate an arbitrary window (they return unaggregated, potentially
overlapping rolling rows — see [DATA_MODEL.md](../DATA_MODEL.md#the-disjoint-daily-view-migration-030)).
That looks like a blocker but isn't: for `pause_creative`/`pause_adset` the
paused object's own after-metrics go to zero **by construction**, so the real
question is "did campaign CPL improve?" — and both budget rules are
campaign-level by nature. Every current recommendation type is correctly
measured at campaign grain.

## The window — and why it's the SAME key as the cooldown

**The measurement window is `RULE_THRESHOLDS.COOLDOWN_DAYS`** — the identical
threshold key [AIC-77b](../RULES.md#precedence--cooldown-aic-77b)'s cooldown
uses, not two keys that happen to share a default. This is deliberate, not
coincidental, and it is **one policy, not two**: the engine may not act again
on a class until it can tell whether the last action on that class worked. So:

> **a recommendation becomes measurable at exactly the moment the engine may
> act on its class again.**

Two separate keys would allow an incoherent config (measure at 7 days, cool
down at 3 → the engine re-recommends against an outcome that's still
provisional) that nothing would flag. This is pinned by a dedicated test —
`outcomes.test.ts`'s **"THE INVARIANT"** describe block walks day-by-day from
execution and asserts the first day `isDueForMeasurement()` returns `true`
is the identical day `resolveCooldownClasses()` stops reporting the class as
cooling — so a future split of the key into two breaks a build rather than
drifting silently apart. If asymmetric windows are ever genuinely needed
(see [Known gaps](#known-gaps-follow-up-triggers)), adding a second key is a
lookup change — every caller already resolves through `resolveThresholds`.

**Windows, anchored on `executed_at`** (never `created_at` — the change lands
at execution, so that's the only moment a before/after boundary means
anything):
- before = the `COOLDOWN_DAYS` complete days **ending the day before**
  execution
- after = the `COOLDOWN_DAYS` complete days **starting the day after**
  execution
- **the execution day itself is in neither window** — the change landed
  mid-day, so that day is a blend of both states, contaminated by
  construction. Same "complete days only" discipline the engine's evidence
  gates already follow.

**Both windows are computed together, at measurement time** — not one live
at execution and the other later. Daily rows are re-upserted for ~45 days as
Meta revises attribution (`DAILY_LOOKBACK_DAYS`), so a "before" captured live
at execution and an "after" captured a week later would have had unequal
settling time. Computing both after the after-window has fully closed makes
them equally settled, and therefore genuinely comparable.

**Due-ness is resolved in TypeScript, not SQL** — this codebase has zero SQL
date arithmetic anywhere. `listDueForMeasurement` fetches candidates
(`state = 'executed'` with no existing outcome row) and checks
`isDueForMeasurement` per row, because the window length is per-account.

### The `executed_at`-on-failed-path trap

`state = 'executed'` is the load-bearing filter — **never**
`executed_at IS NOT NULL`. `completeExecution`
(`recommendation-service.ts`) stamps `executed_at` on the **failed** path
too, so filtering on the timestamp alone would measure a change that never
actually landed on Meta. Directly asserted as a precondition in
`outcome-measurement.integration.test.ts`.

## The verdict

Six values, resolved in strict precedence — **can't compute → can't
attribute → bucket**:

| Verdict | When | Notes |
| --- | --- | --- |
| `not_measurable` | `type` never writes to Meta (`replace_creative` today) | Checked first — nothing else matters if there was no event to measure from. See [below](#why-replace_creative-is-not_measurable-temporarily). |
| `insufficient_data` | either window's CPL is null (zero leads), or the after-window has fewer than `MIN_DAYS_DATA` days with data | Terminal, never retried — the window is fixed and has passed; waiting longer adds nothing. |
| `confounded` | another `action_history` row landed in the full before+after span, or a zero-spend day fell in the after-window | Checked **after** the data gate — "couldn't compute" is the more basic fact than "computed but can't attribute". Detail (`ConfoundDetail`) records **what and when**, so an operator judges rather than trusts an opaque flag. |
| `improved` | CPL fell by ≥ `BUDGET_CPL_RISE_PCT` (25%) | CPL **down** is better. |
| `degraded` | CPL rose by ≥ `BUDGET_CPL_RISE_PCT` | |
| `neutral` | moved, but inside the band | The raw delta is still stored — see below. |

**The materiality band is `BUDGET_CPL_RISE_PCT` — the engine's own existing
bar for "moved enough to act on", reused rather than a second number invented
against zero real outcomes.** Provisional and inherited, not derived; the
first real measured outcomes this ticket produces are exactly what should
recalibrate it.

**The raw delta is always stored, whatever the bucket.** The bucket is a
*view*; `delta` is the *data*. A real −11% CPL move stays visible as
"neutral (−11%)" in `recommendation_outcomes.delta` even though the verdict
column says `neutral` — re-bucketing later (once real evidence justifies a
different band) is a recomputation over stored numbers, not a re-collection.

### Why `replace_creative` is `not_measurable` (temporarily)

`replace_creative` reaches `state='executed'` with `result:'success'` but
makes **no Meta write** (`safe-executor.ts`) — it files an ops ticket for a
human. There is no event to measure from: a human may act tomorrow, next
week, or never, so scoring a fixed window after *filing a ticket* would
credit the engine for a change that may not exist. It also collides with
this ticket's own confound rule — a human creative swap at an unknown time is
exactly "another change in the window." **Recorded, not skipped**, so the ops
aggregate shows the type honestly instead of silently omitting it.

This is a property of that rule's **current implementation**, not a
permanent fact about creative replacement — revisit when AIC-63/AIC-79 give
replacement a real tracked execution with a real timestamp. Meanwhile, judge
it on a different, honest metric: was the ops ticket acted on, and how fast.

### Lead quality is recorded, never a verdict input

`lead_quality_reviews.reviewed_at` is when the **customer** reviewed, and
`leads_delta` covers everything since their previous review — which can
reach back well before the after-window started. A review landing inside the
window may describe leads from before execution. Summed per window and
stored as a nullable annotation (`lead_quality_before`/`lead_quality_after`)
with that caveat; it never moves the verdict.

## Storage

`recommendation_outcomes` (migration 033) — the **first engine-computed
table** in this schema; every prior computed cache (`delivery_ok`,
`no_rec_reason`, `live_budget_agorot`, `leads_to_date`) is a scalar column on
`managed_campaigns`, fine for "current state", useless for "one record per
past event." Modeled on `lead_quality_reviews` (migration 027), the closest
structural precedent: an append-only derived log keyed to an entity.

`recommendation_id` is **UNIQUE** — an outcome is measured **once**, at the
defined window. Meta revises attribution for ~45 days, so re-measuring later
would silently rewrite history with different numbers; the verdict is "what
the defined window showed", not "what we believe today." Enforced with
`ON CONFLICT (recommendation_id) DO NOTHING` in `measureOne`, so a concurrent
or repeated tick can never double-score.

Columns: the four window-boundary `DATE`s, `before_features`/
`after_features`/`delta` (JSONB, shape = `OutcomeFeatures`/`OutcomeDelta` from
`outcomes.ts`), `verdict` (`TEXT` + `CHECK` listing all six values —
widening it later needs the same drop/re-add-constraint migration as any
other enum-shaped column, see [DATA_MODEL.md](../DATA_MODEL.md#enum-shaped-text-columns-need-a-migration-to-widen-every-time)),
`confound_detail` (JSONB, null unless confounded), `lead_quality_before`/
`_after` (JSONB, nullable).

**Reading the DATE columns back:** always via `to_char(col, 'YYYY-MM-DD')` in
the query, never the raw driver value. `pg` parses a `DATE` column as a
local-midnight JS `Date`; calling `.toISOString()` on it (UTC) can shift the
date across a day boundary depending on the machine's timezone —
`insight_snapshots.dailySeries` already reads `period_start` this exact way
for this exact reason (`snapshot-store.ts`), and it's the fix that landed the
one initially-failing assertion in
`outcome-measurement.integration.test.ts` (which read a `DATE` column raw and
got `2026-08-02` back for a stored `2026-08-03` on a machine in
`Asia/Jerusalem`, UTC+3). `recommendation-oversight.ts`'s admin-console query
follows the same convention.

## The tick

Step **3** of the engine loop (`index.ts`), after ingestion → generation.
Ordering is deliberate: it reads only already-ingested snapshots, and running
it last means an outcome recorded this tick is available to the **next**
tick's rules. Needs no Meta token — `buildOutcomeTick` is never inert, unlike
ingestion/generation which build to `null` without one. Wrapped in its own
try/catch: a measurement failure logs and never fails an otherwise-successful
ingest+generate tick, and one recommendation's measurement failing
(`runOutcomeTick`'s per-row try/catch) never blocks the others.

## Ops console

`AdminRecommendations.tsx` (`/admin/recommendations`), on top of the
AIC-46 oversight surface documented in [ops-console.md](ops-console.md#recommendations-oversight-aic-46):

- **Per-recommendation outcome block**, shown in the detail panel for any
  `state='executed'` row: verdict, before/after CPL, the raw delta, the exact
  window dates, when it was measured, and the confound detail (which other
  action, or which zero-spend day) when the verdict is `confounded`. Reads
  `AdminRecRow.outcome` (`recommendation-oversight.ts`'s
  `listRecommendationsForAdmin`, `LEFT JOIN recommendation_outcomes`) — `null`
  when a rec hasn't reached its measurement window yet, shown as "not yet
  measured", never blank.
- **Fleet-wide aggregate by type**, at the top of the page — "how many of
  each recommendation type were executed, and what did they do to CPL."
  `GET /admin/recommendations/outcomes-summary` →
  `getOutcomeAggregate(pool)`, its **own** query (two `GROUP BY`s merged in
  JS), deliberately **not** a client-side rollup over the 300-row-capped list
  above — that list is a recent-tail triage view and would silently
  undercount the moment more than 300 recommendations exist.

**Customer-facing outcome copy was deliberately not built.** With zero
measured outcomes in production, there's nothing to show yet, and the
ticket's own scope says this is "later/optional, once the measurement is
trusted internally."

## Live status (honest note)

Ships **unexercised in production** — the `recommendations` table has zero
rows that have ever reached `state='executed'` (the one live account,
GelNails, hasn't had a real recommendation fire yet — thin data). Verified
instead by a seeded end-to-end run against the real DB: a throwaway executed
recommendation + before/after daily snapshots engineered to produce a known
CPL delta, run through the **real** `runOutcomeTick`, asserting the persisted
row's verdict and delta match the arithmetic, then confirming the ops console
renders both the per-rec block and the fleet aggregate — every throwaway row
deleted afterward. Re-verify with a real measured outcome once the engine
actually executes something on a live account.

## Known gaps / follow-up triggers

- **Recalibrate the materiality band from real outcomes.** 25% is inherited
  from `BUDGET_CPL_RISE_PCT`, not derived from any measured result yet.
  Trigger: the first batch of real measured outcomes. Settle then whether
  `improved`/`degraded` should be **asymmetric** — a worsening may deserve
  attention sooner than a gain deserves celebration, since the downside is a
  customer's money.
- **Revisit `not_measurable` for `replace_creative`** when AIC-63/AIC-79 give
  creative replacement a real tracked execution with a real timestamp.
- **Judge `replace_creative` on ops-ticket response time meanwhile** — "filed
  7, acted on 2" is a real, honest signal about whether the rule is useful,
  without pretending to measure a CPL effect it never produced directly.
- **Split `COOLDOWN_DAYS` into two keys** only if real evidence shows an
  account genuinely needs asymmetric measure/cooldown windows. Cheap to add
  later (every caller already resolves through `resolveThresholds`);
  premature now would trade coherence for a guess.
