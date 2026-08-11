# Campaign builder (P1 — create campaigns)

**Status:** in progress. AIC-49 (recommended-defaults spec), AIC-50 (Meta
create-writes), and AIC-51 (creative handling) are **built and
unit/integration-tested**; AIC-50's live dogfood verification (create a real
paused campaign on an account we control, verify, clean up) is still
pending, and AIC-51's WhatsApp-creative field shapes ride along with that
same live test. AIC-52 (guided builder UI) and AIC-53 (launch gate) are
**planned** — this doc's later sections fill in as each lands. AIC-52 is
also where the HTTP route layer (file upload, list-posts, create-creative
endpoints) gets built — no builder route exists yet, since nothing calls one
until there's a UI to drive it.

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

**Lock-in tests:** `shared/src/recommended-defaults.test.ts`,
`shared/src/creative-handling.test.ts`,
`server/src/meta/campaign-adapter.test.ts` (created-PAUSED invariant +
upload/creative field shapes), `server/src/execution/write-outbox.integration.test.ts`
(`applyIdempotent`), `server/src/builder/campaign-create.integration.test.ts`
(the full campaign orchestration), `server/src/builder/creative-create.integration.test.ts`
(the creative-create orchestration).

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

**Placements** (`RECOMMENDED_PLACEMENTS`): Advantage+ (automatic), with the
"narrowing raises cost" rationale carried alongside it.

**Budget** (`RECOMMENDED_BUDGET_AGOROT_PER_DAY`): a ₪30–50/day range, ₪40
recommended, framed honestly as a *starting point to gather data* — not a
guaranteed-exact number (real CPL varies too much by category/creative to
claim precision we don't have).

**Special Ad Category** (`SPECIAL_AD_CATEGORY`, `RECOMMENDED_SPECIAL_AD_CATEGORY`):
Meta's compliance mechanism for campaigns touching credit, employment,
housing, or social issues/elections — restricted targeting is legally
required for these. The recommended default is always `NONE`, and the
builder must ask the question explicitly every time
(`SPECIAL_AD_CATEGORY_QUESTION`) — this is never silently inferred from the
business category. `SPECIAL_AD_CATEGORY_HINT` maps a handful of our known
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
throwing. Each category default carries a one-line plain-Hebrew rationale.

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

### Planned: AIC-52–53

- **AIC-52 — Guided builder UI**: the step flow implementing "recommended +
  why + expand to change" on every step, reading from this spec — and the
  HTTP route layer (multer upload endpoint, list-posts, create-creative,
  build-campaign) that the UI actually calls. Also where AIC-49's rationale
  strings should move into `web/src/strings.ts` alongside AIC-51's.
- **AIC-53 — Launch gate**: PAUSED → first-campaign review → customer
  approval → activate, as an approved write through the safe-execute
  pipeline (AIC-12) — no builder path may activate directly.
