// DB integration for the serving watch (AIC-178): persistence, one-alert-per
// dark-spell, and recovery. Requires DATABASE_URL; self-skips otherwise.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { OpsQueue } from "./ops-queue.js";
import { recordServing, todayImpressionsByAdSet } from "./serving-watch.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function seed(tag: string): Promise<{ customerId: string; campaignId: string }> {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`,
    [`__it_serve_${tag}`],
  );
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, system_user_id, access_health) VALUES ($1,'9','ok') RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_serve_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, meta_campaign_id, name, status, agreed_budget_agorot)
     VALUES ($1,$2,'m_serve','C','active',3000) RETURNING id`,
    [customerId, acct.rows[0].id],
  );
  return { customerId, campaignId: camp.rows[0].id };
}

const openItems = async (campaignId: string) =>
  (await pool.query(`SELECT type FROM ops_queue_items WHERE campaign_id = $1 AND type = 'ads_not_serving'`, [campaignId])).rows;

const dark = (name = "נשים · 20–35") => [{ metaObjectId: "as_dark", name, impressions: 0, active: true }];

d("serving watch (DB)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_serve_%'`);
    await pool.end();
  });

  it("stays silent inside the grace window, alerts ONCE past it, then dedupes and recovers", async () => {
    const { customerId, campaignId } = await seed("t1");
    const ops = new OpsQueue(pool);
    const base = { pool, ops, campaignId, customerId, campaignRef: "m_serve" };

    // First sight: the grace anchor is set now, so a brand-new ad set that has
    // served nothing is NOT an alert. This is the case that would otherwise
    // page an operator about every ad set the moment it is created.
    await recordServing({ ...base, observations: dark(), now: new Date("2026-09-02T08:00:00Z") });
    expect(await openItems(campaignId)).toHaveLength(0);

    // 6 hours dark — still inside 12.
    await recordServing({ ...base, observations: dark(), now: new Date("2026-09-02T14:00:00Z") });
    expect(await openItems(campaignId)).toHaveLength(0);

    // 13 hours dark — this is the lived case: ACTIVE, zero impressions, Meta
    // reporting no problem at all.
    await recordServing({ ...base, observations: dark(), now: new Date("2026-09-02T21:00:00Z") });
    expect(await openItems(campaignId)).toHaveLength(1);

    // Still dark next tick: one dark spell, one message. A monitor that
    // repeats hourly is a monitor everyone mutes.
    await recordServing({ ...base, observations: dark(), now: new Date("2026-09-02T22:00:00Z") });
    expect(await openItems(campaignId)).toHaveLength(1);

    // It serves again → the standing alert is cleared, so the NEXT dark spell
    // can be reported. Leaving the flag set would make this the last alert
    // this ad set ever produces.
    await recordServing({
      ...base,
      observations: [{ metaObjectId: "as_dark", name: "נשים · 20–35", impressions: 400, active: true }],
      now: new Date("2026-09-02T23:00:00Z"),
    });
    const row = await pool.query<{ alerted_at: Date | null; last_served_at: Date | null }>(
      `SELECT alerted_at, last_served_at FROM ad_serving_watch WHERE meta_object_id = 'as_dark'`,
    );
    expect(row.rows[0].alerted_at).toBeNull();
    expect(row.rows[0].last_served_at).not.toBeNull();

    // A second dark spell, 13h after it last served, alerts again.
    await recordServing({ ...base, observations: dark(), now: new Date("2026-09-03T12:30:00Z") });
    expect(await openItems(campaignId)).toHaveLength(2);
  });

  it("never alerts on a paused ad set, however long it has been silent", async () => {
    const { customerId, campaignId } = await seed("t2");
    const ops = new OpsQueue(pool);
    const paused = [{ metaObjectId: "as_paused", name: "מושהה", impressions: 0, active: false }];
    await recordServing({ pool, ops, campaignId, customerId, campaignRef: "m_serve", observations: paused, now: new Date("2026-09-01T00:00:00Z") });
    await recordServing({ pool, ops, campaignId, customerId, campaignRef: "m_serve", observations: paused, now: new Date("2026-09-05T00:00:00Z") });
    expect(await openItems(campaignId)).toHaveLength(0);
  });

  it("reads today's impressions at ad-set grain", async () => {
    const { campaignId } = await seed("t3");
    await pool.query(
      `INSERT INTO insight_snapshots (campaign_id, grain, meta_object_id, period_start, period_end, spend_agorot, leads, impressions, delivery_status, raw)
       VALUES ($1,'adset','as_x','2026-09-02','2026-09-02', 283, 0, 61, 'active','{}'::jsonb)`,
      [campaignId],
    );
    const m = await todayImpressionsByAdSet(pool, campaignId, "2026-09-02", "2026-09-02");
    expect(m.get("as_x")).toBe(61);
    // An ad set with no row at all reads as zero, not as missing — that is the
    // whole point: a dark ad set produces no snapshot row.
    expect(m.get("as_none") ?? 0).toBe(0);
  });
});
