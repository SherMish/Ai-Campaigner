# Approval & safe execution

**Status:** in progress — AIC-13 (budget safety + idempotent outbox) done. The
safe-execute pipeline (AIC-12) and emergency controls (AIC-14) extend this doc.

**Source of truth:**
- Safe-execute pipeline: `server/src/execution/safe-executor.ts`
- Budget safety: `server/src/execution/budget.ts`
- Live budget sync (dashboard display + ceiling auto-raise): `server/src/services/live-budget.ts`
- Idempotent write outbox: `server/src/execution/write-outbox.ts`, migration `008_meta_write_outbox.sql`
- Customer copy: `server/src/execution/strings.he.ts`

**Lock-in tests:** `server/src/execution/safe-executor.test.ts`, `budget.test.ts`,
`write-outbox.integration.test.ts`, `services/live-budget.integration.test.ts`.

---

> **Scope note (AIC-66).** This doc covers the *approval-gated* path: the engine
> proposes, the customer approves, `SafeExecutor` executes. **Manual controls —
> a human directly pausing/resuming/archiving their own ad or ad set — are a
> separate, non-approval path** with its own module and pipeline; see
> [manual-controls.md](manual-controls.md). It deliberately does not reuse
> `SafeExecutor`, which is recommendation-bound at every step.
>
> Also note the vocabulary clash: **AIC-14's "pause" below means *stop our
> automation*, a DB flag** that never touches Meta. AIC-66's "pause" means
> *stop this ad from delivering*, a real Meta write. They're unrelated
> mechanisms with the same English word.

## Budget safety (AIC-13)

The customer's agreed budget (`managed_campaigns.agreed_budget_agorot`) is a hard
ceiling. `assertWithinBudget(agreed, proposed)` rejects any proposed daily budget
above it or ≤ 0; a `null` proposed (pause/replace — not a budget change) passes.
No budget changes automatically — only an approved recommendation, executed through
the pipeline, can move budget, and the customer sees the exact new amount +
`maxSpendImpactAgorot` before approving (carried on the recommendation from AIC-9).

**The ceiling applies to CREATION too, and it is read there, never written
(AIC-106).** Until 2026-08-19 it did not, in two compounding ways found by
tracing every caller rather than trusting the module's name:

1. `assertWithinBudget` had exactly ONE caller — `safe-executor.ts`, the
   recommendation path. Nothing bounded a campaign CREATE at all.
2. Worse, `builder/campaign-create.ts`'s closing UPDATE **set**
   `agreed_budget_agorot = input.dailyBudgetAgorot`. The builder proposed a
   budget *and* rewrote the ceiling to match it, in either direction — a build
   under the agreed figure silently ratcheted the customer's agreement DOWN,
   and every later recommendation was then measured against a number nobody
   agreed to. The ceiling authorised itself.

A passing test was holding (2) in place: `campaign-create.integration.test.ts`
asserted `agreed_budget_agorot === 4000` after a build — i.e. it encoded the
overwrite as the expected behaviour. Worth remembering when a bug survives a
covered path: check whether a test is defending it.

`assertCreateWithinBudget(agreed, proposed)` is the create-path guard, run
BEFORE the first Meta call so an over-ceiling campaign never exists on Meta at
all, not even PAUSED. It is separate from `assertWithinBudget` because creation
has a precondition update never had: on an update the campaign is already
running under an agreed ceiling, so one exists by definition; on a create it
may never have been set. Measured 2026-08-19: 13 of 15 campaign rows carried
`agreed = 0` (12 `__it_*` leftovers plus one real customer provisioned but not
yet built). So it **fails closed** — 0/null is refused, not read as unlimited.
The alternative would make the most dangerous state the most permissive one,
precisely when AIC-106 removes the human checkpoint.

The two failures are deliberately distinct types and HTTP codes, because they
have different fixes — agree a budget at provisioning vs. lower the number:

| Condition | Error | Route | `code` |
| --- | --- | --- | --- |
| no ceiling ever agreed (0/null) | `BudgetCeilingMissingError` | 409 | `budget_ceiling_missing` |
| proposed above the ceiling | `BudgetLimitError` | 409 | `budget_over_ceiling` |

Both were previously **502 "failed to build campaign"** — "Meta is broken" —
about a precondition entirely on our side, which sends an operator mid-call to
inspect Meta instead of filling one field. Failing closed while lying about
why is only half a guard.

Scope note: the additions path (AIC-63) needs no ceiling check. Budget is
campaign-level (CBO) and neither `AddAdInput` nor `AddAdSetInput` carries a
budget field, so a new ad or ad set delivers WITHIN the campaign's existing
budget and cannot raise it — confirmed by grep, not just by the comment.

**`agreed_budget_agorot` vs the live Meta budget (real bug fixed 2026-08-12).**
The ceiling is deliberately NOT a live mirror of Meta — it's the max the engine's
own automated proposals may ever push the daily budget to. But a customer or
operator can (and does) change the daily budget directly on Meta, bypassing the
app entirely; when that happens the ceiling silently goes stale, and if the new
live budget exceeds it, ANY future `decrease_budget` proposal (computed relative
to the current live budget) would throw `BudgetLimitError` at execution — the
ceiling ends up blocking a change smaller than what's already running.

Fixed via `server/src/services/live-budget.ts` `recordLiveBudget`, called every
generation tick right after the engine's existing live-budget read (`generation.ts`
already fetches it to evaluate rules — this just also caches it): writes
`managed_campaigns.live_budget_agorot`/`live_budget_checked_at` (migration 025) for
display, and **auto-raises** `agreed_budget_agorot` to `GREATEST(agreed, live)` —
never lowers it, so an operator's forward-looking pre-authorization (raising the
ceiling ahead of an intended future increase, before Meta's live budget has caught
up) is never silently reverted. The customer dashboard (`Home.tsx`, `Settings.tsx`)
shows `liveBudgetAgorot ?? agreedBudgetAgorot` — the live-synced number when the
engine has ticked at least once, falling back to the ceiling before that.

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

## Emergency controls + failure handling (AIC-14)

Per-account kill-switches, all effective immediately (DB flags, no deploy),
exposed at `POST /api/admin/campaigns/:id/controls` `{action}`:
- `disable_automation` / `enable_automation` — stop/resume generation + acting
- `freeze_execution` / `unfreeze_execution` — freeze execution, keep monitoring
- `mark_unmanaged` — status → unmanaged
- `pause_management` — stop generation **and** execution, keep monitoring

`ControlService.assertExecutable(campaignId)` is the control gate the SafeExecutor
calls before any Meta write — flipping any switch halts execution on the next
attempt (an in-flight rec stays `approved`, retryable). Generation respects
`isAutomated` (already filtered in the ingestion tick's campaign list).

**Failure handling** is enforced by the pipeline (AIC-12): every abort/failure
records the cause, writes a `failed` `action_history` row, raises an
`ops_queue_item`, and returns a plain-Hebrew customer message — a failure never
looks succeeded. Source: `control-service.ts` (migration 009), executor `fail()`.
Tests: `control-service.test.ts` (gate per flag; kill-switch halts a batch
mid-way). Telegram alerting on failures and ops-console surfacing are wired with
the ops console (P0.4, AIC-16/17); the logger seam is in place.

Source: `server/src/execution/control-service.ts`. Migration `009_execution_controls.sql`.
