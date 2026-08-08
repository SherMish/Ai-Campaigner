# Customer app (P0.5)

**Status:** frontend built on **mock data** — every customer screen exists and
renders in the AdPilot design; **no backend wiring yet** (auth, sessions, live
data). Backend lands per ticket (AIC-21–24). Screens are demoable end-to-end via
in-component state; dev-only state switchers preview each design state.

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
- **Home** (AIC-22): KPIs/state/feedback/activity are mock — wire to
  `buildCampaignReadout` + lead-quality + campaign status.
- **Recommendations** (AIC-23): wire to the explainer + safe-execute pipeline.
- **Settings/review** (AIC-24): budget-change request, billing display, review
  decision wiring.

## Open decision — checkout/payment
The design includes a **self-serve card checkout** (`/checkout`, ₪598 = setup +
first month). P0's billing decision (AIC-19) was **manual billing, no gateway**.
This divergence needs a call — tracked in its own ticket. The screen is built; no
payment integration is wired.
