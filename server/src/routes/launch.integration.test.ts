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
// `adIds` drives the LIVE ad count the launch gate now reads from Meta (it
// used to be COUNT(*) over our own action_history `create_ad` rows, which
// reads 0 for any campaign connected from outside our builder). `host` drives
// the pixel-domain lookup; null simulates a pixel with no recent traffic.
function metaFetch(state: { status: string }, adIds: string[] = ["ad_1", "ad_2"], host: string | null = "example.com") {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST") {
      const body = new URLSearchParams(String(init?.body ?? ""));
      if (body.get("status") === "ACTIVE") state.status = "ACTIVE";
      return jsonRes({ success: true });
    }
    if (u.includes("/stats?aggregation=host")) {
      return jsonRes(host ? { data: [{ data: [{ value: host, count: 42 }] }] } : { data: [] });
    }
    // Both `status` (getCampaignState) and `effective_status` (getDeliveryHealth
    // — a genuinely different Meta field convention) — real Meta responses
    // carry both, and the mock must too or one consumer sees an undefined status.
    if (u.includes("/adsets?")) return jsonRes({ data: [{ id: "as_1", status: "ACTIVE", effective_status: "ACTIVE" }] });
    // adset_id is what getDeliveryHealth's ad-level rollup keys on — without
    // it every ad is silently unattributed and deliveringAdCount stays 0.
    if (u.includes("/ads?")) return jsonRes({ data: adIds.map((id) => ({ id, status: "ACTIVE", effective_status: "ACTIVE", adset_id: "as_1" })) });
    if (u.includes("fields=status")) return jsonRes({ status: state.status, effective_status: state.status });
    if (u.includes("fields=daily_budget")) return jsonRes({ daily_budget: "4000", effective_status: state.status, name: "My Campaign" });
    throw new Error(`launch.integration.test: unexpected fetch ${method} ${u}`);
  });
}

async function seedPendingLaunch(
  tag: string,
  status = "active",
  launched = false,
  metaId: string | null = `meta_camp_${tag}`,
  lead: { whatsappDestination: string; leadEventTypes: string[]; trackingPixelId: string | null } = {
    whatsappDestination: "972500000000",
    leadEventTypes: ["onsite_conversion.messaging_conversation_started_7d", "onsite_conversion.messaging_conversation_started"],
    trackingPixelId: null,
  },
) {
  const cust = await pool.query<{ id: string }>(`INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`, [`__it_launchroute_${tag}`]);
  const customerId = cust.rows[0].id;
  const user = await pool.query<{ id: string }>(`INSERT INTO app_users (email, password_hash, customer_id) VALUES ($1, 'x', $2) RETURNING id`, [`__it_launchroute_${tag}@example.com`, customerId]);
  const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id, access_health) VALUES ($1, 'ok') RETURNING id`, [customerId]);
  const acct = await pool.query<{ id: string }>(`INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1, $2) RETURNING id`, [conn.rows[0].id, `act_lr_${conn.rows[0].id.slice(0, 8)}`]);
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, name, status, meta_campaign_id, agreed_budget_agorot, budget_period, whatsapp_destination, lead_event_types, tracking_pixel_id, launch_approved_at)
     VALUES ($1,$2,'My Campaign',$3,$4,4000,'daily',$5,$6,$7,$8) RETURNING id`,
    [customerId, acct.rows[0].id, status, metaId, lead.whatsappDestination, lead.leadEventTypes, lead.trackingPixelId, launched ? new Date() : null],
  );
  // Deliberately NO `create_ad` action_history rows: the ad count now comes
  // from live Meta state, so a campaign we didn't build must still report its
  // real ads. Seeding builder rows here would hide exactly the bug being fixed.
  return { customerId, token: signAuthToken(user.rows[0].id), campaignId: camp.rows[0].id };
}

d("launch gate routes (DB + HTTP)", () => {
  const app = createApp();

  beforeAll(() => {
    process.env.JWT_SECRET ||= "test-secret-launch-routes-padding-to-32-chars-minimum";
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

  it("GET /launch returns the pending summary with the LIVE ad count and budget", async () => {
    vi.stubGlobal("fetch", metaFetch({ status: "PAUSED" }));
    const { token } = await seedPendingLaunch("summary");
    const res = await request(app).get("/api/app/launch").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.launch).toMatchObject({
      name: "My Campaign",
      dailyBudgetAgorot: 4000,
      adCount: 2, // from Meta's /ads, not from our action_history
      destination: { kind: "whatsapp", whatsappNumber: "972500000000" },
      blockers: [],
    });
  });

  // The bug this suite now pins: a campaign whose leads are Pixel conversions
  // used to render a hardcoded "leads to WhatsApp" label with a BLANK value,
  // on the screen where real spend is authorised.
  it("a Pixel campaign reports a website destination, never a blank WhatsApp one", async () => {
    vi.stubGlobal("fetch", metaFetch({ status: "PAUSED" }, ["ad_1"], "pisga.app"));
    const { token } = await seedPendingLaunch("pixel", "active", false, "meta_camp_pixel", {
      whatsappDestination: "",
      leadEventTypes: ["offsite_conversion.fb_pixel_complete_registration"],
      trackingPixelId: "984664453249037",
    });
    const res = await request(app).get("/api/app/launch").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.launch.destination).toEqual({
      kind: "website",
      eventKey: "COMPLETE_REGISTRATION",
      domain: "pisga.app",
    });
    expect(res.body.launch.blockers).toEqual([]);
  });

  it("blocks approval when Meta reports zero live ads", async () => {
    vi.stubGlobal("fetch", metaFetch({ status: "PAUSED" }, [])); // no ads
    const { token } = await seedPendingLaunch("noads");
    const res = await request(app).get("/api/app/launch").set("Authorization", `Bearer ${token}`);
    expect(res.body.launch).toMatchObject({ adCount: 0, blockers: ["no_ads"] });
  });

  it("refuses to activate a blocked campaign even if the client posts anyway", async () => {
    // The disabled button is a courtesy; this is the gate.
    vi.stubGlobal("fetch", metaFetch({ status: "PAUSED" }, []));
    const { token } = await seedPendingLaunch("blockedpost");
    const res = await request(app).post("/api/app/launch/approve").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect(res.body.blockers).toEqual(["no_ads"]);
  });

  it("blocks approval when the destination can't be determined", async () => {
    vi.stubGlobal("fetch", metaFetch({ status: "PAUSED" }));
    const { token } = await seedPendingLaunch("nodest", "active", false, "meta_camp_nodest", {
      whatsappDestination: "",
      leadEventTypes: [],
      trackingPixelId: null,
    });
    const res = await request(app).get("/api/app/launch").set("Authorization", `Bearer ${token}`);
    expect(res.body.launch.destination).toEqual({ kind: "unknown" });
    expect(res.body.launch.blockers).toContain("unknown_destination");
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

  // REGRESSION (real, found 2026-08-15 live): activateCampaign only writes to
  // Meta — the cached delivery/status columns weren't refreshed until the
  // next hourly engine tick, so a customer who just approved launch (real
  // ads genuinely went ACTIVE on Meta seconds earlier) saw the dashboard
  // confidently claim "לא מתפרסם / אין כרגע מודעות שמוצגות" (nothing is
  // showing) right after taking the single most consequential action they
  // can take. Same refresh-in-request fix AIC-71 already applied to manual
  // pause/resume (delivery-monitor.ts's own doc comment predicts this exact
  // symptom for any write that skips it).
  it("refreshes delivery/status within the SAME request — no stale 'stopped' after a real launch", async () => {
    const state = { status: "PAUSED" };
    // 2 genuinely active ads under one ad set — the real post-launch Meta shape.
    vi.stubGlobal("fetch", metaFetch(state, ["ad_1", "ad_2"]));
    const { token, campaignId } = await seedPendingLaunch("refresh");
    // Simulate the stale cache the real bug showed: the last tick ran BEFORE
    // launch, while the campaign was still paused.
    await pool.query(
      `UPDATE managed_campaigns SET delivery_ok = true, delivering = false, delivering_ad_count = 0 WHERE id = $1`,
      [campaignId],
    );

    const res = await request(app).post("/api/app/launch/approve").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("activated");

    const row = await pool.query<{ delivering: boolean; delivering_ad_count: number }>(
      `SELECT delivering, delivering_ad_count FROM managed_campaigns WHERE id = $1`,
      [campaignId],
    );
    // The stale false/0 must be gone — refreshed within this same request,
    // not left for the next hourly tick.
    expect(row.rows[0].delivering).toBe(true);
    expect(row.rows[0].delivering_ad_count).toBe(2);
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
