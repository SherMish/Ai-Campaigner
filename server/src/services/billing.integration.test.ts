// DB integration for manual billing + weekly lead-quality (AIC-19). Requires
// DATABASE_URL.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { updateBilling, conversionSummary, upsertLeadQuality, listLeadQuality, leadQualityResponseRate } from "./billing.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function makeCampaign(business: string): Promise<{ campaignId: string; customerId: string }> {
  const cust = await pool.query<{ id: string }>(`INSERT INTO customers (business_name, is_test) VALUES ($1, false) RETURNING id`, [business]);
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id) VALUES ($1) RETURNING id`, [customerId]);
  const acct = await pool.query<{ id: string }>(`INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`, [conn.rows[0].id, `act_bl_${conn.rows[0].id.slice(0,8)}`]);
  const camp = await pool.query<{ id: string }>(`INSERT INTO managed_campaigns (customer_id, ad_account_id, status) VALUES ($1,$2,'active') RETURNING id`, [customerId, acct.rows[0].id]);
  return { campaignId: camp.rows[0].id, customerId };
}

d("billing + lead-quality (DB)", () => {
  const ids: string[] = [];
  afterAll(async () => {
    for (const id of ids) await pool.query(`DELETE FROM customers WHERE id = $1`, [id]);
    await pool.end();
  });

  it("tracks manual billing and reads setup→subscription conversion", async () => {
    const { customerId } = await makeCampaign("__it_bill A"); ids.push(customerId);
    await updateBilling(pool, customerId, { setupPaid: true, setupPaidAt: "2026-08-01", status: "active", nextChargeDate: "2026-09-01" });

    const { rows } = await pool.query<{ setup_paid: boolean; status: string; next_charge_date: Date }>(
      `SELECT setup_paid, status, next_charge_date FROM subscriptions WHERE customer_id = $1`, [customerId]);
    expect(rows[0].setup_paid).toBe(true);
    expect(rows[0].status).toBe("active");

    const conv = await conversionSummary(pool);
    expect(conv.setupPaid).toBeGreaterThanOrEqual(1);
    expect(conv.subscribed).toBeGreaterThanOrEqual(1);
    expect(conv.setupToSubscriptionRate).not.toBeNull();
  });

  it("captures weekly lead-quality idempotently and computes response rate", async () => {
    const { campaignId, customerId } = await makeCampaign("__it_bill B"); ids.push(customerId);
    await upsertLeadQuality(pool, { campaignId, weekStart: "2026-07-27", leadsReported: 12, relevantCount: 7, customersWon: 2 });
    // re-answer same week → updates in place, not duplicate
    await upsertLeadQuality(pool, { campaignId, weekStart: "2026-07-27", leadsReported: 12, relevantCount: 9 });

    const weeks = await listLeadQuality(pool, campaignId);
    expect(weeks).toHaveLength(1);
    expect(weeks[0].relevantCount).toBe(9);

    const rr = await leadQualityResponseRate(pool, "2026-07-27");
    expect(rr.answered).toBeGreaterThanOrEqual(1);
    expect(rr.active).toBeGreaterThanOrEqual(1);
    expect(rr.rate).not.toBeNull();
  });
});
