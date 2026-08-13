// DB + HTTP integration for the action-history surface (AIC-15). Requires
// DATABASE_URL; self-skips otherwise. Reads only from action_history.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { listCampaignActionHistory, condense, getLatestEngineActionByType } from "./action-history.js";

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

  // AIC-77b: the cooldown query's real discriminator, against the real schema.
  it("getLatestEngineActionByType: engine-only, successful-only, latest-per-type", async () => {
    const { campaignId, customerId } = await makeCampaign();
    const rec = await pool.query<{ id: string }>(
      `INSERT INTO recommendations (campaign_id, type) VALUES ($1,'pause_creative') RETURNING id`,
      [campaignId],
    );
    const recId = rec.rows[0].id;

    // 1. An OLDER engine-authored success for pause_creative...
    await pool.query(
      `INSERT INTO action_history (campaign_id, recommendation_id, what, action_type, human_involved, result, occurred_at)
       VALUES ($1,$2,'paused cr_old','pause_creative', true, 'success', now() - interval '10 days')`,
      [campaignId, recId],
    );
    // 2. ...and a NEWER one — getLatestEngineActionByType must return this one, not #1.
    await pool.query(
      `INSERT INTO action_history (campaign_id, recommendation_id, what, action_type, human_involved, result, occurred_at)
       VALUES ($1,$2,'paused cr_new','pause_creative', true, 'success', now() - interval '2 days')`,
      [campaignId, recId],
    );
    // 3. A MANUAL control (recommendation_id NULL, the real AIC-66 shape) —
    //    must never be mistaken for an engine action, however recent.
    await pool.query(
      `INSERT INTO action_history (campaign_id, what, action_type, human_involved, result, occurred_at)
       VALUES ($1,'manual pause','pause_ad_set', true, 'success', now())`,
      [campaignId],
    );
    // 4. A FAILED engine-authored execution — must never start a cooldown.
    await pool.query(
      `INSERT INTO action_history (campaign_id, recommendation_id, what, action_type, human_involved, result, occurred_at)
       VALUES ($1,$2,'budget write failed','decrease_budget', true, 'failed', now())`,
      [campaignId, recId],
    );

    const latest = await getLatestEngineActionByType(pool, campaignId);

    expect(Object.keys(latest).sort()).toEqual(["pause_creative"]); // only the qualifying type
    // The NEWER (2 days ago) row, not the older (10 days ago) one.
    expect(latest.pause_creative.getTime()).toBeGreaterThan(Date.now() - 5 * 24 * 60 * 60 * 1000);
    expect(latest.pause_ad_set).toBeUndefined(); // manual — no recommendation_id
    expect(latest.decrease_budget).toBeUndefined(); // failed

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });
});
