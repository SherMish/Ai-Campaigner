import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const guidePath = fileURLToPath(
  new URL("../../content/guides/הקמת-קמפיין-לידים-במטא.md", import.meta.url),
);
const budgetGuidePath = fileURLToPath(
  new URL("../../content/guides/מדריך-תקציב-פייסבוק.md", import.meta.url),
);
const imagePath = fileURLToPath(
  new URL("../../web/public/meta-leads-setup-2026.png", import.meta.url),
);
const guidesCssPath = fileURLToPath(new URL("../../scripts/guides.css", import.meta.url));
const markdown = fs.readFileSync(guidePath, "utf8");
const budgetMarkdown = fs.readFileSync(budgetGuidePath, "utf8");
const guidesCss = fs.readFileSync(guidesCssPath, "utf8");

describe("Meta lead-campaign setup guide (AIC-147)", () => {
  it("ships complete SEO metadata and a truthful Ads Agent CTA", () => {
    expect(markdown).toContain('seoTitle: "הקמת קמפיין לידים במטא - מדריך לעסק קטן"');
    expect(markdown).toContain('slug: "הקמת-קמפיין-לידים-במטא"');
    expect(markdown).toContain('image: "/meta-leads-setup-2026.png"');
    expect(markdown).toContain('ctaTitle: "לא רוצים להקים את זה לבד?"');
    expect(markdown).toContain("בלי הבטחת קסמים ובלי לחיות בתוך Ads Manager");
    expect(markdown).not.toContain("נבטיח");
  });

  it("uses only the normal short hyphen", () => {
    expect(markdown).not.toMatch(/[–—־]/);
  });

  it("does not import unsupported learning or budget folklore", () => {
    expect(markdown).not.toMatch(/50\s+(אירוע|המר)/);
    expect(markdown).not.toMatch(/3\s*-\s*5.*(תקציב|עלות)/);
    expect(markdown).not.toMatch(/חייבים לחכות 7 ימים/);
    expect(markdown).toContain("אין תקציב יומי קסום שמתאים לכל קמפיין לידים");
    expect(markdown).toContain("היא לא מראה לכם אם המודעה רווחית");
    expect(budgetMarkdown).not.toMatch(/[–—־]/);
    expect(budgetMarkdown).not.toMatch(/3\s*-\s*5.*(תקציב|עלות)/);
    expect(budgetMarkdown).not.toMatch(/20\s*-\s*30\s*אחוז/);
    expect(budgetMarkdown).not.toContain("כל שינוי מאפס את הלמידה");
    expect(budgetMarkdown).toContain("אין תקציב יומי אחד שמתאים לכל קמפיין");
  });

  it("links to primary Meta sources for the factual setup claims", () => {
    expect(markdown).toContain("https://www.facebookblueprint.com/");
    expect(markdown).toContain("https://about.fb.com/");
    expect(markdown).toContain("https://www.facebook.com/help/");
    expect(markdown).toContain("https://www.facebook.com/ads/library/");
  });

  it("ships a 1200x630 PNG title image", () => {
    expect(fs.existsSync(imagePath)).toBe(true);
    const png = fs.readFileSync(imagePath);
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
  });

  it("allows long tracking parameters to wrap on mobile", () => {
    expect(markdown).toContain("utm_source=meta&utm_medium=paid_social&utm_campaign=campaign_name");
    expect(guidesCss).toMatch(/\.g-body code[\s\S]*overflow-wrap:\s*anywhere/);
  });
});
