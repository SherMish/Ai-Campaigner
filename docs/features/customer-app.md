# Customer app (P0.5)

**Status:** every customer screen exists in the Ads Agent design and is wired to
the backend — **Auth (AIC-21), Home (AIC-22), Settings (AIC-24), Onboarding +
Connect (AIC-21), and the recommendations flow (AIC-23, approve/dismiss
through the real safe-execute pipeline)**. Home + Settings render live from
`GET /api/app/overview` (see [customer-overview.md](customer-overview.md)).
The **review screen alone stays mock** (AIC-32, backlog — its design shows
specific proposal-cards that don't yet match the `campaign_reviews` schema).
No screen keeps an in-component mock-state switcher anymore except Review.

**Source of truth:**
- Design system: `web/src/ui.css` (Ads Agent tokens/components) + fonts in `web/index.html`
- Copy: `web/src/strings.ts` → `strings.he.app` (all screen copy centralized)
- Shared components: `web/src/app/components.tsx` (AppHeader, AuthLayout, Stepper, StatusPill, SupportCard, Field, Brand)
- Screens: `web/src/app/*` — `Auth.tsx`, `Checkout.tsx`, `Onboarding.tsx`, `Connect.tsx`, `Review.tsx`, `Home.tsx`, `Recommendations.tsx`, `Settings.tsx`
- Routing: `web/src/App.tsx`

**Lock-in tests:** none yet (frontend-only, mock data). Tests land with the backend
wiring per ticket.

---


## The ad list shows ads that EXIST, not only ads that have data (2026-08-22)

Found live: a customer added an ad from an existing post, got a success
confirmation, and the dashboard still listed only their old ads. Nothing had
failed — the ad was on Meta within seconds.

The per-ad list is built from `insight_snapshots`, i.e. ads with **measured
data**. A brand-new ad has none: no impressions, no spend, no row. So the list
was showing *"ads that have data"* while the customer read it as *"my ads"*.

Two states make this permanent rather than a delay:

- **`PENDING_REVIEW`** — every new ad sits here for its first hours. This value
  appeared **nowhere** in the codebase before this fix.
- **`DISAPPROVED`** — a rejected ad *never* gains insight data, so waiting would
  never have helped. It would have stayed invisible forever, indistinguishable
  from "the create silently failed", when in fact Meta refused the content and
  can say why.

**How it works now.** `ad_meta` (migration 041) caches per-ad
`effective_status`, upserted with the same prune discipline as `ad_set_meta`
(AIC-65 — without the prune a deleted ad stays listed forever).
`campaign-audiences` merges in cached ads that have no insight row. The gate is
the **data, not the status**: an ad with no rows in any period has never been
measured, so nothing else in the view will ever mention it. An ad with rows in
another period is a different, already-handled case — `moreCreativesCount`
covers it, and merging both would double-count.

(That gate was originally the ad's *status* — only `PENDING_REVIEW`/
`DISAPPROVED`, via a `hasNoDataYet` helper since deleted. AIC-116 found the hole
it left: the commonest case of all is an **`ACTIVE` ad created minutes ago**
that Meta hasn't reported on yet, and it was excluded. See the section below.)

`hasData: false` is carried separately from the zeroes on purpose: rendering
"₪0 · 0 leads" for a brand-new ad would be a claim of zero **results** for
something that has not had the chance to produce any. The UI shows the state
and its explanation instead.

**Refreshed in-request after an add**, not just on the tick — the same shape
AIC-71 applied to pause/resume and the launch flow, for the same reason: the
dashboard must not contradict what we just told the customer. Waiting for the
hourly tick would have left the original bug in place for up to an hour.

## The ad list needs an ad SET to hang ads on (AIC-116, 2026-08-23)

The 2026-08-22 fix above merges a data-less ad into an ad set **that has data**.
Every test for it seeded exactly such an ad set, which is why the remaining hole
survived a full green suite.

A campaign built minutes ago has no ad set with data either — Meta has not
reported a single insight row. The audience list was itself built from insight
rows, so there was no row to merge into and the whole panel collapsed to "no
data yet". A real customer built a campaign, watched it go live, and opened a
dashboard reading `מודעות —` and *"עדיין אין מספיק נתונים לפירוט לפי קהל"*.

The panel is now built from the ad sets we manage (the `ad_set_meta` cache) with
performance attached where it exists — see
[customer-overview.md](customer-overview.md)'s audience-details section for the
exact inclusion rules. Two separate causes had to be fixed for the customer to
see anything at all; the other one was the campaign's own `status` never leaving
`under_review`, in [campaign-builder.md](campaign-builder.md).

## The connection panel shows the ad account id when it has no name (AIC-116)

`ad_accounts.name` is `NOT NULL` with a `''` default, and the admin wizard never
sent one — `provisionConnection` has accepted `adAccountName` all along, but no
caller in `web/` passed it. So every wizard-provisioned account stored an empty
name, and `Connect.tsx`/`Settings.tsx` rendered `name || "—"`: a dash, directly
above a technical line printing the very id we were pretending not to have.

Both now use `adAccountLabel()` (`web/src/api.ts`), which falls back to the
`act_…` id — the thing that identifies the account to a customer on the phone
with Meta support anyway. The wizard also sends `adAccountName` and `currency`
from the picker (which already had both) for accounts provisioned from now on;
an id typed by hand still sends null and takes the column defaults, as before.

## Routes & screens

| Route | Screen | Ticket | States implemented |
| --- | --- | --- | --- |
| `/signup` `/login` `/forgot` `/reset` | Auth (email+password) | AIC-21 | forgot→sent, reset→done |
| `/checkout` | Join + payment | AIC-21 / *see note* | — |
| `/onboarding` | Onboarding status + stepper | AIC-21 | 6 states A–F (`?s=`) |
| `/connect` | Connect Meta (partner access) | AIC-21 | checking / connected / missing-access / not-verified |
| `/review` | First-campaign review (customer approve) | AIC-24 | proposals → confirmed |
| `/app` | Home dashboard | AIC-22 | ok / rec / collecting / paused / attention + weekly feedback + activity |
| `/app/recommendations` | Recommendations list + history | AIC-23 | waiting / history |
| `/app/recommendations/:id` | Recommendation detail | AIC-23 | pause / increase / replace × idle→approved→executed / dismissed |
| `/app/settings` | Settings & support | AIC-24 | budget, Meta connection, billing, account, support |

Design fidelity verified (login, home, onboarding rendered against the comps). The
marketing landing stays the static `landing/` page at `/`; this SPA owns everything
else (single-origin).

## App shell (AIC-40)

The signed-in app (`/app*`) is wrapped by a **right-side sidebar shell** (Pisga-style
`studentApp` chrome, restyled in the Ads Agent palette — ink sidebar, orange
accent): `web/src/app/AppShell.tsx` (a React Router **layout route** rendering
`<Outlet/>`) + `web/src/app/Sidebar.tsx`. The sidebar has the Ads Agent brand
(logo icon + wordmark) → nav sections
(ניהול: ראשי `/app`, המלצות `/app/recommendations` + pending-recs badge · עזרה:
עזרה והגדרות `/app/settings`) → spacer → a user card at the bottom (initials avatar +
real name/email from `getOverview`, gear → account menu with settings + logout).
Below 860px the sidebar becomes an off-canvas drawer opened by a floating menu
button on the right. Shell CSS is `.ap-*` classes in `ui.css`. The old top
`AppHeader` is retired from the app screens (onboarding/connect keep their own
minimal header). `lucide-react` provides the icons.

**Horizontal padding against the sidebar is owned by `.wrap` alone
(AIC-120).** `.ap-content` (the shell's own content slot) deliberately has
none — every routed page supplies its own via `className="wrap page"` (or
`"wrap page dash"` on a dashboard-shaped page). Found live, reported as "no
gap between content and the sidebar" on an admin screen: `.page`/`.dash` exist
only for VERTICAL rhythm, but both declared it with the `padding` shorthand
(`padding: 40px 0 90px`), which sets all four sides — so their `0` for
left/right silently overrode `.wrap`'s `padding: 0 24px` at equal specificity,
by source order. This was true of **every** page that combines the classes,
not one screen: the entire customer app (`Home`, `Builder`, `AddContent`,
`Settings`, `Recommendations`, `Connect`, `Checkout`, `Onboarding`, `Review`)
and the entire admin console. It read as fine almost everywhere because most
content sits inside a `.card`, whose own padding/border/shadow reads as a gap
even with none from the page itself — it took a full-bleed colored box (a
warning banner) touching the sidebar directly to make it visible. Fixed by
switching `.page`/`.dash` to `padding-block`, which only ever touches
top/bottom and can't collide with `.wrap`'s horizontal value again.

**Dashboard layout (AIC-41):** Home (`/app`) is a two-column **rail + main** grid
(`.dash*` in `ui.css`) — left rail = the campaign at-a-glance card; main = status
hero + KPI row + recommendation nudge + weekly feedback + activity. Tighter type +
lifted cards; collapses to one column ≤1024px. The active-creative count on the
rail is **de-duplicated by creative name** — the same design running under two
audiences is one "creative" to a non-technical owner, even though it's two Meta
ad objects.

**Opt-in audience details (AIC-37):** below the KPIs, a collapsed **"הצג פירוט"**
expander — closed by default, never the landing view — reveals the campaign's
**per-audience** breakdown (each ad set named by its human dimension: age, gender,
or geo — never "ad set N" or a raw Meta name, via
[`deriveAudienceLabels`](../../server/src/meta/audience-label.ts)), each
expandable to its own **per-creative** rows (spend/leads/CPL only — no raw
ad-jargon metrics). Fetched lazily on open (`GET /api/app/audiences`,
`server/src/services/campaign-audiences.ts`), ownership-scoped, reading only
cached data (`insight_snapshots` + `ad_set_meta`) — no live Meta call at render.
The audience label is the same one the engine's audience rule uses in its
customer-facing explanation (`RULES.md`). The ops console keeps its own full
internal per-audience view regardless of this toggle (AIC-45).

*Not built in this pass:* instrumenting the details-toggle open-rate as a product
signal (AIC-37's AC) — deferred until the AIC-28 metrics layer exists; there's no
event sink to write to yet.

**Design-system roll-out + polish (AIC-42):** Recommendations (list + detail) and
Settings now share the dashboard's tighter type + lifted cards
(`.dash`/`.dash-title` applied alongside their existing `.wrap.page`) instead of
the earlier looser sizing — one visual system across every `/app*` screen.

- **Shared overview fetch** (`web/src/app/overview-store.ts`): the sidebar, Home,
  and Settings all read `GET /api/app/overview` through one `useSyncExternalStore`
  cache instead of each firing their own request — confirmed one fetch per page
  load (was up to 3).
- **A11y pass**: the sidebar's account menu is keyboard-operable (opens with focus
  on the first item, ↑/↓ cycle items, Escape closes and returns focus to the
  gear); the mobile drawer closes on Escape; the active nav item gets
  `aria-current="page"` (built into React Router's `NavLink`); visible
  `:focus-visible` rings added for nav items, the account-menu gear, the mobile
  FAB, and account-menu entries.

## Design system
Ads Agent palette (orange `#FF5A36`, cream `#F7F2EA`/`#EDE6DA`, ink `#171717`, green
`#2FA36B`, indigo `#665CFF`, WhatsApp `#DCF8C6`), Rubik + IBM Plex Mono, RTL Hebrew.
`ui.css` provides `.btn* .card .pill .kpi .stepper .field .appbar` etc. reused by
every screen; responsive at ≤860px (grids collapse, nav hides).

## What's NOT wired (backend, per ticket)
- **Auth** (AIC-21): ✅ **now wired** — email+password signup/login + JWT sessions,
  see [customer-auth.md](customer-auth.md). Forgot/reset still frontend-only. `WA`
  contact links are placeholders (`wa.me/972500000000`).
- **Onboarding/connect** (AIC-21): ✅ **now wired** — Onboarding renders the real
  `onboarding_status` (call_scheduled/meta_connection_required/campaign_under_review/ready
  → the matching card + stepper) with the real name; Connect shows the real
  connection state and "check connection" calls `POST /api/app/connection/recheck`
  (live per-asset verify when a Meta token is set, else the stored health). The
  business-portfolio-ID copybox now shows the real value (AIC-33 closed, bug fix
  2026-08-15) — `META_BUSINESS_PORTFOLIO_ID` (`web/src/strings.ts`, the same
  `2491237118040524` recorded in [META_SETUP.md](../META_SETUP.md)'s identifiers
  table), not `strings.he.app.mock.businessId`. Found live: the copybox's copy
  button worked and looked fully real, so this had shipped a fake, unusable ID
  ("418 552 907 431") to every real customer reaching the connect step — the
  fix steps for the additions flow's `missing_page` state
  ([campaign-builder.md](campaign-builder.md#add-to-an-existing-campaign-aic-63))
  reuse the same constant and copybox pattern, so there's one real ID, not two
  that could drift.
- **Home** (AIC-22): ✅ **now wired** — KPIs/state/sidebar/activity + weekly
  lead-quality all render from `GET /api/app/overview`, see
  [customer-overview.md](customer-overview.md). The dev state-switcher is gone;
  the headline `homeState` is derived from real rows.
- **Recommendations** (AIC-23): ✅ **now wired** — list + detail read
  `GET /api/app/recommendations`; approve routes through the safe-execute
  pipeline, dismiss transitions the rec. See
  [customer-recommendations.md](customer-recommendations.md). The dev type-switcher
  is gone.
- **Settings** (AIC-24): ✅ **now wired** — budget / Meta connection / billing /
  account read from the overview; the **budget-change request** posts
  `POST /api/app/budget-request` (raises an ops item), **check connection** calls
  the recheck endpoint, and **change password** posts `POST /api/auth/change-password`
  (see [customer-auth.md](customer-auth.md)). The **campaign-review screen** is
  still mock — its schema mismatch with the design is tracked in AIC-32.

## Open decision — checkout/payment
The design includes a **self-serve card checkout** (`/checkout`, ₪598 = setup +
first month). P0's billing decision (AIC-19) was **manual billing, no gateway**.
This divergence needs a call — tracked in its own ticket. The screen is built; no
payment integration is wired.
