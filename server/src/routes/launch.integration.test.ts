// DB + HTTP integration for the launch gate's customer routes (AIC-53).
// Requires DATABASE_URL; self-skips otherwise. Mocks global fetch so the real
// adapter runs through the real routes without touching Meta.
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

// A fetch mock that serves a campaign PAUSED until activated, then ACTIVE.
function metaFetch(state: { status: string }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") {
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (body.get("status") === "ACTIVE") state.status = "ACTIVE";
      return jsonRes({ success: true });
    }
    if (u.includes("fields=status")) return jsonRes({ status: state.status, effective_status: state.status });
    throw new Error(`launch.integration.test: unexpected fetch ${method} ${u}`);
  });
}

async function seedPendingLaunch(tag: string, status = "active", launched = false, metaId: string | null = `meta_camp_${tag}`) {
  const cust = await pool.query<{ id: string }>(`INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`, [`__it_launchroute_${tag}`]);
  const customerId = cust.rows[0].id;
  const user = await pool.query<{ id: string }>(`INSERT INTO app_users (email, password_hash, customer_id) VALUES ($1, 'x', $2) RETURNING id`, [`__it_launchroute_${tag}@example.com`, customerId]);
  const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id, access_health) VALUES ($1, 'ok') RETURNING id`, [customerId]);
  const acct = await pool.query<{ id: string }>(`INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1, $2) RETURNING id`, [conn.rows[0].id, `act_lr_${conn.rows[0].id.slice(0, 8)}`]);
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, name, status, meta_campaign_id, agreed_budget_agorot, budget_period, whatsapp_destination, launch_approved_at)
     VALUES ($1,$2,'My Campaign',$3,$4,4000,'daily','972500000000',$5) RETURNING id`,
    [customerId, acct.rows[0].id, status, metaId, launched ? new Date() : null],
  );
  // Two created-ad rows so adCount = 2.
  for (const t of ["a", "b"]) {
    await pool.query(
      `INSERT INTO action_history (campaign_id, what, action_type, previous_state, new_state, human_involved, result)
       VALUES ($1, 'created ad', 'create_ad', '{}'::jsonb, '{}'::jsonb, true, 'success')`,
      [camp.rows[0].id],
    );
    void t;
  }
  return { customerId, token: signAuthToken(user.rows[0].id), campaignId: camp.rows[0].id };
}

d("launch gate routes (DB + HTTP)", () => {
  const app = createApp();

  beforeAll(() => {
    process.env.JWT_SECRET ||= "test-secret-launch-routes";
    process.env.META_SYSTEM_USER_TOKEN = "test-meta-token";
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    await pool.query(`DELETE FROM app_users WHERE email LIKE '__it_launchroute_%'`);
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_launchroute_%'`);
    delete process.env.META_SYSTEM_USER_TOKEN;
    await pool.end();
  });

  it("rejects both routes without a token", async () => {
    expect((await request(app).get("/api/app/launch")).status).toBe(401);
    expect((await request(app).post("/api/app/launch/approve")).status).toBe(401);
  });

  it("GET /launch returns the pending summary with the ad count and budget", async () => {
    const { token } = await seedPendingLaunch("summary");
    const res = await request(app).get("/api/app/launch").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.launch).toMatchObject({ name: "My Campaign", dailyBudgetAgorot: 4000, adCount: 2, whatsappDestination: "972500000000" });
  });

  it("GET /launch returns null when nothing is pending (already launched)", async () => {
    const { token } = await seedPendingLaunch("done", "active", true);
    const res = await request(app).get("/api/app/launch").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.launch).toBeNull();
  });

  it("POST /launch/approve activates a pending campaign and flips it to ACTIVE on Meta", async () => {
    const state = { status: "PAUSED" };
    vi.stubGlobal("fetch", metaFetch(state));
    const { token, campaignId } = await seedPendingLaunch("approve");

    const res = await request(app).post("/api/app/launch/approve").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("activated");
    expect(state.status).toBe("ACTIVE");

    const row = await pool.query(`SELECT launch_approved_at FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(row.rows[0].launch_approved_at).toBeTruthy();

    // The overview now no longer reports it as pending.
    const summary = await request(app).get("/api/app/launch").set("Authorization", `Bearer ${token}`);
    expect(summary.body.launch).toBeNull();
  });

  it("POST /launch/approve 404s when there's nothing to launch", async () => {
    const { token } = await seedPendingLaunch("nothing", "active", true);
    const res = await request(app).post("/api/app/launch/approve").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("a campaign still under_review is NOT offered for launch (review must pass first)", async () => {
    const { token } = await seedPendingLaunch("underreview", "under_review");
    const res = await request(app).get("/api/app/launch").set("Authorization", `Bearer ${token}`);
    expect(res.body.launch).toBeNull();
  });

  it("503s honestly when no META_SYSTEM_USER_TOKEN is configured", async () => {
    const saved = process.env.META_SYSTEM_USER_TOKEN;
    delete process.env.META_SYSTEM_USER_TOKEN;
    try {
      const { token } = await seedPendingLaunch("notoken");
      const res = await request(app).post("/api/app/launch/approve").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(503);
    } finally {
      process.env.META_SYSTEM_USER_TOKEN = saved;
    }
  });
});
