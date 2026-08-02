# Recommendation engine

**Status:** in progress — AIC-8 (state machine) done. Rules (AIC-9), staleness
(AIC-11), and the LLM explainer (AIC-10) extend this doc as they land.

**Source of truth:**
- State machine: `server/src/recommendations/state-machine.ts`
- Types: `server/src/recommendations/types.ts`
- Store: `server/src/recommendations/recommendation-store.ts` (pg + in-memory)
- Service: `server/src/recommendations/recommendation-service.ts`

**Lock-in tests:** `server/src/recommendations/state-machine.test.ts`,
`recommendation-service.test.ts`, `recommendation-store.integration.test.ts`.

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
repeat ticks don't pile up, and `no_action` is never stored as a row.

Source: `server/src/recommendations/rules.ts`, `rule-evaluator.ts`. Tests:
`rules.test.ts` (each rule fires when it should and, crucially, does **not** on
thin evidence), `rule-evaluator.test.ts`.

## Not built yet
- Proactive staleness/expiry on a tick (AIC-11)
- LLM explainer that renders a draft as plain Hebrew (AIC-10)
