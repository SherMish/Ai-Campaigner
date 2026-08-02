# Approval & safe execution

**Status:** in progress — AIC-13 (budget safety + idempotent outbox) done. The
safe-execute pipeline (AIC-12) and emergency controls (AIC-14) extend this doc.

**Source of truth:**
- Safe-execute pipeline: `server/src/execution/safe-executor.ts`
- Budget safety: `server/src/execution/budget.ts`
- Idempotent write outbox: `server/src/execution/write-outbox.ts`, migration `008_meta_write_outbox.sql`
- Customer copy: `server/src/execution/strings.he.ts`

**Lock-in tests:** `server/src/execution/safe-executor.test.ts`, `budget.test.ts`,
`write-outbox.integration.test.ts`.

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

## Safe-execute pipeline (AIC-12)

`SafeExecutor.execute(recId)` runs when an approved recommendation is executed —
the most correctness-critical path (it moves real money on someone else's account).
Ordered, each step can abort:

1. **Relevance** — only an `approved` rec proceeds (belt with AIC-8/AIC-11).
2. **Access health** (AIC-5) — lost access is a **hold**: the rec stays `approved`
   to retry after reconnect, an ops item is raised, the customer sees the reconnect
   message. Not a failure.
3. **Emergency controls** (AIC-14) — a stop is an intentional hold: rec stays
   `approved`, no ops noise.
4. Claim `approved → executing` (from here any problem ends in `failed`).
5. `replace_creative` → escalate to ops as a human task (no Meta write), mark
   executed with `humanInvolved`.
6. **Sync** live state; **detect external change** — budget rec: live daily budget
   ≠ captured → **fail + cancel** (never overwrite someone else's edit); pause rec:
   target ad no longer active → fail.
7. **Budget safety** (AIC-13) — over the agreed ceiling → fail before Meta.
8. **Execute** the idempotent absolute-set op.
9. **Verify read-back** — a mismatch is a **failure, not a success**.
10. **Log** the real change to `action_history` and mark `executed`.

Every abort/failure raises an `ops_queue_item` and returns a plain-Hebrew customer
message; a failed execution **never leaves a rec looking succeeded**. All ten
scenarios (happy budget + pause, replace escalation, wrong-state, external-change
×2, over-budget, read-back mismatch, access-lost hold, automation-stop hold) are
covered by `safe-executor.test.ts`.

## Not built yet
- Emergency-control state + failure→ops surfacing (AIC-14 fills the control gate)
