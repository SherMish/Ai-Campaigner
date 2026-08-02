# Recommendation rules & the LLM boundary

**Status:** live — deterministic rules v1 (AIC-9). The LLM boundary section is
filled by AIC-10.

**Source of truth:** `server/src/recommendations/rules.ts` (thresholds + rules),
`server/src/recommendations/rule-evaluator.ts` (evidence assembly + persistence).
**Lock-in tests:** `rules.test.ts`, `rule-evaluator.test.ts`.

---

## The gates matter more than the rules

"Doing nothing is valid." A rule that fires on one lead of data is worse than no
product — it erodes the trust the ₪299/mo proposition depends on. Below the gate,
the evaluator emits `no_action` (never a forced change). **No LLM anywhere** in the
rules — output is fully structured; the LLM only *explains* it (AIC-10).

### Global minimum-evidence gate
Every acting rule requires all of:

| Threshold | Value | Meaning |
| --- | --- | --- |
| `MIN_DAYS_DATA` | 3 | don't judge on < 3 days of data |
| `MIN_DELIVERY_DAYS` | 3 | give delivery time to leave the learning phase |
| `MIN_CAMPAIGN_LEADS` | 5 | a campaign needs some volume before we act |

Below the gate → `no_action` with reason `insufficient_evidence`. Gate met but no
rule fires → `no_action` with reason `stable`.

## Rules v1 (evaluated in priority order)

Targeted creative fixes come before blunt budget moves; scaling comes last.

1. **pause_weak_creative** — a creative spent ≥ `MIN_CREATIVE_SPEND_AGOROT` (₪150)
   yet its CPL is ≥ `PAUSE_WEAK_CPL_MULTIPLIER` (2×) the best peer's — or it spent
   that much for zero leads — while ≥ `PAUSE_MIN_PEERS` (2) creatives have data.
2. **replace_creative** — a creative's own CPL decayed ≥ `REPLACE_DECAY_MULTIPLIER`
   (1.5×) vs its previous window (distinct from "weak vs peers"). Needs previous-
   window per-creative data.
3. **decrease_budget** — campaign CPL rose ≥ `BUDGET_CPL_RISE_PCT` (25%) window-
   over-window. Proposes −`BUDGET_DECREASE_STEP` (20%).
4. **increase_budget** — CPL not worse **and** leads not fewer window-over-window,
   with a strict improvement on at least one axis (a flat campaign is `no_action`,
   not a manufactured scale-up). Proposes +`BUDGET_INCREASE_STEP` (15%).

All thresholds are named constants in `RULE_THRESHOLDS` (one place). Budget changes
are only *proposed* here; the agreed-budget safety clamp is enforced at execution
(AIC-13), and every change needs customer approval.

### v1 approximations (documented, refined later)
- Trend rules compare the **current window vs the previous window** (not daily
  granularity) — sufficient for v1; daily snapshots are a later refinement.
- `deliveryDays` is approximated from the current window length; a true learning-
  phase-exit signal from Meta is not yet ingested.
- Budget rules use **relative movement** (window-over-window), not an absolute CPL
  target (no target-CPL field exists yet).

## Staleness
A `proposed` recommendation expires when its evidence **materially diverges**,
defined precisely as: the same gated rules, run on current evidence, no longer
produce an equivalent recommendation (same type + target). See
[recommendation-engine.md](features/recommendation-engine.md) (AIC-11).

## LLM boundary (AIC-10)
_To be documented when the explainer lands: the LLM explains, never decides; every
figure is passed in and echoed verbatim._
