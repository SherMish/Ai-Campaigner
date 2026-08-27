#!/usr/bin/env node
// Static generator for /guides — the blog (AIC-126).
//
// WHY STATIC AND NOT REACT. server/src/app.ts serves the SPA shell (app.html)
// for every non-API route. A React blog would therefore serve crawlers an empty
// document with the SPA's generic <title> and no description, no Open Graph and
// no article text until JS executes. Google can render JS, but slower and less
// reliably, and social/LLM crawlers frequently do not. For a surface whose
// entire job is organic search, the content has to BE in the HTML. This mirrors
// how landing/index.html, privacy.html and terms.html already work.
//
// Output goes to web/public/guides/, which Vite copies verbatim into
// web/dist/ — so the same files serve in dev (Vite's public dir) and in prod
// (express.static), with no route handler and no bundle.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import matter from "gray-matter";
import {
  escapeHtml, escapeJsonLd, slugify, extractToc,
  readingMinutes, seoWarnings, validatePost,
} from "./guides-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONTENT = path.join(ROOT, "content/guides");
const OUT = path.join(ROOT, "web/public/guides");
const PUBLIC = path.join(ROOT, "web/public");

const SITE = process.env.SITE_ORIGIN || "https://ads-agent.co.il";
const BRAND = "Ads Agent";
const SECTION_TITLE = "מדריכים";
const SECTION_DESC =
  "מדריכים מעשיים לפרסום בפייסבוק ובאינסטגרם לעסקים קטנים — תקציב, קהלים, קריאייטיב ומדידה. בלי ז'רגון, עם החלטות שאפשר ליישם היום.";

// ── shared chrome ────────────────────────────────────────────────────────────
// One <head> builder for both page types, so a tag can never be present on the
// article and missing on the index (the usual way OG tags rot).
function head({ title, description, canonical, ogType, image, jsonLd, publishedAt, modifiedAt }) {
  const img = image ? (image.startsWith("http") ? image : SITE + image) : `${SITE}/logo-source.png`;
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<link rel="canonical" href="${escapeHtml(canonical)}" />
<link rel="icon" type="image/png" href="/favicon.png" />
<meta property="og:type" content="${ogType}" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:url" content="${escapeHtml(canonical)}" />
<meta property="og:image" content="${escapeHtml(img)}" />
<meta property="og:site_name" content="${escapeHtml(BRAND)}" />
<meta property="og:locale" content="he_IL" />
${publishedAt ? `<meta property="article:published_time" content="${publishedAt}" />` : ""}
${modifiedAt ? `<meta property="article:modified_time" content="${modifiedAt}" />` : ""}
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
<meta name="twitter:image" content="${escapeHtml(img)}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700;800;900&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/guides/guides.css" />
<script type="application/ld+json">${escapeJsonLd(jsonLd)}</script>
</head>
<body>
<header class="g-top">
  <a class="g-brand" href="/">${escapeHtml(BRAND)}</a>
  <nav class="g-nav"><a href="/guides">${escapeHtml(SECTION_TITLE)}</a><a class="g-cta" href="/signup">התחלה</a></nav>
</header>`;
}

const footer = `<footer class="g-foot">
  <a href="/">${escapeHtml(BRAND)}</a> · <a href="/guides">${escapeHtml(SECTION_TITLE)}</a> ·
  <a href="/terms.html">תנאי שימוש</a> · <a href="/privacy.html">פרטיות</a>
</footer>
</body></html>`;

// Breadcrumbs are rendered AND emitted as JSON-LD from the same array, so the
// visible trail and the structured data cannot drift apart.
function crumbsHtml(items) {
  return `<nav class="g-crumbs" aria-label="פירורי לחם">${items
    .map((c, i) =>
      i === items.length - 1
        ? `<span aria-current="page">${escapeHtml(c.name)}</span>`
        : `<a href="${escapeHtml(c.url)}">${escapeHtml(c.name)}</a><span class="sep">›</span>`,
    )
    .join("")}</nav>`;
}

function crumbsJsonLd(items) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((c, i) => ({
      "@type": "ListItem", position: i + 1, name: c.name,
      ...(c.url ? { item: SITE + c.url } : {}),
    })),
  };
}

const heDate = (iso) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" });

// ── read + parse ─────────────────────────────────────────────────────────────
function readPosts() {
  if (!fs.existsSync(CONTENT)) return [];
  return fs
    .readdirSync(CONTENT)
    .filter((f) => f.endsWith(".md"))
    .map((file) => {
      const raw = fs.readFileSync(path.join(CONTENT, file), "utf8");
      const { data, content } = matter(raw);
      validatePost(data, file);
      const slug = data.slug || slugify(data.title);
      const rendered = marked.parse(content, { mangle: false, headerIds: false });
      const { html, toc } = extractToc(rendered);
      return {
        ...data,
        file, slug, toc, html,
        readingMinutes: readingMinutes(content),
        url: `/guides/${slug}`,
        warnings: seoWarnings(data),
      };
    })
    // Newest first — the index's order and the sitemap's both derive from this
    // one sort, so they can't disagree.
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

// ── article page ─────────────────────────────────────────────────────────────
function renderArticle(post, all) {
  const canonical = SITE + post.url;
  const crumbs = [
    { name: "בית", url: "/" },
    { name: SECTION_TITLE, url: "/guides" },
    { name: post.title, url: post.url },
  ];

  const graph = [
    {
      "@type": "BlogPosting",
      headline: post.seoTitle || post.title,
      description: post.description,
      datePublished: post.date,
      dateModified: post.updated || post.date,
      inLanguage: "he-IL",
      mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
      author: { "@type": "Person", name: post.author, ...(post.authorRole ? { jobTitle: post.authorRole } : {}) },
      publisher: { "@type": "Organization", name: BRAND, logo: { "@type": "ImageObject", url: `${SITE}/logo-source.png` } },
      ...(post.image ? { image: SITE + post.image } : {}),
      ...(post.keywords ? { keywords: [].concat(post.keywords).join(", ") } : {}),
    },
    crumbsJsonLd(crumbs),
  ];
  // FAQPage is what earns the expandable rich result in Google. Emitted only
  // when the post actually has questions — claiming an empty FAQ is exactly the
  // kind of structured-data lie that gets a site penalised.
  if (Array.isArray(post.faq) && post.faq.length) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: post.faq.map((f) => ({
        "@type": "Question", name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    });
  }

  // The FAQ is appended to the body AFTER extractToc has run, so it would
  // otherwise be the one section with a heading id and no sidebar link — the
  // reader can reach every section but that one. Added explicitly.
  const hasFaq = Array.isArray(post.faq) && post.faq.length > 0;
  const tocEntries = hasFaq
    ? [...post.toc, { level: 2, text: "שאלות נפוצות", id: "faq" }]
    : post.toc;
  const toc = tocEntries.length
    ? `<aside class="g-toc"><div class="g-toc-title">בעמוד הזה</div><nav>${tocEntries
        .map((t) => `<a class="lvl${t.level}" href="#${escapeHtml(t.id)}">${escapeHtml(t.text)}</a>`)
        .join("")}</nav></aside>`
    : "";

  const faq = hasFaq
    ? `<section class="g-faq"><h2 id="faq">שאלות נפוצות</h2>${post.faq
        .map((f) => `<details><summary>${escapeHtml(f.q)}</summary><p>${escapeHtml(f.a)}</p></details>`)
        .join("")}</section>`
    : "";

  const related = all.filter((p) => p.slug !== post.slug).slice(0, 3);
  const relatedHtml = related.length
    ? `<section class="g-related"><h2>מדריכים נוספים</h2><div class="g-grid">${related.map(card).join("")}</div></section>`
    : "";

  return `${head({
    title: post.seoTitle || `${post.title} | ${BRAND}`,
    description: post.description,
    canonical, ogType: "article", image: post.image,
    publishedAt: post.date, modifiedAt: post.updated || post.date,
    jsonLd: { "@context": "https://schema.org", "@graph": graph },
  })}
<main class="g-wrap g-article">
  ${crumbsHtml(crumbs)}
  <p class="g-eyebrow">${escapeHtml(post.category)}</p>
  <h1>${escapeHtml(post.title)}</h1>
  <p class="g-lede">${escapeHtml(post.description)}</p>
  <div class="g-byline">
    <div><span class="g-author">${escapeHtml(post.author)}</span>${post.authorRole ? `<span class="g-role">${escapeHtml(post.authorRole)}</span>` : ""}</div>
    <div class="g-meta"><time datetime="${escapeHtml(post.date)}">${heDate(post.date)}</time> · ${post.readingMinutes} דקות קריאה</div>
  </div>
  ${post.image ? `<img class="g-hero" src="${escapeHtml(post.image)}" alt="${escapeHtml(post.imageAlt || post.title)}" width="1200" height="630" />` : ""}
  <div class="g-body">
    <article>${post.html}${faq}</article>
    ${toc}
  </div>
  ${relatedHtml}
  <section class="g-cta-box">
    <h2>${escapeHtml(post.ctaTitle || "רוצים עזרה עם הצד הטכני?")}</h2>
    <p>${escapeHtml(post.ctaText || "Ads Agent מחבר או מקים קמפיין לידים אחד, עוקב אחרי פרסום ומדידה, ומציג את הנתונים בעברית.")}</p>
    <a class="g-btn" href="/signup">בדיקת התאמה</a>
  </section>
</main>
${footer}`;
}

function card(p) {
  return `<a class="g-card" href="${escapeHtml(p.url)}">
    ${p.image ? `<img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.imageAlt || p.title)}" loading="lazy" width="600" height="315" />` : ""}
    <span class="g-eyebrow">${escapeHtml(p.category)}</span>
    <h2>${escapeHtml(p.title)}</h2>
    <p>${escapeHtml(p.description)}</p>
    <span class="g-meta"><time datetime="${escapeHtml(p.date)}">${heDate(p.date)}</time> · ${p.readingMinutes} דקות</span>
  </a>`;
}

function renderIndex(posts) {
  const crumbs = [{ name: "בית", url: "/" }, { name: SECTION_TITLE, url: "/guides" }];
  return `${head({
    title: `${SECTION_TITLE} | ${BRAND}`,
    description: SECTION_DESC,
    canonical: `${SITE}/guides`,
    ogType: "website",
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "CollectionPage", name: SECTION_TITLE, description: SECTION_DESC,
          url: `${SITE}/guides`, inLanguage: "he-IL",
          hasPart: posts.map((p) => ({
            "@type": "BlogPosting", headline: p.title, url: SITE + p.url, datePublished: p.date,
          })),
        },
        crumbsJsonLd(crumbs),
      ],
    },
  })}
<main class="g-wrap">
  ${crumbsHtml(crumbs)}
  <p class="g-eyebrow">${escapeHtml(SECTION_TITLE)}</p>
  <h1>${escapeHtml(SECTION_TITLE)}</h1>
  <p class="g-lede">${escapeHtml(SECTION_DESC)}</p>
  ${posts.length
    ? `<p class="g-count">${posts.length} מדריכים</p><div class="g-grid">${posts.map(card).join("")}</div>`
    : `<p class="g-empty">בקרוב — המדריך הראשון בדרך.</p>`}
</main>
${footer}`;
}

// ── sitemap + robots ─────────────────────────────────────────────────────────
// Both generated from the same post list that built the pages, so a published
// guide cannot be missing from the sitemap.
function renderSitemap(posts) {
  const urls = [
    { loc: `${SITE}/`, priority: "1.0" },
    { loc: `${SITE}/guides`, priority: "0.9" },
    ...posts.map((p) => ({ loc: SITE + p.url, lastmod: p.updated || p.date, priority: "0.8" })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${escapeHtml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}<priority>${u.priority}</priority></url>`).join("\n")}
</urlset>`;
}

function renderRobots() {
  return `User-agent: *
Allow: /
Allow: /guides

# The app itself is behind auth and has nothing to index.
Disallow: /admin
Disallow: /app
Disallow: /api

Sitemap: ${SITE}/sitemap.xml
`;
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  const posts = readPosts();
  fs.mkdirSync(OUT, { recursive: true });

  // guides/index.html, served by an explicit GET /guides route in
  // server/src/app.ts. Not a sibling guides.html: serve-static resolves the
  // request path against the guides/ DIRECTORY first and never reaches the
  // `extensions` fallback, so a sibling file is unreachable at /guides. The
  // explicit route also keeps the canonical URL (/guides) the URL actually
  // served — no 301 hop for a crawler to follow.
  fs.writeFileSync(path.join(OUT, "index.html"), renderIndex(posts));
  for (const p of posts) fs.writeFileSync(path.join(OUT, `${p.slug}.html`), renderArticle(p, posts));
  fs.copyFileSync(path.join(__dirname, "guides.css"), path.join(OUT, "guides.css"));
  fs.writeFileSync(path.join(PUBLIC, "sitemap.xml"), renderSitemap(posts));
  fs.writeFileSync(path.join(PUBLIC, "robots.txt"), renderRobots());

  console.log(`[guides] ${posts.length} guide(s) → web/public/guides/`);
  for (const p of posts) {
    for (const w of p.warnings) console.warn(`[guides]   ⚠ ${p.file}: ${w}`);
  }
}

main();
