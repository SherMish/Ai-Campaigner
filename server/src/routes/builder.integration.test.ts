// DB + HTTP integration for the guided builder's routes (AIC-52). Requires
// DATABASE_URL with migrations applied; self-skips otherwise. Mocks global
// fetch (same technique as campaign-adapter.test.ts) so the REAL adapter
// code runs end-to-end through the real HTTP routes without touching Meta.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { signAuthToken } from "../auth/tokens.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let counter = 0;
function mockMetaFetch() {
  return vi.fn(async (url: string) => {
    const u = String(url);
    // Page content requires the Page's own token, fetched from me/accounts
    // first — `/promotable_posts` does not exist (verified live 2026-08-12).
    if (u.includes("me/accounts")) {
      return jsonRes({ data: [{ id: "page_it_1", access_token: "PAGE_TOKEN" }] });
    }
    if (u.includes("/posts?")) {
      return jsonRes({ data: [{ id: "post_1", message: "hi", full_picture: "https://x/p.jpg", created_time: "2026-01-01T00:00:00Z" }] });
    }
    if (u.includes("/adspixels")) {
      return jsonRes({ data: [{ id: "984664453249037", name: "Pisga Pixel" }] });
    }
    if (u.includes("/stats?aggregation=event")) {
      return jsonRes({ data: [{ data: [{ value: "CompleteRegistration", count: 5 }] }] });
    }
    if (u.endsWith("/adimages")) return jsonRes({ images: { "photo.jpg": { hash: "img_hash_1", url: "https://x/photo.jpg" } } });
    if (u.endsWith("/adcreatives")) return jsonRes({ id: `crea_${++counter}` });
    if (u.endsWith("/campaigns")) return jsonRes({ id: `meta_camp_${++counter}` });
    if (u.endsWith("/adsets")) return jsonRes({ id: `meta_adset_${++counter}` });
    if (u.endsWith("/ads")) return jsonRes({ id: `meta_ad_${++counter}` });
    throw new Error(`builder.integration.test: unexpected fetch ${u}`);
  });
}

// Seeds a customer ready to build: healthy connection, ad account, Page — no
// managed_campaigns row yet (the precondition resolveBuilderContext checks).
async function seedReadyCustomer(tag: string, category = "beautician") {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test, onboarding_status, category) VALUES ($1, true, 'ready', $2) RETURNING id`,
    [`__it_builder_route_${tag}`, category],
  );
  const customerId = cust.rows[0].id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, password_hash, name, customer_id) VALUES ($1, 'x', 'Owner', $2) RETURNING id`,
    [`__it_builder_route_${tag}@example.com`, customerId],
  );
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, access_health, page_id) VALUES ($1, 'ok', 'page_it_1') RETURNING id`,
    [customerId],
  );
  await pool.query(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id, name) VALUES ($1, $2, 'IT Ad Account')`,
    [conn.rows[0].id, `act_route_${conn.rows[0].id.slice(0, 8)}`],
  );
  return { customerId, userId: user.rows[0].id, token: signAuthToken(user.rows[0].id) };
}

d("guided builder routes (DB + HTTP)", () => {
  const app = createApp();

  beforeAll(() => {
    process.env.JWT_SECRET ||= "test-secret-builder-routes";
    process.env.META_SYSTEM_USER_TOKEN = "test-meta-token";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM app_users WHERE email LIKE '__it_builder_route_%'`);
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_builder_route_%'`);
    delete process.env.META_SYSTEM_USER_TOKEN;
    await pool.end();
  });

  it("rejects every route without a token", async () => {
    expect((await request(app).get("/api/app/builder/context")).status).toBe(401);
    expect((await request(app).post("/api/app/builder/start")).status).toBe(401);
    expect((await request(app).get("/api/app/builder/posts")).status).toBe(401);
  });

  it("/context 409s a customer with no ready connection, prefills category for one who is ready", async () => {
    const notReady = await pool.query<{ id: string }>(
      `INSERT INTO customers (business_name, is_test, onboarding_status) VALUES ('__it_builder_route_notready', true, 'ready') RETURNING id`,
    );
    const nrUser = await pool.query<{ id: string }>(
      `INSERT INTO app_users (email, password_hash, customer_id) VALUES ('__it_builder_route_notready@example.com', 'x', $1) RETURNING id`,
      [notReady.rows[0].id],
    );
    const nrToken = signAuthToken(nrUser.rows[0].id);
    const bad = await request(app).get("/api/app/builder/context").set("Authorization", `Bearer ${nrToken}`);
    expect(bad.status).toBe(409);

    const { token } = await seedReadyCustomer("ctx", "fitness");
    const ok = await request(app).get("/api/app/builder/context").set("Authorization", `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(ok.body.category).toBe("fitness");
  });

  it("full happy path: start → existing-post creative → build, all PAUSED and idempotent", async () => {
    vi.stubGlobal("fetch", mockMetaFetch());
    const { customerId, token } = await seedReadyCustomer("happy");

    const start = await request(app).post("/api/app/builder/start").set("Authorization", `Bearer ${token}`);
    expect(start.status).toBe(200);
    const localCampaignId = start.body.localCampaignId as string;
    expect(localCampaignId).toBeTruthy();

    // Resuming /start returns the SAME shell row (no duplicate).
    const startAgain = await request(app).post("/api/app/builder/start").set("Authorization", `Bearer ${token}`);
    expect(startAgain.body.localCampaignId).toBe(localCampaignId);

    const posts = await request(app).get("/api/app/builder/posts").set("Authorization", `Bearer ${token}`);
    expect(posts.status).toBe(200);
    expect(posts.body.posts[0].id).toBe("post_1");

    const creative = await request(app)
      .post("/api/app/builder/creative")
      .set("Authorization", `Bearer ${token}`)
      .send({ localCampaignId, clientKey: "adset-1-ad-1", name: "Ad 1", postId: "post_1" });
    expect(creative.status).toBe(200);
    const creativeId = creative.body.creativeId as string;
    expect(creativeId).toBeTruthy();

    const build = await request(app)
      .post("/api/app/builder/build")
      .set("Authorization", `Bearer ${token}`)
      .send({
        localCampaignId,
        name: "My Business",
        dailyBudgetAgorot: 4000,
        specialAdCategories: [],
        whatsappDestination: "972500000000",
        targeting: { ageMin: 18, ageMax: 45, genders: "female" },
        ads: [{ clientKey: "adset-1-ad-1", name: "Ad 1", creativeId }],
      });
    expect(build.status).toBe(200);
    expect(build.body.metaCampaignId).toBeTruthy();
    expect(build.body.adSets).toHaveLength(1);
    expect(build.body.adSets[0].ads).toHaveLength(1);

    const camp = await pool.query(`SELECT meta_campaign_id, status FROM managed_campaigns WHERE id = $1`, [localCampaignId]);
    expect(camp.rows[0].meta_campaign_id).toBe(build.body.metaCampaignId);
    expect(camp.rows[0].status).toBe("under_review"); // building never activates (AIC-53's job)

    // A customer already has a campaign now — the builder is done with them.
    const again = await request(app).get("/api/app/builder/context").set("Authorization", `Bearer ${token}`);
    expect(again.status).toBe(409);

    const custCheck = await pool.query(`SELECT id FROM customers WHERE id = $1`, [customerId]);
    expect(custCheck.rows).toHaveLength(1);
  });

  it("upload path: validates copy before ever calling Meta", async () => {
    vi.stubGlobal("fetch", mockMetaFetch());
    const { token } = await seedReadyCustomer("upload-validate");
    const start = await request(app).post("/api/app/builder/start").set("Authorization", `Bearer ${token}`);
    const localCampaignId = start.body.localCampaignId as string;

    const bad = await request(app)
      .post("/api/app/builder/creative")
      .set("Authorization", `Bearer ${token}`)
      .send({ localCampaignId, clientKey: "adset-1-ad-1", name: "Ad 1", headline: "", primaryText: "x", media: { kind: "image", imageHash: "h" } });
    expect(bad.status).toBe(400);
    expect(bad.body.errors).toContain("missing_headline");
  });

  it("upload endpoint accepts a real multipart file and returns Meta's hash", async () => {
    vi.stubGlobal("fetch", mockMetaFetch());
    const { token } = await seedReadyCustomer("upload-file");

    const res = await request(app)
      .post("/api/app/builder/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("fake image bytes"), { filename: "photo.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(200);
    expect(res.body.media).toEqual({ kind: "image", imageHash: "img_hash_1" });
  });

  it("rejects a build/creative call for a localCampaignId that belongs to someone else", async () => {
    vi.stubGlobal("fetch", mockMetaFetch());
    const a = await seedReadyCustomer("owner-a");
    const b = await seedReadyCustomer("owner-b");
    const startA = await request(app).post("/api/app/builder/start").set("Authorization", `Bearer ${a.token}`);
    const localCampaignId = startA.body.localCampaignId as string;

    const stolen = await request(app)
      .post("/api/app/builder/creative")
      .set("Authorization", `Bearer ${b.token}`)
      .send({ localCampaignId, clientKey: "adset-1-ad-1", name: "Ad 1", postId: "post_1" });
    expect(stolen.status).toBe(404);
  });

  // AIC-89 — the website-destination step's Pixel picker + recency guard,
  // and the full website-destination build end-to-end.
  it("GET /pixels lists Pixels on the ad account", async () => {
    vi.stubGlobal("fetch", mockMetaFetch());
    const { token } = await seedReadyCustomer("pixels");
    const res = await request(app).get("/api/app/builder/pixels").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.pixels).toEqual([{ id: "984664453249037", name: "Pisga Pixel" }]);
  });

  it("POST /pixel-check reports recency for the chosen Pixel + event", async () => {
    vi.stubGlobal("fetch", mockMetaFetch());
    const { token } = await seedReadyCustomer("pixel-check");
    const res = await request(app)
      .post("/api/app/builder/pixel-check")
      .set("Authorization", `Bearer ${token}`)
      .send({ pixelId: "984664453249037", conversionEvent: "CompleteRegistration" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hasRecentEvents: true });
  });

  it("full website-destination happy path: build creates a link-CTA ad and persists website_url/lead_event_types/tracking_pixel_id", async () => {
    vi.stubGlobal("fetch", mockMetaFetch());
    const { token } = await seedReadyCustomer("website-happy");

    const start = await request(app).post("/api/app/builder/start").set("Authorization", `Bearer ${token}`);
    const localCampaignId = start.body.localCampaignId as string;

    const creative = await request(app)
      .post("/api/app/builder/creative")
      .set("Authorization", `Bearer ${token}`)
      .send({
        localCampaignId, clientKey: "adset-1-ad-1", name: "Ad 1",
        headline: "כותרת טובה", primaryText: "טקסט מספיק ארוך כדי לעבור ולידציה",
        media: { kind: "image", imageHash: "img_hash_1" },
        destination: "website", destinationUrl: "https://pisga.app/signup",
      });
    expect(creative.status).toBe(200);
    const creativeId = creative.body.creativeId as string;

    const build = await request(app)
      .post("/api/app/builder/build")
      .set("Authorization", `Bearer ${token}`)
      .send({
        localCampaignId,
        name: "Pisga website campaign",
        dailyBudgetAgorot: 4000,
        specialAdCategories: [],
        destination: "website",
        whatsappDestination: "",
        destinationUrl: "https://pisga.app/signup",
        pixelId: "984664453249037",
        conversionEvent: "COMPLETE_REGISTRATION",
        targeting: { ageMin: 18, ageMax: 45, genders: "all" },
        ads: [{ clientKey: "adset-1-ad-1", name: "Ad 1", creativeId }],
      });
    expect(build.status).toBe(200);
    expect(build.body.metaCampaignId).toBeTruthy();

    const camp = await pool.query<{ website_url: string; tracking_pixel_id: string; lead_event_types: string[] }>(
      `SELECT website_url, tracking_pixel_id, lead_event_types FROM managed_campaigns WHERE id = $1`,
      [localCampaignId],
    );
    expect(camp.rows[0].website_url).toBe("https://pisga.app/signup");
    expect(camp.rows[0].tracking_pixel_id).toBe("984664453249037");
    expect(camp.rows[0].lead_event_types).toEqual(["offsite_conversion.fb_pixel_complete_registration"]);
  });

  it("503s honestly when no META_SYSTEM_USER_TOKEN is configured", async () => {
    const saved = process.env.META_SYSTEM_USER_TOKEN;
    delete process.env.META_SYSTEM_USER_TOKEN;
    try {
      const { token } = await seedReadyCustomer("no-token");
      const res = await request(app).get("/api/app/builder/posts").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(503);
    } finally {
      process.env.META_SYSTEM_USER_TOKEN = saved;
    }
  });
});
