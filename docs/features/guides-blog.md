# Guides (the blog) — `/guides`

**Status:** live. Static HTML generated at build time from Markdown. Six guides
ship; adding more is a Markdown file and, when needed, a tracked public image.

**Source of truth:**
`content/guides/*.md` (article content and metadata),
`web/public/<guide-image>.png` (tracked 1200x630 title images),
`scripts/build-guides.mjs` (the generator),
`scripts/guides-lib.mjs` (its pure helpers),
`scripts/guides.css` (the standalone stylesheet),
`server/src/app.ts` (the `/guides` route + `extensions: ["html"]`),
`landing/index.html` (the nav + footer links in).

**Lock-in tests:**
`web/src/guides/guides-lib.test.ts` (escaping, slugs, TOC ids/dedupe, validation,
SEO warnings),
`server/src/guide-content.test.ts` (AIC-147/AIC-153 source quality,
primary-source links, short-hyphen rule and exact title-image dimensions),
`server/src/routes/guides-static.integration.test.ts` (the URLs serve real HTML
and **not** the SPA shell; sitemap/robots; SPA routes still work).

---

## Why static HTML and not React

`server/src/app.ts` serves the SPA shell (`app.html`) for every non-API route. A
React blog would therefore hand every crawler an empty document with the SPA's
generic `<title>`, no description, no Open Graph and no article text until JS
runs. Google can render JS — slower and less reliably — and social and LLM
crawlers frequently do not.

For a surface whose entire purpose is organic search, the content has to **be**
in the HTML. So each guide is a real file, with its own `<title>`, meta
description, canonical, OG/Twitter tags and JSON-LD, served by `express.static`
with no bundle and no JS at all. This is the same pattern `landing/index.html`,
`privacy.html` and `terms.html` already use.

## How it builds

`npm run --workspace web build` runs the generator **before** Vite, writing to
`web/public/`, which Vite then copies verbatim into `web/dist/`:

| Output | URL |
| --- | --- |
| `web/public/guides/index.html` | `/guides` |
| `web/public/guides/<slug>.html` | `/guides/<slug>` |
| `web/public/guides/guides.css` | `/guides/guides.css` |
| `web/public/sitemap.xml` | `/sitemap.xml` |
| `web/public/robots.txt` | `/robots.txt` |

All of it is **gitignored** — the Markdown is the source; these are build output
and would otherwise be spurious diffs on every build.

### The two routing details, both of which cost real crawl traffic when wrong

1. **`extensions: ["html"]`** on `express.static` is what makes
   `/guides/<slug>` serve `guides/<slug>.html`. Without it the request falls
   through to the SPA catch-all and a crawler gets the app shell. It only
   matches files that exist, so `/login` and `/admin/*` are unaffected.
2. **`GET /guides` is an explicit route**, registered before the static
   middleware. serve-static resolves `/guides` against the `guides/`
   **directory** and never reaches the `extensions` fallback — with
   `redirect: true` it 301s to `/guides/` (so the canonical URL is never the URL
   served), and with `redirect: false` it falls through to the SPA. Both were
   observed during this change; the explicit route is the only form that serves
   the index at its canonical URL with no redirect hop. It mirrors the existing
   handler for the landing at `/`.

Run it alone with `npm run --workspace web build:guides`.

## Current guide set

| Guide | Search job |
| --- | --- |
| `מדריך-תקציב-פייסבוק.md` | Decide a test budget from unit economics rather than a universal formula |
| `הקמת-קמפיין-לידים-במטא.md` | Set up a WhatsApp or website lead campaign without skipping destination and measurement |
| `קמפיין-פעיל-אין-פניות.md` | Diagnose delivery, lead routing and measurement before changing audiences or creatives |
| `פיקסל-פייסבוק-בדיקה.md` | Verify that the correct website conversion event fires once at the correct moment |
| `מעורבות-או-לידים-לוואטסאפ.md` | Choose by conversion location and performance goal instead of trusting the campaign objective label |
| `מודעות-של-מתחרים-בפייסבוק-ובאינסטגרם.md` | Research active competitor ads without treating visibility, age or repetition as proof of performance |

The two troubleshooting guides form one journey and cross-link directly:
campaign symptoms first, then the deeper Pixel/event check when the campaign
uses a website destination. Both point back to the setup guide rather than
repeating the full build tutorial.

The campaign-type guide is linked contextually from the signed-in dashboard for
messaging and post-engagement campaigns. It explains why an Engagement campaign
can still open WhatsApp, Instagram Direct or Messenger, while keeping post
engagement and customer conversations as separate outcomes.

The competitor-research guide teaches the public Meta Ad Library workflow and
keeps its evidence boundary explicit: visible creative, offer, CTA, platform and
start date are observable; spend, leads, targeting, profit and the winning
variant are not. It cross-links with the campaign setup guide so research ends
in an original test brief rather than copied creative.

## What a guide needs — the authoring spec

One Markdown file in `content/guides/`. Frontmatter, then the body.

### Required — the build FAILS without these

A guide missing any of them would silently ship an empty meta tag or an
unsortable date, which is worse than a red build.

| Field | Rules | Why it matters |
| --- | --- | --- |
| `title` | the H1 and the card title | the primary ranking signal |
| `description` | **70–160 chars** | becomes `<meta name="description">`, the OG/Twitter description and the card excerpt — this is the text in the search result |
| `date` | **`YYYY-MM-DD`**, quoted | sort order, `datePublished`, sitemap `lastmod` |
| `category` | short Hebrew label (e.g. `תקציב`) | the eyebrow on the card and article |
| `author` | display name | `Person` in the Article schema |

### Optional

| Field | Default | Use it when |
| --- | --- | --- |
| `seoTitle` | `<title>` falls back to `title \| Ads Agent` | the display H1 runs past ~60 chars — set a shorter `<title>` without shortening the headline |
| `slug` | derived from `title` | you want a shorter URL, or you renamed the title and must keep the old URL (**changing a live slug breaks its ranking — set `slug` to the old value instead**) |
| `updated` | `date` | a substantive revision; drives `dateModified` and sitemap `lastmod` |
| `authorRole` | — | shown under the name; `jobTitle` in the schema |
| `image` / `imageAlt` | site logo | a hero image; **1200×630** for link previews. `imageAlt` is real alt text, not the title again |
| `keywords` | — | a list; becomes `keywords` in the Article schema |
| `faq` | — | a list of `{q, a}` — see below |
| `ctaTitle` / `ctaText` | generic | tailor the closing CTA to the guide's topic |

### The FAQ is the highest-leverage optional field

`faq` emits **FAQPage** structured data, which is what earns the expandable
Q&A block under a Google result — more vertical space and more clicks for the
same position. It also renders as `<details>` on the page, so the answers are in
the DOM (a crawler reading the schema finds matching visible text, which is what
Google requires).

Emitted **only** when the post actually has questions. An empty or invented FAQ
is the kind of structured-data lie that gets a site penalised.

### The body

Plain Markdown. `##` and `###` headings become the sticky quick-jump sidebar
automatically — the ids are stamped on the **rendered** headings and read back
out of the same HTML, so a sidebar link can never point at an id the body
doesn't have. Repeated headings are deduped (`סיכום`, `סיכום-2`), because a
duplicate id silently sends the second link to the first section.

Use one `#`-level idea per `##`. Don't write an H1 in the body — `title` is the
page's only H1, and a second one muddies the hierarchy.

### Full example

```yaml
---
title: "כמה כסף להשקיע בפרסום בפייסבוק? מדריך תקציב לעסק קטן"
seoTitle: "כמה להשקיע בפרסום בפייסבוק — מדריך תקציב 2026"
description: "כמה תקציב יומי צריך קמפיין פייסבוק בישראל כדי לייצר לידים…"
date: "2026-08-24"
category: "תקציב"
author: "צוות Ads Agent"
authorRole: "ניהול קמפיינים לעסקים קטנים"
keywords: ["תקציב פרסום בפייסבוק", "עלות לליד"]
faq:
  - q: "מה התקציב היומי המינימלי?"
    a: "פי 3–5 מהעלות שאתם מוכנים לשלם על ליד."
---
```

## SEO shipped per page

Content in the HTML with zero JS · unique `<title>` + description · `canonical`
· OG + Twitter `summary_large_image` · `lang="he" dir="rtl"` + `og:locale=he_IL`
· JSON-LD `BlogPosting` + `BreadcrumbList` (+ `FAQPage` when present) · visible
breadcrumbs built from the same array as the schema, so they cannot drift ·
semantic `<article>`, one H1, `<time datetime>` · internal links (homepage nav +
footer → index → article → related → back) · `sitemap.xml` and `robots.txt`
generated from the same post list that built the pages, so a published guide
cannot be missing from the sitemap.

**Length limits are warnings, never build failures.** A good title three
characters over is better than a bad one that fits, so the generator prints the
count and lets the author decide.

## Known gaps

- **`SITE_ORIGIN` defaults to `https://ads-agent.co.il`.** Canonical and OG URLs
  are absolute, so if the domain changes this must be set in the build
  environment or every canonical points at the old host.
- **The Vite dev server (5173) does not serve `/guides`** — the extensionless
  routing lives in Express. Use the server on :4000, which is what production
  runs.
- **No pagination.** The index lists every guide. Fine to roughly 50; past that
  it needs paging or the page gets heavy.
- **No per-guide OG images.** Without `image` a guide shares the site logo in
  link previews, which is weaker social CTR than a real image.
