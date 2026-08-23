// Pure helpers for the guides (blog) static generator — no fs, no network, so
// every one of them is unit-tested. SEO bugs are silent by nature: a duplicate
// heading id, an unescaped quote in a meta tag, or a title 40 characters too
// long all render fine and cost ranking. Tests are the only place they surface.

// Escape for HTML TEXT content.
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Escape for a JSON-LD <script> block. The danger is not HTML entities — the
// block is raw JSON — but a literal "</script>" inside a string closing the
// tag early, which breaks the page AND the structured data. Also neutralises
// the HTML-comment openers, which do the same thing in some parsers.
export function escapeJsonLd(obj) {
  return JSON.stringify(obj)
    .replace(/<\/script/gi, "<\\/script")
    .replace(/<!--/g, "\\u003C!--");
}

// A URL slug from a title. Hebrew is kept as-is: Hebrew URLs are valid,
// percent-encoded by the browser, and Google handles them — transliterating
// would produce worse, less clickable URLs for a Hebrew-language site. Only
// characters that are genuinely unsafe in a path segment are stripped.
export function slugify(title) {
  return String(title)
    .trim()
    .toLowerCase()
    .replace(/['"’”“]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

// Heading ids for the quick-jump sidebar. Deduped with a numeric suffix,
// because two sections legitimately share a title ("סיכום" twice) and a
// duplicate id makes the second anchor unreachable — the TOC link would jump
// to the wrong section, silently.
export function headingId(text, seen) {
  const base = slugify(text) || "section";
  if (!seen.has(base)) {
    seen.set(base, 1);
    return base;
  }
  const n = seen.get(base) + 1;
  seen.set(base, n);
  return `${base}-${n}`;
}

// Pull the h2/h3 headings out of rendered HTML to build the sidebar, and stamp
// each one with its id. Returns the modified html plus a flat toc list.
// Deliberately reads the RENDERED html rather than the markdown source, so the
// ids in the sidebar and the ids in the body can never disagree.
export function extractToc(html) {
  const seen = new Map();
  const toc = [];
  const out = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_m, level, inner) => {
    const text = inner.replace(/<[^>]+>/g, "").trim();
    const id = headingId(text, seen);
    toc.push({ level: Number(level), text, id });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });
  return { html: out, toc };
}

// Reading time, stated because it sets expectations on a long guide. Hebrew
// and English both average out near 200 wpm for this purpose; the number is
// rounded up so a 30-second read never shows "0 דקות".
export function readingMinutes(markdown) {
  const words = String(markdown).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

// SEO length guidance. NOT hard failures — a good title that runs 3 characters
// long is better than a bad one that fits — so these are reported as warnings
// the author can weigh, never as build errors.
export const SEO_LIMITS = { titleMax: 60, descriptionMin: 70, descriptionMax: 160 };

export function seoWarnings(post) {
  const w = [];
  const seoTitle = post.seoTitle || post.title;
  if (seoTitle.length > SEO_LIMITS.titleMax) {
    w.push(`title is ${seoTitle.length} chars (Google truncates near ${SEO_LIMITS.titleMax}) — set seoTitle to a shorter variant`);
  }
  const d = post.description || "";
  if (d.length < SEO_LIMITS.descriptionMin) w.push(`description is ${d.length} chars (aim ${SEO_LIMITS.descriptionMin}–${SEO_LIMITS.descriptionMax})`);
  if (d.length > SEO_LIMITS.descriptionMax) w.push(`description is ${d.length} chars (Google truncates near ${SEO_LIMITS.descriptionMax})`);
  return w;
}

// Required frontmatter. Missing any of these is a BUILD FAILURE, not a warning:
// a guide with no description ships an empty meta tag, and a guide with no date
// cannot be sorted or marked up as an Article. Better to break the build than
// to publish a page that silently forfeits its ranking.
export const REQUIRED_FIELDS = ["title", "description", "date", "category", "author"];

export function validatePost(post, file) {
  const missing = REQUIRED_FIELDS.filter((f) => !post[f]);
  if (missing.length) {
    throw new Error(`${file}: missing required frontmatter: ${missing.join(", ")}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(post.date))) {
    throw new Error(`${file}: date must be YYYY-MM-DD, got "${post.date}"`);
  }
  return true;
}
