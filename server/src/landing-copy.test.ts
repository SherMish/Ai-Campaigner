import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const landingPath = fileURLToPath(new URL("../../landing/index.html", import.meta.url));
const heroCreativePaths = [
  "landing-reel-nails.jpg",
  "landing-reel-pilates.jpg",
  "landing-reel-grooming.jpg",
  "landing-reel-ceramics.jpg",
].map((filename) => fileURLToPath(new URL(`../../web/public/${filename}`, import.meta.url)));
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

  it("rotates four local-business creatives with distinct actions", () => {
    const hero = sectionStartingAt('<section class="hero">');
    expect(hero.match(/class="ad-slide/g)).toHaveLength(4);
    expect(hero).toContain("לקביעת תור");
    expect(hero).toContain("להרשמה לשיעור ניסיון");
    expect(hero).toContain("שלחו וואטסאפ");
    expect(hero).toContain("להרשמה לסדנה");
    expect(html).toContain("@keyframes hero-reel");
    expect(html).toContain("prefers-reduced-motion: reduce");
    for (const path of heroCreativePaths) expect(fs.existsSync(path)).toBe(true);
  });

  it("omits removed hero labels and the one-time setup fee", () => {
    expect(html).not.toContain("דוגמה לקריאייטיב של עסק מקומי");
    expect(html).not.toContain("פייסבוק + אינסטגרם");
    expect(html).not.toContain("וואטסאפ + אתר");
    expect(html).not.toContain("₪299 הקמה חד-פעמית");
    expect(html).not.toContain(".stage::after");
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

  it("routes every acquisition CTA to the real business WhatsApp", () => {
    const links = [...html.matchAll(/href="(https:\/\/wa\.me\/972526964069\?text=[^"]+)"/g)].map((match) => match[1]);
    expect(links).toHaveLength(6);
    expect(html).not.toContain("mailto:");
    for (const href of links) {
      expect(new URL(href).searchParams.get("text")?.trim()).toBeTruthy();
    }
    expect(html.match(/target="_blank" rel="noopener"/g)).toHaveLength(6);
  });
});
