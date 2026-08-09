// DB + HTTP integration for the fleet overview (AIC-43). Requires DATABASE_URL.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { buildFleetOverview } from "./fleet-overview.js";
import { rollingPeriods } from "../meta/scheduled-ingestion.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;
const ADMIN = "Bearer test-admin";
const { current: CUR } = rollingPeriods();

async function seed(tag: string, o: { isTest?: boolean; setupPaid?: boolean; subStatus?: string; campStatus?: string; deliveryOk?: boolean } = {}) {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test) VALUES ($1,$2) RETURNING id`,
    [`__it_fleet_${tag}`, o.isTest ?? false],
  );
  const customerId = cust.rows[0].id;
  await pool.query(
    `INSERT INTO subscriptions (customer_id, setup_paid, status) VALUES ($1,$2,$3)`,
    [customerId, o.setupPaid ?? false, o.subStatus ?? "pending"],
  );
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, system_user_id, access_health) VALUES ($1,'9','ok') RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_fleet_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, name, status, delivery_ok, agreed_budget_agorot)
     VALUES ($1,$2,$3,$4,$5,1000) RETURNING id`,
    [customerId, acct.rows[0].id, `camp_${tag}`, o.campStatus ?? "active", o.deliveryOk ?? true],
  );
  return { customerId, campaignId: camp.rows[0].id };
}

d("fleet overview (DB + HTTP)", () => {
  beforeAll(() => { process.env.ADMIN_TOKEN = "test-admin"; });
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_fleet_%'`);
    await pool.end();
  });

  it("aggregates campaigns-by-status, delivery health, spend/leads, queue depth, and excludes test customers from conversion", async () => {
    const real = await seed("real", { isTest: false, setupPaid: true, subStatus: "active" });
    await seed("dogfood", { isTest: true, campStatus: "active", deliveryOk: false });
    await pool.query(
      `INSERT INTO insight_snapshots (campaign_id, grain, meta_object_id, period_start, period_end, spend_agorot, leads)
       VALUES ($1,'campaign','m1',$2,$3,5000,3)`,
      [real.campaignId, CUR.start, CUR.end],
    );
    await pool.query(
      `INSERT INTO ops_queue_items (customer_id, type, severity, detail) VALUES ($1,'campaign_not_delivering','high','x')`,
      [real.customerId],
    );

    const ov = await buildFleetOverview(pool);
    expect(ov.campaignsByStatus.active).toBeGreaterThanOrEqual(2);
    expect(ov.delivering).toBeGreaterThanOrEqual(1);
    expect(ov.needsAttentionDelivery).toBeGreaterThanOrEqual(1); // the dogfood one
    expect(ov.spendAgorot).toBeGreaterThanOrEqual(5000);
    expect(ov.leads).toBeGreaterThanOrEqual(3);
    expect(ov.openOpsItems).toBeGreaterThanOrEqual(1);
    // conversion counts only the real (non-test) customer.
    expect(ov.conversion.customers).toBeGreaterThanOrEqual(1);

    const res = await request(createApp()).get("/api/admin/overview").set("Authorization", ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.spendAgorot).toBeGreaterThanOrEqual(5000);
  });

  it("rejects the route without an admin credential", async () => {
    const res = await request(createApp()).get("/api/admin/overview");
    expect(res.status).toBe(401);
  });
});
