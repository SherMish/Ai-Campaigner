// DB integration for the first-campaign review workflow (AIC-18). Requires
// DATABASE_URL.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { submitReview, recordCustomerDecision, getLatestReview } from "./campaign-review.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function makeCampaign(): Promise<{ campaignId: string; customerId: string }> {
  const cust = await pool.query<{ id: string }>(`INSERT INTO customers (business_name) VALUES ('__it_review') RETURNING id`);
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id) VALUES ($1) RETURNING id`, [customerId]);
  const acct = await pool.query<{ id: string }>(`INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`, [conn.rows[0].id, `act_rv_${conn.rows[0].id.slice(0,8)}`]);
  // status defaults to 'under_review'
  const camp = await pool.query<{ id: string }>(`INSERT INTO managed_campaigns (customer_id, ad_account_id) VALUES ($1,$2) RETURNING id`, [customerId, acct.rows[0].id]);
  return { campaignId: camp.rows[0].id, customerId };
}

async function statusOf(campaignId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(`SELECT status FROM managed_campaigns WHERE id = $1`, [campaignId]);
  return rows[0].status;
}

d("first-campaign review (DB)", () => {
  afterAll(async () => { await pool.end(); });

  it("approved → campaign becomes managed (active), recorded with reviewer + timestamp", async () => {
    const { campaignId, customerId } = await makeCampaign();
    const review = await submitReview(pool, { campaignId, reviewer: "liam", outcome: "approved", checklist: { whatsapp_ok: true, budget_ok: true }, notes: "clean" });
    expect(review.outcome).toBe("approved");
    expect(review.reviewer).toBe("liam");
    expect(await statusOf(campaignId)).toBe("active");
    expect((await getLatestReview(pool, campaignId))?.id).toBe(review.id);
    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });

  it("unsupported → campaign marked unmanaged", async () => {
    const { campaignId, customerId } = await makeCampaign();
    await submitReview(pool, { campaignId, reviewer: "liam", outcome: "unsupported", notes: "catalog campaign, not P0" });
    expect(await statusOf(campaignId)).toBe("unmanaged");
    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });

  it("changes_requested does NOT activate until the customer approves (§11 hard rule)", async () => {
    const { campaignId, customerId } = await makeCampaign();
    const review = await submitReview(pool, { campaignId, reviewer: "liam", outcome: "changes_requested", notes: "rebuild to standard structure" });
    // Must stay under_review — no modification without customer approval.
    expect(await statusOf(campaignId)).toBe("under_review");

    await recordCustomerDecision(pool, review.id, true);
    expect(await statusOf(campaignId)).toBe("active"); // now managed, after approval
    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });

  it("changes_requested + customer declines → stays under_review", async () => {
    const { campaignId, customerId } = await makeCampaign();
    const review = await submitReview(pool, { campaignId, reviewer: "liam", outcome: "changes_requested", notes: "x" });
    await recordCustomerDecision(pool, review.id, false);
    expect(await statusOf(campaignId)).toBe("under_review");
    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });
});
