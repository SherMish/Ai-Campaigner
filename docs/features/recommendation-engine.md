# Recommendation engine

**Status:** live — state machine (AIC-8), rules (AIC-9), staleness (AIC-11), and
the LLM explainer (AIC-10) are all in place, and the **scheduled evaluator** now
runs them in the engine loop (ingest → generate) so recommendations are produced
automatically for managed campaigns.

**Source of truth:**
- State machine: `server/src/recommendations/state-machine.ts`
- Types: `server/src/recommendations/types.ts`
- Store: `server/src/recommendations/recommendation-store.ts` (pg + in-memory)
- Service: `server/src/recommendations/recommendation-service.ts`
- Scheduled evaluator: `server/src/recommendations/generation.ts`, wired in `server/src/index.ts`

**Lock-in tests:** `server/src/recommendations/state-machine.test.ts`,
`recommendation-service.test.ts`, `recommendation-store.integration.test.ts`,
`generation.test.ts`, `generation.integration.test.ts`.

---

## State machine (AIC-8)

A recommendation moves real ad spend, so its lifecycle is modeled explicitly, not
as a free-text status:

```
proposed → approved | dismissed | expired
approved → executing
executing → executed | failed
(executed, failed, dismissed, expired are terminal)
```

`assertTransition` rejects every illegal move **before any write** — you cannot
approve an `expired` or `dismissed` rec, cannot execute one that was never
approved, cannot re-run an `executed` one. `no_action` is a first-class *type*
(not the absence of a rec), so "we looked and chose not to act" is recorded.

**Service.** `RecommendationService` wraps each transition with (1) the state
machine check and (2) the store's **optimistic guard** (`setState` only succeeds
if the row is still in the expected `from` state; a lost race throws
`StaleRecommendationError` rather than clobbering). `completeExecution` transitions
`executing → executed|failed` **and** writes the PRD §23 audit row to
`action_history` (what / previous / new / why / who / human / when / result) — the
one place a real change is logged.

## Deterministic rules (AIC-9)

A campaign is evaluated by pure rules over `insight_snapshot`-derived evidence,
emitting exactly one `RecommendationDraft` per tick — an acting type or
`no_action`. The minimum-evidence gates (below which nothing fires) are the hard
part; thresholds and rule priority are documented in [../RULES.md](../RULES.md).
`rule-evaluator.ts` assembles the evidence (current/previous window totals +
per-creative rows), runs `evaluateCampaign`, and persists an acting draft as a
`proposed` rec — **deduped** against existing proposed recs (same type+target) so
repeat ticks don't pile up, and `no_action` is never stored as a `recommendations`
row. Its structured reason IS cached, separately, per campaign (AIC-64 —
`managed_campaigns.no_rec_reason`, see [../RULES.md](../RULES.md#why-theres-no-recommendation-aic-64))
so the dashboard/ops console can show WHY without re-running evaluation.

**The feature layer (AIC-75).** The rules don't compute their own metrics —
`rules.ts` calls named, independently-tested functions from
`recommendations/features.ts` (peer-CPL comparison, ad-set grouping,
spend-without-lead, real per-day activity counts) instead of inlining that
math. See [../FEATURES.md](../FEATURES.md) for the full metric catalogue; the
refactor onto it made no behaviour change (pinned by characterization tests in
`rules.test.ts` written before the refactor).

Source: `server/src/recommendations/rules.ts`, `features.ts`, `rule-evaluator.ts`.
Tests: `rules.test.ts` (each rule fires when it should and, crucially, does
**not** on thin evidence), `features.test.ts`, `rule-evaluator.test.ts`.

## Staleness / expiry (AIC-11)

`refreshRecommendations` is the canonical evaluation tick. A `proposed` rec is
valid **iff the same gated rules, run on current evidence, still produce an
equivalent recommendation** (same type + target) — that is the "material
divergence" test. If the weak creative recovered, CPL swung back, or delivery
changed so the rules no longer call for the action, the rec is `expired` (and,
where a different action is now warranted, a fresh rec replaces it). An expired rec
is un-approvable by construction (the state machine). Rules are the single source
of truth for both producing *and* invalidating a recommendation.

Source: `server/src/recommendations/staleness.ts`. Tests: `staleness.test.ts`
(evidence-holds → stays; evidence-diverged → expires; expired → un-approvable;
replaced when a new action is warranted).

## Scheduled evaluator — the engine loop (AIC-9)

`generation.ts` is the harness that actually runs the engine in production. It's
wired into the same scheduler as ingestion (`index.ts`), and generation runs
**after** ingestion in each tick so it evaluates the freshest snapshots:

```
engine tick → ingest snapshots (+ connection health) → generate recommendations
```

- `listEligibleForGeneration(pool)` selects campaigns that are `status = 'active'`,
  `automation_enabled`, linked to a Meta campaign, and on an `access_health = 'ok'`
  connection. Execution-frozen still generates (a freeze blocks *execution*, not
  proposals); unmanaged / paused / automation-off / unhealthy do not.
- `runGenerationTick(...)` reads each campaign's **live daily budget** from the Meta
  reader (the rules propose relative to it) and calls `refreshRecommendations`
  (the staleness tick above) — so one function both creates fresh proposals and
  expires ones the rules no longer support. A campaign whose live budget can't be
  read is **skipped, never guessed**. It returns a summary
  (`evaluated / created / expired / skipped`) that the tick logs.
- `buildGenerationTick(pool)` returns `null` when no System-User token is set, so
  the loop stays inert until Meta is wired up — same contract as ingestion.
- It only **proposes**. A recommendation becomes a real Meta change solely when the
  customer approves it (customer-recommendations → the safe-execute pipeline). No
  LLM here; generation is fully deterministic.

The scheduler (`services/scheduler.ts`) runs one tick immediately on start (not
after a full interval), so a fresh boot/deploy doesn't leave up to an hour with no
ingestion or generation.

Source: `server/src/recommendations/generation.ts`. Tests: `generation.test.ts`
(proposes + dedupes on repeat, thin evidence → nothing, unreadable budget → skip),
`generation.integration.test.ts` (the eligibility filter).

## LLM explainer (AIC-10)

`explain(rec)` renders a recommendation as plain business Hebrew from a centralized
copy table, injecting every figure from the structured record by code — the
deterministic fallback that always works. `explainWithLlm(rec, llm)` optionally
smooths phrasing but accepts the model's text **only if** every required figure
survives verbatim and no Ads Manager jargon appears; otherwise it returns the
template. The LLM explains, never decides. Full boundary in [../RULES.md](../RULES.md).

Source: `server/src/recommendations/explainer.ts`. Tests: `explainer.test.ts`.
