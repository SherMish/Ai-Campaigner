# Campaign builder (P1 — create campaigns)

**Status:** in progress. All six tickets — AIC-49 (recommended-defaults
spec), AIC-50 (Meta create-writes), AIC-51 (creative handling), AIC-52
(guided builder UI), AIC-53 (launch gate), AIC-63 (add to an existing
campaign) — are **built and unit/integration-tested, live-verified in the
browser**. The one thing still pending across the whole phase is a single
live Meta dogfood on an account we control: create a real paused campaign,
activate it, verify, clean up. That test is what finally confirms AIC-50's
create field shapes, AIC-51's WhatsApp-creative shape, AIC-53's
PAUSED→ACTIVE flip, and AIC-63's add-content writes against the real
Marketing API — everything else is verified with a mocked `fetch` through
the real adapter.

**Source of truth:**
- Recommended-defaults spec: `shared/src/recommended-defaults.ts`
- Create-writes: `server/src/builder/types.ts` (the `BuilderWriter` interface
  + params), `server/src/builder/campaign-create.ts` (`startBuilderCampaign`,
  `buildCampaignOnMeta`), `server/src/meta/campaign-adapter.ts`
  (`GraphCampaignAdapter.createCampaign/createAdSet/createAd`)
- Creative handling: `shared/src/creative-handling.ts` (limits +
  `validateCreativeCopy`, codes only — display text lives in
  `web/src/strings.ts`'s `builder` section), `server/src/builder/creative-types.ts`
  (the `CreativeWriter` interface + params), `server/src/builder/creative-create.ts`
  (`uploadCreativeMedia`, `createCreativeIdempotent`),
  `server/src/meta/campaign-adapter.ts`
  (`GraphCampaignAdapter.uploadImage/uploadVideo/listPromotablePosts/createCreativeFromUpload/createCreativeFromExistingPost`)
- Idempotency: `server/src/execution/write-outbox.ts` (`applyIdempotent`,
  `builderKey` — extends the AIC-13 outbox)
- Builder session + HTTP routes: `server/src/builder/session.ts`
  (`resolveBuilderContext`, `ownsLocalCampaign`, `buildBuilderWriter`),
  `server/src/routes/builder.ts` (mounted at `/api/app/builder`)
- Guided UI: `web/src/app/Builder.tsx` (the 8-step wizard shell + goal/
  whatsapp/budget/specialCategory/audience/placements/review steps),
  `web/src/app/BuilderCreatives.tsx` (the creatives step), `web/src/api.ts`
  (builder client functions), `web/src/strings.ts`'s `builder` section
- Launch gate: `server/src/launch/types.ts` (the `LaunchWriter` interface),
  `server/src/launch/activate.ts` (`activateCampaign` — the one PAUSED→ACTIVE
  path), `server/src/services/customer-launch.ts` (`getPendingLaunch`,
  `approveLaunch`), routes in `server/src/routes/app.ts` (`/api/app/launch`,
  `/api/app/launch/approve`); the customer UI is the `LaunchModal` in
  `web/src/app/Home.tsx` + the `ready_to_launch` home state
- Add to an existing campaign: `server/src/additions/types.ts` (the
  `AdditionWriter` interface), `server/src/additions/session.ts`
  (`resolveAdditionContext`, `buildAdditionWriter`), `server/src/additions/add-content.ts`
  (`addAdToExistingCampaign`, `addAdSetToExistingCampaign`),
  `server/src/additions/approve.ts` (`approveAddition`, `listPendingAdditions`),
  routes in `server/src/routes/additions.ts` (mounted at `/api/app/additions`);
  the customer UI is `web/src/app/AddContent.tsx` (+ the shared
  `web/src/app/AudienceFields.tsx`, also used by the builder)

**Lock-in tests:** `shared/src/recommended-defaults.test.ts`,
`shared/src/creative-handling.test.ts`,
`server/src/meta/campaign-adapter.test.ts` (created-PAUSED invariant +
upload/creative field shapes + the activate-always-sends-ACTIVE invariant,
for both the campaign and the ad-set/ad level),
`server/src/execution/write-outbox.integration.test.ts`
(`applyIdempotent`), `server/src/builder/campaign-create.integration.test.ts`
(the full campaign orchestration), `server/src/builder/creative-create.integration.test.ts`
(the creative-create orchestration), `server/src/routes/builder.integration.test.ts`
(the full builder HTTP surface), `server/src/launch/activate.integration.test.ts`
(the launch gate: activate-happy-path, blocked-before-review, idempotent,
failed-write-not-marked-launched), `server/src/routes/launch.integration.test.ts`
(the launch HTTP routes end to end), `server/src/additions/add-content.integration.test.ts`
(add-ad, add-ad-set, idempotent, partial-failure-resume, approve, ownership),
`server/src/routes/additions.integration.test.ts` (the full add-content HTTP
surface end to end).

---

## Why this is P1, not P0

P0 manages a customer's **existing** campaign (PRD §7) — the engine reasons
over what's already running, but a human (the founder) still walks each
customer through creating that first campaign in Ads Manager by hand, which
is exactly what happened for GelNails. This phase replaces that manual
walk-through with a guided in-product builder — the thing that lets the
product create a customer's *first* campaign itself, not just optimize one
that already exists.

## How it works today

### Recommended-defaults spec (AIC-49)

The single documented source of truth for what the builder recommends at
every step, in `shared/src/recommended-defaults.ts` — consumed by both the
server and the web app (it's in the shared workspace, same as `money.ts`),
so no UI component hardcodes an opinion independently. Every value here is a
**recommendation**: overridable in the builder (AIC-52), never a hard
constraint — except two P0-fixed choices, which the builder won't even
present as a choice, plus one former-fixed choice that AIC-89 turned real:

| Fixed choice | Value |
| --- | --- |
| Objective | `OUTCOME_LEADS` (`FIXED_OBJECTIVE`) |
| Buying type | `AUCTION` (`FIXED_BUYING_TYPE`) |

**Destination is now a real choice (AIC-89), not fixed.** WhatsApp
(`FIXED_DESTINATION`) remains the **recommended default** — simplest for the
customer, no website needed, on-platform tracking that can't silently break
— but a business with a converting website can choose Website
(`WEBSITE_DESTINATION`) instead. See "The destination choice (AIC-89)" below.

**Structure** (`RECOMMENDED_STRUCTURE`): 1 ad set, 3–5 ads — the AIC-38
single-ad-set ideal, presented here as what it's always been: a
*recommendation*, never an assumption the engine or review may rely on. A
customer can and does run more ad sets (audience splits are normal, not
exceptional — see [DATA_MODEL.md](../DATA_MODEL.md)).

**Placements** (`FIXED_PLACEMENTS`): Advantage+ (automatic). This is a
*fixed* P0 choice, not a recommendation — `createAdSet` sends no placement
field so Meta uses automatic placements, and there's no path to narrow them.
Presented in the builder as fixed (no מומלץ badge), copy in
`web/src/strings.ts`'s `builder.placements.fixedNote` (AIC-52 honesty pass,
see below).

**Budget** (`RECOMMENDED_BUDGET_AGOROT_PER_DAY`): a ₪30–50/day range, ₪40
recommended, framed honestly as a *starting point to gather data* — not a
guaranteed-exact number (real CPL varies too much by category/creative to
claim precision we don't have).

**Special Ad Category** (`SPECIAL_AD_CATEGORY`, `RECOMMENDED_SPECIAL_AD_CATEGORY`):
Meta's compliance mechanism for campaigns touching credit, employment,
housing, or social issues/elections — restricted targeting is legally
required for these. The recommended default is always `NONE`, and the
builder must ask the question explicitly every time (the question text is
`web/src/strings.ts`'s `builder.specialCategory.question`) — this is never
silently inferred from the business category. `SPECIAL_AD_CATEGORY_HINT` maps a handful of our known
categories (currently just `real_estate` → `HOUSING`) to a likely category,
but a hint only prompts a more careful honest answer; it never sets the
declaration itself.

**Business-category → audience defaults** (`CATEGORY_AUDIENCE_DEFAULTS`,
`resolveAudienceDefault`): age range and gender per business category
(`BUSINESS_CATEGORY` — a small, curated set of common Israeli-SMB categories,
not a taxonomy: beautician, fitness, tutor, restaurant, home_services, retail,
health_wellness, professional_services, real_estate). Each default also
carries a `radiusKm`, kept as the per-category seed for real geo-targeting
(AIC-60) — **P0 does not wire it to Meta** (all-of-Israel by age+gender only);
see the audience-step notes below. `customers.category` (migration 002)
stays free text, set by the operator during manual onboarding (AIC-44) — it
is **not** validated against this list at the DB layer, so
`normalizeBusinessCategory` case/whitespace-normalizes and resolves anything
unrecognized to `other`'s honest broad default rather than guessing or
throwing. The one-line plain-Hebrew rationale per category lives in
`web/src/strings.ts`'s `builder.audience.categoryRationale`, keyed to match
(AIC-52 correction, see below) — `CATEGORY_AUDIENCE_DEFAULTS` itself carries
only the numeric/structural defaults.

### Forward reference: first-campaign review (AIC-18/38)

AIC-49 asks this spec to be "referenced by" the first-campaign-review
"rebuild to standard" language ([ops-console.md](ops-console.md)). Today's
review UI is three outcome buttons (approve / changes-requested /
unsupported) with no rendered checklist yet, so there's no concrete UI hook
to wire this into right now — this is a forward reference: once the review
UI grows detailed "rebuild to standard" copy, it should pull rationale
strings from here rather than re-writing them.

### Meta create-writes (AIC-50)

The write surface the builder needs: `createCampaign` / `createAdSet` /
`createAd` on `GraphCampaignAdapter`, implementing a new `BuilderWriter`
interface (`builder/types.ts`) — kept **separate from `ExecWriter`**
(safe-executor.ts): these create new objects, they never modify an existing
recommendation's target, so folding them into the recommendation-approval
interface would be the wrong shape. `SafeExecutor`/recommendations are
untouched by this ticket.

**This rule was REVERSED by AIC-106 (2026-08-19).** It used to read: "every
create sends `status=PAUSED`; there is no code path that can create a live
object." That is no longer true — creates send `status=ACTIVE` and the
campaign spends the moment the build returns. `campaign-adapter.test.ts`
still pins the status against the real field names sent to Meta; it now pins
`ACTIVE`. See "Creation goes live immediately" below for what replaced the
gate, and the section directly beneath this one for the consequence nobody
noticed at the time.

**Idempotent via the AIC-13 outbox, extended, not duplicated** (migration
020 widens `meta_write_outbox.kind` to include the three create kinds + adds
a `result` column for the created object's real Meta id).
`WriteOutbox.applyIdempotent(entry, writer)` is the new synchronous
create-write path (`drainOnce` stays as-is for the existing async
budget/pause writes — a create can't drain in arbitrary background order
since ad-set creation needs the campaign's *real* Meta id, and ad creation
needs the ad set's): check for an already-`succeeded` row for this key first
(read its remembered result, skip calling Meta again) → atomically claim the
row (`pending`→`in_progress`, so a concurrent double-submit's loser backs off
instead of racing to create a second object) → call the writer → record the
result or the failure.

**Orchestration** (`builder/campaign-create.ts`):
`startBuilderCampaign(pool, customerId, adAccountId)` creates (or, if one
already exists unlinked, reuses) the **local `managed_campaigns` shell row**
every create-write anchors to — `status='under_review'`,
`meta_campaign_id=NULL` until every step lands. The final UPDATE that links the
row also moves it to **`status='active'`**: reaching that line means every
object is live on Meta, and `listEligibleForGeneration` filters on
`status='active'`, so a built campaign that kept the shell status was invisible
to the engine — no recommendations, and (because that tick is the only writer
of `ad_meta`/`ad_set_meta`) a customer dashboard showing no ads and no audience
breakdown for a campaign that was spending. See AIC-116 below. `buildCampaignOnMeta(pool,
writer, input)` walks campaign → each ad set → each ad, computing a
deterministic `builderKey(localCampaignId, kind, clientKey)` idempotency key
per object, logging an `action_history` row per successful create
(`recommendation_id=NULL`, `human_involved=true`), and — only once every
step has landed — updates the local row with the real `meta_campaign_id`
and the agreed budget. Until that final UPDATE, `listEligibleForGeneration`
(generation.ts) can't see the campaign at all (it requires
`meta_campaign_id IS NOT NULL`), so a campaign mid-build is never evaluated
by the engine.

**Partial-failure reconcile = resume, not cleanup.** If step N throws, the
error propagates and the campaign+every-prior-step's PAUSED objects are left
exactly as they are — they are the resume point, not orphans. Re-calling
`buildCampaignOnMeta` with the same `localCampaignId` and the same
`clientKey`s per ad set/ad recomputes the same idempotency keys, finds the
already-`succeeded` ones, skips re-creating them, and continues from the
first step that hasn't landed yet.

**Field-shape confidence.** Campaign fields (name/objective/status/budget/
special_ad_categories/bid_strategy) mirror fields this codebase already
reads and writes elsewhere — well-verified. The ad-set WhatsApp-destination
fields (`optimization_goal=CONVERSATIONS`, `destination_type=WHATSAPP`,
`promoted_object={page_id}`) are this adapter's best-effort reading of
Meta's Click-to-WhatsApp API and are **not yet live-verified** the way
`setDailyBudget`/`pauseAdSet` were (AIC-1/36's reversible dogfood tests).
The AC's "dogfood on an account we control" step is what actually verifies
this shape — treat that live test, not this code, as the real confirmation.

**The destination fields are resolved, never hardcoded.** `CreateAdSetParams`
carries an explicit `destination: string`, resolved by
`shared/src/recommended-defaults.ts`'s `resolveDestinationShape()` — the
single place every Meta field for a destination lives (`optimizationGoal`/
`destinationType`/`ctaType`). It **throws** for anything it doesn't recognize
rather than silently returning the WhatsApp shape — the fix for a real bug
(2026-08-14) where `createAdSet` wrote `"CONVERSATIONS"`/`"WHATSAPP"` as
inline literals nothing actually resolved from the campaign's real lead type,
which is exactly how a Pixel campaign once reached Meta with a WhatsApp shape.

### Advantage audience is explicitly OFF, and that is a promise we made

Meta refuses an ad set create outright unless `targeting.targeting_automation
.advantage_audience` is an explicit `0` or `1` — an omitted flag is a hard
error ("you need to enable or disable the Advantage audience feature"), found
live 2026-08-19 mid-build.

We send **0** (`ADVANTAGE_AUDIENCE_ENABLED` in `shared/recommended-defaults.ts`),
and it is a product decision rather than a default. The wizard's audience step
tells the customer plainly that *"the campaign targets all of Israel, by age
and gender"*, and the review step lists the exact range and gender back to
them. Advantage audience lets Meta deliver **outside** that whenever it
predicts better results — which would make both statements untrue and the
audience control an illusion.

**The trade-off, recorded rather than hidden:** Advantage audience often
improves delivery, especially on small budgets, so this may cost some
performance. Revisiting it is legitimate — but the order matters: change what
we PROMISE the customer first, then the flag. Flipping it while the copy still
claims fixed targeting would be the product lying about its own behaviour.

### The budget ceiling is enforced at the field, not at the end

Found live 2026-08-19, immediately after the ceiling shipped: an operator
agreed ₪20/day at provisioning, the wizard happily accepted ₪40/day at its
budget step, and the refusal only arrived on the FINAL click —
`proposed budget 4000 exceeds agreed ceiling 2000`, after every remaining step
had been filled in.

The ceiling is known from provisioning, so `/builder/context` now returns
`agreedBudgetAgorot` alongside `category` and `businessName`, and the budget
step refuses an over-ceiling number where it is typed, naming the actual
ceiling rather than saying "invalid".

The server check (`assertCreateWithinBudget`) is unchanged and still the
guarantee — a client check is a convenience that can be bypassed, never the
enforcement. This is AIC-105's first error rule ("validate inline, at the
field, before submit is possible; never a post-submit toast") applied to the
one field where getting it wrong wastes the most of an operator's call.

### An existing-post creative carries the campaign's CTA (AIC-115)

Found live 2026-08-23: a click-to-WhatsApp build failed at the LAST step
(`create_ad`) with *"The ad's creative is incompatible with the objective of the
campaign the ad belongs to."*

`createCreativeFromExistingPost` sent **only** `object_story_id`. The post was a
plain photo with no call-to-action, so the creative had no WhatsApp button and
could not serve the objective.

**The comment that caused this is worth remembering.** It read: *"Meta reuses
whatever CTA/link the original Page post already has."* That is an accurate
description of what happens when you send nothing — and it was read as a
**limit**, which is why nobody tried sending one. Probed against a real ad
account: Meta accepts `call_to_action` alongside `object_story_id`, and it
persists (read back as `call_to_action_type: WHATSAPP_MESSAGE`). The post never
needed its own CTA; we needed to attach one.

The adapter now resolves the destination shape and attaches its CTA, exactly as
the upload path already did. Engagement campaigns send none — they have no
`ctaType` by design, because the interaction happens on the post itself and
imposing a button would change what the customer chose to run.

**Best-effort in the additions path, deliberately.** If a campaign's destination
is BLOCKED (e.g. a website campaign with no `website_url` on file) the CTA is
omitted and the post is used as-is, rather than refusing. `free_beta_signups_leads`
is exactly that shape — its posts are link shares carrying their own CTA, and
adding an ad from one works today. Requiring a destination there would have
broken a working path in order to fix a different one.

### A failed build leaves nothing behind (rollback)

**Shipped 2026-08-19.** Replaces AIC-50's resume-point design.

AIC-50 deliberately treated a partially-created build as a **resume point**:
objects already created on Meta were kept, and a retry reused them rather
than making duplicates. The original wording was "an already-created PAUSED
object from a failed attempt is never an orphan to clean up — it's exactly
the resume point the next call expects to find."

That reasoning depended entirely on the word **PAUSED**. AIC-106 made creates
ACTIVE the same day, which silently converted every resume point into a
*live* object sitting in a customer's ad account. The premise expired and the
design outlived it — found live on a real onboarding call, where a refused
ad-set create left an ACTIVE campaign with zero ad sets stranded on the
customer's account, unreferenced by our own DB.

**How it works:**

1. **Meta is all-or-nothing.** `buildCampaignOnMeta` records every id it
   creates. Any failure calls `rollback()`, which deletes them **newest
   first** — children before parents. Meta does cascade a campaign delete,
   but relying on that would strand the ad set if the campaign delete were
   the call that failed. `GraphCampaignAdapter.deleteObject` is one method
   for all three kinds, since Meta's `DELETE /{id}` is the same call.
2. **It also purges that build's outbox rows** (`WriteOutbox.purgeForBuild`,
   keyed on the `localCampaignId:` prefix that `builderKey()` namespaces
   every row with). Easy to miss and fatal to skip: the outbox remembers
   each object's real Meta id, so deleting on Meta while leaving the rows
   makes the next attempt "resume" onto ids that no longer exist. That exact
   state had to be repaired by hand in production once.
3. **The original error always wins.** Cleanup is best-effort and swallows
   its own failures — logged, plus an `action_history` row (`rollback_build`)
   recording which ids could not be deleted, with `result: 'partial'`. An
   operator must see *why the build failed*, never a secondary cleanup error
   standing in front of it.
4. **The local shell row survives**, unlinked and with its agreed ceiling
   intact. The operator retries into the same row; the agreed budget was
   never the builder's to discard.
5. **Resume moved to the client.** What an operator actually wants back after
   a failure is *the work they typed* — budget, audience, ad copy — not Meta
   objects. `Builder.tsx` persists the wizard to `localStorage` on every
   edit, keyed **per customer**, cleared on successful submit and expiring
   after 6h. Both of those are safety properties, not housekeeping: without
   per-customer keying or the TTL, a half-filled wizard from one call could
   restore into the next customer's session.

**Why this is better than what it replaces.** The old design optimised for
not re-calling Meta; the new one optimises for never leaving a live object
nobody approved. Re-creating a campaign is cheap and idempotent-safe once the
outbox rows are gone. An unexplained ACTIVE campaign in a paying customer's
ad account is not cheap — it is the kind of thing that erodes trust in every
number the product shows.

**Known trade-off, stated rather than buried:** a transient failure (rate
limit, timeout) will also roll back, so the retry rebuilds from scratch —
more Meta writes than the resume design needed. That is the accepted cost of
the guarantee. If it proves expensive in practice, the narrower option is to
roll back only on terminal refusals and keep resume for transient ones, which
needs a trustworthy transient-vs-terminal signal (`is_transient` exists on
Meta's error body; it has not been verified across error types).

### The destination choice (AIC-89)

**Destination is a real builder step now, not a P0-fixed value.** Step 1
("יעד הפנייה") lets the customer choose WhatsApp (recommended default) or
Website — this is the CREATE-time counterpart to AIC-102's fix on the
additions (add-content-to-an-existing-campaign) flow, which taught the
existing-campaign path to build a website-shaped creative but never touched
how a *new* campaign gets created.

**`CreateAdSetParams` gained `pixelId`/`conversionEvent`, used only for the
WEBSITE destination.** `createAdSet` branches its `promoted_object` the same
way `createCreativeFromUpload` already branches its `call_to_action`
(AIC-102): `{ page_id }` for WhatsApp, `{ pixel_id, custom_event_type }` for
website. Both fields are ignored/absent for a WhatsApp ad set — no cross-talk
between the two shapes. **Field-shape confidence note, same discipline as
the WhatsApp shape above:** `pixel_id`/`custom_event_type` is this adapter's
best-effort reading of Meta's `OFFSITE_CONVERSIONS` API, matching the real
shape observed live on Pisga's own `free_beta_signups_leads` campaign during
the AIC-87 investigation — not yet independently live-verified as a *create*
write (as opposed to a read), same as every other builder create-write
before its own first live dogfood test.

**The conversion-event picker is curated, not free-text.** `LEAD_CONVERSION_EVENTS`
(`shared/src/recommended-defaults.ts`) lists five of Meta's own standard
lead-relevant events (`LEAD`, `COMPLETE_REGISTRATION`, `SUBMIT_APPLICATION`,
`SCHEDULE`, `CONTACT`) — each paired with the exact Insights `action_type` it
reports as (`resolveLeadActionType()`), so `managed_campaigns.lead_event_types`
is never built from an inline string transform at a call site. Throws for an
unrecognized event rather than silently building a wrong lead definition.

**The Pixel picker replaces free-text entry for the create path.**
`GraphCampaignAdapter.listPixels(adAccountId)` (`GET act_.../adspixels`) —
new; AIC-87's free-text `tracking_pixel_id` capture (during onboarding) is
unaffected and still exists for the *manage-an-existing-connection* path
(AIC-101's wizard).

**The Pixel-recency guardrail never renders a confident "the Pixel is dead."**
`checkPixelEventRecency(pixelId, eventName)` — adapted from the already-proven
`getPixelTopHost`'s `/stats` pattern, bucketed by event name instead of host.
Three-valued: `true` (recent volume), `false` (the event genuinely has zero
recent volume, or never appears in the response at all), `null` (the check
itself failed — network error, unparseable response). The UI treats `null`
the same as `true` (no warning) — warning on an inconclusive signal would cry
wolf, the same principle `docs/features/tracking-health.md` documents for
why a pixel-recency check was originally deferred at all. Unlike that
deferred check (which would have run *after* a campaign was already
spending), this one runs at **build time**, before anything is created —
genuinely lower-risk than the design that was rejected there.

**Switching destination mid-wizard clears the other branch's fields**
(`Builder.tsx`'s `chooseDestination`) — a customer who types a WhatsApp
number then switches to Website never has that stale number silently
submitted alongside a URL.

Tests: `shared/recommended-defaults.test.ts` (`resolveDestinationShape`/
`resolveLeadActionType` for the website shape, unrecognized-value throws),
`server/src/meta/campaign-adapter.test.ts` (`createAdSet`'s website
`promoted_object`, `listPixels`, `checkPixelEventRecency`'s three-valued
result including the never-a-confident-false-on-network-failure case),
`server/src/builder/campaign-create.integration.test.ts` (a full
website-destination build persists `website_url`/`tracking_pixel_id`/
`lead_event_types` correctly; an unrecognized destination throws before any
Meta call), `server/src/routes/builder.integration.test.ts` (`GET /pixels`,
`POST /pixel-check`, and the full website-destination HTTP happy path).

Tests: `campaign-adapter.test.ts` (created-PAUSED + correct endpoint/field
shape per object, mocked `fetch`), `write-outbox.integration.test.ts`
(`applyIdempotent`: resume-without-recreating, failure-then-retry, and the
concurrent-claim race is blocked), `campaign-create.integration.test.ts`
(the full orchestration: shell-row idempotency, every object PAUSED +
action_history logged + the campaign linked on success, a mid-build failure
resumes without recreating prior steps, a full re-run after success makes no
new Meta calls at all).

### Creative handling (AIC-51)

The content step: turning a customer's media into a Meta ad creative
`createAd` (AIC-50) can attach, on two paths real customers both need —
**upload** new image/video, or **pick an existing IG/FB post** (like
GelNails did). Split the same way as AIC-50, platform-independent spec in
`shared/`, Meta API calls in `server/src/builder/` and the adapter.

**Validation returns codes, never text** (`shared/src/creative-handling.ts`,
`validateCreativeCopy`) — `missing_media` / `missing_headline` /
`headline_too_long` / `missing_primary_text` / `primary_text_too_long`. This
is a correction from AIC-49's precedent (rationale strings hardcoded
straight into the shared spec module): AIC-51's own AC explicitly requires
"copy/labels in the strings file," so this module stays copy-free — the
Hebrew responsibility notice and every error message live in
`web/src/strings.ts`'s `builder` section, mapped from a code via
`creativeValidationMessage()`. **AIC-49's rationale strings are pre-existing
debt in the same direction**, not yet retrofitted — deferred to AIC-52,
where the actual UI consuming both will make the right strings.ts shape
obvious instead of guessed at ahead of time.

**Upload → Meta** (`GraphCampaignAdapter`, implementing a new
`CreativeWriter` interface): `uploadImage` posts base64 `bytes` to
`adAccountId/adimages`, parsing Meta's `{images: {<filename>: {hash, url}}}`
response shape (notably different from every other create endpoint's flat
`{id}`). `uploadVideo` posts multipart form data to `adAccountId/advideos`,
then polls `GET /{video_id}?fields=status,picture` (bounded — 10 attempts,
2s apart in production, injectable via the adapter's 3rd constructor param
so tests don't wait in real time) until Meta reports `video_status=ready`
and a thumbnail is available; throws honestly on `video_status=error` or on
exhausting the poll budget, rather than hanging or fabricating a result.

**Existing-post path**: `listPromotablePosts(pageId)` reads the connected
Page's `promotable_posts` edge; `createCreativeFromExistingPost` creates the
ad creative via `object_story_id` (`{pageId}_{postId}`) — no
`object_story_spec`, no upload, at all.

**The creative's CTA shape follows the destination** (`createCreativeFromUpload`),
resolved via the same `resolveDestinationShape()` as the ad-set fields:
`object_story_spec.link_data.call_to_action = {type: FIXED_CTA, value:
{whatsapp_number}}` for WhatsApp, `{type: WEBSITE_CTA, value: {link}}` plus
a top-level `link_data.link` for website (AIC-89) — the exact branch AIC-102
built first for the additions (existing-campaign) flow, reused here unchanged
for the create path. Both remain this adapter's best-effort reading of
Meta's respective APIs — **not yet independently live-verified as a create
write** — treat the first live create-write dogfood test on an account we
control as the real confirmation, not this code.

**Idempotent the same way as AIC-50's creates** (`builder/creative-create.ts`,
`createCreativeIdempotent` → `WriteOutbox.applyIdempotent`, migration 021
widens the outbox's `kind` check to add `create_creative`). Deliberately
**not** applied to the raw upload step itself (`uploadCreativeMedia`) — an
uploaded file buffer is request-scoped and not meaningfully resumable, unlike
the small deterministic JSON payloads every other create-write uses; a
failed upload is just re-uploaded, ordinary file-upload UX.

**3–5 separate ads** (`RECOMMENDED_AD_COUNT`, `shared/creative-handling.ts`):
a recommendation, not a constraint — each ad's creative gets its own
`clientKey` (e.g. `"adset-1-ad-2"`), so the engine can compare per-creative
performance (AIC-36's rationale for per-creative pause).

Tests: `shared/creative-handling.test.ts` (validation codes, accumulates
every problem rather than stopping at the first), `campaign-adapter.test.ts`
(upload/video-poll/list-posts/create-creative field shapes, honest throws on
Meta rejection and on video-processing failure/timeout),
`creative-create.integration.test.ts` (upload path, existing-post path,
idempotent per clientKey, failure-then-resume, distinct creatives per
clientKey).

### The guided builder UI + HTTP routes (AIC-52)

The step flow: 8 steps (goal, destination choice, budget, special ad category,
audience, placements, creatives, review), each showing its recommended
default already filled in — "accept every default and click through" is a
real, working path, not just a design intent. Every real choice is a live,
editable control on the step itself (never a collapsed "we'll handle it"),
with a green "מומלץ" badge (`StatusPill variant="ok"`, reusing the existing
component rather than inventing a new one) marking the recommended option
and a one-line rationale underneath, pulled from `shared/recommended-defaults.ts`'s
structural values + `web/src/strings.ts`'s matching copy.

**The objective is a real choice (AIC-107), not a fixed field.** Step 1 offers
Leads (recommended) or Engagement. The two are genuinely different campaigns
on Meta — `OUTCOME_LEADS` vs `OUTCOME_ENGAGEMENT` — resolved from
`resolveDestinationShape(destination).objective`, one place, never an inline
literal. (It was one before: `FIXED_OBJECTIVE` had zero consumers while
`createCampaign` hardcoded `"OUTCOME_LEADS"`, so an engagement campaign would
have been created on Meta as a Leads campaign.)

Choosing Engagement changes three later steps, each stating its reason rather
than silently differing:
- **Step 2 (יעד הפנייה)** has nothing to choose — the interaction happens on
  the Page post — so it says that instead of rendering an empty panel.
- **Step 7 (מודעות)** drops the upload tab: an engagement ad promotes an
  *existing* post. `createCreativeFromUpload` refuses a CTA-less destination
  outright rather than sending Meta `call_to_action: { type: null }`.
- **Step 1 itself** states what the engine will NOT do for this type — no
  budget-increase recommendations, no lead-quality question — per AIC-98,
  so the customer learns it at the decision point, not by noticing an absence
  later.

**מומלץ vs fixed — the badge means "you can change this," and only appears
where that's true.** A follow-up honesty pass (see below) drew the line hard:
the goal and placements steps are *fixed* (no code path to change them in P0),
so they carry no badge and say so plainly, exactly like the goal step's
"...קבועות בשלב הזה ולא מוצגות כבחירה." Only steps with a real, wired,
editable control (budget, special-ad-category, audience) get the מומלץ badge.

**The audience step's business type is an editable control, not an invisible
field.** The single input driving the whole audience recommendation
(age/gender defaults + rationale) is the customer's business category. It was
originally read silently from `customers.category` — a free-text field only
an *operator* sets during manual onboarding, which the customer never sees or
confirms. That meant a mis-typed or blank category would confidently target,
say, a plumber as "women 18–45" with no way for them to notice or fix it. So
the step now leads with a **business-type `<select>`** (`web/src/app/Builder.tsx`,
options from `BUSINESS_CATEGORY`, labels in `strings.ts`'s
`builder.audience.businessTypes`), pre-selected from the onboarding category
(normalized via `normalizeBusinessCategory`, so a blank/unknown value resolves
to a real `other` option rather than a mystery) and **editable** — changing it
re-derives age/gender from `resolveAudienceDefault(cat)` and re-renders the
rationale live. "לפי מה שסיפרתם לנו. לא מדויק? אפשר לשנות כאן."

**Placements are genuinely fixed, and the copy no longer pretends otherwise.**
`createAdSet` sends no placement field at all → Meta uses automatic
(Advantage+) placements; there is no code path to narrow them. The step
originally carried a מומלץ badge and a rationale about "the tradeoff of
narrowing manually" — language that only makes sense for a lever the customer
doesn't have. It's now presented as fixed (no badge, `builder.placements.fixedNote`),
and the spec constant was renamed `RECOMMENDED_PLACEMENTS` → `FIXED_PLACEMENTS`
so the code, spec, and copy finally agree.

**Location/radius is all-of-Israel in P0, said plainly — not a dead control.**
The audience step originally shipped a "radius (ק״מ)" number input that *went
nowhere*: the value never left the browser, and `createAdSet` sends only
`age_min`/`age_max`/`genders`/`geo_locations.countries=["IL"]`. A control that
silently discards its input is a lie, so it was removed and replaced with a
plain note: the campaign targets all of Israel by age + gender, and
area/radius targeting is coming later. `CATEGORY_AUDIENCE_DEFAULTS[cat].radiusKm`
is kept in the spec as the per-category seed for that future work — real
geo-targeting (business location + geocoding + Meta `custom_locations`) is its
own ticket, **AIC-60**, which is the AC-accurate version of what the radius
input was faking.

**HTTP routes** (`server/src/routes/builder.ts`, mounted at
`/api/app/builder`, `requireAuth` throughout): `GET /context` (resolves
whether this customer can build — see below — and returns their business
category to prefill the audience step), `POST /start` (idempotent — same
`startBuilderCampaign` as AIC-50), `POST /upload` (`multer` memory storage,
`limits.fileSize = MAX_VIDEO_BYTES`), `GET /posts`, `POST /creative`, `POST
/build`. Every route resolves the caller's ad-account/Page/category fresh
from their own JWT-scoped rows (`server/src/builder/session.ts`'s
`resolveBuilderContext`) — nothing is trusted from the client, including
`adAccountId`/`pageId` (a client-supplied `localCampaignId` is checked for
ownership via `ownsLocalCampaign` before every write).

**"Ready to build" is a real precondition, not just a UI nicety**:
`resolveBuilderContext` returns `null` (→ 409) unless the customer has a
healthy connection (`access_health = 'ok'`), a linked ad account, a Page,
**and no managed campaign yet** — the builder is for a customer's *first*
campaign only, matching `startBuilderCampaign`'s `UNIQUE(customer_id)`
constraint on `managed_campaigns`. A real bug caught here during testing:
the "already has a campaign" check initially matched the unlinked shell row
`/start` itself creates, which meant calling `/start` twice (the normal
resume case) 409'd on the *second* call — fixed by scoping the check to
`meta_campaign_id IS NOT NULL` (a genuinely *linked* campaign), which is
what `startBuilderCampaign`'s own resume logic already checked.

**The builder always creates exactly ONE ad set** (AIC-38/49's recommended
structure — there is no ad-set-count step). Each ad in the creatives step
gets its own `clientKey`; the review step's "Create (paused)" button posts
the full spec to `/build`, which resolves to a `BuildCampaignInput` with one
`adSets` entry and calls `buildCampaignOnMeta` (AIC-50) exactly as designed.

**Frontend**: `web/src/app/Builder.tsx` (the wizard shell + state machine +
goal/whatsapp/budget/specialCategory/audience/placements/review step
renders) and `web/src/app/BuilderCreatives.tsx` (the creatives step: per-ad
upload-or-existing-post, headline/primary-text, calling `/upload` then
`/creative` per ad). No client-side draft persistence — refreshing mid-wizard
loses in-progress field values (the *created* Meta objects themselves are
safe and resumable via the outbox; only the unsaved form state is not) — a
deliberate P0 simplification, not an oversight.

**Corrected an AIC-49 precedent while building this**: AIC-52's own AC says
"all copy in the strings file." Building the actual UI made it obvious that
`recommended-defaults.ts`'s rationale strings (budget, placements, the
special-ad-category question, and every category's audience rationale) were
exactly the copy this rule is about — so they moved into `web/src/strings.ts`'s
`builder` section (`budget.rationale`, `placements.rationale`,
`specialCategory.question`, `audience.categoryRationale`, keyed by
`BusinessCategory`), and `shared/recommended-defaults.ts` is now genuinely
copy-free (only numbers/structure/enums). This was flagged as deferred debt
in AIC-51's doc entry and STATE.md; it's resolved now rather than deferred
again.

**Home CTA** (`web/src/app/Home.tsx`): the `no_campaign` state now branches —
a customer with a healthy connection + ad account + Page sees "בואו ניצור את
הקמפיין הראשון שלכם" → `/app/builder`; a customer still mid-onboarding sees
the pre-existing "we're setting up your account" → `/onboarding` copy,
unchanged. No permanent sidebar nav entry — reached only via the Home CTA,
matching the existing `/onboarding` pattern.

**Reused wholesale for an operator building on a customer's behalf (AIC-105
Branch A)** — the ops console's onboarding wizard (see
[ops-console.md](ops-console.md)'s step-4 section) launches this exact
component for a customer with zero existing campaigns. `Builder.tsx` and
`BuilderCreatives.tsx` both take an optional `customerId` prop; every `api.ts`
call it makes (`getBuilderContext`, `startBuilder`, `buildCampaign`,
`getBuilderPixels`, `checkBuilderPixel`, `getPromotablePosts`,
`uploadCreativeFile`, `createCreative`) takes a matching optional `customerId`
and, when present, targets `/admin/customers/:id/builder/*`
(`server/src/routes/admin-builder.ts`, `requireAdmin`-gated) instead of this
section's `/app/builder/*` — same shapes, same 8 steps, only which backend
route answers changes. `resolveBuilderContextForCustomer`
(`server/src/builder/session.ts`) is the customerId-keyed sibling of
`resolveBuilderContext` above, sharing the identical readiness check via one
`contextFromRow` helper, so "ready to build" can never mean something
different for an operator than it does for the customer. No second wizard
exists or was considered — reuse, not a parallel implementation, was the
whole point.

**Verification**: `server/src/routes/builder.integration.test.ts` (7 tests —
full happy path with a mocked `fetch` exercising the real
`GraphCampaignAdapter` through the real HTTP routes end to end, ownership
checks, honest 409/503/400 responses, multipart upload). The wizard was also
walked step-by-step in a real browser against a locally-seeded "beautician"
customer, confirming the audience step correctly prefilled 18–45/female/8km
with the beautician rationale text, and every step's validation gating
worked (Next stays disabled until the step's real requirement is met).
**Found and fixed during that pass**: (1) a `server/.env` file (from earlier
Meta-verification work) holds a real `META_SYSTEM_USER_TOKEN` that local dev
picks up automatically — worth remembering before any local run of the
builder routes, since `GET /posts` etc. will make a REAL Meta call rather
than the intended honest 503 unless that var is explicitly unset first; (2)
at a phone width, the 8-step `Stepper` (`web/src/app/components.tsx`,
shared with Onboarding's 4-step use) overflowed its card with no way to
reach steps 5–8 — fixed with a `max-width: 640px` rule making `.stepper`
horizontally scrollable (shrinking the circles/labels a bit) plus a
`scrollIntoView` effect so the current step auto-scrolls into view, so
"more steps exist" is discoverable rather than silently clipped. Re-checked
the full wizard at 375px afterward — the two-up age-range `.field-row` and
every other step render cleanly at that width.

### Meta's own error message reaches the operator (AIC-105, narrow slice)

Found live, same call as the ceiling gap above: a WhatsApp campaign build
failed with `"failed to build campaign"` — Meta itself had refused with a
specific, actionable reason (Page not linked to a WhatsApp Business Account),
and the generic 502 catch-all discarded it.

`GraphWriteError` (`meta/campaign-adapter.ts`) carries Meta's own
`error_user_title`/`error_user_msg` structurally when Meta provides both —
every write path (`post`, `postCreate`, `adimages`, `advideos`) now throws it
in place of a plain `Error(string)` in that case. The build routes catch it
before the generic fallback and return `502 meta_write_refused` with Meta's
real message, its title, and `transient` (from `is_transient`).

**Deliberately narrow — not AIC-105's full error-handling scope.** This is
one category (Meta API failure) and only the slice of it Meta already labels
for us. Still not built, and not claimed here: the three-layer symptom-table
translation for errors Meta does NOT label this well, the 409/state-conflict
category, the transient-vs-real UX (the boolean rides along but nothing acts
on it yet), and inline pre-submit field validation. AIC-105's ticket still
owns tracking those.

### The agreed ceiling now has somewhere to be set for Branch A (AIC-106 follow-up)

Found live on a real onboarding call, the day the launch gate came out: an
operator could complete the ENTIRE builder wizard — goal, destination,
budget, category, audience, placements, three ads — and only discover there
was no agreed ceiling on the FINAL click, with `budget_ceiling_missing`.

The gap: `startCampaign` (Branch A's "צור קמפיין חדש") provisions the
CONNECTION only, with no campaign fields and no budget field anywhere in that
form — the half-1 ceiling work assumed a budget would already exist by build
time, but for a brand-new customer nothing had ever asked for one. The
₪20/day the operator typed was the wizard's own PROPOSED-spend field, not the
AGREED ceiling; those are deliberately different things and must never be
conflated (that conflation was half of the original AIC-106 bug).

Fix: `AdminOnboarding.tsx`'s "צור קמפיין חדש" section now has its own
required "תקציב יומי שסוכם עם הלקוח" field, gating the button exactly like
the Page/Instagram verification checks already do. `provisionConnection`
accepts it on the connect-only path and pre-creates the shell row
`startBuilderCampaign` would otherwise create later, with the ceiling
already set — that function's own idempotent `SELECT ... WHERE
meta_campaign_id IS NULL` finds and reuses it, so no change was needed there.
Omitting the budget is unchanged behaviour (no shell row, exactly as
before) — additive, not a new requirement on any other caller.

### The build refuses an incomplete campaign (AIC-103 x AIC-105)

Before the first Meta call, the builder checks the destination's required
fields from AIC-103's declared table (`CAMPAIGN_TYPE_REQUIRED_FIELDS`) and
throws `CampaignConfigIncompleteError` if any are missing — website needs
`website_url` + `tracking_pixel_id` + `lead_event_types`, WhatsApp needs
`whatsapp_destination`, engagement needs `lead_event_types`.

**Why here, when AIC-103 already enforces it at provisioning.** AIC-103
enforced the table at provisioning, at use, and as a health check. AIC-105's
Branch A slipped between all three: it provisions the CONNECTION with no
campaign, and the builder creates the campaign afterwards — so nothing re-ran
the check. The one path that produces new campaigns was the one path whose end
state was unverified. That is Pisga's own missing `website_url` reintroduced
through the new route.

AIC-106 raised the cost of the gap rather than creating it: the campaign is
ACTIVE on creation, so an incomplete one starts **spending** while unable to
attribute a single lead, instead of sitting PAUSED where someone might notice.

The check reads the values being BUILT WITH, not the row on disk — the row is
written after the Meta calls, so reading it there would check the wrong thing
and pass on an empty shell every time.

Surfaces as `409 campaign_config_incomplete` with a `missingFields` array, so
the operator is told which field to fill rather than "invalid config" — never
502, which would blame Meta for our own precondition.

### Creation goes live immediately — the launch gate is gone (AIC-106)

There is no PAUSED-then-approve step. The builder creates the campaign, ad
set(s) and ad(s) **ACTIVE**, and the campaign is spending the moment the build
returns. `launch_approved_at` is stamped in the same write, so nothing
downstream still treats the campaign as awaiting approval.

This REVERSES AIC-50/AIC-53's original hard rule ("a create must never produce
a live, spending object"), deliberately. The governing distinction is now:

> **Creating something new** no longer needs approval.
> **Changing something the customer already has running** still does.

Recommendation approvals (AIC-12/13) are untouched — a proposed budget change,
creative pause, or audience pause on a running campaign still requires an
explicit approval through the safe-execute pipeline.

**What replaced the gate.** The gate was doing two jobs, and only one of them
was approval:

1. *A ceiling on spend.* Now the create-path budget guard
   (`assertCreateWithinBudget`, see
   [safe-execution.md](safe-execution.md)) — it refuses an over-ceiling or
   ceiling-less build BEFORE the first Meta call, so nothing reaches Meta
   unbounded.
2. *Catching the wrong customer.* This was incidental but real: the customer
   reviewed the campaign and would have said "this isn't mine." An operator
   running several onboardings in one session is most likely to have exactly
   this wrong, and a budget ceiling cannot catch it — a correctly-typed budget
   against the wrong customer passes every numeric check.

So the review step now carries a confirmation naming the customer, the daily
budget, and that it starts immediately:

> יצירת קמפיין עבור **יורם גאון** · ₪40 ליום · הקמפיין יתחיל לפעול מיד

The name comes from `BuilderContext.businessName`, sourced from the customer
record via `/builder/context` — **never** from operator-entered text. A name
the operator typed themselves would confirm nothing about who is being spent
for; that is the whole point of the control.

**What the AIC-18 first-campaign review still does — and no longer does.** It
still exists and still moves the local row `under_review → active`. It no
longer sits between creation and spend, because the Meta objects are live from
creation. Treat it as a management record, not a spend gate.

**It applies to IMPORTED campaigns, not built ones** (AIC-116). The review asks
"is this structure manageable at all?" — wrong objective, no destination, an
unwieldy sprawl of ad sets. That question only has content for a campaign we
found on Meta and connected (`customer-onboarding.ts`). For one the builder
created, we chose the objective, the destination and the ad-set shape
ourselves, so there is nothing to review and nobody ever submits one. Until
AIC-116 a built campaign therefore sat `under_review` **forever**, which is how
it stayed hidden from the engine. Built campaigns are now `active` on
completion; imported ones still start `under_review` and still need the review.

**The launch-approval path still exists in code** (`launch/activate.ts`,
`services/customer-launch.ts`, `/app/launch`), and is deliberately retained
for now: it is the only way to activate a campaign that was created PAUSED
under the old behaviour. Verified 2026-08-19 that no such campaign remains
(both live campaigns have `launch_approved_at` set), so it is currently
unreachable for new work — `readyToLaunch` requires `launch_approved_at IS
NULL`, which creation now always stamps. Removing that path is tracked as
cleanup rather than done here, so a stranded old campaign can never become
unactivatable.

### Add to an existing campaign (AIC-63)

The gap the first five tickets left: the builder is hard-scoped to a
customer's *first* campaign (`resolveBuilderContext` 409s unless there's no
managed campaign yet, and `startBuilderCampaign` has a `UNIQUE(customer_id)`
constraint). Creating a first campaign is rare — most customers arrive with
one already. **Adding a creative or testing a new audience is the everyday
management action**, and until this ticket there was no in-app way to do it;
the only option was Ads Manager, which defeats the product. This ticket adds
the missing everyday path, reusing every primitive the builder already
proved out rather than duplicating it.

**Two sub-flows, one orchestration module**
(`server/src/additions/add-content.ts`):

- **Add an ad** (`addAdToExistingCampaign`) — one PAUSED ad under an
  *existing* ad set the caller already owns.
- **Add an ad set** (`addAdSetToExistingCampaign`) — a new PAUSED ad set +
  its ads under the *existing* campaign. The builder's "always exactly one
  ad set" rule doesn't apply here — this is precisely how a second (or
  third) ad set gets added.

Both reuse `createAdSet`/`createAd` (AIC-50, unchanged — still always
PAUSED) and the SAME idempotent outbox (`WriteOutbox.applyIdempotent`,
`builderKey`) via `campaign-create.ts`'s `asCreatingWriter` (exported, not
duplicated). Creative creation reuses AIC-51's `createCreativeIdempotent`
and `uploadCreativeMedia` unchanged too — only the HTTP routes differ
(`/api/app/additions/{upload,posts,creative}` instead of `/api/app/builder/*`),
because the precondition is the opposite (an existing campaign is *required*,
not forbidden) and reusing the builder's own routes would have meant
weakening that gate.

**`pending_additions`** (migration 023) is the approval marker — the
per-object equivalent of AIC-53's `managed_campaigns.launch_approved_at`,
needed because an added ad/ad-set doesn't have its own row anywhere else to
track "created, not yet approved" against. Inserted only once every create
for that addition has succeeded (same "anchor only once complete" discipline
as `buildCampaignOnMeta`) — idempotent per `(campaign_id, addition_key)` so
a resubmitted addition (its underlying creates all replaying as
already-succeeded via the outbox) never produces a second pending row for
the same objects.

**Activation is per-object, not per-campaign.** AIC-53's `activateCampaign`
only flips the *campaign*; it doesn't touch the ad sets/ads under it (which
were also created PAUSED). AIC-63 needed a genuinely new activation
primitive: `GraphCampaignAdapter.activateAd` (mirrors `activateCampaign` —
hardcodes `status=ACTIVE`, no caller-supplied value) and `activateAdSet`
(wraps the pre-existing `setAdSetStatus`, same hard rule). `server/src/additions/approve.ts`'s
`approveAddition` activates the ad set first (if `kind='ad_set'`) then every
ad, checking each object's live status *before* writing — an activation
write is naturally idempotent (setting an already-ACTIVE object to ACTIVE is
a harmless no-op), so this check is what makes a retry after a partial
failure never re-activate or double-log an object that already landed.

**Ownership is checked twice, not assumed.** `resolveAdditionContext`
resolves the caller's own campaign/ad-account/Page fresh from their JWT (the
same pattern as `resolveBuilderContext`), and `POST /additions/ad` separately
re-validates the client-supplied `metaAdSetId` against a **live** re-fetch of
`getAdSetMeta` before creating anything — a customer can never add an ad to
an ad set that isn't genuinely theirs, even if they guessed a valid-looking
ID. The ad-set list is read live (not the `ad_set_meta` cache), specifically
so an ad set created moments earlier in the *same* visit — before the hourly
engine tick would ever refresh that cache — is immediately pickable.

**Refused, not attempted, on a non-WhatsApp campaign (bug fix, 2026-08-14).**
This flow hardcodes WhatsApp-shaped Meta objects (a `WHATSAPP_MESSAGE`
call-to-action, `CONVERSATIONS`/`WHATSAPP` ad sets) — correct for AIC-63's
original scope (every managed campaign was Click-to-WhatsApp) but wrong for
any other lead type, including a campaign our own builder created. Found by
checking a real connected Pixel campaign: an added creative would carry an
empty `whatsapp_number` into a real Meta write, and an added ad set's
conversions could never match the campaign's `lead_event_types` — real
spend, zero countable leads, and AIC-88's tracking guard would then flag the
campaign as broken.

`resolveAdditionContext` (`server/src/additions/session.ts`) is the single
chokepoint every additions route passes through, so the guard lives there
rather than per-route: `whatsappWriteBlock(ctx)` returns one of two distinct
reasons — `not_whatsapp` (this campaign's leads don't arrive over WhatsApp at
all) or `missing_number` (it genuinely is a WhatsApp campaign, but we never
captured its number, e.g. connected from outside the builder). **Not
collapsed into one message**: checking against the real accounts found
GelNails hits `missing_number`, not `not_whatsapp` — its own campaign was
never built through the app, so `whatsapp_destination` was never written,
even though its leads genuinely are WhatsApp messages. `AdditionContext.whatsappNumber`
is `string | null` (not a coalesced `''`) specifically so a caller can't
reach a real Meta write with an empty number by forgetting to check — the
nullable type turns the one remaining unguarded consumer into a compile
error. Both routes (`POST /creative`, `POST /ad-set`) return `409` with
`{ reason, error }` before any Meta call or DB write. Full support for other
destinations is AIC-89's scope, not this fix's — this only ensures the
flow never attempts a write it can't get right.

**"No campaign" collapsed six different reasons into one wrong message
(bug fix, 2026-08-15, found live).** `resolveAdditionContext` 409s (with no
detail) whenever ANY of six preconditions fails — no customer, no campaign
row, campaign not linked to Meta, unhealthy connection, no ad account, or no
Page on file. The frontend showed one generic message for all six: "עוד אין
קמפיין להוסיף לו תוכן — צריך קודם ליצור את הקמפיין הראשון שלכם" (no campaign
yet — build your first one), with a CTA into the builder. Confirmed live: a
customer with an ACTIVE, spending campaign hit this exact screen — their
connection's `page_id` was `NULL` (our System User also turned out to lack
read access to that campaign's actual Facebook Page, a Meta Business Manager
permission gap the app can't self-heal). Telling that customer to "build
your first campaign" is both false and a dead end — the builder itself
refuses to run once a campaign already exists (`resolveBuilderContext`'s
own opposite precondition).

Fixed with the same "distinct reasons need distinct copy" pattern as the
WhatsApp guard above, not a bigger collapse: `resolveAdditionAvailability`
(`session.ts`) classifies the failure into `no_campaign` (genuinely build
one — the only case the original CTA was ever correct for), `not_launched`
(a local campaign row exists but was never linked to a real Meta campaign —
CTA to Home to review/launch), `missing_page` (the campaign is real and the
ad account access is fine, but we don't have the Facebook Page — CTA to
Settings), or `connection_issue` (the rarer remainder: unhealthy connection
or no ad account on file — also CTA to Settings). `resolveAdditionContext`
itself is untouched (still a blunt `AdditionContext | null` for the eight
write routes that only ever need a yes/no); `resolveAdditionAvailability` is
a second, thin function over the same row-fetch, used only by `GET /context`
— the one place that has to explain the "no" to the customer. `ApiError` on
the web client gained a `body` field so `AddContent.tsx` can read the 409's
`reason` without a second round trip.

**`missing_page` got its own message, not just its own reason (bug fix, same
day, found live testing the fix above).** The generic `connection_issue`
copy ("check your connection in Settings") was itself unhelpful for the most
common real case — it didn't say *what* was wrong or how to fix it, even
though that exact explanation already existed: onboarding's Connect screen
(`web/src/app/Connect.tsx`) has had precise, tested copy for "ad account
connected, Page access missing" since AIC-5 (`missingTitle`/`missingBody`/
`howToFix`/`fixSteps` — the two-step Meta Business Settings fix: share the
Page to our Business Portfolio by ID, then assign it to the System User).
That copy was simply unreachable once onboarding was behind you.
`resolveAdditionAvailability` now checks `page_id` separately from the rest
of `connection_issue`, and `AddContent.tsx` renders the exact same
`app.connect` strings rather than duplicating them — same problem, same
explanation, wherever a customer encounters it.

**The classification itself moved out to a shared module (same day,
follow-up).** `no_campaign`/`not_launched`/`missing_page`/`connection_issue`
is now `classifyConnectionReadiness` in `server/src/services/connection-readiness.ts`
— a pure function over `{campaignId, metaCampaignId, accessHealth,
metaAdAccountId, pageId}`, returning the reason or `null` when ready. Both
`resolveAdditionContext` and `resolveAdditionAvailability` call it rather
than re-checking the four fields inline; the admin console's customer list
(`customers.ts`, see [ops-console.md](ops-console.md#customers-view-aic-16))
calls the exact same function so an operator sees the identical reason a
customer would eventually hit, before they hit it.

**Customer surface** (`web/src/app/AddContent.tsx`): reached via a new
persistent sidebar entry ("הוספת תוכן"), shown whenever a managed campaign
exists — the opposite gate from the builder's `no_campaign`-only Home CTA.
Two mode tabs (add ad / add ad set); the ad-set audience fields reuse
`AudienceFields.tsx`, extracted from `Builder.tsx` during this ticket so the
honesty-pass fix (visible, editable business type; no dead radius control)
only has to exist once. The creatives step reuses `BuilderCreatives.tsx`,
which was parameterized (`getPosts`/`uploadFile`/`createCreativeFn` props,
defaulting to the builder's own endpoints) rather than forked, so both
screens share one upload/validation/post-picker implementation. A "ממתין
לאישור שלכם" section lists every pending addition with its own approve
button — deliberately a plain list, not a single modal like the launch gate,
since more than one addition can be pending at once.

**Two real bugs found and fixed while verifying, not just described:**

1. The add-ad-set audience step never actually derived age/gender from the
   loaded business category — `category` populated correctly (visible in the
   dropdown) but `ageMin`/`ageMax`/`gender` stayed at a hardcoded fallback
   instead of the category's real default. Fixed by calling
   `resolveAudienceDefault` in the context-load effect, matching
   `Builder.tsx`'s own pattern.
2. **A pre-existing, session-wide mobile bug**, not introduced by this
   ticket but first caught verifying it: CSS Grid items default to
   `min-width: auto`, so a `.grid-2`/`.grid-3` column can't shrink below its
   widest child's intrinsic content size. At 375px this silently forced the
   *entire page* to ~497px wide on every screen using those grids (including
   `SupportCard`, present on nearly every customer screen) — invisible in a
   plain screenshot, only caught by measuring `scrollWidth` against the
   viewport directly. Fixed generically: `.grid-2 > *, .grid-3 > * { min-width: 0; }`
   in `ui.css`. A second, narrower instance — `.btn`'s `white-space: nowrap`
   forcing long-label submit buttons ("הוספת קבוצת המודעות (מושהית)") wider
   than their container — got its own `.btn-wide` utility class, applied to
   the builder's and both add-content submit buttons.

**Verification**: `add-content.integration.test.ts` (8) +
`additions.integration.test.ts` (14, full HTTP through the real adapter with
mocked `fetch`, including the three `GET /context` unavailable-reason cases) + `campaign-adapter.test.ts` (+5: `getAdSetStatus`/`getAdStatus`
reads, `activateAdSet`/`activateAd` always-ACTIVE, honest throws, `getAdSetMeta`
carrying `effective_status`). Real-browser walk at both desktop and 375px
mobile against a locally-seeded customer with an existing linked campaign:
sidebar entry appears/disappears correctly, both mode tabs render, the
ad-set picker's honest empty state (503, no Meta token), the audience
prefill bug fix, and the mobile overflow fix — all confirmed zero
`scrollWidth` overflow after the CSS fix. The actual create + activate
against a real Meta campaign rides the same pending live dogfood as AIC-50.

## The ad preview names the Page, not our customer record (AIC-155)

`GET {builderBasePath}/page` returns the connected Page's `{name, pictureUrl}`
via `getPageIdentity`, and the preview header renders it. Reported live: the
header read "Liam Aboros" with a grey initial while the connected Page was
`am nails`.

The cause was two sources for one component. `AddContent.tsx` had always fed
`AdPreview` from the real Page; `Builder.tsx` fed it `businessName` from
`GET /context` — i.e. `customers.business_name`, whatever we typed into the
customer row at onboarding. So the builder previewed the ad as published by our
CRM record rather than by the Page Meta actually publishes from, and passed no
picture at all, which is why the avatar was always the placeholder the code
itself calls "a fallback, not the design". `pagePictureUrl` was already a prop
— only this screen never passed it.

Its own route rather than a wider `/context`: the identity costs two live Meta
reads (me/accounts for a Page token, then the Page), which the builder's load
should not wait on, and a failure must cost the preview header alone.
`pageIdentityOrNulls` (`server/src/builder/page-identity.ts`) turns every
failure into `{null, null}` so a decorative read can never 502 a step.

`businessName` keeps its real job: naming the customer in the creation
confirmation.

**Instagram is not part of this.** The existing-post picker reads
`{page}/posts` only, and no Meta write sends `instagram_actor_id` — a connected
`instagram_id` is stored and health-checked, then never used. AIC-156.

## What we name the things we create (AIC-154)

`server/src/meta/naming.ts` is the only place a campaign, ad-set or ad name is
constructed. Before it, six call sites each built one inline.

| Object | Name | Example |
| --- | --- | --- |
| Campaign | `Ads Agent · <destination> · <YYYY-MM>` | `Ads Agent · וואטסאפ · 2026-08` |
| Ad set | the audience, from `composeAudienceLabel` | `נשים · 35–55 · ישראל` |
| Ad | `מודעה <n>`, n continuing from the ad set | `מודעה 3` |

**The prefix is the point, and used to be the whole name.** The customer
builder sent `strings.he.appName`, so every campaign a customer built was
called "Ads Agent" — a second build produced a second identical row. The
account is theirs and usually holds campaigns they made themselves (GelNails
has five), so a marker for ours is genuinely useful; what it needed was the
destination and the month beside it. An unknown destination **throws**, the
same posture `resolveDestinationShape` takes: a destination nobody has named
is an unfinished change, and a generic fallback would ship it onto a live
account silently.

**The ad-set name and the dashboard's audience label are one string, by
construction.** `composeAudienceLabel` (`meta/audience-label.ts`) was
extracted from `deriveAudienceLabels` so both callers share it. Two
formatters for one concept would have agreed the day they were written and
drifted after — leaving an operator comparing our dashboard against Ads
Manager unable to tell whether different wording meant a different audience.
The old format, `${campaign name} — קהל 1`, repeated what Meta's own nesting
already shows and ended in a hardcoded `1` that was never a counter.

**The ad name is an index and deliberately carries no meaning.** Naming an ad
after its headline sounds better and is worse: the creative can be edited on
Meta afterwards and the name would not follow, leaving a label that
confidently describes copy the ad no longer runs. Nothing needs it to mean
anything — every consumer identifying an ad by content already prefers the
headline, then the primary text, and falls through to the name only when both
are absent (`services/creative-context.ts`). Its one job is uniqueness inside
its ad set, which is the job it was failing: the index was counted per
DRAFTING SESSION, so add-content put a second `מודעה 1` beside the existing
one. `nextAdIndex` now reads the ad set's live ad names from Meta and takes
the higher of "one past our biggest index" and "one past the count" — the
second half is what keeps it safe in an adopted ad set whose ads carry the
customer's own unparsable names. The read is isolated: if it fails, the create
still proceeds with the client's label, because a naming lookup must never be
the reason an add fails.

**Nothing is ever renamed.** Every name here is applied at create time only.
Existing campaigns, ad sets and ads live in customers' accounts, and a rename
is a Meta write nobody asked for — the live-account safety boundary in
CLAUDE.md. Adopted campaigns keep the customer's own names permanently.

**The one name a person still chooses** is an ad set added through
add-content, where the customer types it (placeholder "למשל: נשים 35-55"), and
a campaign name explicitly posted to the admin build route. The customer
builder posts no name at all.

## The creative step: dropzone + ad preview (AIC-130)

**Upload** was a bare `<input type="file">` — the browser's own grey "Choose
File / No file chosen", English chrome in the middle of a Hebrew screen, and the
least considered element in the product at exactly the moment a customer hands
us the photo of their work. It is now a dropzone: click or drag, with the picked
image shown as a thumbnail immediately (before the upload finishes — the
customer chose the file, so the picture is the fastest confirmation the right
one is going up).

Drag-and-drop is why it's a component rather than a styled label; the native
control cannot accept a drop. The drop path re-checks the MIME type, because
`accept` constrains the picker only and a drop bypasses it entirely.

**Preview.** The form asks for "כותרת" and "טקסט ראשי" as two identical boxes,
which says nothing about where either one lands — and they land in very
different places: the primary text is the big paragraph *above* the picture, the
headline is the small bold line *under* it next to the button. Customers
reasonably assume "headline" is the prominent one and write accordingly.

Deliberately a **sketch, not a facsimile**. Meta reformats per placement (feed,
reels, stories all differ), so a pixel-accurate Facebook render would claim
something we cannot deliver; the note under it says so. What it does show
reliably is which field goes where.

An uploaded image has no URL to render — Meta returns only an `imageHash` — so
the draft carries a client-only object URL (`localPreviewUrl`, never sent,
revoked when the file is replaced). Video falls back to Meta's thumbnail. Before
a file is chosen the media area shows a placeholder rather than collapsing: the
point of the preview is the SHAPE, and seeing where the picture will sit is
useful before there is one.

**The header shows the real Page (AIC-136).** It used to read *"העסק שלך"* with
a letter in a circle — a placeholder standing exactly where the most
recognisable thing about the ad belongs. `getPageIdentity` reads the connected
Page's name and profile photo, so the preview shows the customer what they
already see in every ad they scroll past.

That read **needs the Page's own token**: the System User token cannot read a
Page's public fields, and Meta answers *"(#10) requires the
'pages_read_engagement' permission or the Page Public Metadata Access feature"*.
`me/accounts` returns both a name and a usable per-Page token, so the name costs
nothing extra and only the picture needs the second call. Best-effort
throughout — a failure returns nulls and the header falls back to the neutral
placeholder, because a mock-up missing an avatar is still a useful mock-up.

### Two preview bugs found by looking at it (AIC-136)

**It only existed on the upload tab.** The existing-post path — the one where a
real picture is already available — had no preview at all, so choosing a post
showed nothing. Reported as *"still don't see the image in the preview"*. The
preview now sits outside the source branches, and reads the post's own picture
and copy: on that path the headline and primary-text fields are not even shown,
so rendering them would print empty placeholders over a post that has real text,
and the CTA comes from the post rather than from anything we set.

**`<bdi>` broke RTL.** `bdi` derives its direction from the **first strong
character**, so copy beginning with a Latin brand name — *"Ads Agent מנהל את
הקמפיין…"* — made the entire Hebrew paragraph render left-to-right: full stops
jumped to the start of lines, and the brand name slid to the end of the
sentence. The body and headline are plain elements now, inheriting the page's
RTL and letting the bidi algorithm place embedded Latin runs, which is the whole
job. `bdi` is still right for the Page NAME — a short isolated label where
auto-direction is correct and isolation stops it disturbing the row.
