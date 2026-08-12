# docs/STATE.md — dated changelog

Newest first. One `### YYYY-MM-DD — <title>` block per change: **what changed and
why**. Append a block; never edit an existing line. Behaviour is specified in the
owning doc under [features/](features/), not here.

## Changelog

### 2026-08-12 — Details panel round 2 + a confidently-wrong audience label (AIC-73)
Round-2 review of the redesigned panel. The important find was a **data** bug,
not a layout one: the label read **18–65** for an ad set actually targeting
**21–46**. With Advantage+ audience expansion on (the default for
builder-created ad sets) Meta reports `age_min`/`age_max` as the EXPANSION
CEILING, while the configured range lives in `age_range`. We were reading the
ceiling — showing customers an audience they never chose, which is worse than
showing a raw name. Fixed in `audience-label.ts` (+ the ops explorer, same
bug). The ad set's own NAME said "18-46" while the truth was 21–46, so names
stay untrusted.

Also corrected an assumption in the review itself: it asked for "מודעה אחת ·
4 קרייטיבים" on the basis that the ad named `almond green, french, video,
pink lines` was a flexible ad with four creatives. The live API says one
creative, no `asset_feed_spec` — the name is just a label someone typed. So
`assetCount` comes from Meta and the UI says "מודעה אחת"; it only claims N
creatives when `asset_feed_spec` genuinely carries them.

Rest of the round: nested disclosure REMOVED (one click reveals everything;
hierarchy from layout, with adaptive collapse only above 3 audiences), geo
localised to Hebrew, real creative thumbnails (new `meta/ad-media.ts` +
`GET /api/app/controls/media`, live-on-open like `/state`), per-row status
chips, pause demoted to a quiet link, metrics pulled under their row title,
matching metric sets at both levels, and 18px SVG chevrons that rotate inside
a ≥44px hit target.

Full detail: [features/customer-overview.md](features/customer-overview.md).

### 2026-08-12 — Dashboard shows today; engine still evaluates complete days (AIC-67 follow-up #2)
Reported live: "I see 1 and 4." Both numbers were individually correct and
still contradicted each other. The KPI window (`rollingPeriods().current`)
deliberately **stops at yesterday**, and nothing ever ingested today at all —
so today's 3 leads and ₪26.74 were invisible everywhere on the page, while
the lead-quality card (all-time) correctly said 4.

These are two different questions and now get two windows. The **engine**
keeps complete-days-only: a half-finished day looks like underperformance and
acting on it would move real money on bad evidence. The **dashboard** gets
today, ingested as its own snapshot row (`todayPeriod` +
`runIngestionTick`'s `extraPeriods`, display-only — its failure never marks a
campaign failed) and surfaced as `readout.today`. Shown as its own "היום עד
עכשיו" line rather than blended in: folding a partial day into a 7-day CPL
makes that ratio noisy mid-day without helping anyone. Labelled provisional,
since Meta's same-day conversion data revises upward. The two surfaces can
now legitimately disagree, so AIC-64's no-rec card explains why ("we evaluate
on complete days") instead of leaving it to read as self-contradiction.

Also fixed the labels: `kpiSpend` read **"הוצאה החודש"** (*this month*) on a
7-day value. Every KPI now states its window; deliberately NOT switched to
month-to-date (resets each 1st, and mixing windows across adjacent tiles
makes them non-comparable) — a real budget-pacing month element belongs with
AIC-55's range work.

Numbers now reconcile: 1 (7-day, complete) + 3 (today) = 4 (all-time to review).

Full detail: [features/customer-overview.md](features/customer-overview.md).

### 2026-08-12 — leadsToDate over-counted from overlapping snapshots (AIC-67 follow-up)
Found live within minutes of shipping AIC-67: a customer saw "1 פניות" on the
main KPI and "3 לדירוג" on the new lead-quality card for the same campaign
with exactly 1 real lead. Root cause: `leadsToDate` was computed by summing
`leads` across every campaign-grain `insight_snapshots` row for the campaign
— but those rows are NOT disjoint. The ingestion tick writes a new snapshot
every day for a ROLLING 7-day window (`today-7..today-1`, shifting by one day
per tick), so overlapping snapshots re-report the same real leads. Three
daily ticks of the same 1 lead summed to 3.

Fixed the same way `delivery_ok`/`live_budget_agorot`/`delivering` already
are: one Meta Insights call per generation tick
(`level=campaign&date_preset=maximum`, verified live to return a true
non-overlapping lifetime range) cached onto a new `managed_campaigns.leads_to_date`
column (migration 028). The lead-quality read now uses that column only —
never a live call, never a snapshot sum. Also corrected the real account's
already-wrong value immediately rather than waiting for the next hourly tick.

Full detail: [features/customer-overview.md](features/customer-overview.md).

### 2026-08-12 — Lead-quality feedback: incremental delta review, double-counting fixed (AIC-67)
The weekly lead-quality question asked for a cumulative total ("of your N
leads this week, how many were relevant?") with no memory of what was already
reviewed — a customer answering twice in the same week (2 leads → 5 leads)
had to remember they'd already counted the first 2, or double-count. Two
compounding flaws: a moving denominator and no reviewed-so-far state.

Replaced with an append-only review log (migration 027,
`lead_quality_reviews`: `leads_delta`/`relevant_delta` per review action).
The all-time watermark is `SUM()` over that table; the customer is only ever
asked about `pending = max(0, leadsToDate - reviewedSoFar)` — computed
SERVER-SIDE from the caller's own watermark, never client-supplied, so
re-rating already-reviewed leads is structurally impossible, not just
avoided. `max(0, ...)` also makes attribution lag safe for free: a
retroactive downward revision to `leadsToDate` just reads as caught-up
instead of going negative. Existing per-week values migrated forward as the
initial watermark (no data loss) — a customer who'd already answered the old
form isn't re-asked. Deliberately left the operator's manual admin-console
entry untouched (a distinct, adequate mechanism for phone-reported data, not
the thing that caused double-counting).

Full detail: [features/customer-overview.md](features/customer-overview.md).

### 2026-08-12 — Audience details panel redesign + the real root cause of the raw-name leak (AIC-73)
Observed live: the opt-in "הצג פירוט" panel showed the raw Meta ad-set name
(`"IL | Ramat Gan, Givatayim | Women 18-46 | Advantage+"`, pipes and all) —
an AIC-37 spec violation, not cosmetic. Root cause: `deriveAudienceLabels`
only labeled a dimension when it DIFFERED across sibling ad sets; with
exactly one ad set (the common single-audience small-business shape), nothing
ever differs, so every real account fell through to the name. Fixed by
composing every ad set's OWN gender/age/geo unconditionally
(`"נשים · 18–46 · רמת גן, Givatayim"`); the only true fallback (no structured
targeting at all) is a neutral phrase, never the name, and identical-label
collisions get a disambiguating suffix.

Also redesigned the panel itself: labeled metrics (no more bare repeated
numbers), an explicit nested audience→ad hierarchy, a collapsed-state preview
built from data Home already has (no prefetch), a labeled + explained
creative list, consistent pause-button placement, and `<bdi>`-wrapped mixed
Hebrew/Latin text so nothing renders reversed. Verified live on desktop and
375px against the real GelNails account.

Full detail: [features/customer-overview.md](features/customer-overview.md).

### 2026-08-12 — The above server fix needed a frontend half too (AIC-71 follow-up #2)
Reported live immediately after the previous fix shipped: "after I click הפעלת
קהל I need a full refresh before seeing the status updated." The server was
already correct (previous entry) — `AudienceDetails`' `onToggle` (`Home.tsx`)
refreshed the per-row live status but never invalidated the shared overview
cache (`overview-store.ts`) the headline "מצב" actually reads from. One line:
call `invalidateOverview()` after a successful toggle, the same pattern
AIC-53's launch-approval flow already uses. Full detail:
[features/manual-controls.md](features/manual-controls.md).

### 2026-08-12 — Manual pause/resume now updates the Home headline immediately (AIC-71 follow-up)
Found minutes after AIC-71 shipped: paused the only ad set live and Home kept
reading "פעיל" — `managed_campaigns.delivering` was only ever recomputed on
the hourly engine tick, so a customer's own pause left the headline stale for
up to an hour, directly undermining the "stopped" state just shipped to fix
exactly this kind of staleness. `POST /pause`/`/resume` (customer) and the
operator object-control route now call a new `refreshDeliveryNow` right after
a write actually changes something — same computation as the engine tick,
run synchronously instead of waiting. Caught a real test-mock gap in the
process: `controls.integration.test.ts`'s shared Meta mock never returned
`adset_id` on ad rows (nothing had needed it before AIC-71's ad-level
rollup), silently zeroing every ad-count assertion until fixed.

Full detail: [features/manual-controls.md](features/manual-controls.md).

### 2026-08-12 — Honest delivery state on Home: "stopped" + a real active-ad count (AIC-71)
Real GelNails case, seen live right after AIC-66 shipped: the customer paused
their only ad set via the new manual controls — zero delivery, zero spend —
and Home still read **פעיל** with **1 מודעות פעילות**. Neither number ever
reflected live Meta state: `homeState`'s `ok`/`paused` split only knew
`managed_campaigns.status`, an operator DB flag meaning "we manage this,"
unrelated to whether anything is actually running; the active-ad count came
from `insight_snapshots`, i.e. historical spend, so a since-paused ad kept
counting.

Fix reuses the existing per-tick delivery-health read (AIC-39) rather than
adding a new Meta call or a new staleness mode: `getDeliveryHealth`'s
ad-level rollup now also counts each ad set's currently-delivering ads
(`deliveringAdCount`), and `summarize()` exposes `delivering: deliveringAdCount
> 0` — a fact orthogonal to `ok` (a fully, correctly paused campaign is
`ok: true, delivering: false`, not a problem). Persisted alongside
`delivery_ok` every tick (migration 026: `managed_campaigns.delivering`,
`delivering_ad_count`). New `homeState = "stopped"` checks `!delivering`
after the real delivery-problem check and before `collecting` — a campaign
with everything paused will never accumulate data no matter how long you
wait. Home's "מודעות פעילות" now reads `deliveringAdCount` when the engine has
ticked at least once, falling back to the old historical count only before
that.

Full detail: [features/customer-overview.md](features/customer-overview.md),
[features/delivery-health.md](features/delivery-health.md).

### 2026-08-12 — Manual pause/resume/archive/delete of ads + ad sets (AIC-66)
Until now the only way an object changed state was an approved engine
recommendation — a management product that can't manually turn an ad off was
missing table stakes. Adds direct human control on both surfaces, settling a
three-actor authorization model: the engine proposes and the customer
approves; a **customer acting on their own object is self-authorized** (adding
an approval step there would be incoherent — approval exists because the
*engine* proposed something); an **operator** may do the same plus
archive/delete, audited.

Deliberately does NOT reuse `SafeExecutor` (AIC-12), which is
recommendation-bound at every step — reusing it would mean inserting a fake
`recommendations` row and walking it through `proposed → approved`, inventing
an approval that never happened in the one part of the system whose value is
that its records are true. Follows AIC-63's `activateOne` shape instead: read
→ no-op if already at target → write → read-back verify → log.

New `setAdStatus`/`setAdSetStatus` are the first adapter writes taking a
caller-supplied status; the create-always-PAUSED (AIC-50) and
activate-always-ACTIVE (AIC-53/63) invariants they sit next to are unaffected
and the code says so. Destructive actions are operator-only with server-side
confirm-to-type (the bar AIC-44 set for deleting a whole customer), archive
preferred over delete, and the object then drops out of counts via AIC-65's
filtering. First action to write **both** `action_history` and
`admin_audit_log` — the "no current overlap to cross-link" note in `admin.ts`
is now updated.

Full detail: [features/manual-controls.md](features/manual-controls.md).

### 2026-08-12 — Meta setup runbook rewritten around the three layers of access
Investigating why add-content (AIC-63) couldn't be fixed produced a much more
useful finding than the bug itself: **Meta access is three independent layers**,
and Business Settings can look entirely correct while the backend has zero
access. (1) asset shared to our Business Portfolio — customer's action;
(2) asset assigned to our System User — our action, a *separate* step;
(3) the token carries the matching scopes — **frozen at token-generation time**.

Layer 3 is the trap: our token was minted with `ads_management, ads_read,
business_management` only. Assigning Page assets later does not retroactively
add `pages_*` scopes, so every Page call keeps failing with `(#100) … requires
the 'pages_read_engagement' permission` no matter how correct layers 1–2 look.
Adding a new asset type means regenerating the token and rotating the Railway
secret.

[META_SETUP.md](META_SETUP.md) now records our real identifiers (Business
Portfolio **`2491237118040524`** "AI Campaigner" — previously undocumented
anywhere, which cost a live round-trip; app `1762330388097443`; System User
`122103498795426897`), a step-by-step per-customer onboarding runbook with the
exact tasks to grant per asset, a copy-paste verification block that tests each
layer separately, and a symptom→layer→fix table. Also documents the hard-won
ordering rule: **confirm the Page is readable before writing `page_id`** — a
`page_id` the backend can't read flips the connection to `revoked` and silently
stops the recommendation engine (AIC-69).

### 2026-08-12 — Exclude deleted/archived/draft ad sets (AIC-65)
GelNails' "second ad set" turned out to be a never-published draft: real
historical spend (an ad that ran and was later removed), but `effective_status`
still reports `ACTIVE` with zero ads today. The product was treating it as a
real, managed ad set everywhere — a false 2-ad-set count, a false
needs-attention item from its leftover `issues_info`, a confused audience
rule, and a `delivery_blocked` no-rec reason (AIC-64) that was really "this
object doesn't exist."

`AdSetMeta.isManaged` (`audience-label.ts`) is now false for a deleted/
archived `effective_status`, or for zero ads (`getAdSetMeta` now requests
`ads.limit(1){id}`). `runGenerationTick` fetches ad-set metadata first each
tick, excludes unmanaged ad sets from delivery-health, the audience/creative
rule evidence, the cached labels (so the customer's opt-in audience view
never shows it), and the audience count — tracked SEPARATELY from real
delivery problems so AIC-64's `delivery_blocked` reason is never
misattributed to a dead object. Also fixed a real ordering bug in
`delivery-health.ts`: a deleted ad set's stale leftover `issues_info` was
checked before the deleted/archived branch, so it could still be flagged.
Ops explorer (AIC-45) still shows a dead ad set for operator visibility, but
clearly marked "נמחק / לא פורסם," never as active or a problem.

Full detail: [delivery-health.md](features/delivery-health.md#excluding-deaddraft-ad-sets-not-just-unhealthy-ones-aic-65).

### 2026-08-12 — Two real bugs found by Sharon dogfooding: stale budget + broken add-content
Sharon (real customer + operator) reported the dashboard showing ₪10/day after
raising the real Meta budget to ₪30, and "הוספת תוכן" claiming she had no
campaign despite GelNails being live and healthy.

**Stale budget**: `agreed_budget_agorot` is a safety ceiling for the engine's
own automated proposals ([safe-execution.md](features/safe-execution.md)),
not a live mirror of Meta — but the dashboard displayed it as if it were
"today's budget." The engine already reads the live budget every generation
tick (needs it to evaluate rules) but was discarding it after use. Fixed:
`server/src/services/live-budget.ts` caches the read every tick
(`managed_campaigns.live_budget_agorot`, migration 025) for display, and
auto-**raises** (never lowers) the ceiling to match — closing a latent bug
where a live budget above the stale ceiling would make the engine's own next
`decrease_budget` proposal throw `BudgetLimitError` at execution.

**Broken add-content**: root-caused to `meta_connections.page_id` being blank
on Sharon's row — `resolveAdditionContext` requires it and fails with a
generic "no campaign yet" message that doesn't say why. The blank value
traces to how the row was created: hand-written SQL back on 2026-08-08, not
through any console feature (because none exists — see
[AIC-68](https://linear.app/pisga-app/issue/AIC-68)). Extended the admin Meta
explorer (`server/src/meta/explorer.ts`) to read `object_story_spec.page_id`
off a live ad's creative — the one place in the app that can recover a Page
id without a new endpoint — used it to find GelNails' real Page id, then
corrected the DB row directly.

**Deeper gap tracked separately**: there is no admin UI to provision a real
customer's `meta_connections`/`ad_accounts`/`managed_campaigns` rows — every
real customer today is onboarded via hand-written SQL, which is exactly what
produced the blank `page_id`. Filed [AIC-68](https://linear.app/pisga-app/issue/AIC-68)
to build it; user explicitly deferred building it in this session.

### 2026-08-12 — Honest "why no recommendation" reasons (AIC-64)
"No recommendation" was one undifferentiated `no_action` state — the customer
saw identical copy whether the campaign was genuinely stable or the engine was
structurally blind at the current budget. Grounded in a real diagnosis this
session (GelNails: ₪10/day budget → 7-day rolling window maxes at ₪70, under
every rule's spend gate — no amount of *time* fixes that, only raising the
budget does): `classifyNoAction` (`server/src/recommendations/rules.ts`) now
splits the old `insufficient_evidence` into five priority-ordered reasons —
`delivery_blocked`, `budget_below_threshold` (newly computed: 7×daily budget
vs the smallest actionable rule threshold), `collecting`, `single_ad_set`,
`stable` — never the same message for genuinely different situations.

Cached per campaign (`managed_campaigns.no_rec_reason`/`no_rec_detail`,
migration 024) every generation tick, mirroring the `delivery_ok`/
`delivery_reason` pattern (AIC-39) rather than a new table, since it's current
per-campaign state, not an event log. Customer dashboard shows distinct
honest Hebrew per reason with a raise-budget CTA where actionable
(`web/src/app/Home.tsx`); the ops console's customer-detail panel shows the
operator the exact numbers that blocked (`web/src/admin/AdminCustomers.tsx`).

Full detail: [RULES.md](RULES.md#why-theres-no-recommendation-aic-64).

### 2026-08-12 — Add ad / ad set to an existing managed campaign (AIC-63)
The builder only ever handles a customer's *first* campaign
(`resolveBuilderContext` 409s once one exists). Until now that meant
there was no in-app way to add a creative or test a new audience
afterward — the everyday management action — short of Ads Manager. New
`/api/app/additions/*` route family + `/app/add-content` screen add it,
reusing AIC-50/51/53's primitives rather than duplicating them: the same
idempotent outbox (`WriteOutbox.applyIdempotent`, `add-`-prefixed
`builderKey`s), the same `asCreatingWriter` (exported for reuse), the same
creative upload/validation pipeline. New `pending_additions` table
(migration 023) generalizes AIC-53's single-campaign launch gate to a
per-object, repeatable approval — every add lands PAUSED and stays that
way until explicitly approved. New `AdditionWriter.activateAdSet`/
`activateAd` mirror `activateCampaign`'s hard rule (no caller-supplied
status; can only ever send `ACTIVE`), and approval checks each object's
live status before writing so a retry after partial failure never
double-activates. `POST /additions/ad` re-validates the client-supplied ad
set ID against a **live** `getAdSetMeta` fetch (not the hourly cache) —
both to prevent adding to an ad set that isn't the caller's, and so an ad
set created earlier in the same visit is immediately usable.

Two real bugs caught dogfooding, not just described: the add-ad-set
audience step loaded the business category but never derived age/gender
from it (stayed at a hardcoded 18–65/all default); and a pre-existing,
app-wide mobile bug — CSS Grid's default `min-width: auto` on grid items
silently forced every `.grid-2`/`.grid-3` screen to ~497px at a 375px
viewport (via `SupportCard`, present on nearly every screen) — fixed
generically (`.grid-2 > *, .grid-3 > * { min-width: 0; }`), not just
patched at the one button that surfaced it.

Full detail: [features/campaign-builder.md](features/campaign-builder.md).

### 2026-08-11 — Builder honesty pass: business-type selector, fixed placements, no dead radius (AIC-52 follow-up)
Three defects surfaced by dogfooding the builder against a seeded customer,
all the same class ("a control/badge implying a choice the customer doesn't
actually have"):

1. **Audience business type was invisible.** The one input driving the whole
   audience recommendation (age/gender) was read silently from
   `customers.category` — an operator-only free-text field the customer never
   sees or confirms, so a wrong/blank value confidently mis-targets with no
   way to notice. Now the audience step leads with an editable business-type
   `<select>` (pre-selected from the onboarding category via
   `normalizeBusinessCategory`; changing it re-derives age/gender + rationale
   live). "לפי מה שסיפרתם לנו. לא מדויק? אפשר לשנות כאן."
2. **Placements pretended to be a recommendation.** `createAdSet` sends no
   placement field (Meta uses automatic/Advantage+; no path to narrow), yet
   the step had a מומלץ badge + "the tradeoff of narrowing" copy. Now
   presented as fixed like the goal step; `RECOMMENDED_PLACEMENTS` →
   `FIXED_PLACEMENTS`.
3. **The radius input went nowhere.** It accepted a value that never left the
   browser (targeting is age+gender+`countries=["IL"]`). Removed, replaced
   with a plain "targets all of Israel; area/radius coming later" note.
   `CATEGORY_AUDIENCE_DEFAULTS.radiusKm` kept as the seed for real
   geo-targeting, filed as **AIC-60** (business location + geocoding + Meta
   `custom_locations`) — the AC-accurate version of what radius was faking.

The category rationales were also rewritten to justify age/gender only (they
previously claimed "local radius" targeting P0 doesn't apply). Browser-verified
(selector re-derives home_services → 28–60/all; placements shows no badge).
No new automated test — no web component-test infra exists, and the
server/Meta payload is unchanged (radius never reached it); the builder route
integration test already covers the age/gender/country build.

### 2026-08-11 — Launch gate: PAUSED → review → customer approval → ACTIVE (AIC-53)
The controlled path from "built (paused)" to "spending (active)" — a
builder-created campaign never spends without an explicit customer approval.
New `launch_approved_at` column (migration 022, existing rows backfilled
non-NULL since they were already live) distinguishes "review-approved +
managed" (`status='active'`) from "customer approved going live." New
`server/src/launch/activate.ts` `activateCampaign` is its own small
validate→write→read-back-verify→log pipeline (deliberately NOT AIC-12's
SafeExecutor, which is recommendation-bound, nor AIC-50's create-writes,
which hardcode PAUSED). The single adapter method that can send
`status=ACTIVE` takes no status parameter — the create-writes' "always
PAUSED" invariant in reverse, pinned by a unit test.

"No builder path activates directly" is enforced, not just intended:
`buildCampaignOnMeta` never touches status, a fresh build lands
`under_review`, and `activateCampaign` refuses anything not already
review-`active`. Customer surface: a new `ready_to_launch` home state + a
`LaunchModal` (`web/src/app/Home.tsx`) showing budget + estimated monthly
max spend + ad count + WhatsApp destination before the single approve
button (AIC-23 informed-approval pattern). Routes `/api/app/launch` +
`/api/app/launch/approve`.

Tests: `server/src/launch/activate.integration.test.ts` (6) +
`server/src/routes/launch.integration.test.ts` (7) +
`campaign-adapter.test.ts` (+3), all green. Live-verified in a real browser:
the ready-to-launch hero, the modal's spend summary (₪40/day → ₪1200/mo max),
and honest 503 degradation with no token (error shown, DB confirmed not
marked launched). The real PAUSED→ACTIVE flip on a live account is part of
AIC-50's still-pending dogfood, gated behind explicit human go-ahead.

### 2026-08-11 — Guided campaign builder UI + HTTP routes (AIC-52)
The 8-step wizard (goal/WhatsApp/budget/special-ad-category/audience/
placements/creatives/review) implementing "recommended default already
filled in + why + every real choice visible" — `web/src/app/Builder.tsx` +
`web/src/app/BuilderCreatives.tsx`. New HTTP surface `server/src/routes/builder.ts`
(`/api/app/builder/{context,start,upload,posts,creative,build}`, `multer`
for uploads) is a thin layer over AIC-50/51's already-built service code;
`server/src/builder/session.ts`'s `resolveBuilderContext` is the real
precondition gate (healthy connection + ad account + Page + no existing
campaign), not just a UI nicety — every write route re-resolves it and
checks `localCampaignId` ownership server-side.

Bug caught by the route integration tests: the "customer already has a
campaign" check originally matched the UNLINKED shell row `/start` itself
creates, so calling `/start` a second time (the normal resume path) 409'd
instead of resuming — fixed by requiring `meta_campaign_id IS NOT NULL`.

Corrected an AIC-49 precedent flagged as debt in AIC-51's entry below:
`recommended-defaults.ts`'s rationale strings (budget/placements/special-
category-question/per-category audience rationale) moved into
`web/src/strings.ts`'s `builder` section, since AIC-52's own AC requires
"all copy in the strings file" and this ticket is what actually builds the
UI that displays them. `shared/recommended-defaults.ts` is now genuinely
copy-free.

Home's `no_campaign` state now branches: ready-to-build → new CTA to
`/app/builder`; still onboarding → the pre-existing `/onboarding` CTA,
unchanged.

Tests: `server/src/routes/builder.integration.test.ts` (7, mocked-fetch
through the real adapter and real HTTP routes). Also walked the full wizard
in a real browser against a locally-seeded customer — confirmed the
audience step's category-based prefill and every step's validation gating
work correctly. That pass also surfaced that `server/.env` carries a real
`META_SYSTEM_USER_TOKEN` picked up automatically by local dev — one
unintended real (read-only, nonsense-target) Meta call happened before this
was caught; no writes occurred. AIC-50's live dogfood test (and AIC-51's
WhatsApp-creative field-shape verification riding with it) is still the
pending real-Meta-write checkpoint.

### 2026-08-11 — Creative handling: upload/existing-post → Meta ad creative (AIC-51)
The builder's content step, split the same way as AIC-50: platform-
independent spec in `shared/src/creative-handling.ts` (limits,
`validateCreativeCopy` — returns error CODES only, e.g. `missing_headline`,
never Hebrew text), Meta API calls in `GraphCampaignAdapter` via a new
`CreativeWriter` interface (`server/src/builder/creative-types.ts`):
`uploadImage`/`uploadVideo` (video upload polls Meta, bounded, until a
thumbnail is ready), `listPromotablePosts`, `createCreativeFromUpload`/
`createCreativeFromExistingPost`. Idempotent the same way as AIC-50's
creates (`server/src/builder/creative-create.ts`, migration 021 widens the
outbox's kind check for `create_creative`) — except the raw upload step
itself, deliberately left one-shot (a file buffer isn't a resumable
payload the way small JSON creates are).

Corrected an AIC-49 precedent while building this: AIC-51's own AC requires
"copy/labels in the strings file," so — unlike `recommended-defaults.ts`'s
rationale strings — no Hebrew lives in `creative-handling.ts`. The
responsibility notice and every validation error message moved to
`web/src/strings.ts`'s new `builder` section (`creativeValidationMessage()`
maps a code to its text, same pattern as `connectionMessage()`).
AIC-49's existing rationale-strings-in-shared/ is now flagged as the same
class of debt, deferred to AIC-52 rather than retrofitted mid-ticket.

No HTTP route was built — AIC-51's AC never requires one, and nothing calls
one without AIC-52's UI to exist yet; building disconnected endpoints now
would be guessing at a shape AIC-52 should actually determine.

Tests: `shared/creative-handling.test.ts` (7, asserting error codes now
instead of Hebrew substrings), `campaign-adapter.test.ts` gained 8
(upload/video-poll/list-posts/create-creative, mocked fetch), new
`creative-create.integration.test.ts` (5: upload path, existing-post path,
idempotent-per-key, failure-then-resume, distinct creatives per clientKey).
Live-verification of the WhatsApp creative field shape rides along with
AIC-50's still-pending dogfood test.

### 2026-08-11 — Meta create-writes: createCampaign/createAdSet/createAd, always PAUSED (AIC-50)
The builder's write surface. New `BuilderWriter` interface
(`server/src/builder/types.ts`), implemented by `GraphCampaignAdapter`
alongside its existing `MetaReader`/`ExecWriter`/`DeliveryReader` roles —
deliberately kept off `ExecWriter` itself, since create-writes aren't part of
the recommendation-approval flow. Every create hardcodes `status=PAUSED`, no
caller-controllable path to a live object — pinned directly with a mocked-
fetch unit test (`campaign-adapter.test.ts`), the first `GraphCampaignAdapter`
method to get one (every prior write was live-dogfooded only).

Idempotency extends the AIC-13 outbox rather than duplicating it: migration
020 widens `meta_write_outbox.kind` for the three create kinds + adds a
`result` column. New `WriteOutbox.applyIdempotent` is a synchronous
claim-then-create-or-resume path (atomic `pending`→`in_progress` claim
blocks a concurrent double-submit from creating two objects) — `drainOnce`
is untouched for the existing async budget/pause writes. New
`server/src/builder/campaign-create.ts`: `startBuilderCampaign` creates (or
resumes) the local `managed_campaigns` shell row every create-write anchors
to (`status='under_review'`, `meta_campaign_id=NULL` until every step
lands — invisible to `listEligibleForGeneration` until then);
`buildCampaignOnMeta` walks campaign→ad-sets→ads with a deterministic
idempotency key per object, logs `action_history` per success, and links the
local row on completion. A mid-build failure is reconcilable by resuming the
same call with the same keys — already-created PAUSED objects are the
resume point, never orphans to clean up.

**Honest field-shape caveat**: the ad-set WhatsApp-destination fields
(`optimization_goal`/`destination_type`/`promoted_object`) are a best-effort
reading of Meta's API, not yet live-verified the way `setDailyBudget`/
`pauseAdSet` were — the AC's own "dogfood on an account we control" step is
what actually confirms this shape, pending as of this entry. Tests: 4 unit +
10 integration (`write-outbox.integration.test.ts` +4,
`campaign-create.integration.test.ts` new file, 4 tests). Doc:
`campaign-builder.md`.

### 2026-08-10 — Recommended-defaults spec (AIC-49), P1 Campaign Builder begins
Kicks off the new P1 phase: creating a customer's first campaign in-product
instead of a founder walking them through Ads Manager by hand (what actually
happened for GelNails). `shared/src/recommended-defaults.ts` is the single
documented source of truth for what the future builder (AIC-52) recommends
at every step: the 3 P0-fixed choices (objective/buying-type/destination —
not presented as a choice), the AIC-38 single-ad-set structure recommendation,
Advantage+ placements, a ₪30–50/day ("₪40 recommended") budget starting
range framed honestly as a data-gathering point rather than a guaranteed
number, Meta's Special Ad Category compliance question (always defaults to
`NONE`, always asked explicitly, never silently inferred — a small
category→hint map only prompts a more careful honest answer), and a
business-category → audience-defaults map (age/gender/local-radius) for a
curated set of common Israeli-SMB categories, each with a plain-Hebrew
rationale. `customers.category` stays free text (set during AIC-44's manual
onboarding); unrecognized categories resolve to an honest broad `other`
default rather than guessing. New owning doc `campaign-builder.md` (added to
INDEX.md) covers this ticket live and AIC-50–53 as planned. Tests:
`recommended-defaults.test.ts` (9 tests).

## Changelog

### 2026-08-10 — Thin approve surface verified + doc rot fixed (AIC-22/23/37)
No app-code change — this closes out three tickets (AIC-22 Home, AIC-23
recommendation approve/dismiss, AIC-37 audience opt-in details) that were
built in an earlier session but never marked Done in Linear, with a full live
QA pass against prod Neon: real hero states (incl. the AIC-39
delivery-vs-connection distinction), real KPIs+deltas, the audience-details
toggle (correctly falling back to the ad set's real Meta name since GelNails'
actual targeting doesn't structurally differ by age despite the descriptive
names), the weekly lead-quality stepper+submit, and — seeding two realistic
recommendations since GelNails has none real yet — the full approve flow
(hit the real 503 "Meta not configured locally" path, confirmed a clean
Hebrew message with zero leaked technical detail, confirmed the DB never
false-marked the rec as approved) and dismiss flow, both against the live
API. Mobile viewport confirmed no horizontal overflow. All QA-seeded data
(2 recommendations + one real-but-unwanted weekly-feedback row written via
the actual UI flow) cleaned up afterward.

Also fixed real doc rot found along the way: `customer-app.md`'s status line
still said the recommendations flow, onboarding, and connect were "mock" —
they've been live since AIC-21/23 (2026-08-08); only the review screen
(AIC-32) still is. `customer-overview.md` never documented `attentionKind`
(AIC-39) or the audience opt-in view (AIC-37) at all, and `RULES.md` linked
to a doc section that didn't exist. AIC-23's one genuinely unbuilt AC
("approval-rate instrumented for the metrics funnel") and AIC-37's ("toggle
open-rate instrumented") both stay honestly deferred — blocked on AIC-28
(metrics/activation-funnel instrumentation), which doesn't exist yet; no
event sink to write to, so neither is half-built.

### 2026-08-10 — Audience-aware rules: flexible/Advantage+ creative exclusion (AIC-36)
Closes out AIC-36 — the creative-vs-audience conflation fix, the audience rule,
errored-ad-set exclusion, and the pauseAdSet write were already live from
earlier work; the one remaining AC was detecting Meta's Dynamic/Advantage+
creative and skipping `pause_weak_creative`'s per-asset comparison for it
(Meta doesn't expose reliable per-asset CPL for a dynamic-creative ad set —
comparing its "peers" and pausing the apparent loser would be the engine's
first live recommendation being wrong, on someone else's ad spend). New
`is_dynamic_creative` fetched per ad set (`getAdSetMeta`, alongside the
AIC-37 targeting fields), cached in `ad_set_meta` (migration 019).
`CampaignEvidence` gained `flexibleCreativeAdSetIds`; `pause_weak_creative`
skips those ad sets' groups entirely while every other rule (including
`pause_underperforming_audience`, which reads `ev.adsets` not `ev.creatives`)
is unaffected — the ad-set-level CPL is still real, only the per-asset
breakdown inside a flexible ad set isn't. Threaded end-to-end through
`runGenerationTick` → `refreshRecommendations` → `buildCampaignEvidence`.
Tests: `rules.adset.test.ts` (+3, pure rule logic), `generation.test.ts` (+2,
wiring through the real audienceMetaReader → cache → set-building path),
`audience-label.test.ts` fixture updated. Doc: `RULES.md`.

### 2026-08-09 — Operator accounts + full admin audit log (AIC-47)
The last ops-console-v2 ticket — all five admin sections are now live. New
`app_users.admin_role` (`full_admin`|`operator`, migration 018, backfilled
from today's `is_admin` accounts) is the one deliberate role gate: every
admin route still runs on `requireAdmin` alone, except operator-account
management itself, which additionally requires `requireFullAdmin` — a
general per-route RBAC overhaul was explicitly out of scope, only the
concrete "only a full-admin can manage operators" AC. `services/
operator-accounts.ts` add/promote/remove an operator (promotion of an
existing signed-up account only — no invite-by-email, same P0 gap as
password reset); both role-demotion and removal refuse to touch the last
remaining full_admin. Removing revokes console access without deleting the
login. The full filterable audit log reuses AIC-44's `admin_audit_log` table
(no new table) — `listAuditLog` gained an `entityType` filter; new writers
`operator.add/.role_change/.remove` and `campaign.control.<action>` (closed a
real gap: emergency-control use was silently unlogged before this, despite
being explicitly listed in the AIC-47 spec). Web: `AdminOperators.tsx` at
`/admin/operators` (nav item now live — the console's last "בקרוב" row is
gone). Live-verified end to end on prod Neon: added/promoted/removed a real
test operator, the last-full-admin guard correctly blocked a demotion, and a
real reversible emergency-control round trip on Pisga's campaign logged both
actions truthfully — cleaned up afterward. Tests: `middleware/admin.test.ts`
(requireFullAdmin), `operator-accounts.integration.test.ts` (10 tests). Also
removed a stale doc section (`ops-console.md`'s "Web ops console") that still
referenced the pre-shell `OpsConsole.tsx`/`/admin/ops`, deleted back in
AIC-43 but left undocumented as gone.

### 2026-08-09 — Recommendations oversight (AIC-46)
PRD §23's cross-account recommendations surface: every rec the engine has
produced, any customer, filterable by state/type/customer, with its evidence
and full lifecycle status. `services/recommendation-oversight.ts`
`listRecommendationsForAdmin` joins recommendations→campaigns→customers +
the latest linked `action_history` row (outcome + a link back). Deliberately
**read + flag only** — no operator-initiated approve/execute: the product's
core trust model is customer-approval-gated spend changes, and a side-channel
execute button for operators would undercut that for a feature the ticket
itself marked optional. New `flagged_for_review`/`flag_note` on
`recommendations` (migration 017) lets an operator flag a rec for review,
orthogonal to the AIC-8 state machine — logged to `admin_audit_log` (AIC-44's
table, `entity_type: 'recommendation'`). Failed recs surface via the state
filter, consistent with the needs-attention queue. Web: `AdminRecommendations.
tsx` at `/admin/recommendations` (nav item now live). Verified with realistic
seeded-then-cleaned-up data on prod — GelNails hasn't produced a real
recommendation yet (thin data / the delivery-health exclusion), so this is
honestly not yet re-verifiable against real engine output. Tests:
`recommendation-oversight.integration.test.ts`. Doc: `ops-console.md`.

### 2026-08-09 — Full Meta data explorer (AIC-45)
The operator's unrestricted deep view — the exact opposite of the customer's
opt-in audience view (AIC-37): every node (campaign→ad-set→ad→creative) with
every metric Meta gives us, including the ones hidden from customers per PRD
§14 (CPM/CTR/CPC/reach/frequency/quality-engagement-conversion rankings),
targeting, budgets + bid strategy, and delivery issues. New
`server/src/meta/explorer.ts` (`GraphExplorerReader`, its own small read-only
Graph client) + `services/campaign-explorer.ts` fetch live from Meta on every
open/refresh — no new storage table, honest degradation via
`unavailableReason` (`no_meta_campaign`/`no_token`/`meta_error`) instead of a
500 or a fabricated tree. This is the one deliberate exception to "never a
live Meta call at render time" (AIC-7's rule protects the normal navigation
path; this is a gated, explicit operator action). Recognizes flexible/dynamic
creatives (`asset_feed_spec`) instead of rendering them as broken. Web:
`AdminMeta.tsx` at `/admin/meta` (nav item now live); `AdminCustomers.tsx`
links straight in via `?campaign=<id>`. Tests: `explorer.test.ts` (pure
normalizers incl. the flexible-creative shape),
`campaign-explorer.integration.test.ts` (DB+HTTP, injected fake reader).
Doc: `ops-console.md`.

### 2026-08-09 — Customer CRUD + admin audit log (AIC-44)
The operator's actual daily onboarding/support tool: `AdminCustomers.tsx`
gains create ("+ לקוח חדש"), an inline edit form (business fields; budget
edits write straight to `managed_campaigns.agreed_budget_agorot`, which the
engine's safety check already reads live), deactivate/reactivate (reversible;
deactivating marks the managed campaign `unmanaged` — stops both generation
and execution via the existing AIC-14 controls, without touching Meta), and a
gated hard-delete (confirm-to-type, enforced server-side too, cascades the
customer's rows, never touches Meta assets). New `customers.is_active`/
`deactivated_at` + append-only `admin_audit_log` (migration 016;
`services/admin-audit.ts` + `services/customer-admin.ts`) — every write is
logged (who/what/entity/before→after), with `entity_id` deliberately not a
foreign key so a hard-deleted customer's own delete is still legible in its
audit trail. Search + active/deactivated filter over the roster; the
drill-down now shows the full record (business+contact+subscription) plus
lead-quality and condensed action-history via existing endpoints, plus the new
per-customer audit trail. QA'd live end-to-end against prod Neon (create →
edit → deactivate → reactivate → delete, confirm-to-type rejected then
accepted, audit trail survived the cascade) then cleaned up. Tests:
`customer-admin.integration.test.ts`. Doc: `ops-console.md`.

### 2026-08-09 — Admin console nav shell + fleet overview (AIC-43)
The admin console gets a proper multi-section frame — the base the rest of
ops-console-v2 (AIC-44…47) hangs off. New `AdminShell.tsx` (right-side sidebar,
reusing the customer app's shell CSS) + `AdminSidebar.tsx`: **סקירה כללית**
(Overview, `/admin`) and **לקוחות** (Customers, `/admin/customers`, the
pre-shell single dashboard's queue+customers+drill-down content, moved and
restyled to the `.dash`/`.card`/`op-table` system) are live; **נתוני Meta** /
**המלצות** / **מפעילים** show as disabled "בקרוב" rows until AIC-45/46/47 land.
New `GET /api/admin/overview` (`services/fleet-overview.ts`): campaigns-by-status,
delivering-vs-needs-attention (AIC-39 `delivery_ok`), spend/leads for the
managed fleet (all campaigns, incl. dogfood), open ops-queue depth, and
billing/conversion (excludes test customers — honest "no real customers yet" at
current scale). A client-side global search (business name + campaign name)
jumps to `/admin/customers?focus=<id>`, which auto-selects that customer's
drill-down. `CustomerListRow`/`CustomerDetail` gained `campaignName`. Old
`/admin/ops`+`/admin/readout` now redirect to `/admin/customers`. QA'd live:
real GelNails delivery-problem queue item, real fleet numbers, search→jump-to
end-to-end. Tests: `fleet-overview.integration.test.ts`. Doc: `ops-console.md`.

### 2026-08-09 — Design-system roll-out + shared overview fetch + a11y pass (AIC-42)
Recommendations (list + detail) and Settings now use the same tighter type +
lifted cards as the dashboard (`.dash`/`.dash-title`) — one visual system across
`/app*`. New `web/src/app/overview-store.ts`: a single `useSyncExternalStore`
cache for `GET /api/app/overview`, consumed by the sidebar, Home, and Settings —
confirmed via the Performance API that a page load now fires exactly **one**
overview request (was up to 3, one per component). A11y: the account menu opens
with focus on its first item, ↑/↓ cycle entries, Escape closes and returns focus
to the trigger; the mobile drawer closes on Escape; visible `:focus-visible`
rings on nav items/gear/FAB/menu entries; `aria-current="page"` on the active nav
item (via React Router's `NavLink`). Verified live: all three keyboard behaviors
tested end-to-end in the browser. Doc: `customer-app.md`.

### 2026-08-09 — Opt-in per-audience/per-creative details view (AIC-37)
Progressive disclosure for the multi-ad-set campaigns AIC-38 established as
normal: Home stays the 4-number roll-up by default; a collapsed **"הצג פירוט"**
expander reveals the per-audience breakdown, each expandable to its own
per-creative rows. New `GET /api/app/audiences`
(`server/src/services/campaign-audiences.ts`, ownership-scoped, DB-only). Audience
labels are derived from what actually differs between a campaign's ad sets — age
→ gender → geo, else the ad set's own name — never "ad set N"
(`server/src/meta/audience-label.ts`, `deriveAudienceLabels`). Labels are fetched
+ cached (`ad_set_meta`, migration 015) by the engine tick (alongside delivery
health) and threaded into `pause_underperforming_audience`'s evidence, so the
explainer now names the audience by its human dimension instead of generic
phrasing. Home's active-creative count is de-duplicated by creative name (the
same design under two ad sets is one "creative," not two). QA'd live on GelNails:
opened the details, saw "18–35" / "35–45" with the Almond creative under each.
Deferred: instrumenting the toggle as a product signal (needs AIC-28, which
doesn't exist yet). Docs: `RULES.md`, `customer-app.md`.

### 2026-08-09 — Dashboard two-column layout (AIC-41)
Restructured Home (`/app`) into a Pisga-style **rail + main** dashboard: left rail
= the campaign at-a-glance card; main = hero (status) + KPI row + recommendation
nudge + weekly feedback + activity. The status hero no longer spans full width.
Tighter type (smaller title/hero/KPI) and lifted cards (soft shadow) via a new
`.dash*` scope in `ui.css`; collapses to one column ≤1024px. Same `getOverview`
data — no backend change. (Known follow-up for AIC-42: overview is fetched twice —
Sidebar + Home — worth deduping via context.) Doc: customer-app.md.

### 2026-08-09 — App shell: right-side sidebar nav (AIC-40)
Replaced the signed-in app's top header with a Pisga-style **right-side sidebar
shell** in AdPilot's palette (ink sidebar, orange accent). New `AppShell.tsx`
(React Router layout route) + `Sidebar.tsx`; `/app*` nested under it in `App.tsx`;
per-screen `AppHeader` dropped from Home/Recommendations/Settings. Sidebar =
brand → nav sections (ראשי / המלצות+badge / הגדרות) → user card (real name/email +
account menu with logout). Off-canvas drawer + right-side FAB below 860px. Shell
CSS = `.ap-*` in `ui.css`; icons via `lucide-react`. Chrome only — no backend/data
changes. First of the 3-part /app redesign (AIC-40/41/42). Doc: customer-app.md.

### 2026-08-09 — Admin routing + entry-screen redirects (UX)
Single admin dashboard: `/admin` now renders one `AdminDashboard` (queue +
customers + a per-customer drill-down that folds in the campaign readout);
the old `/admin/ops` and `/admin/readout` routes redirect to `/admin`
(`OpsConsole.tsx`/`Readout.tsx` removed). Fixed bare `/admin` bouncing to `/login`.
Authenticated visitors on `/login` `/signup` `/register` `/forgot` `/reset` now
redirect to the dashboard (`/app`); `/onboarding` self-redirects to `/app` once
`onboarding_status = ready`.

### 2026-08-09 — Ad-set delivery-health detection; audience rule now live (AIC-39)
Detects not-delivering / disapproved ad sets (invisible in Insights) via a
separate `effective_status` + `issues_info` read. New `meta/delivery-health.ts`
(normalize/summarize) + adapter `getDeliveryHealth`; `services/delivery-monitor.ts`
persists `managed_campaigns.delivery_ok`/`delivery_reason` (migration 014) and
raises a `campaign_not_delivering` ops item on the ok→not-ok transition (deduped),
recovering on heal. Wired into the engine tick: errored ad sets are recorded and
**excluded** from the rules' evidence (ad sets + their creatives) — which lets
**AIC-36's `pause_underperforming_audience` go live** (re-inserted into `RULES`).
Customer surface: `overview.attentionKind = "delivery"` → Home shows a distinct
plain-Hebrew "needs attention" message; campaign `status` stays `active` so the
engine keeps optimizing the healthy ad sets. New owning doc
`features/delivery-health.md`. Tests: delivery-health, delivery-monitor, generation
exclusion, overview delivery-attention. 122 unit + 45 integration green.

### 2026-08-09 — Audience-aware rules + pauseAdSet write (AIC-36)
The rules now reason at the audience (ad-set) grain. **Creative fix (live):**
`pause_weak_creative` compares creatives WITHIN an ad set (grouped by
`parent_meta_id`), so the same creative under two audiences is never pitted
against itself. **Audience rule (implemented, NOT live):**
`pause_underperforming_audience` proposes pausing the worse ad set when its CPL is
≥2× the best over a stricter evidence gate; held out of the live `RULES` array
until AIC-39 can exclude errored/not-delivering ad sets (else it would recommend
pausing an errored audience). **New execution capability:** `pause_adset` rec type
(migration 013 widens the type CHECK) + `ExecWriter.pauseAdSet` + adapter
`pauseAdSet`/`setAdSetStatus`; the executor does external-change + read-back verify
on the ad set's status. `getCampaignState` now returns `adSetStatuses`. Snapshot
store gained `adsetStats` + `adSetId` on creatives. Budget rules stay
campaign-level (CBO). Docs: `RULES.md`. Tests: `rules.adset.test.ts`,
`safe-executor.test.ts` (pause_adset happy + external-change).

### 2026-08-09 — Managed shape = 1 campaign → N ad sets (AIC-38)
Definition/anchor for the multi-ad-set arc the GelNails dogfood surfaced (a real
campaign with 2 ad sets split by age). Codified the supported shape — **1 campaign
→ N ad sets → 3–5 creatives** — in `DATA_MODEL.md`; the single-ad-set ideal is an
onboarding *recommendation*, not a system/engine/review assumption. First-campaign
review criteria (`ops-console.md` + a `campaign-review.ts` comment): a legitimate
multi-ad-set **audience split** is `approved`/managed-as-is, never
`changes_requested`/"rebuild" or `unsupported` — those are reserved for genuinely
unmanageable structures. Docs + comment only; no behavior change. Anchors AIC-36
(audience-aware engine) and AIC-37 (surfacing).

### 2026-08-09 — Per-user admin role for the ops console
Admin access is now an attribute of the account, not a shared token. New
`app_users.is_admin` (migration 012); `requireAdmin` accepts a valid customer JWT
whose user is admin (403 for a valid non-admin, 401 otherwise — fail-closed in
every environment; the old "open in non-prod" convenience is gone). `ADMIN_TOKEN`
stays as an optional break-glass. `GET /auth/me` now returns `isAdmin`; the web
`AdminGate` renders the console only for a signed-in admin account and `api()`
sends the user's JWT for `/admin/*`. sharon.mishayev@gmail.com set as the sole
admin. Owning doc: `features/ops-console.md`. Tests: `admin.test.ts` (rewritten),
`admin-auth.integration.test.ts`.

### 2026-08-09 — Scheduled recommendation evaluator — closes the engine loop (AIC-9)
The rules engine was built + tested but nothing invoked it at runtime — the
scheduler only ran ingestion, so no recommendation was ever produced. Added
`server/src/recommendations/generation.ts`: `listEligibleForGeneration` (active +
automation-on + linked + healthy-connection campaigns) and `runGenerationTick`
(reads each campaign's live daily budget, then runs the canonical
`refreshRecommendations` staleness tick to create/expire `proposed` recs).
`buildGenerationTick` is inert without a Meta token. Wired into `index.ts` to run
**after** ingestion in the same "engine" tick. Also fixed `startScheduler` to run
one tick immediately on boot (was waiting a full hour after each deploy). It only
proposes — nothing executes without a customer approval. Owning doc updated
(`features/recommendation-engine.md`). Tests: `generation.test.ts`,
`generation.integration.test.ts`. Sharon's customer was also repointed from the
mis-seeded beta to the real **GelNails | Leads | WhatsApp | 2026-08** campaign
(meta 120249004871310352, ₪10/day) so the loop dogfoods on live data.

### 2026-08-08 — Onboarding/Connect + Settings actions wired — AIC-21/24
Onboarding now renders the real `onboarding_status` (→ card + stepper) and the
signed-in name; Connect shows the real connection state and "check connection"
calls `POST /api/app/connection/recheck` (live per-asset verify with a Meta
token, else the stored health). Settings gained three real actions: budget-change
request (`POST /api/app/budget-request` → ops item, `server/src/services/customer-actions.ts`),
check-connection (shared recheck), and change-password
(`POST /api/auth/change-password` — verifies the current password, then
`updatePassword`; new `findByIdWithHash`/`updatePassword` on the user store). The
header self-fetches the name once (`getMe`) so every screen shows it. Deferred to
tickets: the campaign-review screen (AIC-32, schema-vs-design mismatch) and the
real connect config — business-portfolio ID + WhatsApp/booking links (AIC-33).
Tests: `customer-actions.integration.test.ts`, change-password cases in
`auth-service.test.ts`.

### 2026-08-08 — Recommendation approve/dismiss wired over the pipeline — AIC-23
The customer recommendation surface is live: `GET /api/app/recommendations`
(+ `/:id`), `POST …/approve`, `POST …/dismiss` (`server/src/services/customer-recommendations.ts`),
all JWT-scoped to the caller's campaign. Approve transitions proposed → approved
and hands off to the AIC-12 `SafeExecutor` (no execution logic re-implemented);
outcomes map to plain-Hebrew customer messages, and a missing Meta token yields a
503 with the rec untouched. `Recommendations.tsx` list + detail render the
deterministic `explain()` text, exact current→proposed budget, and max spend
impact; the dev type-switcher is gone. `overview.pendingRecommendations` drives
the Home badge + nudge. The app header now fetches the signed-in name once
(`getMe`) so every screen shows it (loader, never the mock). New owning doc
`features/customer-recommendations.md`; lock-in test
`customer-recommendations.integration.test.ts`.

### 2026-08-08 — Home + Settings wired to live customer data — AIC-22/24
New JWT-scoped `GET /api/app/overview` (+ `POST /api/app/lead-quality`) assembles
the caller's account → customer → connection → campaign → subscription, the
snapshot-based readout, and condensed action history — reading only the caller's
own rows. `Home.tsx` and `Settings.tsx` now render from it (real KPIs, deltas,
budget, Meta connection, billing, activity); the Home dev state-switcher is gone
and the headline `homeState` is derived server-side. Honest empty states
(`collecting`, `—`, "nothing changed yet") instead of sample numbers. New owning
doc `features/customer-overview.md`. First real customer (sharon.mishayev@…, the
Pisga dogfood account) now loads end-to-end.

### 2026-08-08 — Customer auth backend wired (email+password + JWT) — AIC-21
Built the auth backend: `app_users` table (migration 011, case-insensitive unique
email), bcrypt passwords, our own JWT sessions (`JWT_SECRET`), `/api/auth/signup|
login|me` + `requireAuth`. Wired the frontend auth screens to the real endpoints
(store JWT, redirect), added `AuthGate` on signed-in routes + logout. Google
sign-in stays deferred (AIC-30); forgot/reset still frontend-only. Verified: 4 unit
+ 5 DB/HTTP integration tests; a real `app_users` row is created end-to-end. Owning
doc: `features/customer-auth.md`.

### 2026-08-08 — AIC-1 spike PASS (live) + admin API auth + Railway live
Live-verified the whole partner-access model on Pisga's real account: a read-only
probe + a no-op budget write routed through the full AIC-12 safe-execute pipeline
both PASSED under **Standard Access** — reads and writes on a partner-owned ad
account work without Advanced Access. AIC-1 Done; AIC-12/13 live-verified; AIC-25
descoped to a scale concern. Added `GraphCampaignAdapter` (real MetaReader/
ExecWriter) + gated probe/write-test tools. Closed the admin-API hole: `requireAdmin`
now **fails closed in production** when `ADMIN_TOKEN` is unset and requires a bearer
otherwise; web console gated via `AdminGate`. Also fixed two Railway deploy blockers
(NODE_ENV skipping devDeps → `NPM_CONFIG_PRODUCTION=false`; cwd-relative web/dist →
`resolveWebDist`); the app is **live** at aicserver-production.up.railway.app serving
landing + SPA + API with Neon migrations applied.

### 2026-08-04 — Customer app screens (frontend, AdPilot design) — AIC-21/22/23/24
Built every customer-facing screen as frontend on mock data, from the AdPilot
Product Phase 1/2 design directions: auth (signup/login/forgot/reset), checkout,
onboarding (6 states + stepper), connect-Meta (4 outcomes), first-campaign review,
home dashboard (5 states + weekly lead-quality + activity), recommendations list +
detail (3 types × approve/dismiss/executed), settings & support. Added the AdPilot
design system (`web/src/ui.css`), shared components (`web/src/app/components.tsx`),
centralized copy (`strings.he.app`), and full routing (`App.tsx`). No backend yet —
screens navigate/switch via in-component state; wiring lands per ticket. Verified:
typecheck + build green; login/home/onboarding render faithfully. Owning doc:
`features/customer-app.md`. Open decision: the design's self-serve **checkout**
diverges from P0 manual billing — tracked separately.

### 2026-08-04 — Landing page (AdPilot design) — AIC-20
Replaced the placeholder `landing/index.html` with the full AdPilot marketing page
from the provided design directions: fluid responsive RTL Hebrew, brand palette
(orange/cream/ink/green/indigo) + Rubik/IBM Plex Mono, and all sections — hero
collage, dark ₪299-vs-₪1,200 comparison, how-it-works, dashboard mock, creative +
lead-quality + support, pricing, 8-question FAQ (native accordion), final CTA,
footer. CSS-only mockups (no external images). Verified: builds into
`web/dist/index.html`, renders at desktop + 375px with no horizontal overflow.
Contact CTAs + brand alignment (AdPilot vs AI Campaigner) flagged as open.

### 2026-08-03 — Ops console: manual billing + weekly lead-quality — AIC-19
Added the manual billing ledger (`updateBilling` + `conversionSummary` for
setup→subscription conversion, no payment gateway) and weekly campaign-level
lead-quality capture (`upsertLeadQuality` idempotent per campaign+week,
`listLeadQuality`, `leadQualityResponseRate`), routes under `/api/admin/*`.
Verified: 2 DB integration tests (billing + conversion; lead-quality upsert +
response rate).

### 2026-08-03 — Ops console: first-campaign review — AIC-18
Added the review workflow (`campaign_reviews` table): `submitReview` records
outcome + reviewer + timestamp + §11 checklist and moves status (approved →
active, unsupported → unmanaged, changes_requested → stays under_review). The §11
hard rule is enforced — a changes_requested campaign is not activated until
`recordCustomerDecision(true)` records explicit customer approval. Routes under
`/api/admin/campaigns/:id/review` + `/reviews/:id/customer-decision`. Verified: 4
DB integration tests (all outcomes + no-activation-without-approval).

### 2026-08-03 — Ops console: needs-attention queue — AIC-17
Added `OpsQueue` over `ops_queue_item`: one prioritized worklist across all
accounts (high severity first, then oldest; resolved fall away), a canonical
`create` (high-sev logged for the alert hook), and triage (`claim` → in_progress +
claimed_by; `resolve(note)`). Routes under `GET/POST /api/admin/ops-queue`.
Verified: DB integration (severity sort, claim, resolve).

### 2026-08-03 — Ops console: customers view — AIC-16
Added `listCustomers` / `getCustomerDetail` assembling each account's info +
subscription + connection health + campaign + agreed budget + outstanding
recommendation + open ops-item count from the real tables, at
`GET /api/admin/customers[/:id]`. Migration 010 adds ops-queue triage columns +
the `campaign_reviews` table for the rest of P0.4. Verified: DB + HTTP integration.

### 2026-08-03 — Action history surface — AIC-15
Added the per-campaign audit surface reading only from `action_history`:
`listCampaignActionHistory` / `listCustomerActionHistory` (newest-first, full PRD
§23 fields, automated-vs-human), and `condense()` — a jargon-free plain-Hebrew
projection for customer reuse. Exposed at `GET /api/admin/campaigns/:id/history`
(`?condensed=true`). Verified: DB + HTTP integration test. Completes P0.3.

### 2026-08-03 — Emergency controls + failure handling — AIC-14
Added per-account kill-switches (disable/enable automation, freeze/unfreeze
execution, mark unmanaged, pause management) as immediate DB flags (migration 009
adds `execution_frozen`), exposed at `POST /api/admin/campaigns/:id/controls`.
`ControlService.assertExecutable` is the control gate the SafeExecutor already
calls — flipping any switch halts execution on the next attempt (rec stays
approved). Failure handling (ops item + plain-Hebrew customer message + failed
action_history, never a silent success) is enforced in the AIC-12 pipeline.
Verified: 6 tests (gate per flag; kill-switch halts a batch mid-way). Telegram
alerting + ops-console surfacing land with P0.4.

### 2026-08-03 — Safe-execute pipeline — AIC-12
Added `SafeExecutor.execute`: the ordered pipeline for executing an approved
recommendation — relevance → access-health hold → emergency-control hold → claim
executing → external-change detection (cancel, never overwrite) → budget-safety
block → execute → read-back verify (mismatch = failure) → log to action_history.
Access-lost and automation-stop are holds (rec stays approved); external-change,
over-budget, write-fail, and verify-mismatch are failures with an ops item + a
plain-Hebrew customer message. A failed execution never looks succeeded.
replace_creative escalates to ops as a human task. Verified: 10 scenario tests.

### 2026-08-03 — Budget safety + idempotent write outbox — AIC-13
Added `assertWithinBudget` (agreed budget is a hard ceiling; ≤0 or over-ceiling
rejected; null/non-budget passes) and `meta_write_outbox` (migration 008): a
durable queue with a unique idempotency key per intended change (repeat enqueue =
no-op), `FOR UPDATE SKIP LOCKED` draining, backoff/retry to MAX_ATTEMPTS, and
terminal succeeded rows. Only absolute-set idempotent ops (set_daily_budget,
pause_ad) are enqueued, so a lost-response retry re-applies to the same end state.
Verified: 4 budget unit tests + 3 DB integration tests (enqueue idempotency,
exactly-once drain, backoff-then-succeed).

### 2026-08-03 — LLM explainer (plain-Hebrew, never decides) — AIC-10
Added the explainer: `explain(rec)` renders each recommendation type + a weekly
status as plain business Hebrew from a centralized copy table, injecting figures
from the structured record by code (deterministic fallback, always works).
`explainWithLlm` optionally rephrases but accepts the model's text only if every
figure survives verbatim and no Ads Manager jargon appears — the "LLM explains,
never decides" boundary, enforced structurally. Documented in `docs/RULES.md`.
Verified: 10 tests (number-fidelity, jargon-absence, fallback, rejection of a
number-changing or jargon-introducing rephrase). P0.2 recommendation engine
complete.

### 2026-08-03 — Recommendation staleness + expiry — AIC-11
Added `refreshRecommendations` as the canonical eval tick: a proposed rec is valid
iff the same gated rules still produce an equivalent rec from current evidence;
otherwise it's expired (and replaced when a different action is now warranted). An
expired rec is un-approvable by construction (AIC-8 state machine). "Material
divergence" is defined as rules-no-longer-yield-it. Verified: 4 tests
(evidence-holds → stays; diverged → expires; expired → un-approvable; replaced).

### 2026-08-03 — Deterministic recommendation rules v1 — AIC-9
Added the rules engine: `evaluateCampaign` runs five rule types
(pause_weak_creative, replace_creative, decrease_budget, increase_budget,
no_action) over per-campaign evidence, gated by named minimum-evidence thresholds
(`RULE_THRESHOLDS`) — below the gate it emits `no_action`, never a forced change.
Zero LLM involvement; output fully structured. `rule-evaluator.ts` assembles
evidence from `insight_snapshot`, persists an acting draft as `proposed` (deduped;
`no_action` not stored). Thresholds + priority documented in `docs/RULES.md`.
Verified: 14 rule fixture tests (fires when it should, does NOT on thin evidence) +
3 evaluator tests.

### 2026-08-03 — Recommendation state machine — AIC-8
Added the recommendation lifecycle as an explicit state machine
(`proposed→approved→executing→executed|failed`, plus `dismissed`/`expired`),
illegal transitions rejected before any write. `RecommendationService` wraps every
transition with the state-machine check + an optimistic store guard
(`StaleRecommendationError` on a lost race); `completeExecution` writes the PRD §23
audit row to `action_history`. `no_action` is a first-class type. pg + in-memory
stores. Verified: 9 unit + 1 DB integration test.

### 2026-08-03 — Dogfood readout (admin) — AIC-7
Added the internal readout: `buildCampaignReadout` (status + current/previous
7-day totals + per-creative rows + period deltas, read only from
`insight_snapshot`), the `/api/admin` routes behind a `requireAdmin` guard, and
the `/admin/readout` React screen (Hebrew, RTL; `formatShekel`, NULL CPL → "—").
Verified: deltaPct unit test + DB/HTTP integration test, and rendered end-to-end
against seeded Pisga snapshots on a local Postgres (status active, ₪734 spend
+8%, 18 leads +20%, CPL ₪40.78 −10%, 3-creative table). Reconciliation vs Ads
Manager gated on real ingestion.

### 2026-08-03 — Insights ingestion → insight_snapshot — AIC-6
Added the ingestion pipeline: `getInsights` on the Meta client (4 grains, creative
derived from ad rows), pure metric functions (`extractLeads` — 7d-preferred, never
double-counted; `computeCpl` — NULL at 0 leads; `normalizeRow` — spend→agorot), the
snapshot store (idempotent upsert per (campaign, grain, object, period) + period
totals), and `runIngestionTick` (per-campaign isolation: a Meta error is caught,
logged, retried next tick, never crashes the run). Wired an inert-until-token
scheduler into `index.ts`. Lead/CPL documented in `docs/METRICS.md`. Verified: 12
new unit tests + 2 DB integration tests (idempotency, period totals). Live against
Pisga gated on a real System User token + linked campaign.

### 2026-08-03 — Meta connection + access-loss detection — AIC-5
Added the Meta client abstraction (`GraphMetaClient` + `FakeMetaClient`), a Graph
error → access-health classifier, the connection store (pg + in-memory), and
`ConnectionService`: verify folds per-asset access into one health, persists
transitions, and raises a single `meta_connection_failure` ops item on loss.
`assertExecutable` throws `AccessHaltedError` unless health is `ok` — the P0.3
execution-halt safety rule. Customer-facing reconnect copy added to `strings.ts`
(plain Hebrew, no Meta jargon; `connectionMessage()` maps every non-ok state to
one prompt). Verified: 8 service + 3 classifier unit tests, and a DB integration
test proving persistence + ops item + halt end-to-end. Live-against-Pisga is
gated on a real System User token (AIC-3 operator steps) and AIC-1.

### 2026-08-03 — Meta setup runbook — AIC-3
Added `docs/META_SETUP.md`: the one-time Meta-side configuration (Business
Portfolio, app, System User + token scopes, partner-asset assignment, token
storage/rotation posture) in the accurate access framing (partner access +
System User, subject to Meta's required Marketing API tier; no customer OAuth in
P0). Added `META_*` env placeholders to `server/.env.example`. The operator steps
(mint token, assign Pisga's ad account) are executed in Meta's UI by a person and
are checklisted in the doc; the app only consumes the resulting token + asset IDs.

### 2026-08-03 — Core data model: 10 P0 entities — AIC-4
Added migrations `002`–`007` creating the ten P0 tables (customers,
subscriptions, meta_connections, ad_accounts, managed_campaigns,
insight_snapshots, recommendations, action_history, lead_quality_feedback,
ops_queue_items) with FKs, indexes, and CHECK-enum columns mirrored in
`shared/src/domain.ts`. Money is integer agorot; `action_history` is append-only;
the snapshot idempotency key is `(campaign, grain, object, period)`. Added the
Pisga dogfood seed (idempotent) and a DB integration test (self-skips without
`DATABASE_URL`). RLS deliberately not adopted (Neon has no PostgREST surface;
rationale in DATA_MODEL.md). Verified against a local Postgres: 7 migrations
apply, seed idempotent, 4/4 integration tests green.

### 2026-08-03 — Stack scaffold (server / web / shared) — AIC-2
Scaffolded the monorepo from Pisga's proven stack: npm workspaces
(`shared` / `server` / `web`), TypeScript throughout, Neon Postgres via a
numbered-migration runner (`001_init.sql` creates the `_migrations` ledger only;
the P0 entities land in AIC-4), an Express API with a root `/health` for Railway
and an `/api` mount point, a Vite + React SPA with the static landing served at
root, the `strings.ts` copy file, `railway.json`, and a GitHub `ci` workflow
(typecheck + build + unit tests). `shared/money.ts` enforces integer-agorot money.
Verified locally: typecheck, build, and 5/5 unit tests green. No DB/e2e in CI yet
(waiting on a Neon dev-branch `DATABASE_URL`).

### 2026-08-02 — Repo bootstrap: governance layer
Created the standalone AI Campaigner repo with its operating rules
([CLAUDE.md](../CLAUDE.md)), the `feature-docs` skill, and the docs system
(INDEX routing table + this changelog + the feature-doc template). Establishes the
docs-travel-with-code and ship discipline before any feature work, so every later
change inherits it. Stack scaffold (server/web/CI/Railway/Neon) lands separately.
