import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const landingPath = fileURLToPath(new URL("../../landing/index.html", import.meta.url));
const heroCreativePath = fileURLToPath(new URL("../../web/public/landing-hero-creative.png", import.meta.url));
const html = fs.readFileSync(landingPath, "utf8");

function sectionStartingAt(marker: string): string {
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = html.indexOf("</section>", start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("landing-page positioning", () => {
  it("keeps price and fabricated recommendation UI out of the hero", () => {
    const hero = sectionStartingAt('<section class="hero">');
    expect(hero).not.toContain("₪299");
    expect(hero).not.toContain("המלצה חדשה");
    expect(hero).not.toContain("אפשר לקבל מחיר");
    expect(hero).not.toContain("ניהול קמפיינים לעסקים קטנים</p>");
  });

  it("states the honest operational promise and avoids performance guarantees", () => {
    expect(html).toContain("מנהלים את הצד הטכני של הפרסום");
    expect(html).toContain("לא מבטיחים קסמים");
    expect(html).toContain("אין התחייבות לתוצאה או לכמות פניות");
    expect(html).not.toContain("ניהול מלא של הקמפיין");
    expect(html).not.toContain("עובדת מצוין");
    expect(html).not.toContain("הכל עובד כרגיל");
  });

  it("does not publish customer dashboard data or substitute a fake dashboard", () => {
    expect(html).not.toContain("landing-dashboard-real.png");
    expect(html).not.toContain("screen-mock");
    expect(html).not.toContain("demo-dashboard");
  });

  it("labels the fictional local-business creative as an example", () => {
    expect(html).toContain('src="/landing-hero-creative.png"');
    expect(html).toContain("דוגמה לקריאייטיב של עסק מקומי");
    expect(fs.existsSync(heroCreativePath)).toBe(true);
  });

  it("keeps pricing in the dedicated pricing section only", () => {
    const pricing = sectionStartingAt('<section id="price">');
    expect(pricing).toContain("₪299");
    expect(html.indexOf("₪299")).toBeGreaterThanOrEqual(html.indexOf('<section id="price">'));
    expect(html.slice(0, html.indexOf('<section id="price">'))).not.toContain("₪299");
    expect(html.slice(html.indexOf("</section>", html.indexOf('<section id="price">')) + 10)).not.toContain("₪299");
  });

  it("contains the natural search terms the offer actually supports", () => {
    expect(html).toContain("ניהול קמפיינים בפייסבוק ובאינסטגרם לעסקים קטנים");
    expect(html).toContain("קמפיינים בפייסבוק ובאינסטגרם לעסקים קטנים");
    expect(html).toContain("קמפיין לידים");
    expect(html).toContain("Ads Manager");
  });
});
