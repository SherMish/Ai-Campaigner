// DB integration for the launch gate (AIC-53). Requires DATABASE_URL; self-
// skips otherwise. No real Meta call — FakeLaunchWriter stands in; the real
// adapter shape is verified by campaign-adapter.test.ts.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { activateCampaign } from "./activate.js";
import { FakeLaunchWriter } from "./types.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function makeCampaign(tag: string, status: string, metaCampaignId: string | null): Promise<string> {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`,
    [`__it_launch_${tag}`],
  );
  const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id) VALUES ($1) RETURNING id`, [cust.rows[0].id]);
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_launch_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, status, meta_campaign_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [cust.rows[0].id, acct.rows[0].id, status, metaCampaignId],
  );
  return camp.rows[0].id;
}

d("launch gate (DB)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_launch_%'`);
    await pool.end();
  });

  it("activates a review-approved, PAUSED campaign: writes, verifies, logs, marks launched", async () => {
    const campaignId = await makeCampaign("happy", "active", "meta_camp_happy");
    const writer = new FakeLaunchWriter();
    writer.statuses.set("meta_camp_happy", "PAUSED");

    const result = await activateCampaign(pool, writer, campaignId);

    expect(result).toEqual({ outcome: "activated" });
    expect(writer.activateCalls).toEqual(["meta_camp_happy"]);

    const row = await pool.query(`SELECT launch_approved_at FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(row.rows[0].launch_approved_at).toBeTruthy();

    const history = await pool.query(`SELECT action_type, result, target_meta_id FROM action_history WHERE campaign_id = $1`, [campaignId]);
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]).toMatchObject({ action_type: "activate_campaign", result: "success", target_meta_id: "meta_camp_happy" });
  });

  it("blocks activation of a campaign that hasn't passed review yet (status still under_review)", async () => {
    const campaignId = await makeCampaign("noreview", "under_review", "meta_camp_noreview");
    const writer = new FakeLaunchWriter();

    const result = await activateCampaign(pool, writer, campaignId);

    expect(result.outcome).toBe("not_approved");
    expect(writer.activateCalls).toHaveLength(0);
  });

  it("blocks a campaign with no Meta campaign linked yet", async () => {
    const campaignId = await makeCampaign("nolink", "active", null);
    const writer = new FakeLaunchWriter();

    const result = await activateCampaign(pool, writer, campaignId);

    expect(result.outcome).toBe("not_linked");
    expect(writer.activateCalls).toHaveLength(0);
  });

  it("is idempotent: a second approval call is a no-op, never re-activates or double-logs", async () => {
    const campaignId = await makeCampaign("idem", "active", "meta_camp_idem");
    const writer = new FakeLaunchWriter();
    writer.statuses.set("meta_camp_idem", "PAUSED");

    const first = await activateCampaign(pool, writer, campaignId);
    const second = await activateCampaign(pool, writer, campaignId);

    expect(first.outcome).toBe("activated");
    expect(second).toEqual({ outcome: "already_launched" });
    expect(writer.activateCalls).toHaveLength(1);

    const history = await pool.query(`SELECT id FROM action_history WHERE campaign_id = $1`, [campaignId]);
    expect(history.rows).toHaveLength(1);
  });

  it("a failed write is reported honestly, never marked launched", async () => {
    const campaignId = await makeCampaign("failwrite", "active", "meta_camp_fail");
    const writer = new FakeLaunchWriter();
    writer.statuses.set("meta_camp_fail", "PAUSED");
    writer.failNextActivate = 1;

    const result = await activateCampaign(pool, writer, campaignId);

    expect(result.outcome).toBe("failed");
    const row = await pool.query(`SELECT launch_approved_at FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(row.rows[0].launch_approved_at).toBeNull();
    const history = await pool.query(`SELECT id FROM action_history WHERE campaign_id = $1`, [campaignId]);
    expect(history.rows).toHaveLength(0);

    // Retrying (as if the customer clicks approve again) succeeds cleanly.
    const retry = await activateCampaign(pool, writer, campaignId);
    expect(retry.outcome).toBe("activated");
  });

  it("a campaign already ACTIVE on Meta (defensive case) is marked launched without a redundant write", async () => {
    const campaignId = await makeCampaign("alreadyactive", "active", "meta_camp_active");
    const writer = new FakeLaunchWriter();
    writer.statuses.set("meta_camp_active", "ACTIVE");

    const result = await activateCampaign(pool, writer, campaignId);

    expect(result.outcome).toBe("activated");
    expect(writer.activateCalls).toHaveLength(0); // never called — it was already active
    const row = await pool.query(`SELECT launch_approved_at FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(row.rows[0].launch_approved_at).toBeTruthy();
  });
});
