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

## Design system
AdPilot palette (orange `#FF5A36`, cream `#F7F2EA`/`#EDE6DA`, ink `#171717`, green
`#2FA36B`, indigo `#665CFF`, WhatsApp `#DCF8C6`), Rubik + IBM Plex Mono, RTL Hebrew.
`ui.css` provides `.btn* .card .pill .kpi .stepper .field .appbar` etc. reused by
every screen; responsive at ≤860px (grids collapse, nav hides).

## What's NOT wired (backend, per ticket)
- **Auth** (AIC-21): ✅ **now wired** — email+password signup/login + JWT sessions,
  see [customer-auth.md](customer-auth.md). Forgot/reset still frontend-only. `WA`
  contact links are placeholders (`wa.me/972500000000`).
- **Onboarding/connect** (AIC-21): status + partner-access verification are mock.
- **Home** (AIC-22): ✅ **now wired** — KPIs/state/sidebar/activity + weekly
  lead-quality all render from `GET /api/app/overview`, see
  [customer-overview.md](customer-overview.md). The dev state-switcher is gone;
  the headline `homeState` is derived from real rows.
- **Recommendations** (AIC-23): wire to the explainer + safe-execute pipeline.
- **Settings** (AIC-24): ✅ **budget / Meta connection / billing / account now
  wired** from the overview endpoint. The budget-change request, "check
  connection", and change-password buttons are still stubs; the review screen is
  still mock.

## Open decision — checkout/payment
The design includes a **self-serve card checkout** (`/checkout`, ₪598 = setup +
first month). P0's billing decision (AIC-19) was **manual billing, no gateway**.
This divergence needs a call — tracked in its own ticket. The screen is built; no
payment integration is wired.
