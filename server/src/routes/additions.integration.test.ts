// DB + HTTP integration for adding content to an existing campaign (AIC-63).
// Requires DATABASE_URL; self-skips otherwise. Mocks global fetch (same
// technique as builder.integration.test.ts) so the real adapter runs
// end-to-end through the real HTTP routes without touching Meta.
import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from "vitest";
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

// A shared status map lets an activate POST flip what a later status GET
// reads back — exactly the read-back-verify path approveAddition depends on.
// `hasAds: false` models a deleted / never-published ad set the way Meta really
// reports it (AIC-65, verified live): `effective_status` still says ACTIVE, and
// the `ads` connection field is OMITTED entirely rather than returned empty.
function mockMetaFetch(existingAdSets: Array<{ id: string; name: string; status?: string; hasAds?: boolean }> = []) {
  const statuses = new Map<string, string>(existingAdSets.map((a) => [a.id, a.status ?? "ACTIVE"]));
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";

    if (method === "GET") {
      // Page content needs the Page's own token, fetched from me/accounts first
      // (verified live — see campaign-adapter.test.ts).
      if (u.includes("me/accounts")) {
        return jsonRes({ data: [{ id: "page_1", access_token: "PAGE_TOKEN" }] });
      }
      if (u.includes("/posts?")) {
        return jsonRes({ data: [{ id: "post_1", message: "hi", full_picture: "https://x/p.jpg", created_time: "2026-01-01T00:00:00Z" }] });
      }
      if (u.includes("/adsets?")) {
        return jsonRes({
          data: existingAdSets.map((a) => ({
            id: a.id, name: a.name, is_dynamic_creative: false,
            effective_status: statuses.get(a.id) ?? "ACTIVE", targeting: {},
            // omit `ads` entirely when the ad set has none — Meta's real shape
            ...(a.hasAds === false ? {} : { ads: { data: [{ id: `${a.id}_ad` }] } }),
          })),
        });
      }
      if (u.includes("fields=status")) {
        const id = u.split("/").pop()!.split("?")[0];
        const st = statuses.get(id) ?? "PAUSED";
        return jsonRes({ status: st, effective_status: st });
      }
      throw new Error(`additions.integration.test: unexpected GET ${u}`);
    }

    // POST
    if (u.endsWith("/adimages")) return jsonRes({ images: { "photo.jpg": { hash: "img_hash_1", url: "https://x/photo.jpg" } } });
    if (u.endsWith("/adcreatives")) return jsonRes({ id: `crea_${++counter}` });
    if (u.endsWith("/adsets")) {
      const id = `meta_adset_${++counter}`;
      statuses.set(id, "PAUSED"); // created PAUSED (AIC-50's hard rule)
      return jsonRes({ id });
    }
    if (u.endsWith("/ads")) {
      const id = `meta_ad_${++counter}`;
      statuses.set(id, "PAUSED");
      return jsonRes({ id });
    }
    // Otherwise: an activate call — POST directly to the object id.
    const id = u.split("/").pop()!;
    statuses.set(id, "ACTIVE");
    return jsonRes({ success: true });
  });
  return { fetchMock, statuses };
}

// An EXISTING, already-linked managed campaign — the addition flow's
// precondition, opposite of the builder's no-campaign-yet gate.
async function seedExistingCampaign(tag: string, category = "beautician") {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test, onboarding_status, category) VALUES ($1, true, 'ready', $2) RETURNING id`,
    [`__it_additions_${tag}`, category],
  );
  const customerId = cust.rows[0].id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, password_hash, name, customer_id) VALUES ($1, 'x', 'Owner', $2) RETURNING id`,
    [`__it_additions_${tag}@example.com`, customerId],
  );
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, access_health, page_id) VALUES ($1, 'ok', 'page_it_1') RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id, name) VALUES ($1, $2, 'IT Ad Account') RETURNING id`,
    [conn.rows[0].id, `act_add_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, status, meta_campaign_id, name)
     VALUES ($1, $2, 'active', 'meta_camp_existing', 'IT Campaign') RETURNING id`,
    [customerId, acct.rows[0].id],
  );
  return { customerId, campaignId: camp.rows[0].id, token: signAuthToken(user.rows[0].id) };
}

d("add-to-existing-campaign routes (DB + HTTP)", () => {
  const app = createApp();

  beforeAll(() => {
    process.env.JWT_SECRET ||= "test-secret-additions-routes";
    process.env.META_SYSTEM_USER_TOKEN = "test-meta-token";
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await pool.query(`DELETE FROM app_users WHERE email LIKE '__it_additions_%'`);
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_additions_%'`);
    delete process.env.META_SYSTEM_USER_TOKEN;
    await pool.end();
  });

  it("rejects every route without a token", async () => {
    expect((await request(app).get("/api/app/additions/context")).status).toBe(401);
    expect((await request(app).get("/api/app/additions/ad-sets")).status).toBe(401);
    expect((await request(app).post("/api/app/additions/ad")).status).toBe(401);
  });

  it("/context 409s a customer with no managed campaign yet (the builder's job, not this one)", async () => {
    const notReady = await pool.query<{ id: string }>(
      `INSERT INTO customers (business_name, is_test, onboarding_status) VALUES ('__it_additions_nocamp', true, 'ready') RETURNING id`,
    );
    const nrUser = await pool.query<{ id: string }>(
      `INSERT INTO app_users (email, password_hash, customer_id) VALUES ('__it_additions_nocamp@example.com', 'x', $1) RETURNING id`,
      [notReady.rows[0].id],
    );
    const res = await request(app).get("/api/app/additions/context").set("Authorization", `Bearer ${signAuthToken(nrUser.rows[0].id)}`);
    expect(res.status).toBe(409);
  });

  it("/context 200s with the existing campaign's name + category for a ready customer", async () => {
    const { token } = await seedExistingCampaign("ctx", "restaurant");
    const res = await request(app).get("/api/app/additions/context").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ campaignName: "IT Campaign", category: "restaurant" });
  });

  it("full add-ad flow: list ad sets → create creative → add ad → pending → approve", async () => {
    const { token, campaignId } = await seedExistingCampaign("add-ad");
    const { fetchMock } = mockMetaFetch([{ id: "as_existing_1", name: "Women 18-45", status: "ACTIVE" }]);
    vi.stubGlobal("fetch", fetchMock);

    const adSets = await request(app).get("/api/app/additions/ad-sets").set("Authorization", `Bearer ${token}`);
    expect(adSets.status).toBe(200);
    expect(adSets.body.adSets).toEqual([{ id: "as_existing_1", name: "Women 18-45", status: "active" }]);

    const creative = await request(app)
      .post("/api/app/additions/creative")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientKey: "add-1", name: "New Ad", postId: "post_1" });
    expect(creative.status).toBe(200);

    const add = await request(app)
      .post("/api/app/additions/ad")
      .set("Authorization", `Bearer ${token}`)
      .send({ metaAdSetId: "as_existing_1", name: "New Ad", creativeId: creative.body.creativeId, additionKey: "attempt-1" });
    expect(add.status).toBe(200);
    expect(add.body.metaAdSetId).toBe("as_existing_1");

    const pending = await request(app).get("/api/app/additions/pending").set("Authorization", `Bearer ${token}`);
    expect(pending.body.pending).toHaveLength(1);
    expect(pending.body.pending[0]).toMatchObject({ kind: "ad", name: "New Ad" });

    const approve = await request(app).post(`/api/app/additions/${add.body.additionId}/approve`).set("Authorization", `Bearer ${token}`);
    expect(approve.status).toBe(200);
    expect(approve.body).toEqual({ outcome: "approved" });

    const pendingAfter = await request(app).get("/api/app/additions/pending").set("Authorization", `Bearer ${token}`);
    expect(pendingAfter.body.pending).toHaveLength(0);

    const camp = await pool.query(`SELECT meta_campaign_id FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(camp.rows[0].meta_campaign_id).toBe("meta_camp_existing"); // never touched — no new campaign
  });

  it("rejects adding an ad to an ad set that isn't the caller's", async () => {
    const { token } = await seedExistingCampaign("wrong-adset");
    const { fetchMock } = mockMetaFetch([{ id: "as_real", name: "Real", status: "ACTIVE" }]);
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(app)
      .post("/api/app/additions/ad")
      .set("Authorization", `Bearer ${token}`)
      .send({ metaAdSetId: "as_not_mine", name: "Ad", creativeId: "crea_1", additionKey: "k1" });
    expect(res.status).toBe(404);
  });

  it("full add-ad-set flow: audience + 2 ads → pending → approve activates ad set and both ads", async () => {
    const { token } = await seedExistingCampaign("add-adset");
    const { fetchMock } = mockMetaFetch();
    vi.stubGlobal("fetch", fetchMock);

    const c1 = await request(app).post("/api/app/additions/creative").set("Authorization", `Bearer ${token}`).send({ clientKey: "c1", name: "Ad A", postId: "post_1" });
    const c2 = await request(app).post("/api/app/additions/creative").set("Authorization", `Bearer ${token}`).send({ clientKey: "c2", name: "Ad B", postId: "post_1" });

    const addSet = await request(app)
      .post("/api/app/additions/ad-set")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Older women",
        targeting: { ageMin: 35, ageMax: 55, genders: "female" },
        ads: [
          { clientKey: "c1", name: "Ad A", creativeId: c1.body.creativeId },
          { clientKey: "c2", name: "Ad B", creativeId: c2.body.creativeId },
        ],
        additionKey: "attempt-2",
      });
    expect(addSet.status).toBe(200);
    expect(addSet.body.metaAdIds).toHaveLength(2);

    const approve = await request(app).post(`/api/app/additions/${addSet.body.additionId}/approve`).set("Authorization", `Bearer ${token}`);
    expect(approve.body).toEqual({ outcome: "approved" });
  });

  // AIC-65 reached the engine tick but NOT these customer-facing routes — found
  // live on 2026-08-12 when the real dead GelNails ad set was still offered in
  // the add-ad picker. An ad added to a dead ad set would never deliver.
  it("never offers a dead/never-published ad set, and refuses one passed by id", async () => {
    const { token, campaignId } = await seedExistingCampaign("deadadset");
    const { fetchMock } = mockMetaFetch([
      { id: "as_real", name: "Women 18-45" },
      { id: "as_dead", name: "Deleted draft", hasAds: false },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const list = await request(app).get("/api/app/additions/ad-sets").set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.adSets.map((a: { id: string }) => a.id)).toEqual(["as_real"]);

    // ...and the id is rejected even if a client sends it directly (the ad-set
    // check runs before anything is created, so a placeholder creative id is
    // enough to prove the guard fires).
    const res = await request(app)
      .post("/api/app/additions/ad")
      .set("Authorization", `Bearer ${token}`)
      .send({ metaAdSetId: "as_dead", name: "Ad", creativeId: "crea_placeholder", additionKey: "k1" });
    expect(res.status).toBe(404);

    const pending = await pool.query(`SELECT count(*)::int AS n FROM pending_additions WHERE campaign_id = $1`, [campaignId]);
    expect(pending.rows[0].n).toBe(0); // nothing created against a dead ad set
  });

  it("503s honestly with no META_SYSTEM_USER_TOKEN configured", async () => {
    const saved = process.env.META_SYSTEM_USER_TOKEN;
    delete process.env.META_SYSTEM_USER_TOKEN;
    try {
      const { token } = await seedExistingCampaign("no-token");
      const res = await request(app).get("/api/app/additions/ad-sets").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(503);
    } finally {
      process.env.META_SYSTEM_USER_TOKEN = saved;
    }
  });
});
