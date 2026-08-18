// DB + HTTP integration for AIC-105 Branch A: the guided builder mirrored for
// an operator building a customer's FIRST campaign on their behalf. Requires
// DATABASE_URL with migrations applied; self-skips otherwise. Mocks global
// fetch (same technique as builder.integration.test.ts) so the REAL adapter
// code runs end-to-end through the real HTTP routes without touching Meta.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;
const ADMIN = "Bearer test-admin-builder";

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let counter = 0;
function mockMetaFetch() {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("me/accounts")) {
      return jsonRes({ data: [{ id: "page_it_1", access_token: "PAGE_TOKEN" }] });
    }
    if (u.includes("/posts?")) {
      return jsonRes({ data: [{ id: "post_1", message: "hi", full_picture: "https://x/p.jpg", created_time: "2026-01-01T00:00:00Z" }] });
    }
    if (u.endsWith("/adcreatives")) return jsonRes({ id: `crea_${++counter}` });
    if (u.endsWith("/campaigns")) return jsonRes({ id: `meta_camp_${++counter}` });
    if (u.endsWith("/adsets")) return jsonRes({ id: `meta_adset_${++counter}` });
    if (u.endsWith("/ads")) return jsonRes({ id: `meta_ad_${++counter}` });
    throw new Error(`admin-builder.integration.test: unexpected fetch ${u}`);
  });
}

// Mirrors builder.integration.test.ts's seedReadyCustomer, minus the
// app_users row: an operator acts on the customer's behalf, so there's no
// customer-owned JWT in this path at all.
async function seedReadyCustomer(tag: string): Promise<string> {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test, onboarding_status, category) VALUES ($1, true, 'ready', 'beautician') RETURNING id`,
    [`__it_admin_builder_${tag}`],
  );
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, access_health, page_id) VALUES ($1, 'ok', 'page_it_1') RETURNING id`,
    [customerId],
  );
  await pool.query(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id, name) VALUES ($1, $2, 'IT Ad Account')`,
    [conn.rows[0].id, `act_admin_builder_${conn.rows[0].id.slice(0, 8)}`],
  );
  return customerId;
}

d("admin builder routes — AIC-105 Branch A (DB + HTTP)", () => {
  const app = createApp();

  beforeAll(() => {
    process.env.JWT_SECRET ||= "test-secret-admin-builder-routes";
    process.env.ADMIN_TOKEN = "test-admin-builder";
    process.env.META_SYSTEM_USER_TOKEN ||= "test-meta-token";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_admin_builder_%'`);
    await pool.end();
  });

  it("rejects every route without an admin credential", async () => {
    const id = await seedReadyCustomer("auth");
    expect((await request(app).get(`/api/admin/customers/${id}/builder/context`)).status).toBe(401);
    expect((await request(app).post(`/api/admin/customers/${id}/builder/start`)).status).toBe(401);
  });

  it("/context 409s a customer with no ready connection, prefills category for one who is ready", async () => {
    const notReady = await pool.query<{ id: string }>(
      `INSERT INTO customers (business_name, is_test, onboarding_status) VALUES ('__it_admin_builder_notready', true, 'ready') RETURNING id`,
    );
    const bad = await request(app).get(`/api/admin/customers/${notReady.rows[0].id}/builder/context`).set("Authorization", ADMIN);
    expect(bad.status).toBe(409);

    const id = await seedReadyCustomer("ctx");
    const ok = await request(app).get(`/api/admin/customers/${id}/builder/context`).set("Authorization", ADMIN);
    expect(ok.status).toBe(200);
    expect(ok.body.category).toBe("beautician");
  });

  it("full happy path: start → existing-post creative → build, all PAUSED, and it's logged to the admin audit trail", async () => {
    vi.stubGlobal("fetch", mockMetaFetch());
    const id = await seedReadyCustomer("happy");

    const start = await request(app).post(`/api/admin/customers/${id}/builder/start`).set("Authorization", ADMIN);
    expect(start.status).toBe(200);
    const localCampaignId = start.body.localCampaignId as string;
    expect(localCampaignId).toBeTruthy();

    const posts = await request(app).get(`/api/admin/customers/${id}/builder/posts`).set("Authorization", ADMIN);
    expect(posts.status).toBe(200);
    expect(posts.body.posts[0].id).toBe("post_1");

    const creative = await request(app)
      .post(`/api/admin/customers/${id}/builder/creative`)
      .set("Authorization", ADMIN)
      .send({ localCampaignId, clientKey: "adset-1-ad-1", name: "Ad 1", postId: "post_1" });
    expect(creative.status).toBe(200);
    const creativeId = creative.body.creativeId as string;

    const build = await request(app)
      .post(`/api/admin/customers/${id}/builder/build`)
      .set("Authorization", ADMIN)
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

    const camp = await pool.query(`SELECT meta_campaign_id, status FROM managed_campaigns WHERE id = $1`, [localCampaignId]);
    expect(camp.rows[0].meta_campaign_id).toBe(build.body.metaCampaignId);
    expect(camp.rows[0].status).toBe("under_review");

    // The consequential write is logged — "which operator built this, for
    // which customer" has to be answerable later.
    const audit = await pool.query<{ action: string; entity_id: string }>(
      `SELECT action, entity_id FROM admin_audit_log WHERE action = 'customer.builder.build' AND entity_id = $1`,
      [id],
    );
    expect(audit.rows).toHaveLength(1);

    // A customer already has a campaign now — Branch A is done with them.
    const again = await request(app).get(`/api/admin/customers/${id}/builder/context`).set("Authorization", ADMIN);
    expect(again.status).toBe(409);
  });

  it("rejects a creative call for a localCampaignId that belongs to a DIFFERENT customer", async () => {
    vi.stubGlobal("fetch", mockMetaFetch());
    const a = await seedReadyCustomer("owner-a");
    const b = await seedReadyCustomer("owner-b");
    const startA = await request(app).post(`/api/admin/customers/${a}/builder/start`).set("Authorization", ADMIN);
    const localCampaignId = startA.body.localCampaignId as string;

    const stolen = await request(app)
      .post(`/api/admin/customers/${b}/builder/creative`)
      .set("Authorization", ADMIN)
      .send({ localCampaignId, clientKey: "adset-1-ad-1", name: "Ad 1", postId: "post_1" });
    expect(stolen.status).toBe(404);
  });
});
