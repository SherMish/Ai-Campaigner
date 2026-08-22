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
      // Safety net, added 2026-08-22. Cleanup used to live on the LAST LINE of
      // each test body, so any test that threw first leaked its customer row
      // permanently. That is not hypothetical: the failing drain-once test in
      // this suite leaked one row EVERY run, which is how 30 `__it_outbox`
      // customers accumulated in the shared production database — showing up
      // in the ops console as real customers, and feeding the unscoped drain
      // that poisoned a live customer's build.
      //
      // afterAll runs regardless of test outcome, so this cannot leak again.
      // Scoped to THIS file's own prefixes: suites run in parallel, and a
      // broader LIKE would delete a concurrently-running suite's rows.
      await pool.query(`DELETE FROM customers WHERE business_name LIKE ANY($1::text[])`, [["__it_snap%"]]);
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

  it("campaignTotals sums the disjoint daily rows in a window", async () => {
    const { campaignId, customerId } = await makeCampaign();
    const store = new PgSnapshotStore(pool);
    await store.upsert([
      snap(campaignId, { metaObjectId: "c", periodStart: "2026-07-28", periodEnd: "2026-07-28", spendAgorot: 12000, leads: 4, cplAgorot: 3000 }),
      snap(campaignId, { metaObjectId: "c", periodStart: "2026-07-30", periodEnd: "2026-07-30", spendAgorot: 6000, leads: 2, cplAgorot: 3000 }),
    ]);
    const totals = await store.campaignTotals(campaignId, "2026-07-27", "2026-08-02");
    expect(totals).toMatchObject({ spendAgorot: 18000, leads: 6, cplAgorot: 3000 });

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });

  // REGRESSION (real, found 2026-08-13 against production data). Ingestion writes
  // BOTH a rolling 7-day campaign-grain row AND disjoint per-day rows covering the
  // same days (ingestion-service.ts). campaignTotals' containment predicate
  // (period_start >= start AND period_end <= end) matched BOTH, so the engine's
  // evidence read exactly 2x the truth — 8 leads where the customer really had 4.
  //
  // That inflation passed a MIN_CAMPAIGN_LEADS gate the real figure should have
  // failed, so the customer was told "הכל עובד כרגיל" (all fine / `stable`) when
  // the honest state was `collecting`. Same overlapping-window class as the
  // leads_to_date bug (migration 028, "1 lead read as 3") — this was a SECOND
  // consumer that fix missed. Summing now goes through the insight_snapshot_daily
  // view (migration 030), so a SUM is disjoint by construction rather than by
  // remembering to filter.
  it("never double-counts a rolling window row that overlaps its own daily rows", async () => {
    const { campaignId, customerId } = await makeCampaign();
    const store = new PgSnapshotStore(pool);
    await store.upsert([
      // the rolling 7-day row ingestion writes...
      snap(campaignId, { metaObjectId: "roll", periodStart: "2026-07-27", periodEnd: "2026-08-02", spendAgorot: 3921, leads: 4, cplAgorot: 980 }),
      // ...and the per-day rows covering the exact same days, same real spend/leads
      snap(campaignId, { metaObjectId: "roll", periodStart: "2026-07-29", periodEnd: "2026-07-29", spendAgorot: 369, leads: 1, cplAgorot: 369 }),
      snap(campaignId, { metaObjectId: "roll", periodStart: "2026-07-31", periodEnd: "2026-07-31", spendAgorot: 813, leads: 0, cplAgorot: null }),
      snap(campaignId, { metaObjectId: "roll", periodStart: "2026-08-01", periodEnd: "2026-08-01", spendAgorot: 2739, leads: 3, cplAgorot: 913 }),
    ]);

    const totals = await store.campaignTotals(campaignId, "2026-07-27", "2026-08-02");

    // The truth, counted once — NOT 8 leads / 7842 agorot.
    expect(totals.leads).toBe(4);
    expect(totals.spendAgorot).toBe(3921);

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });

  // REGRESSION (real, found 2026-08-14 against production GelNails data, while
  // browsing the customer's "audience details" disclosure). The SAME
  // overlapping-window class as the campaignTotals bug above, at a THIRD
  // consumer AIC-75 explicitly (and it turns out incorrectly) declared safe:
  // "those grains have no daily rows written for them at all." They do — the
  // "today" extra-period ingestion (scheduled-ingestion.ts's `todayPeriod`)
  // calls the full multi-grain `getInsights`, which leaves behind ad/adset/
  // creative single-day rows nothing was designed to consume. Those rows then
  // fall inside creativeStats/adsetStats' containment window right alongside
  // the real rolling-window row for the SAME object, and — with no
  // deduplication — get returned as if they were separate objects. One real
  // ad rendered as three in the customer's UI; the AIC-85/86 comparability
  // count read 3 "comparable creatives" where there was really 1.
  //
  // The fix (unlike campaignTotals, which needed to SUM disjoint days)
  // selects only the rolling/aggregate row per object — a single-day row is a
  // slice, never the object's totals for the requested window — and dedupes
  // to the freshest one via DISTINCT ON, in case more than one ever exists.
  it("creativeStats/adsetStats return exactly one row per object, never a daily slice masquerading as a peer", async () => {
    const { campaignId, customerId } = await makeCampaign();
    const store = new PgSnapshotStore(pool);
    await store.upsert([
      // the rolling 7-day row the primary ingestion tick writes...
      snap(campaignId, { grain: "creative", metaObjectId: "cr_only", parentMetaId: "as_1", periodStart: "2026-08-06", periodEnd: "2026-08-12", spendAgorot: 4394, leads: 5, cplAgorot: 879 }),
      // ...and single-day rows the "today" extra-period ingestion leaves
      // behind for the SAME object, on two different days.
      snap(campaignId, { grain: "creative", metaObjectId: "cr_only", parentMetaId: "as_1", periodStart: "2026-08-11", periodEnd: "2026-08-11", spendAgorot: 2739, leads: 3, cplAgorot: 913 }),
      snap(campaignId, { grain: "creative", metaObjectId: "cr_only", parentMetaId: "as_1", periodStart: "2026-08-12", periodEnd: "2026-08-12", spendAgorot: 706, leads: 1, cplAgorot: 706 }),
      // same shape for the ad set.
      snap(campaignId, { grain: "adset", metaObjectId: "as_1", periodStart: "2026-08-06", periodEnd: "2026-08-12", spendAgorot: 4394, leads: 5, cplAgorot: 879 }),
      snap(campaignId, { grain: "adset", metaObjectId: "as_1", periodStart: "2026-08-11", periodEnd: "2026-08-11", spendAgorot: 2739, leads: 3, cplAgorot: 913 }),
      snap(campaignId, { grain: "adset", metaObjectId: "as_1", periodStart: "2026-08-12", periodEnd: "2026-08-12", spendAgorot: 706, leads: 1, cplAgorot: 706 }),
    ]);

    const creatives = await store.creativeStats(campaignId, "2026-08-06", "2026-08-13");
    expect(creatives).toHaveLength(1); // NOT 3
    expect(creatives[0]).toMatchObject({ metaObjectId: "cr_only", spendAgorot: 4394, leads: 5 });

    const adsets = await store.adsetStats(campaignId, "2026-08-06", "2026-08-13");
    expect(adsets).toHaveLength(1); // NOT 3
    expect(adsets[0]).toMatchObject({ adSetId: "as_1", spendAgorot: 4394, leads: 5 });

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });

  // AIC-95: the range-switcher's per-object equivalent of dailySeries/
  // campaignTotals. creativeStats/adsetStats above answer "what is this
  // object's current rolling window" (one row, always ~7 days) — that method
  // structurally can't serve an arbitrary day/week/month selection. These sum
  // ONLY the disjoint daily rows (period_start = period_end), same
  // never-sum-the-rolling-row discipline as campaignTotals, just grouped per
  // object instead of per campaign.
  it("creativeRangeStats/adsetRangeStats sum disjoint daily rows per object, never the overlapping rolling row", async () => {
    const { campaignId, customerId } = await makeCampaign();
    const store = new PgSnapshotStore(pool);
    await store.upsert([
      // A rolling row that OVERLAPS the daily rows below — must never be summed in.
      snap(campaignId, { grain: "creative", metaObjectId: "cr_1", parentMetaId: "as_1", creativeName: "Ad One", periodStart: "2026-08-06", periodEnd: "2026-08-12", spendAgorot: 99999, leads: 99 }),
      snap(campaignId, { grain: "creative", metaObjectId: "cr_1", parentMetaId: "as_1", creativeName: "Ad One", periodStart: "2026-08-10", periodEnd: "2026-08-10", spendAgorot: 1000, leads: 1 }),
      snap(campaignId, { grain: "creative", metaObjectId: "cr_1", parentMetaId: "as_1", creativeName: "Ad One", periodStart: "2026-08-11", periodEnd: "2026-08-11", spendAgorot: 2000, leads: 2 }),
      // A second object's daily row, same days — proves grouping is per-object.
      snap(campaignId, { grain: "creative", metaObjectId: "cr_2", parentMetaId: "as_1", creativeName: "Ad Two", periodStart: "2026-08-11", periodEnd: "2026-08-11", spendAgorot: 500, leads: 0 }),
      // Outside the requested window — must not be included.
      snap(campaignId, { grain: "creative", metaObjectId: "cr_1", parentMetaId: "as_1", creativeName: "Ad One", periodStart: "2026-07-01", periodEnd: "2026-07-01", spendAgorot: 777, leads: 7 }),
      snap(campaignId, { grain: "adset", metaObjectId: "as_1", periodStart: "2026-08-06", periodEnd: "2026-08-12", spendAgorot: 99999, leads: 99 }),
      snap(campaignId, { grain: "adset", metaObjectId: "as_1", periodStart: "2026-08-10", periodEnd: "2026-08-10", spendAgorot: 1500, leads: 1 }),
      snap(campaignId, { grain: "adset", metaObjectId: "as_1", periodStart: "2026-08-11", periodEnd: "2026-08-11", spendAgorot: 2500, leads: 2 }),
    ]);

    const creatives = await store.creativeRangeStats(campaignId, "2026-08-08", "2026-08-14");
    expect(creatives).toHaveLength(2);
    const cr1 = creatives.find((c) => c.metaObjectId === "cr_1")!;
    expect(cr1).toMatchObject({ spendAgorot: 3000, leads: 3, creativeName: "Ad One", adSetId: "as_1" }); // 1000+2000, not 99999
    const cr2 = creatives.find((c) => c.metaObjectId === "cr_2")!;
    expect(cr2).toMatchObject({ spendAgorot: 500, leads: 0 });

    const adsets = await store.adsetRangeStats(campaignId, "2026-08-08", "2026-08-14");
    expect(adsets).toHaveLength(1);
    expect(adsets[0]).toMatchObject({ adSetId: "as_1", spendAgorot: 4000, leads: 3 }); // 1500+2500

    // A window with real prior data but nothing in range returns empty, not
    // the wrong window's numbers.
    const outside = await store.creativeRangeStats(campaignId, "2026-01-01", "2026-01-07");
    expect(outside).toHaveLength(0);

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });

  // AIC-95: the empty-panel-with-a-reason mechanism needs to know the most
  // recent day we have ANY per-object data for — distinguishing "campaign
  // started today" from "was paused for weeks" from "never had data at all".
  it("mostRecentObjectDataDate finds the latest daily row across adset+creative grain, ignores campaign grain and rolling rows", async () => {
    const { campaignId, customerId } = await makeCampaign();
    const store = new PgSnapshotStore(pool);

    expect(await store.mostRecentObjectDataDate(campaignId)).toBeNull();

    await store.upsert([
      snap(campaignId, { grain: "campaign", metaObjectId: "meta_camp_1", periodStart: "2026-08-14", periodEnd: "2026-08-14" }), // campaign grain — ignored
      snap(campaignId, { grain: "creative", metaObjectId: "cr_1", parentMetaId: "as_1", periodStart: "2026-08-06", periodEnd: "2026-08-12" }), // rolling — ignored
      snap(campaignId, { grain: "adset", metaObjectId: "as_1", periodStart: "2026-08-10", periodEnd: "2026-08-10" }),
      snap(campaignId, { grain: "creative", metaObjectId: "cr_1", parentMetaId: "as_1", periodStart: "2026-08-12", periodEnd: "2026-08-12" }),
    ]);

    expect(await store.mostRecentObjectDataDate(campaignId)).toBe("2026-08-12");

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });
});
