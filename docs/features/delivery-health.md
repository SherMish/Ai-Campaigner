# Ad-set delivery health (AIC-39)

**Status:** live. Detects ad sets that are **not delivering / disapproved** —
invisible in Insights (which show near-zero spend, indistinguishable from "no data
yet"). Surfaces it to the customer as "needs attention," raises an ops item for
the operator, and keeps the engine from treating an errored audience as a "weak"
one to pause.

**Source of truth:**
- Normalizer: `server/src/meta/delivery-health.ts` (`getDeliveryHealth` reader interface, `normalizeAdSet`, `summarize`)
- Adapter: `server/src/meta/campaign-adapter.ts` `getDeliveryHealth` (fetches `effective_status` + `issues_info`)
- Persistence + ops: `server/src/services/delivery-monitor.ts`; columns on `managed_campaigns` (migration 014: `delivery_ok`, `delivery_reason`, `delivery_checked_at`)
- Wired in the engine tick: `server/src/recommendations/generation.ts`
- Customer surface: `customer-overview.ts` (`campaign.deliveryOk`, `attentionKind`) → Home
- Dead/draft ad-set detection (AIC-65): `server/src/meta/audience-label.ts` (`AdSetMeta.isManaged`),
  `server/src/meta/campaign-adapter.ts` `getAdSetMeta`, `server/src/services/campaign-audiences.ts`
  (customer view filter), `server/src/meta/explorer.ts` (`ExplorerAdSet.isManaged`, operator badge)

**Lock-in tests:** `delivery-health.test.ts` (normalize + summarize, incl.
deleted/archived-wins-over-stale-issues), `delivery-monitor.integration.test.ts`
(persist + ops dedupe + recover), `generation.test.ts` (errored ad set excluded
from the audience rule; dead/draft ad set excluded from counts and never
flagged, AIC-65), `audience-label.test.ts` (`isManaged` classification),
`campaign-audiences.integration.test.ts` (dead ad set never shown to the
customer), `customer-overview.integration.test.ts` (delivery → attention).

---

## Normalization

Per ad set, from `effective_status` + `issues_info`:

| Condition | state |
| --- | --- |
| `effective_status = ARCHIVED` / `DELETED` (checked FIRST — AIC-65) | `paused` (gone is gone, never a problem, even with leftover `issues_info`) |
| `effective_status = DISAPPROVED` / `WITH_ISSUES` | `disapproved` |
| any `issues_info` (even while status is ACTIVE — the GelNails case) | `not_delivering` |
| `PAUSED` / `ADSET_PAUSED` / `CAMPAIGN_PAUSED` | `paused` (intentional, not a problem) |
| otherwise | `delivering` |

**Deleted/archived is checked before `issues_info` (AIC-65, fixed 2026-08-12).**
A deleted ad set can carry stale `issues_info` left over from before it was
deleted — the old ordering checked `issues_info.length > 0` before the
archived/deleted branch, so a genuinely-gone ad set could still be classified
`not_delivering` and flagged. Real GelNails case: its second ad set is a
never-published draft (see below) that Meta doesn't always reclassify
`effective_status` for, so relying on `effective_status` alone isn't enough
either — see "Excluding dead/draft ad sets" below for the companion fix.

`not_delivering` + `disapproved` are **problems**; `paused` is not. `summarize`
folds the list into `{ ok, reason, problemAdSetIds }`.

## In the engine tick (after ingestion, per campaign)

1. `getDeliveryHealth` → `summarize`.
2. `recordCampaignDelivery` writes `delivery_ok`/`delivery_reason` and raises a
   `campaign_not_delivering` ops item **only on the ok→not-ok transition** (no
   per-tick spam); high severity → the existing alert hook fires (a real Telegram
   sink is a later notifications concern). On recovery it flips `delivery_ok` back.
3. The problem ad set ids become `excludeAdSetIds`, passed to
   `refreshRecommendations` → dropped from the evidence (ad sets **and** their
   creatives). This is what lets the audience rule (AIC-36) run live safely.

A health-read failure never blocks generation — it excludes nothing and logs.

## Customer surface (no jargon)

`delivery_ok = false` sets `overview.attentionKind = "delivery"` and `homeState =
attention`. Home shows a distinct plain-Hebrew message ("חלק מהקמפיין לא מתפרסם
כרגע…") — separate from the lost-connection attention copy. Status stays `active`
so the engine keeps optimizing the healthy ad sets; the customer just sees the
honest "needs attention."

## Ad-level rollup

`getDeliveryHealth` also reads the campaign's **ads** (`effective_status` +
`issues_info`) and rolls any errored/disapproved ad up to its parent ad set — the
"Ad errors / not delivering" reason often lives at the ad grain, not the ad set.
So an ad set whose own status is ACTIVE is still flagged not-delivering when an ad
under it is broken.

## Excluding dead/draft ad sets, not just unhealthy ones (AIC-65)

`effective_status` alone doesn't reliably catch every dead ad set — GelNails'
second ad set reports `ACTIVE` even though it's a **never-published draft**
(zero ads; historical snapshot rows exist from before its one ad was
removed). `getAdSetMeta` (`campaign-adapter.ts`, requests `ads.limit(1){id}`)
and `normalizeAdSetMeta` (`audience-label.ts`) compute `AdSetMeta.isManaged`:
false when `effective_status` is `DELETED`/`ARCHIVED`, **or** when the ad set
has zero ads. `runGenerationTick` fetches ad-set metadata FIRST each tick,
splits `allAdsets` into managed vs `unmanagedAdSetIds`, and:

- filters `del.problemAdSetIds` down to real (managed) ad sets **before**
  `recordCampaignDelivery` — a dead ad set's leftover not-delivering signal
  never raises a needs-attention item;
- only caches/labels/derives audience comparisons over managed ad sets
  (`upsertAdSetMeta`, `deriveAudienceLabels`, `flexibleCreativeAdSetIds`) —
  `ad_set_meta` (and therefore the customer's opt-in audience view, AIC-37)
  never contains a dead ad set, even though its historical `insight_snapshots`
  rows still exist (ingestion isn't filtered — see the note below);
- merges `unmanagedAdSetIds` into the exclusion set passed to
  `buildCampaignEvidence`, same as a real delivery problem, so the audience
  rule (AIC-36) and creative rule never see it — **but** kept in a SEPARATE
  `deliveryProblemAdSetIds` param so AIC-64's `classifyNoAction` never calls
  a dead-object exclusion `delivery_blocked` (it's not a delivery problem).

**Ops explorer (AIC-45)** still shows a dead/draft ad set — an operator needs
to see it exists — but visibly marked (`ExplorerAdSet.isManaged`, a muted card
+ "נמחק / לא פורסם" badge instead of its raw `effective_status`), never as a
normal active ad set or a problem.

**Deliberately NOT filtered at ingestion.** `insight_snapshots` keeps writing
whatever Meta's Insights API returns per ad set, including a since-deleted
one's historical rows for periods when it was genuinely active — that's an
accurate record of what happened, not a bug. Filtering happens at every READ
layer that decides "is this a real, currently-manageable ad set" instead,
which is also where `getAdSetMeta`'s live structural read (not Insights) is
the only reliable signal anyway.

## Not yet
- A real Telegram/notification sink (currently the high-severity ops-log hook).
