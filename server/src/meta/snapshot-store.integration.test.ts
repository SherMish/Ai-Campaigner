// DB integration for PgSnapshotStore (AIC-6). Requires DATABASE_URL with
// migrations applied; self-skips otherwise. Proves upsert idempotency per
// (campaign, grain, object, period) and period-over-period totals.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { PgSnapshotStore } from "./snapshot-store.js";
import type { SnapshotUpsert } from "./insights.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function makeCampaign(): Promise<{ campaignId: string; customerId: string }> {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name) VALUES ('__it_snap') RETURNING id`,
  );
  const customerId = cust.rows[0].id;
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id) VALUES ($1) RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id)
     VALUES ($1, $2) RETURNING id`,
    [conn.rows[0].id, `act_snap_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id) VALUES ($1, $2) RETURNING id`,
    [customerId, acct.rows[0].id],
  );
  return { campaignId: camp.rows[0].id, customerId };
}

function snap(campaignId: string, over: Partial<SnapshotUpsert> = {}): SnapshotUpsert {
  return {
    campaignId,
    grain: "campaign",
    metaObjectId: "meta_camp_1",
    parentMetaId: null,
    creativeName: null,
    periodStart: "2026-07-27",
    periodEnd: "2026-08-02",
    spendAgorot: 18000,
    leads: 5,
    cplAgorot: 3600,
    impressions: 12000,
    linkClicks: 150,
    deliveryStatus: "active",
    raw: {},
    ...over,
  };
}

d("PgSnapshotStore (DB)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("upsert is idempotent and updates in place on re-run", async () => {
    const { campaignId, customerId } = await makeCampaign();
    const store = new PgSnapshotStore(pool);

    await store.upsert([snap(campaignId)]);
    await store.upsert([snap(campaignId, { spendAgorot: 20000, leads: 4, cplAgorot: 5000 })]);

    const { rows } = await pool.query<{ count: string; spend: string; leads: string }>(
      `SELECT count(*)::text AS count,
              max(spend_agorot)::text AS spend,
              max(leads)::text AS leads
       FROM insight_snapshots WHERE campaign_id = $1`,
      [campaignId],
    );
    expect(Number(rows[0].count)).toBe(1); // no duplicate
    expect(Number(rows[0].spend)).toBe(20000); // updated in place
    expect(Number(rows[0].leads)).toBe(4);

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });

  it("campaignTotals sums campaign-grain rows in a window", async () => {
    const { campaignId, customerId } = await makeCampaign();
    const store = new PgSnapshotStore(pool);
    await store.upsert([
      snap(campaignId, { metaObjectId: "c", periodStart: "2026-07-27", periodEnd: "2026-08-02", spendAgorot: 18000, leads: 6, cplAgorot: 3000 }),
    ]);
    const totals = await store.campaignTotals(campaignId, "2026-07-27", "2026-08-02");
    expect(totals).toMatchObject({ spendAgorot: 18000, leads: 6, cplAgorot: 3000 });

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });
});
