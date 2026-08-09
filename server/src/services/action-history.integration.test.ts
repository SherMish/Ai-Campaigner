// DB + HTTP integration for the action-history surface (AIC-15). Requires
// DATABASE_URL; self-skips otherwise. Reads only from action_history.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { listCampaignActionHistory, condense } from "./action-history.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function makeCampaign(): Promise<{ campaignId: string; customerId: string }> {
  const cust = await pool.query<{ id: string }>(`INSERT INTO customers (business_name) VALUES ('__it_hist') RETURNING id`);
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id) VALUES ($1) RETURNING id`, [customerId]);
  const acct = await pool.query<{ id: string }>(`INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`, [conn.rows[0].id, `act_h_${conn.rows[0].id.slice(0, 8)}`]);
  const camp = await pool.query<{ id: string }>(`INSERT INTO managed_campaigns (customer_id, ad_account_id) VALUES ($1,$2) RETURNING id`, [customerId, acct.rows[0].id]);
  return { campaignId: camp.rows[0].id, customerId };
}

const ADMIN = "Bearer test-admin";
d("action history surface (DB + HTTP)", () => {
  beforeAll(() => { process.env.ADMIN_TOKEN = "test-admin"; });
  afterAll(async () => { await pool.end(); });

  it("lists newest-first, distinguishes automated vs human, condenses jargon-free", async () => {
    const { campaignId, customerId } = await makeCampaign();

    // Two entries: an automated budget change, then a human-involved creative swap.
    await pool.query(
      `INSERT INTO action_history (campaign_id, what, action_type, why, human_involved, result, occurred_at)
       VALUES ($1,'set daily budget 7000 → 8000','increase_budget','healthy', false, 'success', now() - interval '1 hour')`,
      [campaignId],
    );
    await pool.query(
      `INSERT INTO action_history (campaign_id, what, action_type, why, human_involved, result, occurred_at)
       VALUES ($1,'flagged creative for replacement','replace_creative','decayed', true, 'success', now())`,
      [campaignId],
    );

    const entries = await listCampaignActionHistory(pool, campaignId);
    expect(entries).toHaveLength(2);
    expect(entries[0].actionType).toBe("replace_creative"); // newest first
    expect(entries[0].humanInvolved).toBe(true);
    expect(entries[1].humanInvolved).toBe(false);

    const condensed = condense(entries);
    expect(condensed[0]).toMatchObject({ summary: "החלפת קריאייטיב", automated: false });
    expect(condensed[1]).toMatchObject({ summary: "העלאת תקציב", automated: true });
    // jargon-free: no agorot numbers / English terms leak into the summary
    expect(condensed[0].summary).not.toMatch(/budget|8000|CTR/i);

    // Over HTTP.
    const full = await request(createApp()).get(`/api/admin/campaigns/${campaignId}/history`).set("Authorization", ADMIN);
    expect(full.status).toBe(200);
    expect(full.body.entries).toHaveLength(2);
    const cond = await request(createApp()).get(`/api/admin/campaigns/${campaignId}/history?condensed=true`).set("Authorization", ADMIN);
    expect(cond.body.entries[0].summary).toBe("החלפת קריאייטיב");

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });
});
