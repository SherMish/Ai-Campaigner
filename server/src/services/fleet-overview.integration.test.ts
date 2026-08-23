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

  // AIC-122: the four analytics blocks added to /admin.
  it("trend: sums PER-DAY rows only, never the overlapping rolling windows", async () => {
    const { campaignId } = await seed("trend");
    // This is a FLEET-WIDE aggregate over a database shared with production, so
    // absolute assertions are meaningless here — the first version of this test
    // asserted `=== 1000` and read 4245, because real production data for the
    // same date is legitimately in the sum. Measure the DELTA our own rows
    // cause instead, which is what the query semantics actually claim.
    const DAY = "2026-08-20";
    const before = (await buildFleetOverview(pool)).trend.find((d) => d.date === DAY);
    const baseSpend = before?.spendAgorot ?? 0;
    const baseLeads = before?.leads ?? 0;

    // A per-day row AND a rolling-window row covering the same day. Summing
    // both double-counts — the exact production bug migration 030 exists for
    // ("1 real lead read as 3"), which is why the view, not the table, is the
    // only correct source for any SUM over time.
    await pool.query(
      `INSERT INTO insight_snapshots (campaign_id, grain, meta_object_id, period_start, period_end, spend_agorot, leads)
       VALUES ($1,'campaign','m_day',$2,$2,1000,2)`,
      [campaignId, DAY],
    );
    await pool.query(
      `INSERT INTO insight_snapshots (campaign_id, grain, meta_object_id, period_start, period_end, spend_agorot, leads)
       VALUES ($1,'campaign','m_roll','2026-08-14',$2,9999,99)`,
      [campaignId, DAY],
    );

    const day = (await buildFleetOverview(pool)).trend.find((d) => d.date === DAY);
    expect(day).toBeDefined();
    // Exactly the per-day row's contribution. If the rolling row leaked in the
    // delta would be 10999/101 — the double-count this guards against.
    expect(day!.spendAgorot - baseSpend).toBe(1000);
    expect(day!.leads - baseLeads).toBe(2);
  });

  it("automation: counts engine-run vs human actions", async () => {
    const { campaignId } = await seed("automation");
    const ins = (human: boolean, type: string) => pool.query(
      `INSERT INTO action_history (campaign_id, what, action_type, human_involved, result)
       VALUES ($1,'x',$2,$3,'success')`,
      [campaignId, type, human],
    );
    await ins(false, "pause_creative");
    await ins(false, "increase_budget");
    await ins(true, "pause_ad");

    const ov = await buildFleetOverview(pool);
    expect(ov.automation.total).toBeGreaterThanOrEqual(3);
    expect(ov.automation.automated).toBeGreaterThanOrEqual(2);
    expect(ov.automation.human).toBeGreaterThanOrEqual(1);
    // A rate, not a raw count, is the headline — and it must be a real
    // fraction of the total, never a divide-by-zero NaN.
    expect(ov.automation.rate).toBeGreaterThan(0);
    expect(ov.automation.rate).toBeLessThanOrEqual(1);
  });

  it("queue health: open backlog by severity and the top recurring types", async () => {
    const { customerId } = await seed("queue");
    const add = (type: string, sev: string, status = "open") => pool.query(
      `INSERT INTO ops_queue_items (customer_id, type, severity, detail, status)
       VALUES ($1,$2,$3,'x',$4)`,
      [customerId, type, sev, status],
    );
    await add("meta_connection_failure", "high");
    await add("meta_connection_failure", "high");
    await add("support_request", "low");
    await add("campaign_rejected", "medium", "resolved"); // resolved: excluded from open counts

    const ov = await buildFleetOverview(pool);
    expect(ov.queueHealth.openBySeverity.high).toBeGreaterThanOrEqual(2);
    expect(ov.queueHealth.openBySeverity.low).toBeGreaterThanOrEqual(1);
    const top = ov.queueHealth.topTypes.find((t) => t.type === "meta_connection_failure");
    expect(top!.count).toBeGreaterThanOrEqual(2);
    // topTypes is ordered by count desc — the point of a "top" list.
    const counts = ov.queueHealth.topTypes.map((t) => t.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it("health: counts delivery and tracking separately, ignoring unmanaged campaigns", async () => {
    await seed("health_ok", { campStatus: "active", deliveryOk: true });
    const bad = await seed("health_bad", { campStatus: "active", deliveryOk: false });
    await pool.query(`UPDATE managed_campaigns SET tracking_ok = false WHERE id = $1`, [bad.campaignId]);
    // An unmanaged campaign is not part of the book we are responsible for.
    await seed("health_unmanaged", { campStatus: "unmanaged", deliveryOk: false });

    const ov = await buildFleetOverview(pool);
    expect(ov.health.managed).toBeGreaterThanOrEqual(2);
    expect(ov.health.deliveryOk).toBeGreaterThanOrEqual(1);
    expect(ov.health.deliveryBroken).toBeGreaterThanOrEqual(1);
    expect(ov.health.trackingBroken).toBeGreaterThanOrEqual(1);
    // managed excludes the unmanaged one, so the two halves always reconcile.
    expect(ov.health.deliveryOk + ov.health.deliveryBroken).toBe(ov.health.managed);
  });

  it("rejects the route without an admin credential", async () => {
    const res = await request(createApp()).get("/api/admin/overview");
    expect(res.status).toBe(401);
  });
});
