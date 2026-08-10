# Recommendation rules & the LLM boundary

**Status:** live — deterministic rules v1 (AIC-9). The LLM boundary section is
filled by AIC-10.

**Source of truth:** `server/src/recommendations/rules.ts` (thresholds + rules),
`server/src/recommendations/rule-evaluator.ts` (evidence assembly + persistence).
**Lock-in tests:** `rules.test.ts`, `rules.adset.test.ts`, `rule-evaluator.test.ts`,
`generation.test.ts`, `audience-label.test.ts`.

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
   **Compared WITHIN an ad set (AIC-36):** the same creative running under two
   audiences is never pitted against itself; creatives are grouped by `adSetId`
   (from the snapshot's `parent_meta_id`) and the peer comparison runs per group.
   Creatives with no known ad set fall into one group (single-ad-set campaigns
   behave exactly as before). **Skips ad sets running Meta's Dynamic/
   Advantage+ creative** (see below) — their per-creative CPL isn't reliable
   enough to compare as peers.
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

### Audience rule — `pause_underperforming_audience` (AIC-36; LIVE since AIC-39)

A managed campaign can have **N ad sets** (audience splits). When one audience's
CPL is ≥ `AUDIENCE_CPL_MULTIPLIER` (2×) the best audience's over enough data — both
audiences spent ≥ `AUDIENCE_MIN_SPEND_AGOROT` (₪300, a **stricter** gate than the
creative rule) and the winner has ≥ `AUDIENCE_MIN_LEADS` (5) — it proposes
**pausing the worse ad set** (`pause_adset`). Under CBO the budget then shifts to
the winner, so `maxSpendImpactAgorot = 0` (no new spend). It's a real
delivery/spend change → approval-gated through AIC-23 → AIC-12, with a live
`pauseAdSet` write (verified read-back on the ad set's status). Budget rules stay
**campaign-level** — no per-ad-set budget writes (CBO owns the split).

**Errored ad sets are excluded (AIC-39).** Meta Insights can't distinguish an
*errored / not-delivering* ad set (near-zero spend, 0 leads, ∞ CPL) from a
genuinely weak one. AIC-39 fetches `effective_status` + `issues_info`
([delivery-health.md](features/delivery-health.md)) and drops any not-delivering
ad set (and its creatives) from the evidence — so this rule only ever compares
genuinely-delivering audiences and never proposes pausing a broken one. That
exclusion is what made the rule safe to run live.

**Dynamic/Advantage+ creative is skipped, never compared (AIC-36).** When an ad
set mixes multiple images/videos/bodies/titles per impression (Meta's Dynamic
Creative, aka "Advantage+ creative" — the account-level default for new ad
sets, so real customers arrive with this constantly), Meta does not expose a
reliable per-asset CPL. Treating that unreliable breakdown as independent
"peers" and pausing the apparent loser would be a wrong recommendation on the
engine's own first read of the data — the exact trust-killer the whole
safe-execute design exists to prevent. `getAdSetMeta` fetches
`is_dynamic_creative` per ad set (cached in `ad_set_meta`, migration 019,
alongside the AIC-37 targeting fields, refreshed by the same engine tick);
`runGenerationTick` builds a `flexibleCreativeAdSetIds` set from it and
`pause_weak_creative` skips those ad sets' groups entirely — the campaign's
other (non-flexible) ad sets are still compared normally, and the audience
rule (`pause_underperforming_audience`, below — reads `ev.adsets`, not
`ev.creatives`) is **unaffected**: the ad-set-level CPL a flexible ad set
reports is still real, only the *per-asset* breakdown inside it isn't.

**Named by its human dimension (AIC-37).** The explainer never says "ad set" or
an ad-set id — `evidence.audienceLabel` carries a label like `"35–45"`, derived
by [`deriveAudienceLabels`](../server/src/meta/audience-label.ts) from whatever
actually differs between the campaign's ad sets (age → gender → geo, falling back
to the ad set's own Meta name). Labels are fetched + cached (`ad_set_meta`,
migration 015) by the same engine tick that reads delivery health, and threaded
into the rule's evidence via `buildCampaignEvidence`'s `adSetLabels` param — never
a live Meta call at render time. See
[customer-overview.md](features/customer-overview.md#opt-in-audience-details-aic-37)
for the customer-facing opt-in details view this same label feeds.

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

The LLM **explains; it never decides.** It never chooses or alters a budget, a Meta
ID, whether an action is permitted, a campaign status, a spend limit, whether enough
data exists, or any API call — all of those arrive already-decided from the
deterministic engine.

Enforced structurally (`server/src/recommendations/explainer.ts`):
- The **template is the source of truth**. `explain(rec)` injects every figure from
  the structured record by code (`formatShekel`, lead counts) and always renders —
  the deterministic-safe fallback that needs no LLM.
- `explainWithLlm(rec, llm)` may only **rephrase** the template. The result is
  accepted **only if** every `requiredFigures(rec)` string survives verbatim **and**
  no Ads Manager jargon appears; otherwise (or on empty output / throw / no LLM) it
  returns the template. So a model can never invent or move a number that moves real
  money, and can never leak jargon.

Tests (`explainer.test.ts`): number-fidelity (rendered figures == structured input),
jargon-absence, fallback path, and rejection of a rephrase that changed a number or
introduced jargon.
