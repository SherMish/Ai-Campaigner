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
constraint — except the three P0-fixed choices, which the builder won't even
present as a choice:

| Fixed choice | Value |
| --- | --- |
| Objective | `OUTCOME_LEADS` (`FIXED_OBJECTIVE`) |
| Buying type | `AUCTION` (`FIXED_BUYING_TYPE`) |
| Destination | WhatsApp (`FIXED_DESTINATION`) |

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

**Hard rule, enforced in the adapter, not configurable by a caller:** every
create sends `status=PAUSED`. There is no code path that can create a live
object — `campaign-adapter.test.ts` pins this directly against the real
field names sent to Meta.

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
`meta_campaign_id=NULL` until every step lands. `buildCampaignOnMeta(pool,
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

**The destination fields are resolved, not hardcoded (bug fix, 2026-08-14).**
`createAdSet` used to write `"CONVERSATIONS"`/`"WHATSAPP"` as inline string
literals — the same literals `shared/src/recommended-defaults.ts`'s
`FIXED_DESTINATION`/`FIXED_CTA` constants existed to own, but nothing
actually read them. That's exactly how a Pixel campaign could reach this
code with a WhatsApp shape: the campaign's real lead type never entered the
decision. `CreateAdSetParams` now carries an explicit `destination: string`,
resolved by `shared/src/recommended-defaults.ts`'s
`resolveDestinationShape()` — the single place every Meta field for a
destination lives. It **throws** for anything it doesn't recognize rather
than silently returning the WhatsApp shape, so a caller can never emit a
wrong write by omission. The builder always passes `FIXED_DESTINATION`
(P0-fixed, unchanged behaviour); a second destination (AIC-89) extends this
one map instead of requiring another literal hunt.

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

**The WhatsApp creative shape** (`createCreativeFromUpload`'s
`object_story_spec.link_data.call_to_action = {type: FIXED_CTA,
value: {whatsapp_number}}`) is, like AIC-50's ad-set destination fields, a
best-effort reading of Meta's Click-to-WhatsApp API — **not yet
live-verified**. It rides along with AIC-50's pending dogfood test rather
than needing a separate one. The CTA type is resolved via the same
`resolveDestinationShape()` as the ad-set fields (bug fix, 2026-08-14, see
AIC-50's section above) — it used to be the inline literal
`"WHATSAPP_MESSAGE"`, which is how a Pixel campaign's creative write once
carried a WhatsApp CTA nobody had checked was correct.

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

The step flow: 8 steps (goal, WhatsApp, budget, special ad category,
audience, placements, creatives, review), each showing its recommended
default already filled in — "accept every default and click through" is a
real, working path, not just a design intent. Every real choice is a live,
editable control on the step itself (never a collapsed "we'll handle it"),
with a green "מומלץ" badge (`StatusPill variant="ok"`, reusing the existing
component rather than inventing a new one) marking the recommended option
and a one-line rationale underneath, pulled from `shared/recommended-defaults.ts`'s
structural values + `web/src/strings.ts`'s matching copy.

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

### The launch gate (AIC-53)

The controlled path from "built (PAUSED)" to "spending (ACTIVE)" — so a
campaign never starts spending a customer's money without an explicit
approval. The full flow: builder finishes → everything exists PAUSED on Meta
(AIC-50) → first-campaign review (AIC-18/38, the existing operator review,
moves the local row to `status='active'`) → **customer launch approval** →
activate.

**Why "review-approved" is not "launched."** Before this ticket,
`campaign-review.ts`'s `submitReview(approved)` set `status='active'`, which
for a pre-existing (already-live) campaign correctly meant "we now manage
it." But a *builder-created* campaign is `status='active'` while still
**PAUSED on Meta** — reviewed and managed, but not yet spending. So AIC-53
adds a separate `launch_approved_at` column (migration 022): NULL = reviewed
but the customer hasn't said "go live" yet. Every campaign that existed
before this migration is backfilled non-NULL (they were already spending, so
retroactively "launched"); only a fresh builder campaign is genuinely NULL.

**The one activation path** (`server/src/launch/activate.ts`,
`activateCampaign`): deliberately its OWN small pipeline, not AIC-12's
`SafeExecutor` (which is bound to a `recommendation` record — there is none
here) and not AIC-50's create-writes (which hardcode PAUSED). Same
discipline as both, though: gate (already-launched → idempotent no-op; not
linked → fail; `status !== 'active'` → refuse, because review hasn't passed)
→ read live status → write `ACTIVE` → **read-back verify it landed** → log to
`action_history` (`action_type='activate_campaign'`, `human_involved=true`) +
set `launch_approved_at`. A failed write is reported honestly and never
marks the campaign launched, so a retry is always safe.

**"No builder path can activate directly" — enforced, not just intended.**
The activate write lives only behind this gate; `buildCampaignOnMeta`
(AIC-50) never touches campaign status, and a fresh build always lands
`under_review`. `activateCampaign` refuses any campaign whose local status
isn't `active`, so a not-yet-reviewed campaign cannot be activated even by
calling the gate directly. The one write method on the adapter that can send
`status=ACTIVE` (`GraphCampaignAdapter.activateCampaign`) takes no status
parameter — the same "hard rule in the adapter" shape the create-writes use
for PAUSED, in reverse. Pinned by `campaign-adapter.test.ts`.

**Customer surface** (`server/src/services/customer-launch.ts` +
`web/src/app/Home.tsx`'s `LaunchModal`): a review-approved, still-unlaunched,
Meta-linked campaign surfaces as a new `ready_to_launch` home state (it
outranks delivery/collecting — a PAUSED campaign has no delivery data to
judge, and the one actionable thing is the launch itself). Approving opens a
modal showing exactly what will run — campaign name, daily budget, **the
estimated monthly max spend** (daily × 30), ad count, lead destination —
then a single "אישור והפעלה". This is the AIC-23 informed-approval pattern:
the customer sees budget + max spend before anything spends. Approving is the
only thing that flips the campaign live.

#### Two rules that apply because it's a consent surface (bug fix, 2026-08-14)

Every row exists so the customer can check "is this what I think I'm
approving?" before real money moves. Two facts on this modal were derived
from assumptions that AIC-87 (per-campaign lead definitions) and connecting
an externally-created campaign both invalidated:

- **The destination row was hardcoded to WhatsApp.** Its label was a fixed
  `"פניות אל וואטסאפ"` and its value was `whatsapp_destination` — a column
  that is `NOT NULL DEFAULT ''`, so for the real connected Pixel campaign it
  rendered a confident WhatsApp label beside a **blank value**. It now
  resolves through `services/launch-destination.ts` into one of three states:
  `whatsapp` (the number), `website` (which action counts as a lead, named in
  plain Hebrew via `strings.launch.leadEvent`, plus the pixel's host — e.g.
  "הרשמה — pisga.app"), or `unknown`. The event is deliberately named in the
  customer's language, not as `CompleteRegistration`: an SMB owner cannot
  verify a Meta event id, and verification is this screen's whole purpose.
  The standard-event mapping is the inverse of AIC-88's `PIXEL_EVENT_ACTION`
  (`standardEventForAction`), reused rather than copied so the two can't drift.
- **The ad count came from our own build history.** It was `COUNT(*)` over
  `action_history` rows with `action_type='create_ad'` — ads *we* created —
  which reads 0 for any campaign connected from outside the builder even when
  real ads exist. It now reads live Meta state (`getCampaignState().adStatuses`),
  the same honest source AIC-71 uses for the delivering-ad count.

**Rule 1 — never render a fact we don't have.** A row whose value is unknown
is omitted, not printed blank. A confident label beside an empty value
asserts something untrue at the worst possible moment.

**Rule 2 — if we can't verify, block.** `LaunchBlocker` is `no_ads` (Meta
reports zero live ads — approving would spend nothing and do nothing),
`unknown_destination` (we can't say where leads arrive), or
`verification_unavailable` (Meta unreachable — *not* the same as "fine",
including the ordinary case of an ad-account API rate limit). Each disables
approval **with its reason stated**, never a silently dead button. Blockers
are re-checked server-side in `approveLaunch` and return `409` — the disabled
button is a courtesy, not the gate.

#### Activation left the dashboard stale (bug fix, 2026-08-15, found live)

`activateCampaign` only ever writes to Meta (PAUSED → ACTIVE) — it never
touches `managed_campaigns.delivery_ok`/`delivering`/`delivering_ad_count`
(AIC-39/71), which are otherwise only recomputed on the hourly engine tick.
`LaunchModal`'s `approve()` already called `invalidateOverview()` on success,
so the client correctly re-fetched the overview — but the overview correctly
returned whatever the *last tick* had cached, which for a campaign PAUSED for
weeks before this launch was `delivering: false, delivering_ad_count: 0`.

Confirmed live on the real free_beta campaign: **seconds after approving**,
Meta genuinely showed 2 ads ACTIVE (a third blocked only by its own,
separately-paused ad set — a real fact about the account, not a bug), while
Home confidently said "לא מתפרסם / אין כרגע מודעות שמוצגות ללקוחות" (nothing
is showing) right after the single most consequential action a customer can
take.

This is the exact other half of the lesson [manual-controls.md](manual-controls.md)
already documents for AIC-66's pause/resume routes — a synchronous backend
recompute matters as much as invalidating the client cache, and a write path
is only fully fixed once both halves are done. `approveLaunch`
(`services/customer-launch.ts`) now calls the identical `refreshDeliveryNow`
(`services/delivery-monitor.ts`) on a genuine `"activated"` outcome — same
function, same call shape as the manual-controls routes, not a second
implementation. `buildLaunchReader` (`launch/writer.ts`) is now typed as
`LaunchStateReader & DeliveryReader` so the one adapter instance serves both
purposes, the same intersection-type pattern `buildAdditionWriter` already
used. Best-effort: a refresh failure (verified live — a transient Meta
ad-account rate limit, from this session's own heavy probing) is logged and
swallowed, leaving the stale row rather than writing a guess; the next hourly
tick catches up regardless.

Test-first: a new DB integration case seeds the exact stale state (the last
tick's cached `delivering: false, delivering_ad_count: 0` from before
launch), asserts `POST /launch/approve` refreshes both to the real
post-activation Meta values within the same request.

**Verification**: the two integration suites named above (13 tests total),
plus a real-browser walk of a locally-seeded review-approved campaign — the
`ready_to_launch` hero, the modal's full spend summary (₪40/day → ₪1200/mo
max, 3 ads), and the honest 503 degradation when no Meta token is configured
(error copy shown, modal stays open, DB confirmed *not* marked launched). The
actual PAUSED→ACTIVE flip against a real Meta campaign is the consequential
live write — it's part of AIC-50's still-pending dogfood, deliberately gated
behind explicit human go-ahead rather than run autonomously.

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
`additions.integration.test.ts` (7, full HTTP through the real adapter with
mocked `fetch`) + `campaign-adapter.test.ts` (+5: `getAdSetStatus`/`getAdStatus`
reads, `activateAdSet`/`activateAd` always-ACTIVE, honest throws, `getAdSetMeta`
carrying `effective_status`). Real-browser walk at both desktop and 375px
mobile against a locally-seeded customer with an existing linked campaign:
sidebar entry appears/disappears correctly, both mode tabs render, the
ad-set picker's honest empty state (503, no Meta token), the audience
prefill bug fix, and the mobile overflow fix — all confirmed zero
`scrollWidth` overflow after the CSS fix. The actual create + activate
against a real Meta campaign rides the same pending live dogfood as AIC-50.
