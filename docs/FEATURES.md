# Feature layer (AIC-75)

**Status:** live — the named, windowed metrics the rules engine reasons over.

**Source of truth:** `server/src/recommendations/features.ts`.

**Lock-in tests:** `features.test.ts` (each feature in isolation — zero-lead,
zero-spend, single-sibling, partial-window cases), plus every existing rules
test (`rules.test.ts`, `rules.adset.test.ts`, `rule-evaluator.test.ts`,
`generation.test.ts`, `staleness.test.ts`) — the refactor onto this module made
**no behaviour change**, so those stay the behavioural lock-in.

---

## How it works today

Before AIC-75, the numbers a rule reasoned over were computed **inline, inside
the rule body** — peer best-CPL was written out by hand in both the creative
rule and the audience rule, ad-set grouping was a hand-rolled `Map` build,
"spent without a lead" was an unnamed `cplAgorot === null` check repeated in
both rules' filters. A number computed twice drifts; this module gives each
one name, once, tested on its own.

**Design rules, enforced by review, not by a linter:**
- **Deterministic only. No LLM anywhere in this layer.**
- **Every feature that summarizes a window carries that window explicitly** —
  in its own name (`campaignCpl`/`adCpl`, `daysActive`) or an explicit
  parameter. A number without its window is a lie (the AIC-55 lesson — see
  [features/customer-overview.md](features/customer-overview.md#kpis-deltas-sidebar)).
- **Null-honest.** CPL with zero leads is `null`, never `0` or `∞`; share-of-
  spend with zero campaign spend is `null`, never `0%`; lead-quality rate with
  zero reviews is `null`, never a `0%` rate. "No data" and "zero" must stay
  distinguishable everywhere a feature is read.
- **Pure functions only.** No DB/Meta/store access — callers
  (`rule-evaluator.ts`, `generation.ts`) own fetching; this module only
  computes. That's what makes every feature testable without a database.

### The features

| Feature | Signature | Notes |
| --- | --- | --- |
| `campaignCpl` / `adCpl` | `(spendAgorot, leads) → agorot \| null` | Thin, separately-named wrappers over `computeCpl` (`meta/insights.ts`) — reused, not reimplemented. |
| `spendWithoutLead` | `(spendAgorot, leads, minSpendAgorot) → boolean` | True once an object cleared a minimum-spend bar with zero leads to show for it. Below the bar it's neither "converting" nor "spending without a lead" — just too new to know. Replaces the `cplAgorot === null` conjunction that used to be written out twice in `rules.ts` (creative + audience rules). |
| `shareOfCampaignSpend` | `(objectSpendAgorot, campaignSpendAgorot) → ratio \| null` | Null when the campaign spent nothing — "no share of nothing" isn't 0%. |
| `daysActive` | `(daily: DailyPoint[]) → number` | Real count of days with real data (`spendAgorot > 0 \|\| leads > 0`) — see [v1 approximations this replaced](#the-two-v1-approximations-this-replaced). |
| `deliveryDaysActive` | `(daily: DailyPoint[]) → number` | Real count of days with delivery (`spendAgorot > 0`) — leads alone don't count as "delivered". |
| `bestPeerCpl` | `(items: PeerLike[], spendGateAgorot: number \| null) → agorot \| null` | The one peer-comparison function both rules call — see [the gate asymmetry](#the-peer-baseline-gate-asymmetry-is-real-not-a-bug) below. |
| `groupCreativesByAdSet` | `(creatives, flexibleAdSetIds?) → Map<adSetId, CreativeStat[]>` | Named version of the grouping `pause_weak_creative` used to build inline. Preserves insertion order exactly — creatives arrive spend-desc from the store, and that order is load-bearing for which group the rule examines first (pinned in `rules.test.ts`). |
| `periodOverPeriodDeltaPct` | re-export of `services/readout.ts`'s `deltaPct` | Available for a future evidence field or AIC-76's outcome comparison. **Not** wired into any rule's gate today — see [why deltaPct isn't in the gates](#why-periodoverperioddeltapct-isnt-wired-into-a-rule-gate). |
| `leadQualityRate` | `(reviewedLeads, relevantLeads) → ratio \| null` | Pure function over the AIC-67 watermark counts (`services/lead-quality-review.ts` owns fetching them). Not wired into a rule's evidence yet — no current rule reasons over lead quality — but AIC-76 and a future rule have one correct definition to call instead of reinventing the division. |
| `isJudgeable` | `(status: "active" \| "paused" \| undefined) → boolean` | AIC-77b. The centrally-owned already-paused exclusion — see [below](#judgeable--the-centrally-owned-already-paused-exclusion-aic-77b). |

### `isJudgeable` — the centrally-owned already-paused exclusion (AIC-77b)

The third instance of one family — AIC-65 (deleted objects counted as real),
AIC-71 (status read from a stale flag), now this — all "the engine reasoning
over an object whose real state it hadn't checked." No rule ever filtered on
live delivery status, so an ad Meta already reports as paused still carried
its historical spend/leads and stayed eligible to be flagged "weak" — the
engine proposing to pause what's already paused. `insight_snapshots.delivery_status`
is **not** the status source (verified against production: empty for nearly
every ad/adset-grain row) — the real signal is Meta's live status
(`getCampaignState`'s `adStatuses`/`adSetStatuses`), already fetched every
tick for the budget and previously discarded. `isJudgeable` is applied
**once**, inside `buildCampaignEvidence` (`rule-evaluator.ts`), so every rule
inherits the exclusion instead of each remembering its own guard — the fix
for why the last two instances of this family kept recurring. Absence of
status is judgeable, not excluded: an unknown/missing status (a test double,
or any object Meta hasn't been asked about) is "we don't know", never "we
know it's paused" — only an explicit `"paused"` excludes.

### Known gaps (not built in this pass)

- **No `impressions`/`frequency` feature.** The AIC-75 ticket's starting set
  named these; no current rule reasons over them, so nothing was built —
  add when a rule actually needs one, rather than speculatively.
- **Dead/draft-object and delivery-problem exclusion (AIC-65/AIC-39) still
  happens upstream, via a different mechanism than `isJudgeable`.**
  `buildCampaignEvidence` (`rule-evaluator.ts`) filters out not-delivering
  and dead/archived ad sets via a passed-in `excludeAdSetIds` set (fetched
  from delivery-health + ad-set metadata, not from `getCampaignState`) —
  a genuinely different signal from the live active/paused status
  `isJudgeable` reads, so it stays a separate mechanism rather than being
  folded into `isJudgeable`. Both are applied in the same function, at the
  same point, for the same reason (evidence assembly is the one place every
  rule's input passes through) — they're just two different upstream facts.
- **Not every rule's evidence is populated from a named feature.**
  `decreaseBudget`/`increaseBudget`/`replaceCreative` still compare
  `current`/`previous` CPL directly (unrounded) rather than through
  `periodOverPeriodDeltaPct` — see [why](#why-periodoverperioddeltapct-isnt-wired-into-a-rule-gate)
  above. Their evidence blocks report the raw CPLs, not a delta feature.

### The peer baseline gate asymmetry is real, not a bug

`bestPeerCpl`'s `spendGateAgorot` parameter makes an existing, deliberate
difference **explicit at the call site** instead of leaving it implicit in two
different hand-written copies:

- **The creative rule's baseline is NOT spend-gated** (`bestPeerCpl(creatives, null)`)
  — a cheap-but-real peer can still set the bar for what counts as "weak".
- **The audience rule's baseline IS spend-gated** (`bestPeerCpl(withData, null)` where
  `withData` was already filtered to `spendAgorot >= AUDIENCE_MIN_SPEND_AGOROT`)
  — pausing a whole audience is a bigger move than pausing one creative, so it
  needs more evidence before an ad set is even eligible to set the baseline.

Both are pinned in `rules.test.ts` ("an under-spend creative CAN set the peer
baseline" / "an under-spend ad set CANNOT set the audience baseline"). This
module does not unify them — that would silently change real behaviour.

### The two v1 approximations this replaced

`rule-evaluator.ts`'s `buildCampaignEvidence` used to derive `days` and
`deliveryDays` without ever looking at real per-day data:

- **`days`** was the rolling window's **length** — always exactly `7`, because
  the window itself is always 7 days. `MIN_DAYS_DATA: 3` could never fail a
  campaign that started yesterday.
- **`deliveryDays`** was a binary **7-or-0**: any spend at all in the window
  read as "delivered all 7 days".

Both are now real counts over `SnapshotStore.dailySeries` — the same disjoint
per-day rows `insight_snapshot_daily` exposes (see
[DATA_MODEL.md](DATA_MODEL.md#the-disjoint-daily-view-migration-030)) — so a
brand-new campaign with one real day of data now genuinely reads as one day,
not seven.

### Why `periodOverPeriodDeltaPct` isn't wired into a rule gate

`deltaPct` **rounds** to a whole percent for display
(`Math.round(((current - previous) / previous) * 100)`). `decreaseBudget`,
`increaseBudget`, and `replaceCreative` compare `current`/`previous` CPL
against a hard multiplier (`BUDGET_CPL_RISE_PCT`, `REPLACE_DECAY_MULTIPLIER`)
directly and unrounded. Rounding a number a hard threshold gate compares
against is a real way to flip a borderline case that the 27 characterization
tests written before this refactor (`rules.test.ts`) exist specifically to
catch. `periodOverPeriodDeltaPct` stays available, re-exported, for a
display-only use (an evidence field, a future dashboard number) where that
risk doesn't apply — it's just not force-fit into today's gates for the sake
of reuse.
