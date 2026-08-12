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

## KPIs, deltas, sidebar

CPL / leads / spend come from `readout.current`; the signed period-over-period
deltas from `readout.delta` (null when there's no prior period — shown as no
comparison, never a fake +100%). The sidebar shows the campaign name, budget +
period, active-creative count, and total leads. When collecting, values
honestly render `—` / `0`, not placeholder numbers.

**Budget shown = `liveBudgetAgorot ?? agreedBudgetAgorot`** (real bug fixed
2026-08-12): `agreedBudgetAgorot` is the engine's own safety ceiling
([safe-execution.md](safe-execution.md#budget-safety-aic-13)), not necessarily
what's live on Meta right now — a customer changing the budget directly on Meta
used to leave the dashboard silently stale. `liveBudgetAgorot` is cached fresh
every generation tick and is what's actually shown once the engine has ticked at
least once for this campaign; the ceiling is only the fallback before that.

## Weekly lead-quality feedback

`POST /api/app/lead-quality { leadsReported, relevantCount }` upserts one
`lead_quality_feedback` row for the current week (Monday-keyed), scoped to the
caller's campaign. `relevantCount > leadsReported` → 400. On Home, `leadsReported`
is this week's real lead count from the readout; the customer reports how many
were relevant. Zero leads → the "no leads yet" copy instead of the form.

## Recent activity

`condense(listCustomerActionHistory(...))`, newest first, capped at 8. Empty
until the safe-execute pipeline records real actions — the screen shows an honest
"nothing changed yet" line rather than sample events.
