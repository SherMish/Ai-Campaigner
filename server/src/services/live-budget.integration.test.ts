// DB integration for the live-budget sync (fixes a real customer-reported
// bug: dashboard showed a stale budget once someone changed it directly on
// Meta). Requires DATABASE_URL; self-skips otherwise.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { recordLiveBudget } from "./live-budget.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function seed(tag: string, agreedBudgetAgorot: number): Promise<string> {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`,
    [`__it_lb_${tag}`],
  );
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, system_user_id, access_health) VALUES ($1,'9','ok') RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_lb_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, meta_campaign_id, name, status, agreed_budget_agorot)
     VALUES ($1,$2,'m','C','active',$3) RETURNING id`,
    [customerId, acct.rows[0].id, agreedBudgetAgorot],
  );
  return camp.rows[0].id;
}

d("recordLiveBudget (DB)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_lb_%'`);
    await pool.end();
  });

  it("caches the live read for display", async () => {
    const campaignId = await seed("t1", 1000);
    await recordLiveBudget({ pool, campaignId, liveBudgetAgorot: 1000 });
    const row = await pool.query(`SELECT live_budget_agorot, agreed_budget_agorot FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(row.rows[0]).toMatchObject({ live_budget_agorot: 1000, agreed_budget_agorot: 1000 });
  });

  it("auto-RAISES the agreed ceiling when live budget exceeds it (the GelNails bug)", async () => {
    const campaignId = await seed("t2", 1000); // ₪10/day ceiling
    await recordLiveBudget({ pool, campaignId, liveBudgetAgorot: 3000 }); // customer raised it to ₪30 directly on Meta
    const row = await pool.query(`SELECT live_budget_agorot, agreed_budget_agorot FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(row.rows[0]).toMatchObject({ live_budget_agorot: 3000, agreed_budget_agorot: 3000 });
  });

  it("never auto-LOWERS the ceiling — preserves a forward-authorized higher ceiling until Meta catches up", async () => {
    const campaignId = await seed("t3", 5000); // admin pre-authorized ₪50/day for a future increase
    await recordLiveBudget({ pool, campaignId, liveBudgetAgorot: 1000 }); // Meta is still at ₪10 today
    const row = await pool.query(`SELECT live_budget_agorot, agreed_budget_agorot FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(row.rows[0]).toMatchObject({ live_budget_agorot: 1000, agreed_budget_agorot: 5000 });
  });

  it("updates live_budget_checked_at on every call", async () => {
    const campaignId = await seed("t4", 1000);
    await recordLiveBudget({ pool, campaignId, liveBudgetAgorot: 1000 });
    const row = await pool.query(`SELECT live_budget_checked_at FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(row.rows[0].live_budget_checked_at).not.toBeNull();
  });
});
