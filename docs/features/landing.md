# Landing page

**Status:** live — the static marketing page (AIC-20), implementing the **Ads
Agent** design directions (RTL Hebrew, cream/ink/orange).

**Source of truth:** `landing/index.html` (self-contained static HTML/CSS). Served
at `/` by the server (`web/dist/index.html` after build) and by the Vite dev
plugin; see [scaffold.md](scaffold.md).

**Lock-in tests:** none (static). The build copies it into `web/dist/index.html`
(`server/src/app.ts` serves it single-origin); `app.static.test.ts` covers that the
server serves the landing at `/`.

---

## How it works today

A single fluid, responsive RTL page in the Ads Agent brand:
- **Palette:** orange `#FF5A36`, cream `#F7F2EA`/`#EDE6DA`, ink `#171717`, green
  `#2FA36B`, indigo `#665CFF`, WhatsApp `#DCF8C6`. Fonts: **Rubik** + **IBM Plex
  Mono** (Google Fonts).
- **Sections:** sticky header · hero (headline + phone/collage + price) · dark
  ₪299-vs-₪1,200 comparison · "you don't need to learn to run campaigns" band ·
  how-it-works (01/02/03) · "no Ads Manager" dashboard mock · creative comparison ·
  weekly lead-quality · human support + approval guarantee · pricing (₪299 + fit
  list) · FAQ (native `<details>` accordion, 8 Qs) · final CTA · footer.
- **Responsive:** grids collapse to one column ≤900px; nav links hide on mobile;
  `overflow-x: hidden` guards the hero collage's negative insets. Verified: no
  horizontal overflow at 375px or desktop.
- **Mockups** (phone, dashboard, cards) are pure CSS — no external images. Real
  creative photos can drop into the hero creative slot later.

## Placeholders to fill before go-live
- Contact CTAs (`דברו איתנו`, WhatsApp, `קבעו שיחה`) point to
  `https://wa.me/972500000000` and `#contact` — replace with the real WhatsApp
  number + booking link.
- `כניסה` → `/login` (the SPA login lands with AIC-21).

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
