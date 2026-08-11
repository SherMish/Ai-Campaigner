# Campaign builder (P1 — create campaigns)

**Status:** in progress. AIC-49 (recommended-defaults spec) and AIC-50 (Meta
create-writes) are **built and unit/integration-tested**; AIC-50's live
dogfood verification (create a real paused campaign on an account we
control, verify, clean up) is still pending. AIC-51 (creative handling),
AIC-52 (guided builder UI), and AIC-53 (launch gate) are **planned** — this
doc's later sections fill in as each lands.

**Source of truth:**
- Recommended-defaults spec: `shared/src/recommended-defaults.ts`
- Create-writes: `server/src/builder/types.ts` (the `BuilderWriter` interface
  + params), `server/src/builder/campaign-create.ts` (`startBuilderCampaign`,
  `buildCampaignOnMeta`), `server/src/meta/campaign-adapter.ts`
  (`GraphCampaignAdapter.createCampaign/createAdSet/createAd`)
- Idempotency: `server/src/execution/write-outbox.ts` (`applyIdempotent`,
  `builderKey` — extends the AIC-13 outbox)

**Lock-in tests:** `shared/src/recommended-defaults.test.ts`,
`server/src/meta/campaign-adapter.test.ts` (created-PAUSED invariant),
`server/src/execution/write-outbox.integration.test.ts` (`applyIdempotent`),
`server/src/builder/campaign-create.integration.test.ts` (the full orchestration).

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

### Planned: AIC-51–53

- **AIC-51 — Creative handling**: upload image/video or select an existing
  IG/FB post → a Meta ad creative; per-ad copy; recommends 3–5 separate ads.
- **AIC-52 — Guided builder UI**: the step flow implementing "recommended +
  why + expand to change" on every step, reading from this spec.
- **AIC-53 — Launch gate**: PAUSED → first-campaign review → customer
  approval → activate, as an approved write through the safe-execute
  pipeline (AIC-12) — no builder path may activate directly.
