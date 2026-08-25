// DB + HTTP integration for the guided builder's routes (AIC-52). Requires
// DATABASE_URL with migrations applied; self-skips otherwise. Mocks global
// fetch (same technique as campaign-adapter.test.ts) so the REAL adapter
// code runs end-to-end through the real HTTP routes without touching Meta.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { signAuthToken } from "../auth/tokens.js";

// AIC-106 — a build now requires an agreed daily ceiling, and fails closed
// without one. In production that figure is set at provisioning (onboarding
// step 4); these route tests create the campaign shell via /builder/start,
// which leaves it at 0, so they have to model the provisioning step too.
async function agreeBudget(localCampaignId: string, agorot = 10000) {
  await pool.query(`UPDATE managed_campaigns SET agreed_budget_agorot = $2 WHERE id = $1`, [localCampaignId, agorot]);
}

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
    process.env.JWT_SECRET ||= "test-secret-builder-routes-padding-to-32-chars-minimum";
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

  // AIC-106 — the refusal has to be legible, not just correct. Before this,
  // a missing ceiling surfaced as 502 "failed to build campaign", i.e. "Meta
  // is broken" — sending an operator mid-call to go inspect Meta when the
  // real fix is one field in provisioning. A guard that fails closed but lies
  // about why is only half a guard.
  async function buildWithBudget(token: string, localCampaignId: string, creativeId: string, dailyBudgetAgorot: number) {
    return request(app)
      .post("/api/app/builder/build")
      .set("Authorization", `Bearer ${token}`)
      .send({
        localCampaignId, name: "My Business", dailyBudgetAgorot,
        specialAdCategories: [], whatsappDestination: "972500000000",
        targeting: { ageMin: 18, ageMax: 45, genders: "female" },
        ads: [{ clientKey: "adset-1-ad-1", name: "Ad 1", creativeId }],
      });
  }

  async function readyToBuild(tag: string) {
    vi.stubGlobal("fetch", mockMetaFetch());
    const { token } = await seedReadyCustomer(tag);
    const start = await request(app).post("/api/app/builder/start").set("Authorization", `Bearer ${token}`);
    const localCampaignId = start.body.localCampaignId as string;
    const creative = await request(app)
      .post("/api/app/builder/creative")
      .set("Authorization", `Bearer ${token}`)
      .send({ localCampaignId, clientKey: "adset-1-ad-1", name: "Ad 1", postId: "post_1" });
    return { token, localCampaignId, creativeId: creative.body.creativeId as string };
  }

  // AIC-106 — the confirmation that replaces the launch gate names the
  // customer, and its whole value is that the name is NOT operator-entered.
  // If it could be typed, it would confirm nothing about who is being spent
  // for. Locked in at the source.
  it("serves the customer's business name from the record for the creation confirmation", async () => {
    vi.stubGlobal("fetch", mockMetaFetch());
    const { customerId, token } = await seedReadyCustomer("bizname");
    // Renaming to a BARE name (this was "יורם גאון") defeated every
    // prefix-based cleanup and leaked one row per run — 18 of them before it
    // was caught. The test's point is that the name comes from the RECORD,
    // which any name proves, so it keeps the __it_ prefix.
    // MUST keep this file's own cleanup prefix (__it_builder_route_) — a
    // bare name, or any other prefix, escapes the afterAll delete below and
    // leaks one row per run. That is exactly what happened here twice.
    const BIZ = "__it_builder_route_biz יורם גאון";
    await pool.query(`UPDATE customers SET business_name = $2 WHERE id = $1`, [customerId, BIZ]);

    const ctx = await request(app).get("/api/app/builder/context").set("Authorization", `Bearer ${token}`);
    expect(ctx.status).toBe(200);
    expect(ctx.body.businessName).toBe(BIZ);
  });

  // AIC-103 x AIC-105 — the wizard must not be able to complete a campaign that
  // cannot attribute a lead. Now that creation goes live immediately, an
  // incomplete campaign SPENDS while unable to count a single result.
  it("refuses an incomplete website build as 409, naming the missing fields", async () => {
    const { token, localCampaignId, creativeId } = await readyToBuild("incomplete");
    await agreeBudget(localCampaignId);
    const build = await request(app)
      .post("/api/app/builder/build")
      .set("Authorization", `Bearer ${token}`)
      .send({
        localCampaignId, name: "My Business", dailyBudgetAgorot: 4000,
        specialAdCategories: [], destination: "website", whatsappDestination: "",
        // no destinationUrl — the free_beta_signups_leads failure exactly
        pixelId: "984664453249037", conversionEvent: "COMPLETE_REGISTRATION",
        targeting: { ageMin: 18, ageMax: 45, genders: "female" },
        ads: [{ clientKey: "adset-1-ad-1", name: "Ad 1", creativeId }],
      });

    expect(build.status).toBe(409);
    expect(build.body.code).toBe("campaign_config_incomplete");
    // Names WHICH field, so the operator can fix it instead of guessing.
    expect(build.body.missingFields).toContain("website_url");
    expect(build.status).not.toBe(502);
  });

  it("refuses a build with NO agreed ceiling as 409 with a specific code — never 502", async () => {
    const { token, localCampaignId, creativeId } = await readyToBuild("noceiling");
    // deliberately NO agreeBudget() — this is the real Branch A state
    const build = await buildWithBudget(token, localCampaignId, creativeId, 4000);

    expect(build.status).toBe(409);
    expect(build.body.code).toBe("budget_ceiling_missing");
    // 502 would say "Meta failed" about a problem entirely on our side.
    expect(build.status).not.toBe(502);
  });

  it("refuses an OVER-ceiling build as 409 with its own distinct code", async () => {
    const { token, localCampaignId, creativeId } = await readyToBuild("overceiling");
    await agreeBudget(localCampaignId, 2000);
    const build = await buildWithBudget(token, localCampaignId, creativeId, 9900);

    expect(build.status).toBe(409);
    // A different fix from the missing-ceiling case (lower the number vs.
    // agree one at all), so it must be distinguishable by the client.
    expect(build.body.code).toBe("budget_over_ceiling");
  });

  it("full happy path: start → existing-post creative → build, all ACTIVE and idempotent", async () => {
    vi.stubGlobal("fetch", mockMetaFetch());
    const { customerId, token } = await seedReadyCustomer("happy");

    const start = await request(app).post("/api/app/builder/start").set("Authorization", `Bearer ${token}`);
    expect(start.status).toBe(200);
    const localCampaignId = start.body.localCampaignId as string;
    await agreeBudget(localCampaignId);
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
    // AIC-116: was 'under_review' — "building never activates" was true only
    // while the build created everything PAUSED for a separate launch step.
    // AIC-106 made creation the launch, so the campaign is live here, and the
    // status has to say so or the engine skips it (generation.ts filters on
    // status='active') and the customer's dashboard shows no ads at all.
    // (Activating the Meta objects themselves was AIC-53's job.)
    expect(camp.rows[0].status).toBe("active");

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
    await agreeBudget(localCampaignId);

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
    await agreeBudget(localCampaignId);

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
    await agreeBudget(localCampaignId);

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
