# Approval & safe execution

**Status:** in progress — AIC-13 (budget safety + idempotent outbox) done. The
safe-execute pipeline (AIC-12) and emergency controls (AIC-14) extend this doc.

**Source of truth:**
- Budget safety: `server/src/execution/budget.ts`
- Idempotent write outbox: `server/src/execution/write-outbox.ts`, migration `008_meta_write_outbox.sql`

**Lock-in tests:** `server/src/execution/budget.test.ts`,
`server/src/execution/write-outbox.integration.test.ts`.

---

## Budget safety (AIC-13)

The customer's agreed budget (`managed_campaigns.agreed_budget_agorot`) is a hard
ceiling. `assertWithinBudget(agreed, proposed)` rejects any proposed daily budget
above it or ≤ 0; a `null` proposed (pause/replace — not a budget change) passes.
No budget changes automatically — only an approved recommendation, executed through
the pipeline, can move budget, and the customer sees the exact new amount +
`maxSpendImpactAgorot` before approving (carried on the recommendation from AIC-9).

## Idempotent write outbox (AIC-13)

`meta_write_outbox` is a durable queue of intended mutations, each with a **unique
idempotency key** (`recommendationId:kind:targetId`). `enqueue` is a no-op on a
repeat key, so proposing/approving the same change twice can't create two writes.
`drainOnce` claims eligible rows with `FOR UPDATE SKIP LOCKED` (concurrent workers
don't contend), applies each via a `MetaWriter`, marks `succeeded` (terminal, never
re-run) or backs off and retries to `MAX_ATTEMPTS`. Only **absolute-set, naturally
idempotent** ops are enqueued (`set_daily_budget`, `pause_ad`), so a lost-response
retry re-applies to the same end state — no double budget-bump, no double pause.

## Not built yet
- Safe-execute pipeline: sync → detect-external-change → verify → guard → execute →
  read-back → log (AIC-12)
- Emergency controls + failure → ops queue (AIC-14)
