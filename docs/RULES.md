# Recommendation rules & the LLM boundary

**Status:** live — deterministic rules v1 (AIC-9), configurable per-account
thresholds (AIC-77a). The LLM boundary section is filled by AIC-10.

**Source of truth:** `server/src/recommendations/rules.ts` (thresholds +
`resolveThresholds` + rules + no-rec reason classification),
`server/src/recommendations/features.ts` (the named metrics the rules call —
see [FEATURES.md](FEATURES.md)), `server/src/recommendations/rule-evaluator.ts`
(evidence + threshold resolution + persistence), `server/src/services/customer-admin.ts`
(threshold override writes + validation), `server/src/services/evaluation-reason.ts`
(caches the reason per campaign, AIC-64).
**Lock-in tests:** `rules.test.ts`, `rules.adset.test.ts`, `features.test.ts`,
`rule-evaluator.test.ts`, `staleness.test.ts`, `generation.test.ts`,
`audience-label.test.ts`, `customer-admin.integration.test.ts`.

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

Below the gate, or gate met but no rule fires, the evaluator emits `no_action` —
never silently the same message twice (AIC-64). See below.

### Why there's no recommendation (AIC-64)

"No recommendation" used to be one undifferentiated `no_action` — the customer
saw the identical reassurance whether the campaign was genuinely stable or the
engine was structurally blind at the current budget. `classifyNoAction`
(`rules.ts`) now picks one of nine reasons, in priority order — `cooling_down`
(AIC-77b) is decided inside `evaluateCampaign` itself, before falling through
to `classifyNoAction`, since it's the one reason that depends on a rule
having actually fired (see [Cooldown](#cooldown-aic-77b) below):

| Reason | When | Actionable? |
| --- | --- | --- |
| `delivery_blocked` | An ad set was excluded from evidence (AIC-39) — checked FIRST, even if the gate would otherwise pass, since a delivery problem is usually the root cause of thin data | fix the delivery problem |
| `tracking_broken` | The campaign's declared `lead_event_types` doesn't match what its ad sets are configured on Meta to optimize for (AIC-88) — checked SECOND, before even the pre-gate AIC-86 advisory: the lead count itself is structurally wrong (not thin, WRONG), so nothing may act on it, including advice | fix the lead-definition mismatch (see [tracking-health.md](features/tracking-health.md)) |

> **`tracking_broken` was unreachable on the dashboard until 2026-08-22.** The
> reason was wired end to end — classifier, customer copy, ops label — but
> `managed_campaigns.no_rec_reason`'s CHECK constraint was last widened in
> migration 035, before this reason existed. `recordNoRecReason`'s write is
> wrapped in a swallowing try/catch, so every attempt raised a constraint
> violation, was logged, and the column stayed stale. A campaign with broken
> tracking could never say so. Fixed in migration 042 — and it is exactly the
> silent-failure class this document warns about below, which had already
> happened without anyone noticing.

| `budget_below_threshold` | `dailyBudgetAgorot × 7 < MIN_CREATIVE_SPEND_AGOROT` — the campaign's own 7-day rolling window can never reach the cheapest rule's spend gate, so no amount of *time* fixes it | raise the budget |
| `collecting` | Below the minimum-evidence gate (days/delivery-days/leads), but the budget COULD reach it with more time | wait |
| `cooling_down` | Gate passed and a rule genuinely WOULD have fired, but its class executed successfully within `COOLDOWN_DAYS` — reported ONLY when something would have fired and was suppressed, never as a placeholder | wait for the cooldown to elapse |
| `no_comparable_creatives` | Fewer than 2 real creatives — AIC-85. **Rarely actually stored**: the [AIC-86 advisory rule](#comparability--the-add_creatives_for_comparison-advisory-aic-85-86) intercepts this exact condition before `classifyNoAction` is ever reached, and produces a real recommendation instead. Kept for completeness/defensive correctness | add creatives (a real recommendation says this — see below) |
| `no_comparable_audiences` | Gate passed, no rule fired, and fewer than 2 ad sets are real (non-dormant) audience-comparison data — AIC-85, replaces `single_ad_set`; see below for why | none needed |
| `below_object_evidence_floor` | Comparable creatives or audiences EXIST (≥2 real ones), but none has individually cleared the absolute spend gate yet — AIC-85, genuinely different from "nothing to compare at all" | wait |
| `stable` | Gate passed, no rule fired, everything genuinely evaluated and healthy | none needed |

`budget_below_threshold` is the AIC-64 headline case: at GelNails' real ₪10/day
budget, 7 × ₪10 = ₪70/week — under `MIN_CREATIVE_SPEND_AGOROT` (₪150), so
`pause_weak_creative`/`replace_creative` can **never** fire, regardless of how
long the campaign runs. `collecting` and `budget_below_threshold` were
previously the same code (`insufficient_evidence`) — splitting them is the
difference between an honest "wait" and an honest "this needs a decision."

**Real bug, found and fixed (AIC-75):** `ev.current.leads` was silently
**double-counted** — `PgSnapshotStore.campaignTotals`'s window query matched
both a rolling 7-day campaign row and the disjoint daily rows covering the
same days, so 4 real leads read as 8. `MIN_CAMPAIGN_LEADS` (5) passed on the
doubled figure when the true count should have failed it, so the gate was
skipped and evaluation fell through to `stable` — "הכל עובד כרגיל" — on a
campaign that was really still `collecting`. Fixed at the data layer, not
here: see [DATA_MODEL.md](DATA_MODEL.md#the-disjoint-daily-view-migration-030).

**Where it's cached.** The reason a tick computes is written to
`managed_campaigns.no_rec_reason`/`no_rec_detail`/`no_rec_checked_at`
(migration 024, widened by migration 032 to accept `cooling_down`,
`server/src/services/evaluation-reason.ts`) every generation tick — cleared
back to `NULL` when an acting recommendation exists instead. Mirrors
`delivery_ok`/`delivery_reason` (AIC-39): the engine writes, the dashboard and
ops console read, with no live evaluation at render time. **A new reason
value always needs its own migration** — the column has a CHECK constraint
listing the valid values by name; widening it without a migration fails
*silently* inside `generation.ts`'s swallowing try/catch (the tick logs and
continues, the reason is just never cached).

**Customer surface**: `web/src/app/Home.tsx`'s no-action card picks distinct
Hebrew copy per reason (`strings.ts` → `home.noRec`), with a CTA to
`/app/settings` for `budget_below_threshold`. `delivery_blocked` never reaches
this card — `deriveHomeState` (`customer-overview.ts`) already routes a
delivery problem to the `attention` state before this branch is reached, so
the two surfaces are never in conflict. `cooling_down` **does** reach this
card (the campaign is still `homeState: "ok"`) with real copy — "we're
watching the last change" is an honest progress signal, not a placeholder.

**Ops surface**: the operator's customer-detail panel
(`web/src/admin/AdminCustomers.tsx`) shows the precise reason plus the exact
numbers from `no_rec_detail` (e.g. `₪10/יום × 7 = ₪70 < נדרש ₪150`) — sourced
from `getCustomerDetail` (`server/src/services/customers.ts`).

## Comparability & the `add_creatives_for_comparison` advisory (AIC-85/86)

**Status:** live. Found and fixed together, from a live GelNails investigation
(2026-08-14): `stable` was standing in for three genuinely different
situations at once — everything evaluated and healthy; nothing comparable
to evaluate AT ALL (so a rule structurally can't run, regardless of spend or
thresholds); and comparable objects that just haven't individually cleared
the spend gate yet. All three used to render identically, and `no_rec_detail`
was empty for `stable`, so the nuance wasn't even stored for the operator.

**"Comparable" is relative to campaign spend, not raw presence.** The bug
this fixes precisely: the old `single_ad_set` check counted
`ev.adsets.length` — any ad set present, including a technically-nonzero but
effectively-dormant one — which let a ₪2.35/week ad set silently count
toward "2 ad sets" and fall through to `stable`. `comparableCreatives`/
`comparableAdsets` (`rules.ts`) fix this: an object is "comparable" only when
`shareOfCampaignSpend(objectSpendAgorot, campaignSpendAgorot) >= 0.10`
(`shareOfCampaignSpend` already existed, AIC-75 — see
[FEATURES.md](FEATURES.md)). A fixed shekel floor was considered and
rejected: it breaks across account sizes (dormant in a ₪210/week campaign,
half the real delivery in a ₪50/week one). **10% is a chosen, scale-free
number — provisional, same treatment as `BUDGET_CPL_RISE_PCT`**, meant to be
recalibrated once AIC-76 has produced real outcomes to look at.

**Comparable ≠ EXISTING either — the third question, added AIC-117.** Both
counts above are derived from insight rows, so both answer questions about ads
that have *measured data*. Neither answers "how many ads are actually running",
and on a campaign built hours ago the two diverge completely: two ads live, zero
comparable. The advisory skips the evidence gates on the argument that *"there
is only one creative" is a COUNT, and no amount of additional data makes a count
more true* — sound, but it was reading `comparableCount`, which is not that
count. A real customer with two running ads was told only one was running and
advised to add more.

`CampaignEvidence.liveCreativeCount` carries the honest number:
delivery-health's `deliveringAdCount`, computed in the same tick from real
ad/ad-set status, and previously used only for the "מודעות פעילות" figure on
Home. **The advisory now fires only on positive evidence of exactly one ad**,
never on the absence of evidence:

| `liveCreativeCount` | Fires? | Why |
| --- | --- | --- |
| `1` | yes | exactly one ad delivering — the case the rule is for, and what its copy says |
| `>= 2` | no | they already have what it would ask for |
| `0` | no | nothing delivering: a paused campaign with five ads is indistinguishable from one with none, and creative advice on a stopped campaign is wrong anyway |
| unknown | only if exactly one creative has data | the original evidence-based case (a flexible ad, or a genuine single-creative campaign) |

The last row matters more than it looks. The first version of this fix treated a
missing count as zero, and a live tick immediately proved it wrong: delivery-health
was rate-limited (Meta code 17), the count came back `null`, and the rule fired
again on the very customer it was written for. Absence of evidence is not
evidence of one ad.
The customer-facing sentence "כרגע רצה מודעה אחת בלבד" is likewise now
conditional on that count actually being 1; otherwise the copy makes no claim
about how many ads run. Recommendation rows written before AIC-117 carry no
live count and keep the phrasing they were generated with.

**Comparable ≠ evidence-sufficient — two independent questions, on purpose:**
- *comparable* (relative) — is Meta actually delivering to this object at
  all? Answers "can we even ask the question."
- *evidence-sufficient* (absolute, the existing `MIN_CREATIVE_SPEND_AGOROT`/
  `AUDIENCE_MIN_SPEND_AGOROT` gates, unchanged) — has THIS specific object
  individually spent enough to trust a judgement about it? Two real,
  comparable objects can both still be too thin to judge — that's
  `below_object_evidence_floor`, checked only once comparability is already
  established for both sides.

**The advisory rule fires independent of the evidence gate — deliberately.**
`addCreativesForComparison` (`rules.ts`) is checked in `evaluateCampaign`
*before* `hasMinimumEvidence`, not inside the `RULES` array — the only
rule that isn't. The principle: the evidence gates exist for **comparative**
claims ("creative A underperforms creative B" needs statistical power) —
"there is only one creative" is a **count**, and no amount of additional data
makes a count more true. Firing from day one is the point: this is most
valuable *before* a customer burns weeks of budget on one untested creative,
not after. It's advisory (no spend change, no approval/execute gate — the
customer UI never calls the approve pipeline for this type, it just links to
the existing add-ad screen, AIC-63) and dismissible, so the cost of firing
early is mild redundancy; the cost of waiting for 5 leads is a customer who
already did the thing it warns against. Still respects delivery-blocked
precedence (checked first, same as everywhere else — "fix the breakage
first").

**Placement**: effectively rule zero — takes priority over every rule in the
`RULES` array, including budget moves, since you can't trust a budget
decision blind to which creative is actually driving the cost. `pauseWeakCreative`/
`pauseUnderperformingAudience` structurally can't fire anyway when there's
nothing comparable (no peer to judge against), so this only changes
precedence relative to `decreaseBudget`/`increaseBudget`.

**The flexible-ad case names itself** (AIC-36): `ev.flexibleCreativeAdSetIds`
already exists — when the sole comparable creative sits in a flexible ad set,
the evidence (`isFlexibleAd`) and the copy say so explicitly ("can't compare
designs inside one flexible ad", not the generic "only one ad").

**Evidence carries both sides, for the ops console.** The customer only ever
sees the creative-focused message ("add creatives" — one clear action beats
two competing ones), but the draft's `evidence` block carries
`comparableCreativeCount`, `comparableAdsetCount`, `dormantAdsetIds`, and
`isFlexibleAd` together — an operator reading the ops console's (already
generic) evidence table gets the full structural picture, not just the half
the customer acted on.

**Practical consequence for `no_rec_reason`:** since the advisory rule
intercepts the "no comparable creatives" condition before `classifyNoAction`
is ever reached, `no_comparable_creatives` is rarely actually the *stored*
`no_rec_reason` value in production — a live pending recommendation exists
instead. Find structurally-un-optimizable accounts by querying for pending
`add_creatives_for_comparison` recommendations, not by `no_rec_reason`.

**Verified live** (2026-08-14, same GelNails account, same tick mechanism as
AIC-75's verification): the real production tick now reports
`below_object_evidence_floor` (`kind: creative`, 3 real comparable creatives,
0 individually past ₪150) instead of `stable` — the account's shape had
changed since the investigation (comparability was no longer the blocker),
which is itself live proof the fix responds correctly to real data. Customer
copy rendered: *"אין המלצה כרגע — יש מה להשוות, אבל עדיין לא מספיק נתונים
(מודעות: 0/3 עברו את סף ₪150)"* — not "הכל עובד כרגיל". `add_creatives_for_comparison`
itself is covered by 24+ direct unit/integration tests (fires day one with
zero evidence, names the flexible-ad case, takes priority over a budget rule,
suppressed on delivery-blocked, auto-expires via the existing staleness
mechanism once a second creative appears) — not re-demonstrated live because
the account had already resolved past that specific state.

**Lock-in tests:** `rules.test.ts` (`comparableCreatives`/`comparableAdsets`
— the dormant-miscount bug as a failing-then-fixed test; `add_creatives_for_comparison`
— day-one firing, flexible-ad naming, priority over budget rules, delivery-
blocked suppression, never cooldown-tracked; `classifyNoAction`'s full new
precedence order), `explainer.test.ts` (both copy variants — with
performance data and day-one — plus the flexible-ad phrasing, never "nothing
to do"), `staleness.test.ts` (the advisory rec created and auto-expired like
any other draft).

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
3. **pause_underperforming_audience** — corrected 2026-08-22: this list used to
   jump from `replace_creative` straight to the budget rules, describing the
   audience rule only in its own subsection below. In `RULES` (`rules.ts`) it
   sits **here**, at index 2 — between `replace_creative` and `decrease_budget`.
   The prose further down ("targeted fixes → the audience fix → blunt budget
   moves") always had the order right; this numbered list did not, and reading
   only the list would mis-order the engine. Conditions in the subsection below.
4. **decrease_budget** — campaign CPL rose ≥ `BUDGET_CPL_RISE_PCT` (25%) window-
   over-window. Proposes −`BUDGET_DECREASE_STEP` (20%).
5. **increase_budget** — CPL not worse **and** leads not fewer window-over-window,
   with a strict improvement on at least one axis (a flat campaign is `no_action`,
   not a manufactured scale-up). Proposes +`BUDGET_INCREASE_STEP` (15%).

   **Refused outright for engagement campaigns (AIC-107, undocumented until
   2026-08-22).** `rules.ts` opens this rule with `if (ev.isEngagement) return
   null`, derived from `isEngagementResult(lead_event_types)`. An engagement
   campaign's "results" are post interactions, not leads, so a CPL-based
   scale-up would be reasoning about a number that does not mean what the rule
   assumes.

**Rule 0, outside this list:** `add_creatives_for_comparison` is evaluated
*before* all of the above and, uniquely, **below the evidence gate** — it fires
from day one, because "you only have one ad, we cannot compare anything" is
true immediately and does not need data to establish. It is advisory: no Meta
write, no approval, the UI routes to add-content instead.

All thresholds are named constants in `RULE_THRESHOLDS` (one place) — with one
exception worth knowing: **`DORMANT_SHARE_THRESHOLD` (10%) is a private module
constant in `rules.ts`, not a `RULE_THRESHOLDS` key**, so unlike the 14 real
keys it is **not** per-account overridable. Noted 2026-08-22, because this
document elsewhere states that every threshold resolves per campaign. Budget changes
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

**Dead/draft ad sets are excluded too, but not as a "delivery problem"
(AIC-65).** A deleted/archived ad set, or one that was never published (zero
ads — `effective_status` can still say `ACTIVE`), is excluded from `ev.adsets`
the same way as a real delivery problem, but tracked separately
(`AdSetMeta.isManaged`, `runGenerationTick`'s `unmanagedAdSetIds`) so
[AIC-64](features/recommendation-engine.md)'s `classifyNoAction` never calls
it `delivery_blocked` — a dead object isn't a delivery problem. This is what
GelNails' real "second ad set" turned out to be: a never-published draft with
leftover historical spend, inflating the audience count to a phantom 2 when
there's really just 1. See
[delivery-health.md](features/delivery-health.md#excluding-deaddraft-ad-sets-not-just-unhealthy-ones-aic-65).

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

**Already-paused objects are excluded (AIC-77b).** No rule ever filtered on
live delivery status, so an ad or ad set Meta already reports as paused
(paused by us, or manually via [manual-controls.md](features/manual-controls.md))
still carried its historical spend/leads in the window and stayed eligible to
be flagged "weak" — the engine proposing to pause something already paused.
`insight_snapshots.delivery_status` is **not** the status source (verified
against production: empty for nearly every ad/adset-grain row) — the real
signal is Meta's live status, already fetched every tick by
`getCampaignState` for the budget and previously discarded.
`isJudgeable` ([FEATURES.md](FEATURES.md#judgeable--the-centrally-owned-already-paused-exclusion-aic-77b))
owns the exclusion once, centrally, applied in `buildCampaignEvidence` —
every rule inherits it. Absence of status is judgeable, not excluded:
"we don't know" is never "we know it's paused."

### v1 approximations (documented, refined later)
- Trend rules compare the **current window vs the previous window** (not daily
  granularity) — sufficient for v1; daily snapshots are a later refinement.
- Budget rules use **relative movement** (window-over-window), not an absolute CPL
  target (no target-CPL field exists yet).

**Fixed (AIC-75):** `days` and `deliveryDays` used to be approximated from the
window's *length* (always 7) and a binary 7-or-0, so `MIN_DAYS_DATA`/
`MIN_DELIVERY_DAYS` could never fail a brand-new campaign. Both are now real
per-day counts (`features.ts`'s `daysActive`/`deliveryDaysActive`, reading
`insight_snapshot_daily` via `SnapshotStore.dailySeries`) — see
[FEATURES.md](FEATURES.md#the-two-v1-approximations-this-replaced).

## Configurable thresholds (AIC-77a)

**Status:** live — `RULE_THRESHOLDS` is no longer the only value the rules ever
see. Every threshold **resolves** per campaign, in order:

1. **Account override** (`managed_campaigns.threshold_overrides`, a sparse
   JSONB — only the keys an operator explicitly set) — wins outright, no
   further adjustment. An explicit ops decision is never second-guessed by a
   formula.
2. **Budget-relative formula** — for the two minimum-evidence *spend* gates
   only (`MIN_CREATIVE_SPEND_AGOROT`, `AUDIENCE_MIN_SPEND_AGOROT`):
   `max(global default, 1.5 × the campaign's own daily budget)`. Every other
   threshold (day counts, % moves, multipliers, peer counts) is never
   budget-relative — scaling a percentage or a count by budget doesn't mean
   anything.
3. **Global default** (`RULE_THRESHOLDS[key]`, unchanged) — everything else.

**Why only those two keys get the formula.** The concrete problem: a flat
₪150 minimum-spend gate is trivially cleared on day one by a ₪300/day
account, so `pause_weak_creative` judges a creative on almost no real signal
— "hair-triggered." The `max()` floor means every existing small/medium
account's behaviour is **byte-identical** to before (the global default
already exceeds the relative figure until budget gets large); a big-budget
account now needs proportionally more real spend before judgment, not a
manually-tuned override per customer.

**Deliberately NOT built: a per-category default tier.** The ticket's
original language ("per account → per category → global default") overstated
the need — `customers.category` (already used for AIC-49 audience defaults)
gets no rule-threshold job here, because no rule currently has evidence that
different verticals need different gate values. Adding one would mean
inventing numbers, the same failure mode as a confidence score calibrated
against zero outcomes. The resolution chain above is written so a category
tier slots in later as one function change, once AIC-76 produces real
evidence a vertical actually needs one — not before.

**Source of truth:** `resolveThresholds` (`server/src/recommendations/rules.ts`)
— every rule function takes an explicit `thresholds: RuleThresholds` parameter
(defaulted to `RULE_THRESHOLDS`, so every pre-AIC-77a call site keeps working
unchanged); `rule-evaluator.ts::evaluateAndPersist` and
`staleness.ts::refreshRecommendations` — the two places `evaluateCampaign` is
called — each resolve thresholds from `EvaluableCampaign.thresholdOverrides`
before calling it.

**Editing overrides:** the admin customer edit form
(`web/src/admin/AdminCustomers.tsx`), one number input per threshold key
(blank = no override, placeholder shows the resolved effective value),
grouped the same way as [Rules v1](#rules-v1-evaluated-in-priority-order)
above (evidence gates / creative / audience / budget). Writes go through the
same `customer-admin.ts::updateCustomer` path as `agreedBudgetAgorot` — same
`managed_campaigns` write-and-propagate shape, same `customer.edit` audit log
entry, validated (unknown key / non-finite value rejected, all-or-nothing)
before any write.

**Lock-in tests:** `rules.test.ts` (`resolveThresholds` in isolation: override
wins, formula applies only to the two spend keys, a no-op at typical small-
account budgets; `evaluateCampaign(ev, thresholds)` — a stricter/looser
override changes the outcome), `rule-evaluator.test.ts`/`staleness.test.ts`
(the override reaches the rules end-to-end through the real call chain),
`customer-admin.integration.test.ts` (round-trip, rejection, audit).

## Precedence & cooldown (AIC-77b)

**Status:** live.

### Precedence — already true, now documented

Precedence is *implicit in array index* (`RULES` in `rules.ts`) with no
separate conflict-resolution mechanism — and that turns out to already be
sufficient, verified structurally rather than assumed: `evaluateCampaign`
returns **exactly one** draft per tick (first-match-wins), and
[staleness](#staleness)'s replace-on-divergence expires any `proposed` rec
the fresh draft no longer matches. Together that guarantees there is never
more than one `proposed` recommendation per campaign — "one primary
recommendation, superseded when a different action becomes warranted" is
already the system's behaviour, not a gap this ticket needed to close.

**Rationale for the order** (targeted fixes → the audience fix → blunt
budget moves → scaling last): fix the creative before cutting budget — the
creative is the specific cause, the budget a campaign-wide symptom of it.
Fixing the audience split is a bigger move than fixing one creative, so it
comes after. Cutting budget is a retreat, tried before the last resort of
scaling — scaling a campaign that hasn't been fixed multiplies whatever's
wrong with it instead of curing it.

### Cooldown — genuinely new

After an engine-authored action executes, the same **class** of change is
suppressed for `COOLDOWN_DAYS` (a 14th `RULE_THRESHOLDS` key — see
[Configurable thresholds](#configurable-thresholds-aic-77a) above — default
**7**, Meta's documented learning-phase length, not a preference; resolvable
per account like every other threshold) so the engine never recommends
against an outcome it hasn't had time to measure yet.

**Classes are campaign-wide, not per-target:** `creative` =
`pause_creative`+`replace_creative`; `audience` = `pause_adset`; `budget` =
`decrease_budget`+`increase_budget` (`ruleClassOf`, `rules.ts`). Campaign-
wide because pausing creative A redistributes spend to its siblings — judging
sibling B on pre-change evidence is stale in a new place, the same mistake
as before, just relocated.

**Source: `action_history`, no new table.**
`getLatestEngineActionByType(pool, campaignId)`
(`server/src/services/action-history.ts`) returns the most recent
**successful, engine-authored** execution per recommendation type:
`recommendation_id IS NOT NULL AND result = 'success'`.
`recommendation_id IS NOT NULL` is a verified discriminator — every
non-engine writer (manual [AIC-66](features/manual-controls.md) controls,
the builder, launch) hardcodes the literal `NULL` in its SQL, so no other
code path can ever produce a row that looks engine-authored.
**Not `human_involved`** — that field does *not* discriminate (every acting
recommendation is customer-approved, so engine rows are `true` too).
`result = 'success'` excludes a failed Meta write, which must never start a
cooldown. The cutoff is computed in TypeScript and compared client-side
(`resolveCooldownClasses`, `rules.ts`) — this codebase has no SQL date
arithmetic anywhere; the reader returns raw timestamps, the caller decides
"how recent is recent" once thresholds are resolved.

**How it reaches the rules:** `EvaluableCampaign.lastActionAtByType` — the
same carrier as `thresholdOverrides` (AIC-77a), for the same reason: both
callers of `evaluateCampaign` (`rule-evaluator.ts`, `staleness.ts`) inherit
it automatically instead of one silently missing it, the exact "missed
consumer" class of bug AIC-70 and AIC-75 both hit. `generation.ts` fetches it
per campaign via an injected `cooldownReader` (mirroring `deliveryReader`/
`leadsReader`) — a read failure just means no cooldown applies that tick,
the same fail-open shape as every other optional reader there.

**Suppression is not a skip — it's tried, then deferred.**
`evaluateCampaign(ev, thresholds, cooldown)` doesn't remove a cooling-down
rule from consideration; it keeps trying **lower-priority** rules first, so
a genuinely different, non-cooling class can still fire and take precedence.
Only when every rule that *would* fire belongs to a cooling class does it
report `cooling_down` — carrying the suppressed type, the cooldown length,
and when it resumes. **If nothing would have fired regardless of cooldown,
the reason stays `stable`/`collecting`** — claiming "cooling down" when
there was nothing to do would be a different dishonesty than the one this
mechanism exists to prevent.

**Lock-in tests:** `rules.test.ts` (`ruleClassOf`, `resolveCooldownClasses`
in isolation — window boundary, multiple classes, null/empty input;
`evaluateCampaign` — suppression + `cooling_down`, a different class still
fires, nothing-would-fire never invents the reason), `staleness.test.ts`
(the real production path end-to-end, including a per-account
`COOLDOWN_DAYS` override), `action-history.integration.test.ts`
(`getLatestEngineActionByType` against the real schema: engine-only,
successful-only, latest-per-type).

**`COOLDOWN_DAYS` is also the [outcome-measurement](features/outcome-measurement.md)
window (AIC-76) — one key, not two that happen to share a default.** The
engine may not act again on a class until it can tell whether the last
action on that class worked, so "when the cooldown lifts" and "when the
outcome is measurable" are the same moment by definition, not by
coincidence. See [outcome-measurement.md](features/outcome-measurement.md#the-window--and-why-its-the-same-key-as-the-cooldown)
for the invariant and its lock-in test.

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
