# Campaign builder (P1 — create campaigns)

**Status:** in progress. AIC-49 (recommended-defaults spec), AIC-50 (Meta
create-writes), AIC-51 (creative handling), and AIC-52 (guided builder UI)
are **built and unit/integration-tested, live-verified in the browser**;
AIC-50's live Meta dogfood test (create a real paused campaign on an account
we control, verify, clean up) is still pending, and AIC-51's WhatsApp-
creative field shapes ride along with that same live test. AIC-53 (launch
gate) is **planned** — this doc's later section fills in once it lands.

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

**Lock-in tests:** `shared/src/recommended-defaults.test.ts`,
`shared/src/creative-handling.test.ts`,
`server/src/meta/campaign-adapter.test.ts` (created-PAUSED invariant +
upload/creative field shapes), `server/src/execution/write-outbox.integration.test.ts`
(`applyIdempotent`), `server/src/builder/campaign-create.integration.test.ts`
(the full campaign orchestration), `server/src/builder/creative-create.integration.test.ts`
(the creative-create orchestration), `server/src/routes/builder.integration.test.ts`
(the full HTTP surface: context/start/upload/posts/creative/build, ownership
checks, honest 409/503 degradation).

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

**Placements** (`RECOMMENDED_PLACEMENTS`): Advantage+ (automatic). The
"narrowing raises cost" rationale is display copy, not spec data — it lives
in `web/src/strings.ts`'s `builder.placements.rationale` (AIC-52 correction,
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
`resolveAudienceDefault`): age range, gender, and a local-radius
recommendation per business category (`BUSINESS_CATEGORY` — a small, curated
set of common Israeli-SMB categories, not a taxonomy: beautician, fitness,
tutor, restaurant, home_services, retail, health_wellness,
professional_services, real_estate). `customers.category` (migration 002)
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
`object_story_spec.link_data.call_to_action = {type: "WHATSAPP_MESSAGE",
value: {whatsapp_number}}`) is, like AIC-50's ad-set destination fields, a
best-effort reading of Meta's Click-to-WhatsApp API — **not yet
live-verified**. It rides along with AIC-50's pending dogfood test rather
than needing a separate one.

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

### Planned: AIC-53

- **Launch gate**: PAUSED → first-campaign review → customer approval →
  activate, as an approved write through the safe-execute pipeline (AIC-12)
  — no builder path may activate directly.
