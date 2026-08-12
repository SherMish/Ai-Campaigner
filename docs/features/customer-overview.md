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
surfacing + clearing).

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
| `attention` | connection `access_health` ≠ `ok`, or campaign `needs_attention`/`connection_problem` |
| `paused` | campaign `status = paused` |
| `collecting` | campaign active but no snapshot data (no spend, no leads, no creatives) |
| `ok` | active with data |

The client maps each state to hero copy in `strings.he.app.home.states`; only
states with a real destination carry a CTA (`attention` → `/connect`,
`no_campaign` → `/onboarding`). `attention` carries a second signal,
`attentionKind: 'connection' | 'delivery' | null` (AIC-39) — a lost Meta
connection and a not-delivering ad set are different problems with different
copy (`h.states.attention` vs `h.states.delivery`); a delivery problem shows
no CTA (there's nothing for the customer to click — we're already on it).

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

## Opt-in audience details (AIC-37)

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

## KPIs, deltas, sidebar

CPL / leads / spend come from `readout.current`; the signed period-over-period
deltas from `readout.delta` (null when there's no prior period — shown as no
comparison, never a fake +100%). The sidebar shows the campaign name, agreed
budget + period, active-creative count, and total leads. When collecting, values
honestly render `—` / `0`, not placeholder numbers.

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
