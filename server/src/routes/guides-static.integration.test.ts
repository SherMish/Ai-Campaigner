// AIC-126: the guides are static HTML precisely so a crawler gets the article
// without running JS. That guarantee lives in one line of app.ts
// (`extensions: ["html"]`) — without it these URLs fall through to the SPA
// catch-all and return the empty app shell, which looks fine in a browser and
// is invisible to whoever notices the traffic never arrives.
import { describe, it, expect } from "vitest";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "../../../web/dist");
const BUILT = fs.existsSync(path.join(DIST, "guides", "index.html"));
const d = BUILT ? describe : describe.skip;

d("guides are served as real HTML (DB-free)", () => {
  const app = createApp();

  it("serves /guides without the .html extension", async () => {
    const res = await request(app).get("/guides");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("<h1>");
  });

  it("serves an article at its extensionless URL, with the article text in the source", async () => {
    const slug = fs
      .readdirSync(path.join(DIST, "guides"))
      .find((f) => f.endsWith(".html") && f !== "index.html")!
      .replace(/\.html$/, "");
    const res = await request(app).get(`/guides/${encodeURIComponent(slug)}`);
    expect(res.status).toBe(200);
    // The whole point: title, description and body present WITHOUT JS.
    expect(res.text).toMatch(/<title>[^<]+<\/title>/);
    expect(res.text).toMatch(/<meta name="description" content="[^"]+"/);
    expect(res.text).toContain("application/ld+json");
    expect(res.text).toContain('rel="canonical"');
    // ...and it is NOT the SPA shell.
    expect(res.text).not.toContain('<div id="root"></div>');
  });

  it("serves both AIC-153 troubleshooting guides as crawlable HTML", async () => {
    const guides = [
      ["קמפיין-פעיל-אין-פניות", "הקמפיין פעיל אבל אין פניות"],
      ["פיקסל-פייסבוק-בדיקה", "מה זה פיקסל של פייסבוק"],
    ];

    for (const [slug, title] of guides) {
      const res = await request(app).get(`/guides/${encodeURIComponent(slug)}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain(title);
      expect(res.text).toContain("FAQPage");
      expect(res.text).not.toContain('<div id="root"></div>');
    }
  });

  it("serves the campaign-type guide as crawlable HTML", async () => {
    const res = await request(app).get(
      `/guides/${encodeURIComponent("מעורבות-או-לידים-לוואטסאפ")}`,
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain("קמפיין מעורבות או לידים לוואטסאפ");
    expect(res.text).toContain("FAQPage");
    expect(res.text).not.toContain('<div id="root"></div>');
  });

  it("serves sitemap.xml and robots.txt, and the sitemap lists the guides", async () => {
    const sitemap = await request(app).get("/sitemap.xml");
    expect(sitemap.status).toBe(200);
    expect(sitemap.text).toContain("/guides");
    expect(sitemap.text).toContain("/guides/קמפיין-פעיל-אין-פניות");
    expect(sitemap.text).toContain("/guides/פיקסל-פייסבוק-בדיקה");
    expect(sitemap.text).toContain("/guides/מעורבות-או-לידים-לוואטסאפ");

    const robots = await request(app).get("/robots.txt");
    expect(robots.status).toBe(200);
    expect(robots.text).toContain("Sitemap:");
  });

  // The guard that the static-first change didn't break client routing: these
  // have no matching file, so they must still reach the SPA.
  it("still falls back to the SPA for real app routes", async () => {
    for (const route of ["/login", "/admin/customers"]) {
      const res = await request(app).get(route);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/html/);
    }
  });
});
