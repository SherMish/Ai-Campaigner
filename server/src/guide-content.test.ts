import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const guidePath = fileURLToPath(
  new URL("../../content/guides/הקמת-קמפיין-לידים-במטא.md", import.meta.url),
);
const budgetGuidePath = fileURLToPath(
  new URL("../../content/guides/מדריך-תקציב-פייסבוק.md", import.meta.url),
);
const noLeadsGuidePath = fileURLToPath(
  new URL("../../content/guides/קמפיין-פעיל-אין-פניות.md", import.meta.url),
);
const pixelGuidePath = fileURLToPath(
  new URL("../../content/guides/פיקסל-פייסבוק-בדיקה.md", import.meta.url),
);
const campaignTypeGuidePath = fileURLToPath(
  new URL("../../content/guides/מעורבות-או-לידים-לוואטסאפ.md", import.meta.url),
);
const imagePath = fileURLToPath(
  new URL("../../web/public/meta-leads-setup-2026.png", import.meta.url),
);
const noLeadsImagePath = fileURLToPath(
  new URL("../../web/public/facebook-campaign-no-leads.png", import.meta.url),
);
const pixelImagePath = fileURLToPath(
  new URL("../../web/public/meta-pixel-check-guide.png", import.meta.url),
);
const campaignTypeImagePath = fileURLToPath(
  new URL("../../web/public/engagement-vs-whatsapp-leads.png", import.meta.url),
);
const guidesCssPath = fileURLToPath(new URL("../../scripts/guides.css", import.meta.url));
const markdown = fs.readFileSync(guidePath, "utf8");
const budgetMarkdown = fs.readFileSync(budgetGuidePath, "utf8");
const noLeadsMarkdown = fs.readFileSync(noLeadsGuidePath, "utf8");
const pixelMarkdown = fs.readFileSync(pixelGuidePath, "utf8");
const campaignTypeMarkdown = fs.readFileSync(campaignTypeGuidePath, "utf8");
const guidesCss = fs.readFileSync(guidesCssPath, "utf8");

function expectPngDimensions(path: string, width: number, height: number) {
  expect(fs.existsSync(path)).toBe(true);
  const png = fs.readFileSync(path);
  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  expect(png.readUInt32BE(16)).toBe(width);
  expect(png.readUInt32BE(20)).toBe(height);
}

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
    expectPngDimensions(imagePath, 1200, 630);
  });

  it("allows long tracking parameters to wrap on mobile", () => {
    expect(markdown).toContain("utm_source=meta&utm_medium=paid_social&utm_campaign=campaign_name");
    expect(guidesCss).toMatch(/\.g-body code[\s\S]*overflow-wrap:\s*anywhere/);
  });
});

describe("no-leads and Meta Pixel guides (AIC-153)", () => {
  it("ships distinct search metadata, stable slugs and honest CTAs", () => {
    expect(noLeadsMarkdown).toContain('seoTitle: "קמפיין פייסבוק פעיל ואין פניות - 10 בדיקות"');
    expect(noLeadsMarkdown).toContain('slug: "קמפיין-פעיל-אין-פניות"');
    expect(noLeadsMarkdown).toContain('image: "/facebook-campaign-no-leads.png"');
    expect(noLeadsMarkdown).toContain("בלי הבטחת לידים ובלי להסתיר תקלה מאחורי גרפים");

    expect(pixelMarkdown).toContain('seoTitle: "פיקסל של פייסבוק - מה זה ואיך בודקים שהוא עובד"');
    expect(pixelMarkdown).toContain('slug: "פיקסל-פייסבוק-בדיקה"');
    expect(pixelMarkdown).toContain('image: "/meta-pixel-check-guide.png"');
    expect(pixelMarkdown).toContain("בלי להציג ביקור באתר כאילו הוא ליד");
  });

  it("uses normal short hyphens in both guides", () => {
    expect(noLeadsMarkdown).not.toMatch(/[–—־]/);
    expect(pixelMarkdown).not.toMatch(/[–—־]/);
  });

  it("keeps diagnosis ahead of optimization and distinguishes PageView from a lead", () => {
    expect(noLeadsMarkdown).toContain("רק אחרי שכל המסלול תקין יש טעם להשוות בין מודעות");
    expect(noLeadsMarkdown).toContain("אין חוק שאומר שכל קמפיין צריך לחכות מספר קבוע של ימים");
    expect(noLeadsMarkdown).not.toMatch(/חייבים לחכות\s+\d+\s+ימים/);

    expect(pixelMarkdown).toContain("`PageView` אומר שהעמוד נטען בדפדפן");
    expect(pixelMarkdown).toContain("האירוע הנכון, ברגע הנכון, פעם אחת");
    expect(pixelMarkdown).not.toContain("הפיקסל סופר כל משתמש");
  });

  it("cross-links the troubleshooting journey and cites primary Meta tools and docs", () => {
    expect(noLeadsMarkdown).toContain("/guides/פיקסל-פייסבוק-בדיקה");
    expect(noLeadsMarkdown).toContain("https://metastatus.com/ads-manager");
    expect(noLeadsMarkdown).toContain("https://www.facebook.com/accountquality/");

    expect(pixelMarkdown).toContain("/guides/קמפיין-פעיל-אין-פניות");
    expect(pixelMarkdown).toContain("https://developers.facebook.com/docs/meta-pixel/get-started/");
    expect(pixelMarkdown).toContain("https://www.facebookblueprint.com/");
    expect(pixelMarkdown).toContain("https://chromewebstore.google.com/");
  });

  it("ships a 1200x630 PNG title image for each guide", () => {
    expectPngDimensions(noLeadsImagePath, 1200, 630);
    expectPngDimensions(pixelImagePath, 1200, 630);
  });
});

describe("Engagement vs messaging-leads guide", () => {
  it("ships distinct SEO metadata and an honest CTA", () => {
    expect(campaignTypeMarkdown).toContain('seoTitle: "מעורבות או לידים לוואטסאפ - מה לבחור במטא"');
    expect(campaignTypeMarkdown).toContain('slug: "מעורבות-או-לידים-לוואטסאפ"');
    expect(campaignTypeMarkdown).toContain('image: "/engagement-vs-whatsapp-leads.png"');
    expect(campaignTypeMarkdown).toContain('ctaTitle: "לא בטוחים מה הקמפיין שלכם באמת מודד?"');
    expect(campaignTypeMarkdown).not.toContain("נבטיח");
  });

  it("separates objective, conversion location and performance goal", () => {
    expect(campaignTypeMarkdown).toContain("הקומה הראשונה נותנת כיוון. הקומה השנייה קובעת את ההתנהגות בפועל");
    expect(campaignTypeMarkdown).toContain("מעורבות בפוסט");
    expect(campaignTypeMarkdown).toContain("אפליקציות מסרים");
    expect(campaignTypeMarkdown).toContain("WhatsApp");
    expect(campaignTypeMarkdown).toContain("Instagram Direct");
    expect(campaignTypeMarkdown).toContain("Messenger");
    expect(campaignTypeMarkdown).not.toContain("Engagement הוא תמיד");
  });

  it("labels the live-account ratio as one directional example, not a benchmark", () => {
    expect(campaignTypeMarkdown).toContain("בדוגמה אחת מחשבון פעיל");
    expect(campaignTypeMarkdown).toContain("לא benchmark");
    expect(campaignTypeMarkdown).toContain("המדדים אינם זהים לחלוטין");
    expect(campaignTypeMarkdown).not.toContain("4 מתוך 5");
  });

  it("uses normal short hyphens and cites primary guidance", () => {
    expect(campaignTypeMarkdown).not.toMatch(/[–—־]/);
    expect(campaignTypeMarkdown).toContain("https://whatsappbusiness.com/resources/");
    expect(campaignTypeMarkdown).toContain("https://whatsappbusiness.com/products/");
    expect(campaignTypeMarkdown).toContain("https://www.facebookblueprint.com/");
  });

  it("ships a 1200x630 PNG title image", () => {
    expectPngDimensions(campaignTypeImagePath, 1200, 630);
  });
});
