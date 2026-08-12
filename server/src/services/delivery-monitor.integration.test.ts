// DB integration for delivery-health persistence + ops raising (AIC-39).
// Requires DATABASE_URL; self-skips otherwise.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { OpsQueue } from "./ops-queue.js";
import { recordCampaignDelivery } from "./delivery-monitor.js";
import type { DeliverySummary } from "../meta/delivery-health.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function seed(tag: string): Promise<{ customerId: string; campaignId: string }> {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`,
    [`__it_del_${tag}`],
  );
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, system_user_id, access_health) VALUES ($1,'9','ok') RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_del_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, meta_campaign_id, name, status, agreed_budget_agorot)
     VALUES ($1,$2,'m','C','active',1000) RETURNING id`,
    [customerId, acct.rows[0].id],
  );
  return { customerId, campaignId: camp.rows[0].id };
}

const bad = (): DeliverySummary => ({ ok: false, reason: "Ad set not delivering", problemAdSetIds: ["as_9"], delivering: false, deliveringAdCount: 0 });
const good = (): DeliverySummary => ({ ok: true, reason: null, problemAdSetIds: [], delivering: true, deliveringAdCount: 3 });
const stopped = (): DeliverySummary => ({ ok: true, reason: null, problemAdSetIds: [], delivering: false, deliveringAdCount: 0 });

d("recordCampaignDelivery (DB)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_del_%'`);
    await pool.end();
  });

  it("marks not-delivering, raises ONE ops item, then dedupes on repeat, and recovers", async () => {
    const { customerId, campaignId } = await seed("t1");
    const ops = new OpsQueue(pool);

    // ok → not-ok: raises an ops item + flips delivery_ok.
    const first = await recordCampaignDelivery({ pool, ops, campaignId, customerId, summary: bad() });
    expect(first.raisedOps).toBe(true);
    let row = await pool.query(`SELECT delivery_ok, delivery_reason FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(row.rows[0]).toMatchObject({ delivery_ok: false, delivery_reason: "Ad set not delivering" });

    // still not-ok: no new ops item (dedupe).
    const second = await recordCampaignDelivery({ pool, ops, campaignId, customerId, summary: bad() });
    expect(second.raisedOps).toBe(false);
    const items = await pool.query(`SELECT count(*)::int AS n FROM ops_queue_items WHERE campaign_id = $1`, [campaignId]);
    expect(items.rows[0].n).toBe(1);

    // recovered: delivery_ok back to true, reason cleared.
    await recordCampaignDelivery({ pool, ops, campaignId, customerId, summary: good() });
    row = await pool.query(`SELECT delivery_ok, delivery_reason FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(row.rows[0]).toMatchObject({ delivery_ok: true, delivery_reason: null });
  });

  it("persists delivering + deliveringAdCount every tick, independent of ok (AIC-71)", async () => {
    const { customerId, campaignId } = await seed("t2");
    const ops = new OpsQueue(pool);

    await recordCampaignDelivery({ pool, ops, campaignId, customerId, summary: good() });
    let row = await pool.query(`SELECT delivering, delivering_ad_count FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(row.rows[0]).toMatchObject({ delivering: true, delivering_ad_count: 3 });

    // ok (nothing broken) but nothing delivering either — no ops item, this
    // isn't a problem, it's the honest "stopped" reading (AIC-71).
    const before = await pool.query(`SELECT count(*)::int AS n FROM ops_queue_items WHERE campaign_id = $1`, [campaignId]);
    await recordCampaignDelivery({ pool, ops, campaignId, customerId, summary: stopped() });
    row = await pool.query(`SELECT delivery_ok, delivering, delivering_ad_count FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(row.rows[0]).toMatchObject({ delivery_ok: true, delivering: false, delivering_ad_count: 0 });
    const after = await pool.query(`SELECT count(*)::int AS n FROM ops_queue_items WHERE campaign_id = $1`, [campaignId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
