// The guides generator's pure helpers. Lives under web/src so it runs in the
// existing web vitest project (the generator itself is a build script at
// scripts/guides-lib.mjs — plain ESM, imported directly).
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs build script, no types by design
import { escapeHtml, escapeJsonLd, slugify, headingId, extractToc, readingMinutes, seoWarnings, validatePost } from "../../../scripts/guides-lib.mjs";

// The generator is a plain .mjs build script with no .d.ts — deliberately, so
// it stays runnable by `node` with no build step of its own. This names the one
// shape the tests destructure, rather than sprinkling `any` at each call site.
interface TocEntry { level: number; text: string; id: string }

describe("guides generator — escaping (AIC-126)", () => {
  it("escapes every character that can break an attribute or inject markup", () => {
    expect(escapeHtml(`<script>"x" & 'y'`)).toBe("&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;");
  });

  // A meta description containing a quote is ordinary Hebrew copy; unescaped it
  // closes the content="" attribute and silently truncates the description
  // Google reads.
  it("keeps a quoted description safe inside an attribute", () => {
    expect(escapeHtml('הוא אמר "שלום"')).not.toContain('"שלום"');
    expect(escapeHtml('הוא אמר "שלום"')).toContain("&quot;");
  });

  // JSON-LD is raw JSON in a <script> — HTML-escaping it would corrupt the
  // structured data. The only real hazard is a literal closing tag in a string.
  it("neutralises a closing script tag inside JSON-LD without mangling the JSON", () => {
    const out = escapeJsonLd({ headline: "a </script> b", n: 3 });
    expect(out).not.toContain("</script");
    expect(JSON.parse(out.replace("<\\/script", "</script")).n).toBe(3);
  });
});

describe("guides generator — slugs", () => {
  it("keeps Hebrew rather than transliterating it", () => {
    expect(slugify("מדריך קמפיין מטא")).toBe("מדריך-קמפיין-מטא");
  });

  it("lowercases, collapses punctuation, and never leaves edge dashes", () => {
    expect(slugify("  Meta Campaign Setup: The 2026 Guide!  ")).toBe("meta-campaign-setup-the-2026-guide");
  });

  it("drops quotes instead of turning them into dashes", () => {
    expect(slugify(`The "Best" Guide`)).toBe("the-best-guide");
  });
});

describe("guides generator — table of contents", () => {
  it("stamps ids on h2/h3 and returns them in document order", () => {
    const { html, toc } = extractToc("<h2>שלב 1</h2><p>x</p><h3>תת-סעיף</h3><h2>שלב 2</h2>");
    expect((toc as TocEntry[]).map((t) => [t.level, t.text, t.id])).toEqual([
      [2, "שלב 1", "שלב-1"],
      [3, "תת-סעיף", "תת-סעיף"],
      [2, "שלב 2", "שלב-2"],
    ]);
    expect(html).toContain('<h2 id="שלב-1">');
  });

  // Two sections can legitimately share a title. A duplicate id makes the
  // second sidebar link jump to the FIRST section — a wrong destination that
  // looks like it worked.
  it("dedupes repeated headings so every sidebar link has its own target", () => {
    const { toc } = extractToc("<h2>סיכום</h2><h2>סיכום</h2><h2>סיכום</h2>");
    expect((toc as TocEntry[]).map((t) => t.id)).toEqual(["סיכום", "סיכום-2", "סיכום-3"]);
  });

  it("strips inline markup from the heading text but keeps it in the body", () => {
    const { html, toc } = extractToc("<h2>שלב <strong>ראשון</strong></h2>");
    expect(toc[0].text).toBe("שלב ראשון");
    expect(html).toContain("<strong>ראשון</strong>");
  });

  it("leaves h1 alone — the page title is not a section", () => {
    const { toc } = extractToc("<h1>Title</h1><h2>Real section</h2>");
    expect(toc).toHaveLength(1);
  });
});

describe("guides generator — validation", () => {
  const ok = { title: "t", description: "d", date: "2026-08-24", category: "c", author: "a" };

  it("fails the build on missing required frontmatter, naming every field", () => {
    expect(() => validatePost({ title: "t" }, "x.md")).toThrow(/description, date, category, author/);
  });

  it("rejects a date that is not YYYY-MM-DD", () => {
    expect(() => validatePost({ ...ok, date: "24/08/2026" }, "x.md")).toThrow(/YYYY-MM-DD/);
  });

  it("accepts a complete post", () => {
    expect(validatePost(ok, "x.md")).toBe(true);
  });
});

describe("guides generator — SEO warnings (advisory, never fatal)", () => {
  it("flags an over-long title and an out-of-range description", () => {
    expect(seoWarnings({ title: "x".repeat(70), description: "d".repeat(100) })[0]).toMatch(/title is 70/);
    expect(seoWarnings({ title: "t", description: "short" })[0]).toMatch(/description is 5/);
    expect(seoWarnings({ title: "t", description: "d".repeat(200) })[0]).toMatch(/description is 200/);
  });

  it("prefers an explicit seoTitle over the display title when judging length", () => {
    const post = { title: "x".repeat(90), seoTitle: "Short enough", description: "d".repeat(100) };
    expect(seoWarnings(post)).toEqual([]);
  });

  it("says nothing when both are in range", () => {
    expect(seoWarnings({ title: "A good title", description: "d".repeat(120) })).toEqual([]);
  });
});

describe("guides generator — reading time", () => {
  it("never reports zero minutes", () => {
    expect(readingMinutes("word")).toBe(1);
  });
  it("rounds up from a 200-wpm baseline", () => {
    expect(readingMinutes(Array(450).fill("מילה").join(" "))).toBe(3);
  });
});
