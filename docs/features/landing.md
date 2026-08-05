# Landing page

**Status:** live — the static marketing page (AIC-20), implementing the **AdPilot**
design directions (RTL Hebrew, cream/ink/orange).

**Source of truth:** `landing/index.html` (self-contained static HTML/CSS). Served
at `/` by the server (`web/dist/index.html` after build) and by the Vite dev
plugin; see [scaffold.md](scaffold.md).

**Lock-in tests:** none (static). The build copies it into `web/dist/index.html`
(`server/src/app.ts` serves it single-origin); `app.static.test.ts` covers that the
server serves the landing at `/`.

---

## How it works today

A single fluid, responsive RTL page in the AdPilot brand:
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
- Footer `תקנון` / `פרטיות` link to `#` until those pages exist.

## Note — brand
The design brands the product **AdPilot**; the app code/strings still say "AI
Campaigner". Aligning the two (rename, or keep AdPilot as the consumer brand over
the AI Campaigner codename) is an open product decision.
