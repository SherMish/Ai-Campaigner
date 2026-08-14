# Customer overview API (AIC-22/24)

**Status:** live. The logged-in customer's Home + Settings screens render from a
single JWT-scoped endpoint that reads only the caller's own rows. No live Meta
call at render time — performance figures come from `insight_snapshots` via the
readout builder.

**Source of truth:**
- Service: `server/src/services/customer-overview.ts` — `buildCustomerOverview(pool, userId, ref?)`
- Audience details (AIC-37): `server/src/services/campaign-audiences.ts` — `buildCampaignAudiences(pool, userId, ref?)`
- Route: `server/src/routes/app.ts` — `GET /api/app/overview`, `POST /api/app/lead-quality`,
  `GET /api/app/audiences` (all `requireAuth`)
- Client: `web/src/api.ts` — `getOverview()`, `postLeadQuality()`, `getCampaignAudiences()`, `shekels()`, `CustomerOverview` type
- Screens: `web/src/app/Home.tsx`, `web/src/app/Settings.tsx`

**Lock-in tests:** `server/src/services/customer-overview.integration.test.ts`
(full-chain assembly; `homeState` = `ok` with data / `collecting` without;
401 without a token; lead-quality write + validation; AIC-64's noRecReason
surfacing + clearing; AIC-71's `stopped` outranking `collecting` even with no
snapshot data, and the pre-first-tick `delivering=true` default).

---

## What it returns

`buildCustomerOverview` joins the caller's `app_user` → `customer` →
`meta_connection` (+ first `ad_account`) → `managed_campaign` → `subscription`,
plus the snapshot-based `CampaignReadout` and condensed `action_history`. Money
is integer agorot throughout; the client formats with `shekels()`.

Every query filters by the customer id resolved from the JWT's user — a customer
can only ever see their own data. An account with no linked `customer_id`
returns `homeState: "no_campaign"` with null sections (the Home "setup" state).

### `pendingRecommendationType`, not just a count (bug fix, 2026-08-14)

`pendingRecommendations` (a bare count, ≤1 by construction — RULES.md's
precedence guarantee) used to be the *only* signal the Home dashboard teaser
had. The teaser's headline was a single hardcoded string ("worth pausing one
of the ads") shown for **any** pending type — fine while every acting type
was a spend change with roughly that shape, wrong the moment AIC-86
introduced `add_creatives_for_comparison`: the customer saw "pause an ad,"
clicked through, and found "add more ads" instead.

`pendingRecommendationType` fixes this at the data layer: `buildCustomerOverview`
now fetches the actual proposed row(s)' `type`, not a `count(*)`. `Home.tsx`'s
teaser headline reads `recDetail.titles[pendingRecommendationType]` — the
exact same per-type copy the detail screen (`Recommendations.tsx`) uses — so
the two can never say different things again. The teaser's CTA is also
neutral ("view", not "view and approve") since not every type has an
approval step.

## homeState (the single Home headline)

Derived server-side, highest-priority first:

| state | condition |
| --- | --- |
| `no_campaign` | account has no linked customer/campaign yet |
| `attention` | connection `access_health` ≠ `ok`, or campaign `needs_attention`/`connection_problem`, or a real delivery problem (AIC-39) |
| `paused` | campaign `status = paused` (an operator paused OUR management of it — resuming needs us) |
| `stopped` | nothing is currently deliverable, but nothing is broken (AIC-71) — usually the customer's own pause via the audience controls; they can resume it themselves |
| `collecting` | campaign active but no snapshot data (no spend, no leads, no creatives) |
| `ok` | active with data |

The client maps each state to hero copy in `strings.he.app.home.states`; only
states with a real destination carry a CTA (`attention` → `/connect`,
`no_campaign` → `/onboarding`). `attention` carries a second signal,
`attentionKind: 'connection' | 'delivery' | null` (AIC-39) — a lost Meta
connection and a not-delivering ad set are different problems with different
copy (`h.states.attention` vs `h.states.delivery`); a delivery problem shows
no CTA (there's nothing for the customer to click — we're already on it).

## Honest delivery state, not the management flag (AIC-71)

`campaign.status` (`paused` above) is a DB flag meaning "are **we** managing
this" — set only by an operator's emergency controls
([safe-execution.md](safe-execution.md)), never by real Meta ad/ad-set state.
Before AIC-71, `homeState` had no live-delivery signal at all: a customer who
paused their only ad set via the manual controls (AIC-66) still saw `ok` /
"פעיל" with a stale active-ad count, because nothing in the derivation asked
"is anything actually showing right now."

`stopped` fixes that using the SAME per-tick cached read as `deliveryOk`
(AIC-39, [delivery-health.md](delivery-health.md)) — no new Meta call,
no new staleness mode: `campaign.delivering` / `campaign.deliveringAdCount`
are computed by `summarize()` from real ad/ad-set `effective_status`, counting
ads that are themselves currently deliverable, not merely "the ad set has no
error." `deriveHomeState` checks `!campaign.delivering` AFTER the real
delivery-problem check (so a genuine error still routes to `attention`, never
`stopped`) and BEFORE `collecting` — a campaign with everything paused will
never accumulate data no matter how long you wait, so `stopped` must outrank
"still collecting."

Both default to `true` / `null` until the engine's first tick for a campaign
(mirroring `deliveryOk`/`liveBudgetAgorot`), so a brand-new campaign correctly
reads `collecting`, never a false `stopped`.

On Home, the "מודעות פעילות" (active ads) count now reads
`campaign.deliveringAdCount` when it's non-null, falling back to the old
historical-spend count (deduplicated by creative name, AIC-37) only before
the first tick — the same honesty fix applied to the count, not just the
headline state.

## Why there's no recommendation (AIC-64)

When `homeState` is `ok` or `collecting`, Home's reassurance card no longer
shows one generic message — `campaign.noRecReason`/`noRecDetail` (cached by
the engine on `managed_campaigns`, see [RULES.md](../RULES.md#why-theres-no-recommendation-aic-64))
picks distinct copy per reason (`stable`/`collecting`/`budget_below_threshold`/
`single_ad_set`, `web/src/strings.ts` → `home.noRec`), with a raise-budget CTA
to `/app/settings` for `budget_below_threshold`. `delivery_blocked` never
reaches this card — `deriveHomeState` already routes a delivery problem to
`attention` first, so the two surfaces can't disagree. `noRecReason` is
`null` before the engine's first tick for a campaign; the card falls back to
the original generic copy in that case.

## Opt-in audience details (AIC-37, redesigned AIC-73)

Home defaults to the campaign roll-up only — no ad-set/audience detail ever
shows unprompted (PRD §14's "not prominently," not a ban). A collapsed "הצג
פירוט" toggle on Home (`AudienceDetails` in `Home.tsx`) lazily fetches
`GET /api/app/audiences` only when opened, rendering one row per audience
(spend/leads/CPL) labeled by its human dimension — never a raw ad-set id or
"ad set N" (see [`deriveAudienceLabels`](../../server/src/meta/audience-label.ts)
and [RULES.md](../RULES.md)'s audience-rule section) — each expandable to its
own per-creative breakdown. Backed by `services/campaign-audiences.ts`
`buildCampaignAudiences` (DB-only, ownership-scoped, no live Meta call).
**Deferred AC:** instrumenting the toggle's open-rate needs the AIC-28 metrics
layer, which doesn't exist yet — there's no event sink to write to, so this
isn't half-built here.

**AIC-73 fixed the actual root cause of the raw-name leak.**
`deriveAudienceLabels` used to label a dimension only when it DIFFERED across
sibling ad sets — with exactly one ad set (the common shape for a small
business, e.g. GelNails), nothing ever differs, so every real account fell
through to the ad set's own Meta name (`"IL | Ramat Gan, Givatayim | Women
18-46 | Advantage+"`, pipes and all — a direct AIC-37 spec violation, not
polish). Corrected to compose EVERY ad set's own gender/age/geo unconditionally
(`"נשים · 18–46 · רמת גן, Givatayim"`), regardless of whether a sibling
differs; the only true fallback (no structured targeting at all) is a neutral
phrase ("קהל כללי"), never the raw name — and two ad sets that land on an
identical composed label get a disambiguating `(2)`/`(3)` suffix instead of
silently duplicating.

**The panel itself was also redesigned** (raw-mixed-value strings, no metric
labels, near-equal audience/ad visual weight, a caret stranded across the
full card width, unlabeled creative list, inconsistent pause-button
placement, reversed bidi text) — every number now carries its own label
(`Metric` component), the audience/ad relationship is an explicit nested
block (`border-inline-start` + indent), the collapsed state previews its
content (`{activeAds} מודעות פעילות`, built from data Home already has — no
prefetch), and mixed Hebrew/Latin strings (labels, creative names) are
wrapped in `<bdi>` so nothing renders reversed.

**Re-baseline any AIC-37 open-rate instrumentation built after this ships** —
numbers from before the redesign measured "is the details panel usable,"
not "do customers want detail."

### Round 2 (AIC-73, same day)

**One click, no nested disclosure.** The panel used to be פירוט → audience →
ads (two clicks). The second level is gone: hierarchy comes from layout
(indent + rule), not interaction. Progressive disclosure was solving a volume
problem that doesn't exist — a typical customer has 1–2 audiences × 1–5 ads,
and the P0 builder always creates exactly one ad set (AIC-49), so a collapsed
container around a single item was pure ceremony. It also hid the thing the
customer had just asked for, and corrupted AIC-37's measurement (low
engagement conflated "doesn't want detail" with "never found the second
toggle"). Above `ADAPTIVE_COLLAPSE_ABOVE` (3) audiences the per-audience
collapse returns — disclosure earned by real volume, not applied preemptively.

**⚠️ `age_range`, not `age_min`/`age_max` — a real confidently-wrong label.**
The panel showed **18–65** for an ad set actually targeting **21–46**. With
Advantage+ audience expansion on (the default for builder-created ad sets),
Meta reports `age_min`/`age_max` as the EXPANSION CEILING, while the
configured range lives in `age_range`. `configuredAge()` in `audience-label.ts`
prefers `age_range` and falls back only when it's absent/malformed; the
adapter and the ops explorer both request the field. Note the ad set's own
NAME said "18-46" while the truth was 21–46 — another reason names are never
trusted.

**Geo is localised** (`localizePlace`): Meta returns place names in English
regardless of locale, so "נשים · 21–46 · Ramat Gan, Giv'atayim" was still
half-raw. Unmapped names pass through unchanged — an English city name beats
a wrong transliteration.

**Creative thumbnails** (`meta/ad-media.ts`, `GET /api/app/controls/media`):
the ads are pictures, and a grey comma-string was the weakest possible
representation of them. Fetched live on panel open — the same
explicit-user-action rule that justifies `GET /state`, since the DB-only
readout carries no image data. Degrades to the ad's name when Meta exposes no
usable image.

**`assetCount` is what Meta reports, never inferred from the name.** The
round-2 review assumed this ad was "one flexible ad containing 4 creatives"
because it's named `almond green, french, video, pink lines`. The live API
says otherwise: one creative, no `asset_feed_spec`, `is_dynamic_creative`
false. The name is just a label someone typed. So the UI says "מודעה אחת"
here, and only says "N קרייטיבים" when `asset_feed_spec` genuinely carries N
assets — claiming 4 would have been inventing data.

**Also:** per-row status chips (`מפרסם` / `מושהה על ידך`, AIC-71's
vocabulary) so "is this running?" no longer has to be inferred from which way
the action button points; pause demoted from a prominent outline pill to a
quiet text link (secondary, mildly destructive — it shouldn't out-rank the
audience label); metrics moved directly under their row title, removing dead
space that read as "something failed to load"; the ad row now shows the same
three metrics as the audience row (it silently dropped עלות לפנייה); and real
SVG chevrons at 18px that rotate on toggle, inside a ≥44px hit target
(the old ~10px text triangle was near-impossible to hit on a phone).

**API-call cost, stated honestly:** opening the panel now makes **four** Meta
reads (campaign + ad sets + ads for `/state`, plus ads-with-creative for
`/media`). Both calls fail soft — `/state` failing hides the pause links,
`/media` failing falls back to names — and neither breaks the panel. This was
observed for real during development: heavy API probing tripped Meta's
per-ad-account rate limit (code 17) and the panel degraded exactly as
designed. If panel opens ever become frequent, merging the two ad-level reads
into one is the obvious saving.

## The range switcher (day / week / month / all-time)

Home's KPIs are driven by ONE customer-selected window. This replaced a
"today card + separate 7-day KPI block" that showed two sets of numbers for
the same campaign and read as a contradiction ("very very confusing"). The
window is now an explicit choice rather than an unstated assumption.

**The data foundation had to change first.** Snapshots were stored only as
overlapping rolling-7-day windows (a fresh `[today-7 … today-1]` row every
tick), so summing them over an arbitrary range double-counts — the same flaw
that made 1 real lead read as 3. Ingestion now ALSO writes **disjoint
per-day rows** (`MetaClient.getDailyInsights`, `time_increment=1`, stored with
`period_start = period_end`), and `PgSnapshotStore.dailySeries` reads only
those (`WHERE period_start = period_end`). Every bounded range is a sum over
days.

| range | source |
| --- | --- |
| `day` | today's per-day row (partial, still updating) |
| `week` / `month` | trailing 7 / 30 per-day rows, **including today** |
| `allTime` | cached lifetime read (`leads_to_date` / `spend_to_date`) |

`allTime` deliberately does NOT sum the daily rows: those only reach back
`DAILY_LOOKBACK_DAYS` (45), so an older campaign would be silently
under-reported. The lifetime figures come from one
`date_preset=maximum` Meta call per generation tick.

**The engine is unaffected.** It still evaluates on `rollingPeriods().current`
— complete days only — no matter what the customer has selected. A
half-finished day looks like underperformance and must never trigger a
recommendation. AIC-64's no-rec card explains the difference when today has
activity, so the two surfaces never look like they're contradicting.

**Thin data is stated, not implied.** `firstDataDate` (earliest day with real
data) lets Home say "the campaign has been running since 9 Aug" instead of
letting a 30-day window imply a flat, empty month of bad performance.

## פניות לפי שבוע graph

The rail's trend glance, built from the same disjoint daily series bucketed
into trailing 7-day blocks (newest first in RTL). A zero week renders as a
visible grey sliver rather than a missing bar, so "no leads that week" reads
as zero rather than as a rendering gap.

## Today vs the engine's window — two questions, two windows

**Real bug, 2026-08-12:** a customer got 3 leads today and the headline still
read **1 פניות**. Nothing was wrong with the number — the readout window is
`rollingPeriods().current` = `[today-7 … today-1]`, which deliberately **stops
at yesterday**, and nothing ever ingested today at all. So today's 3 leads and
₪26.74 were invisible everywhere on the page, while the lead-quality card
(all-time) correctly said 4. Two true numbers that read as a contradiction.

The two surfaces are answering genuinely different questions and so get
different windows:

| | window | why |
| --- | --- | --- |
| **Engine / rules** | complete days only (`[today-7 … today-1]`) | A half-finished day looks like underperformance. Acting on it would move real money on bad evidence. |
| **Customer dashboard** | + today, shown separately | Someone who got 3 leads today must see them, or the product looks broken. |

Implementation: `todayPeriod(ref)` (`meta/scheduled-ingestion.ts`) is a
single-day window ingested as its **own snapshot row** via
`runIngestionTick`'s `extraPeriods` — a display-only extra whose failure is
logged but never marks the campaign failed (the engine's primary window is
what matters). `buildCampaignReadout` exposes it as `readout.today`,
deliberately **not** folded into `current`: blending a partial day into a
7-day CPL ratio makes that ratio noisy mid-day without helping anyone.

On Home it renders as its own "היום עד עכשיו" line above the KPI group,
labelled **provisional** — Meta's same-day conversion data is incomplete and
revises upward, so 3 leads at noon becoming 5 by evening should read as
expected, not as a bug.

**The two surfaces can now legitimately disagree** — the customer can see
today's leads while the engine still says "no recommendation yet." That's
explained rather than left to look like a contradiction: the AIC-64 no-rec
card appends `noRec.completeDaysNote` whenever today has activity.

## KPIs, deltas, sidebar

CPL / leads / spend come from `readout.current`; the signed period-over-period
deltas from `readout.delta` (null when there's no prior period — shown as no
comparison, never a fake +100%). The sidebar shows the campaign name, budget +
period, active-creative count, and total leads. When collecting, values
honestly render `—` / `0`, not placeholder numbers.

**Every KPI states its own window** (fixed 2026-08-12 alongside the today
split). `kpiSpend` used to read **"הוצאה החודש"** — *spend this month* — on a
7-day value: a label claiming something the number isn't, the same class of
small lie as a false "פעיל". The window is now stated once above the group
(`h.kpiWindow` = "7 ימים אחרונים (עד אתמול)") rather than repeated on each
tile, and the sidebar's "פניות לפי שבוע" became "פניות (7 ימים)".

Deliberately **not** switched to month-to-date: a month figure resets to
near-zero every 1st and would make performance look like it collapsed, and
mixing a month-to-date spend next to a 7-day CPL makes adjacent tiles
non-comparable. A real budget-pacing month element ("spent ₪X of your monthly
budget") is a separate, deliberate addition — it belongs with AIC-55's
day/week/month range work, where "which window" gets settled coherently
rather than one KPI at a time.

**Budget shown = `liveBudgetAgorot ?? agreedBudgetAgorot`** (real bug fixed
2026-08-12): `agreedBudgetAgorot` is the engine's own safety ceiling
([safe-execution.md](safe-execution.md#budget-safety-aic-13)), not necessarily
what's live on Meta right now — a customer changing the budget directly on Meta
used to leave the dashboard silently stale. `liveBudgetAgorot` is cached fresh
every generation tick and is what's actually shown once the engine has ticked at
least once for this campaign; the ceiling is only the fallback before that.

## Lead-quality feedback — incremental delta review (AIC-19/22, redesigned AIC-67)

**Status:** live. Replaces a cumulative-weekly single value ("of your N leads
this week, how many were relevant?") that had a real double-counting bug: the
denominator grew all week and the UI kept no memory of what was already
reviewed, so answering twice in the same week (2 leads → 5 leads) forced the
customer to remember they'd already counted the first 2, or double-count.

**Source of truth:**
- Service: `server/src/services/lead-quality-review.ts` —
  `getLeadQualityStatus` (derived read), `recordLeadQualityReview` (the only write)
- Wired into `buildCustomerOverview` (`leadQuality` field) — `leadsToDate`
  comes from `managed_campaigns.leads_to_date`, cached once per generation
  tick (`GraphCampaignAdapter.getLifetimeLeads`, `services/leads-to-date.ts`)
- Route: `POST /api/app/lead-quality { relevant }` — `services/customer-overview.ts`
- Client: `web/src/api.ts` `postLeadQuality(relevant)`, `LeadQualityStatus`;
  screen: `LeadQualityCard` in `web/src/app/Home.tsx`
- Storage: migration 027 — `lead_quality_reviews` (append-only event log:
  `leads_delta`, `relevant_delta` per review action); migration 028 — `leads_to_date`

**Lock-in tests:** `customer-overview.integration.test.ts` ("only asks about
the delta, watermark advances, double-counting is impossible" — the exact bug
this replaces; "overlapping rolling-window snapshots never inflate
leadQuality" — the real 1-lead-read-as-3 bug below), `lead-quality-review.integration.test.ts`
(watermark math, attribution-lag negative-safety, this-week rollup, migration
backfill), `lead-quality-review.test.ts` (`mondayOf`, validation never writes
on bad input), `campaign-adapter.test.ts` (`getLifetimeLeads` uses
`date_preset=maximum`, never a snapshot sum), `generation.test.ts`
(`leadsReader`/`recordLeadsToDate` tick wiring).

### `leadsToDate` must NEVER be summed from `insight_snapshots` (real bug, found live)

Shipped once already computing `leadsToDate` as
`PgSnapshotStore.campaignTotals(campaignId, ALL_TIME_START, today)` — summing
`leads` across every campaign-grain `insight_snapshots` row. That's wrong:
the ingestion tick writes a NEW row every day for a ROLLING 7-day window
(`today-7..today-1`, shifting by one day per tick) — these rows OVERLAP, they
are not disjoint weekly buckets. Summing them counts the same real leads once
per overlapping snapshot. Caught live within minutes of shipping: a customer
saw "1 פניות" on the main KPI and "3 לדירוג" on the lead-quality card for the
SAME campaign with exactly 1 real lead — three daily ticks had written three
overlapping snapshots of that one lead, and the sum was 3.

Fixed the same way `delivery_ok`/`live_budget_agorot`/`delivering` already
are: a single Meta Insights call per generation tick
(`level=campaign&date_preset=maximum` — verified live to return a true,
non-overlapping lifetime range without needing to know the campaign's actual
creation date) cached onto `managed_campaigns.leads_to_date`. The UI never
computes this itself and never sums snapshot rows for it.

### The watermark, not a cumulative field

`lead_quality_reviews` is append-only — every review is a new row, never an
UPDATE. The all-time watermark (`reviewedSoFar`/`relevantSoFar`) is `SUM()`
over that table; `pending = max(0, leadsToDate - reviewedSoFar)`. The customer
is only ever asked about `pending` — never a total they'd have to reconstruct
themselves — and re-rating already-reviewed leads is structurally impossible,
not just avoided: the ROUTE computes `pending` server-side from the caller's
own watermark and passes it straight to `recordLeadQualityReview` as
`leadsDelta`; the client never supplies a lead count, only how many of the
(server-determined) pending batch were relevant.

`max(0, ...)` also makes attribution lag safe for free: if Meta's attribution
window revises `leadsToDate` downward after the fact, `pending` just reads
zero (caught up) instead of going negative — no special-casing needed.

### Why "leads to date" and not "this week"

The old field reset weekly (`week_start`, Monday-keyed) and asked about
`leads this week`. The new watermark is deliberately all-time cumulative —
new leads are always net-new since the last review, full stop, so there's no
"does pending reset on Monday" edge case to get wrong. A "running weekly
quality" figure (`leadsThisWeek`/`relevantThisWeek`) is still shown on Home,
but it's a DERIVED read (reviews grouped by the calendar week of
`reviewed_at`), never a separate thing the customer enters.

### Migration forward, no data loss

Migration 027 backfills one `lead_quality_reviews` row per campaign that had
existing `lead_quality_feedback` history, summing everything ever reported as
the initial watermark — a customer who'd already answered the old weekly form
isn't re-asked about leads they already rated.

### Deliberately out of scope

The **operator's** manual lead-quality entry (`POST /admin/campaigns/:id/lead-quality`,
`services/billing.ts` `upsertLeadQuality`) and the admin console's per-week
table (`AdminCustomers.tsx`) are **unchanged** — still the old direct-overwrite
`lead_quality_feedback` model. That's a distinct, already-adequate mechanism
for the rare case of phone-reported data, and isn't what caused
double-counting (a single deliberate operator entry, not an unaware customer
accumulating state across sessions). The admin console's historical view does
not yet reflect the customer's own post-migration delta reviews — a
reasonable follow-up, not required by this fix.

## Recent activity

`condense(listCustomerActionHistory(...))`, newest first, capped at 8. Empty
until the safe-execute pipeline records real actions — the screen shows an honest
"nothing changed yet" line rather than sample events.
