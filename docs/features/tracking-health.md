# Lead-tracking health (AIC-88)

**Status:** live. Detects when a campaign's declared lead definition
(`managed_campaigns.lead_event_types`, AIC-87) doesn't match what its ad
sets are actually configured on Meta to optimize for — the failure mode
where real conversions arrive, but the product counts zero of them, and the
engine confidently reasons over (and could eventually recommend cutting) a
campaign that is actually working.

**Source of truth:**
- Pure module: `server/src/meta/tracking-health.ts` (`impliedLeadActionType`,
  `summarizeTracking`, `TrackingReader`)
- Adapter: `server/src/meta/campaign-adapter.ts` `getAdSetTracking` (reads
  `optimization_goal`, `destination_type`, `promoted_object`)
- Persistence + ops: `server/src/services/tracking-monitor.ts`
  `recordCampaignTracking`; columns on `managed_campaigns` (migration 038:
  `tracking_ok`, `tracking_reason`, `tracking_detail`, `tracking_checked_at`)
- Wired in the engine tick: `server/src/recommendations/generation.ts`, right
  after the delivery-health step
- Suppression: `CampaignEvidence.trackingBroken` (`rules.ts`) — blocks every
  rule AND the AIC-86 pre-gate advisory; `classifyNoAction`'s `tracking_broken`
  reason (see [RULES.md](../RULES.md#why-theres-no-recommendation-aic-64))
- Customer surface: `customer-overview.ts` (`campaign.trackingOk`,
  `attentionKind: "tracking"`) → Home hero (`web/src/strings.ts` →
  `home.states.tracking`)

**Lock-in tests:** `tracking-health.test.ts` (pure: the implied-action-type
mapping, the real free_beta-shaped bug reproduced as a regression case, the
three-valued `unknown` handling), `campaign-adapter.test.ts` (the adapter
read), `tracking-monitor.integration.test.ts` (persist + idempotent ops
raising + the `unknown`-never-clears-`broken` divergence from
delivery-monitor), `rules.test.ts` (precedence: outranked only by
`delivery_blocked`, outranks the evidence gate and the AIC-86 advisory),
`explainer.test.ts` (distinct customer copy).

---

## Why a config comparison, not a statistical one

The obvious design — "spent real money, recorded zero leads, and the pixel
hasn't fired recently" — was designed, then discarded after an adversarial
review, before any of it was built. Three reasons, worth keeping written down
so it isn't re-proposed:

1. **`{pixel}/stats` is pixel-scoped, not campaign-scoped.** For a landing
   page whose only traffic is the one campaign being checked, "the event
   never fired" is logically identical to "nobody converted yet" — the check
   adds zero discriminating power in exactly the case it exists to resolve.
   The moment the pixel has ANY other traffic (organic, a second campaign, a
   manual test), the event fires and a genuinely broken campaign goes
   unnoticed — the dominant failure mode, not an edge case, since shared
   pixels are the norm.
2. **Attribution lag** makes "spent with zero leads" normal for a young
   campaign, so any spend threshold either cries wolf early or arrives late.
3. **A spend threshold near the existing evidence gates is unreachable on a
   small budget.** ₪20/day × 7 complete days = ₪140, under
   `MIN_CREATIVE_SPEND_AGOROT` (₪150) — the exact real campaign that
   motivated this ticket could never have tripped its own guard.

The ad set's own Meta configuration **deterministically implies** which
Insights action type its conversions arrive as — `optimization_goal:
OFFSITE_CONVERSIONS` + `promoted_object.custom_event_type: X` maps to
`offsite_conversion.fb_pixel_<x>`; `optimization_goal: CONVERSATIONS` maps to
the WhatsApp messaging event. Comparing that against the campaign's stored
`lead_event_types` is exact — zero false positives, no spend required, no
attribution lag — and it works on a **paused** campaign, i.e. it catches the
misconfiguration before a shekel is spent, which the statistical version
structurally could not.

**The honest trade-off:** this catches a wrong or missing declared lead
type. It does **not** catch a correctly-declared type whose pixel has
silently stopped firing (a dead Meta Pixel snippet, a broken deploy). That
gap is deliberate, not an oversight — see "Known gap" below.

## The mapping table

`PIXEL_EVENT_ACTION` (`tracking-health.ts`) covers Meta's standard pixel
events (`COMPLETE_REGISTRATION`, `LEAD`, `PURCHASE`, …). A `CUSTOM`
conversion (`offsite_conversion.custom.<id>`) has no name derivable from the
ad set's config alone — `impliedLeadActionType` returns `null` for it, which
resolves to `unknown`, **never** `broken`. Guessing there would flag every
custom-conversion campaign as broken.

## Three-valued, not two — `unknown` is not a soft `ok`

`summarizeTracking` returns `ok | broken | unknown`. This differs
deliberately from `delivery-health.ts`'s `summarize`, which is legitimately
two-valued because Meta reports the delivery state directly
(`effective_status`); tracking health is an **inference**, and "we couldn't
determine this" is a real third state — an ad-set read failure, no judgeable
ad set, or an unmapped custom event.

`recordCampaignTracking` never writes `tracking_ok` on `unknown` — only
`tracking_checked_at` advances. A naive mirror of `recordCampaignDelivery`
(which writes its flag unconditionally) would silently clear a real prior
alarm on every transient read failure; this is the first of two places this
module deliberately diverges from the delivery-health pattern it otherwise
mirrors.

## Ops alerting is idempotent, not edge-based — the second divergence

`recordCampaignDelivery` raises an ops item only on the ok→not-ok
**transition**. Review found a latent failure in that shape: the flag UPDATE
lands before `ops.create`, so if `ops.create` then throws (a CHECK constraint
not yet widened after a migration/deploy race, any DB error), the flag is
already `false` — the next tick's "did it just flip" is `false` forever
after, and the alert is **permanently lost** while the customer-facing state
still shows a problem nobody is watching.

`recordCampaignTracking` instead checks "is it broken AND is there no OPEN
`campaign_tracking_broken` item already" — robust to write-ordering, to a
previous crash mid-write, and to an operator resolving the item while the
underlying problem persists (the next tick correctly re-raises). Locked in by
`tracking-monitor.integration.test.ts`.

## In the engine tick (after delivery-health, per campaign)

Unlike delivery-health, **not gated on `delivering`** — a config mismatch is
true or false regardless of whether the campaign is currently spending, so
checking it on a paused campaign is not just safe, it's the point: catching
the misconfiguration before launch is strictly more valuable than catching it
after. Read-only, fail-open like every other optional generation-tick step —
an adapter read failure is logged and treated as `unknown`, never `broken`.

## Suppression — nothing may act on a wrong number

`CampaignEvidence.trackingBroken` blocks two places:
- `classifyNoAction` returns `tracking_broken` **second**, right after
  `delivery_blocked` and before the evidence gate — the lead count isn't
  thin, it's wrong, and no amount of waiting fixes a wrong number.
- The AIC-86 pre-gate advisory (`add_creatives_for_comparison`) is also
  suppressed. Telling a customer whose conversions aren't being counted at
  all to "add more ads" is confidently wrong advice that would bury the
  actual fix.

## Customer + ops surfaces

Customer: `deriveHomeState` returns `attention` when `campaign.trackingOk ===
false` (explicit `=== false` — `null` means never-checked and must never
read as a problem), `attentionKind: "tracking"` routes the hero to distinct
copy (`h.states.tracking`) that says the numbers are incomplete and it's on
us to fix — never that the campaign is failing. No CTA, same as the delivery
hero: there's nothing for the customer to click.

Ops: `ops.noRecReason.tracking_broken` label; the existing generic evidence
table on `AdminRecommendations.tsx` renders `tracking_broken`'s detail with
no new code (same "evidence is a generic key→value blob" property AIC-85/86
relied on).

## Known gap — not built, not silently missing

**A correctly-declared lead type whose pixel silently stops firing** (a
removed/broken Pixel snippet, a site redesign that dropped the tag) is
invisible to this check — the config still matches, so `summarizeTracking`
correctly reports `ok`. This is the statistical signal deliberately deferred
above. If it's built later, it should be **ops-only** (a "spend accruing,
zero leads, the configured event hasn't fired on the pixel in N days"
signal), never customer-facing without much more confidence than that
combination provides — see "Why a config comparison" above for the exact
reasons a naive version of it doesn't work.
