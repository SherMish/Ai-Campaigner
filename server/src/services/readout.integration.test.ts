// DB + HTTP integration for the dogfood readout (AIC-7). Requires DATABASE_URL
// with migrations applied; self-skips otherwise. Seeds snapshots and asserts both
// the service output and the admin endpoint JSON.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { buildCampaignReadout } from "./readout.js";
import { rollingPeriods } from "../meta/scheduled-ingestion.js";
import { PgSnapshotStore } from "../meta/snapshot-store.js";
import type { SnapshotUpsert } from "../meta/insights.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

// Seed against the real "now" window so the HTTP route (which uses new Date())
// and the direct service call (default ref) both read the same period.
const { current, previous } = rollingPeriods();

function snap(campaignId: string, o: Partial<SnapshotUpsert>): SnapshotUpsert {
  return {
    campaignId,
    grain: "campaign",
    metaObjectId: "meta_camp_1",
    parentMetaId: null,
    creativeName: null,
    periodStart: current.start,
    periodEnd: current.end,
    spendAgorot: 0,
    leads: 0,
    cplAgorot: null,
    impressions: 0,
    linkClicks: 0,
    deliveryStatus: "active",
    raw: {},
    ...o,
  };
}

const ADMIN = "Bearer test-admin";
d("dogfood readout (DB + HTTP)", () => {
  beforeAll(() => { process.env.ADMIN_TOKEN = "test-admin"; });
  afterAll(async () => {
    await pool.end();
  });

  it("assembles status, totals, delta, and per-creative from snapshots", async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (business_name, is_test) VALUES ('__it_readout', true) RETURNING id`,
    );
    const customerId = cust.rows[0].id;
    const conn = await pool.query<{ id: string }>(
      `INSERT INTO meta_connections (customer_id) VALUES ($1) RETURNING id`,
      [customerId],
    );
    const acct = await pool.query<{ id: string }>(
      `INSERT INTO ad_accounts (connection_id, meta_ad_account_id)
       VALUES ($1, $2) RETURNING id`,
      [conn.rows[0].id, `act_ro_${conn.rows[0].id.slice(0, 8)}`],
    );
    const camp = await pool.query<{ id: string }>(
      `INSERT INTO managed_campaigns (customer_id, ad_account_id, name, status)
       VALUES ($1, $2, 'Pisga דוגפוד', 'active') RETURNING id`,
      [customerId, acct.rows[0].id],
    );
    const campaignId = camp.rows[0].id;

    const store = new PgSnapshotStore(pool);
    await store.upsert([
      // current period: campaign total + two creatives
      snap(campaignId, { spendAgorot: 18000, leads: 6, cplAgorot: 3000 }),
      snap(campaignId, {
        grain: "creative",
        metaObjectId: "cr_1",
        creativeName: "Creative A",
        spendAgorot: 12000,
        leads: 5,
        cplAgorot: 2400,
      }),
      snap(campaignId, {
        grain: "creative",
        metaObjectId: "cr_2",
        creativeName: "Creative B",
        spendAgorot: 6000,
        leads: 1,
        cplAgorot: 6000,
      }),
      // previous period campaign total for the delta
      snap(campaignId, {
        periodStart: previous.start,
        periodEnd: previous.end,
        spendAgorot: 15000,
        leads: 5,
        cplAgorot: 3000,
      }),
    ]);

    const readout = await buildCampaignReadout(pool, campaignId);
    expect(readout).not.toBeNull();
    expect(readout!.status).toBe("active");
    expect(readout!.current).toMatchObject({ spendAgorot: 18000, leads: 6, cplAgorot: 3000 });
    expect(readout!.previous).toMatchObject({ spendAgorot: 15000, leads: 5 });
    expect(readout!.delta.leadsPct).toBe(20); // 5 → 6
    expect(readout!.perCreative).toHaveLength(2);
    expect(readout!.perCreative[0].creativeName).toBe("Creative A"); // ordered by spend desc

    // And over HTTP through the admin route.
    const res = await request(createApp()).get(
      `/api/admin/campaigns/${campaignId}/readout`,
    ).set("Authorization", ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.current.leads).toBe(6);
    expect(res.body.perCreative).toHaveLength(2);

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });

  it("404s an unknown campaign", async () => {
    const res = await request(createApp()).get(
      `/api/admin/campaigns/00000000-0000-0000-0000-000000000000/readout`,
    ).set("Authorization", ADMIN);
    expect(res.status).toBe(404);
  });

  // REGRESSION (real, 2026-08-12): a customer got 3 leads today and the
  // dashboard headline still read "1 פניות" — nothing ingested today, and the
  // 7-day window deliberately stops at yesterday. `today` is now its own
  // snapshot + its own readout field, kept OUT of `current` so the engine
  // still evaluates on complete days only.
  it("today is reported separately and never folded into the 7-day window", async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (business_name, is_test) VALUES ('__it_ro_today', true) RETURNING id`,
    );
    const conn = await pool.query<{ id: string }>(
      `INSERT INTO meta_connections (customer_id, access_health) VALUES ($1,'ok') RETURNING id`,
      [cust.rows[0].id],
    );
    const acct = await pool.query<{ id: string }>(
      `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
      [conn.rows[0].id, `act_ro_${conn.rows[0].id.slice(0, 8)}`],
    );
    const camp = await pool.query<{ id: string }>(
      `INSERT INTO managed_campaigns (customer_id, ad_account_id, name, status)
       VALUES ($1,$2,'Today split','active') RETURNING id`,
      [cust.rows[0].id, acct.rows[0].id],
    );
    const campaignId = camp.rows[0].id;
    const today = new Date().toISOString().slice(0, 10);

    const store = new PgSnapshotStore(pool);
    await store.upsert([
      // The complete-days window the engine reads: 1 lead.
      snap(campaignId, { spendAgorot: 1182, leads: 1, cplAgorot: 1182 }),
      // Today's own row: 3 more leads that the 7-day window structurally
      // cannot contain (its period ends yesterday).
      snap(campaignId, { periodStart: today, periodEnd: today, spendAgorot: 2674, leads: 3, cplAgorot: 891 }),
    ]);

    const readout = await buildCampaignReadout(pool, campaignId);
    // The engine's window is untouched by today — no partial-day contamination.
    expect(readout!.current).toMatchObject({ spendAgorot: 1182, leads: 1 });
    // ...and today is visible on its own, which is what the customer needed.
    expect(readout!.today).toMatchObject({ spendAgorot: 2674, leads: 3 });

    await pool.query(`DELETE FROM customers WHERE id = $1`, [cust.rows[0].id]);
  });

  // The day/week/month/all-time switcher. The critical property: ranges are
  // summed from DISJOINT per-day rows and are completely unaffected by the
  // overlapping rolling-window rows stored alongside them — summing those was
  // the real bug that made 1 lead read as 3.
  it("ranges sum disjoint per-day rows and ignore the overlapping rolling windows", async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (business_name, is_test) VALUES ('__it_ro_ranges', true) RETURNING id`,
    );
    const conn = await pool.query<{ id: string }>(
      `INSERT INTO meta_connections (customer_id, access_health) VALUES ($1,'ok') RETURNING id`,
      [cust.rows[0].id],
    );
    const acct = await pool.query<{ id: string }>(
      `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
      [conn.rows[0].id, `act_rg_${conn.rows[0].id.slice(0, 8)}`],
    );
    const camp = await pool.query<{ id: string }>(
      `INSERT INTO managed_campaigns (customer_id, ad_account_id, name, status, leads_to_date, spend_to_date)
       VALUES ($1,$2,'Ranges','active', 99, 12345) RETURNING id`,
      [cust.rows[0].id, acct.rows[0].id],
    );
    const campaignId = camp.rows[0].id;
    const iso = (offset: number) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);

    const store = new PgSnapshotStore(pool);
    await store.upsert([
      // Disjoint single-day rows: today, 3 days ago, 20 days ago.
      snap(campaignId, { periodStart: iso(0), periodEnd: iso(0), spendAgorot: 100, leads: 1 }),
      snap(campaignId, { periodStart: iso(3), periodEnd: iso(3), spendAgorot: 200, leads: 2 }),
      snap(campaignId, { periodStart: iso(20), periodEnd: iso(20), spendAgorot: 400, leads: 4 }),
      // An OVERLAPPING rolling window covering all of the above. If ranges
      // ever summed this too, every figure below would be inflated.
      snap(campaignId, { periodStart: iso(25), periodEnd: iso(0), spendAgorot: 9999, leads: 99 }),
    ]);

    const readout = await buildCampaignReadout(pool, campaignId);
    expect(readout!.ranges.day).toMatchObject({ spendAgorot: 100, leads: 1 });
    expect(readout!.ranges.week).toMatchObject({ spendAgorot: 300, leads: 3 }); // today + 3d ago
    expect(readout!.ranges.month).toMatchObject({ spendAgorot: 700, leads: 7 }); // + 20d ago
    // All-time comes from the cached lifetime read, NOT from summing days —
    // per-day rows only reach back DAILY_LOOKBACK_DAYS.
    expect(readout!.ranges.allTime).toMatchObject({ spendAgorot: 12345, leads: 99 });
    // The graph series carries only the real single-day points.
    expect(readout!.daily.map((p) => p.leads)).toEqual([4, 2, 1]);
    expect(readout!.firstDataDate).toBe(iso(20));

    await pool.query(`DELETE FROM customers WHERE id = $1`, [cust.rows[0].id]);
  });
});
