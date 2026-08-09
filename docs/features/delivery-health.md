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

**Lock-in tests:** `delivery-health.test.ts` (normalize + summarize),
`delivery-monitor.integration.test.ts` (persist + ops dedupe + recover),
`generation.test.ts` (errored ad set excluded from the audience rule),
`customer-overview.integration.test.ts` (delivery → attention).

---

## Normalization

Per ad set, from `effective_status` + `issues_info`:

| Condition | state |
| --- | --- |
| `effective_status = DISAPPROVED` / `WITH_ISSUES` | `disapproved` |
| any `issues_info` (even while status is ACTIVE — the GelNails case) | `not_delivering` |
| `PAUSED` / `ARCHIVED` / `DELETED` | `paused` (intentional, not a problem) |
| otherwise | `delivering` |

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

## Not yet
- A real Telegram/notification sink (currently the high-severity ops-log hook).
