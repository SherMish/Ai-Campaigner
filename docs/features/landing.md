# Landing page

**Status:** live - the static RTL marketing page for Ads Agent (AIC-146).

**Source of truth:** `landing/index.html` for structure, copy, styling and the
CSS-only hero rotation; `web/public/landing-reel-*.jpg` for the four fictional
local-service creatives. The web build copies the landing to
`web/dist/index.html`; see [scaffold.md](scaffold.md).

**Lock-in tests:** `server/src/landing-copy.test.ts` protects the positioning
boundary, hero removals, one-section pricing, evidence rules, required assets
and supported SEO terms. `server/src/app.static.test.ts` verifies that
the built landing is served at `/`.

---

## Positioning

The page sells the product that exists today:

> Meta advertising for Israeli small businesses, without living inside Ads
> Manager.

Ads Agent is presented as the operational layer above Meta, not as a general
marketing suite, a full-service creative agency or an autonomous performance
manager. The promise is deliberately limited to guided connection, one lead
campaign, WhatsApp/website destinations, operational-health monitoring, a
simple Hebrew dashboard, basic controls, lead-quality feedback and human
support. It explicitly refuses guarantees of more leads, lower CPL or growth.

## Page structure

A single fluid, responsive RTL page in the Ads Agent cream/ink/orange system:

1. **Hero:** `פרסום במטא. בלי לחיות בתוך Ads Manager.` plus the operational
   promise and a phone rotating between four fictional local businesses: nails,
   Pilates, dog grooming and a ceramics workshop. Each creative has its own
   relevant action copy. There are no recommendation, WhatsApp-message, result,
   platform, destination or price cards around the phone. The rotation is CSS
   only and stays on the first creative when reduced motion is requested.
2. **Proof strip and manifesto:** non-numeric service facts and the need for
   delivery/measurement certainty rather than another analytics dashboard.
3. **Value:** connection/setup, operational-health monitoring and a quiet,
   business-language surface.
4. **Process:** a factual three-step flow with no fabricated campaign numbers.
5. **Lead quality and creative boundary:** why a Meta lead is not necessarily a
   relevant enquiry, and what Ads Agent does and does not do with creative.
6. **Pricing:** the only visible price presentation, after the value story.
7. **Human support, FAQ and final fit-check CTA.**

## Evidence and search rules

- CSS result mockups and fabricated metrics are not used as product proof.
- Generated creatives contain no result claims, interface chrome, metrics or
  baked-in text. Business names, messages and action labels remain editable HTML.
- Customer dashboard screenshots are not published without explicit approval,
  even after cropping. A future approved screenshot must remove personal
  account information and state nearby that its figures are not a performance
  promise.
- Copy may describe what Ads Agent monitors; it may not imply that every failure
  is detectable.
- The monthly price appears in the dedicated section, not in the hero,
  comparison bands, FAQ or final CTA. The landing does not advertise a separate
  one-time setup fee.
- Title, description, H1 and body naturally cover `ניהול קמפיינים בפייסבוק`,
  `ניהול קמפיינים באינסטגרם`, `עסקים קטנים`, `קמפיין לידים`, Meta and Ads
  Manager. Canonical, Open Graph and `Service` JSON-LD are included.

## Contact path

Every acquisition CTA opens WhatsApp for the business number
`972526964069` in a new tab. Fit-check, joining and conversation links each
carry a short matching Hebrew message so the visitor does not start from an
empty chat. `כניסה` still points to `/login`; legal links remain internal.

## Legal pages (terms of use, privacy policy)
`web/public/terms.html` and `web/public/privacy.html` — self-contained static
pages in the same design system as the landing page, one level simpler (no
hero/nav, just a header→content→footer shell). Vite's `public/` copies them
to `dist/` root at build time, so `express.static` in `server/src/app.ts`
serves them directly at `/terms.html` / `/privacy.html` with no server route
needed — same mechanism as `favicon.png`.

Content is the real, lawyer-provided text (not placeholder copy), with the
product's legal-document name normalized to **Ads Agent** and the contact
address set to `hello@ads-agent.co.il`.

Linked from two places:
- The landing footer's `תקנון` / `פרטיות` links (previously `#` placeholders).
- The signup checkbox (`web/src/app/Auth.tsx`, `strings.he.app.auth.terms` —
  split into `pre/tos/mid/privacy/post` parts so "תנאי השירות" and "מדיניות
  הפרטיות" render as real links, opened in a new tab so an in-progress signup
  form isn't lost).

## Note — brand
The product's consumer-facing name is **Ads Agent** (renamed 2026-08-15 from
**Ads Manager**, itself decided 2026-08-12 resolving the earlier
AdPilot-vs-AI-Campaigner ambiguity — all three earlier names are retired).
The name lives in one place, `strings.he.appName` (`web/src/strings.ts`), and
every in-app surface (customer sidebar, admin sidebar, the pre-shell screens'
`Brand` component in `web/src/app/components.tsx`) reads it from there rather
than hardcoding it, so a future rename is a one-line change — the static
landing page and the two legal pages are the only surfaces that still
hardcode the wordmark, since they're plain HTML with no shared strings
module. The logo icon (`web/public/favicon.png`, full-res source
`logo-source.png`) renders beside the wordmark everywhere the brand appears.
The site favicon uses the same file.
