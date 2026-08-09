# Customer app (P0.5)

**Status:** every customer screen exists in the AdPilot design. **Auth (AIC-21),
Home (AIC-22), and Settings (AIC-24 data) are wired to the backend**; Home +
Settings render live from `GET /api/app/overview` (see
[customer-overview.md](customer-overview.md)). Onboarding/connect, the
recommendations flow (AIC-23), and the review screen are still mock. Remaining
mock screens keep their in-component state switchers; Home no longer has one.

**Source of truth:**
- Design system: `web/src/ui.css` (AdPilot tokens/components) + fonts in `web/index.html`
- Copy: `web/src/strings.ts` → `strings.he.app` (all screen copy centralized)
- Shared components: `web/src/app/components.tsx` (AppHeader, AuthLayout, Stepper, StatusPill, SupportCard, Field, Brand)
- Screens: `web/src/app/*` — `Auth.tsx`, `Checkout.tsx`, `Onboarding.tsx`, `Connect.tsx`, `Review.tsx`, `Home.tsx`, `Recommendations.tsx`, `Settings.tsx`
- Routing: `web/src/App.tsx`

**Lock-in tests:** none yet (frontend-only, mock data). Tests land with the backend
wiring per ticket.

---

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
`studentApp` chrome, restyled in AdPilot's palette — ink sidebar, orange accent):
`web/src/app/AppShell.tsx` (a React Router **layout route** rendering `<Outlet/>`) +
`web/src/app/Sidebar.tsx`. The sidebar has the AdPilot brand → nav sections
(ניהול: ראשי `/app`, המלצות `/app/recommendations` + pending-recs badge · עזרה:
עזרה והגדרות `/app/settings`) → spacer → a user card at the bottom (initials avatar +
real name/email from `getOverview`, gear → account menu with settings + logout).
Below 860px the sidebar becomes an off-canvas drawer opened by a floating menu
button on the right. Shell CSS is `.ap-*` classes in `ui.css`. The old top
`AppHeader` is retired from the app screens (onboarding/connect keep their own
minimal header). `lucide-react` provides the icons.

**Dashboard layout (AIC-41):** Home (`/app`) is a two-column **rail + main** grid
(`.dash*` in `ui.css`) — left rail = the campaign at-a-glance card; main = status
hero + KPI row + recommendation nudge + weekly feedback + activity. Tighter type +
lifted cards; collapses to one column ≤1024px. The per-audience / per-creative
(ad set / ad) drill-down is a separate ticket (AIC-37).

## Design system
AdPilot palette (orange `#FF5A36`, cream `#F7F2EA`/`#EDE6DA`, ink `#171717`, green
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
  business-portfolio-ID copybox is still a placeholder config value (AIC-33).
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
