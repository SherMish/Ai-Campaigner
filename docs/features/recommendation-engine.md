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

## Not built yet
- Deterministic rules that emit drafts (AIC-9) → `docs/RULES.md`
- Proactive staleness/expiry on a tick (AIC-11)
- LLM explainer that renders a draft as plain Hebrew (AIC-10)
