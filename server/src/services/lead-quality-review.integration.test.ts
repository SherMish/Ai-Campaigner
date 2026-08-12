// DB integration for the incremental lead-quality watermark (AIC-67).
// Requires DATABASE_URL; self-skips otherwise.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { getLeadQualityStatus, recordLeadQualityReview } from "./lead-quality-review.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function seed(tag: string): Promise<string> {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`,
    [`__it_lq_${tag}`],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, access_health) VALUES ($1,'ok') RETURNING id`,
    [cust.rows[0].id],
  );
  const adAcct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [acct.rows[0].id, `act_lq_${acct.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, status, name, agreed_budget_agorot)
     VALUES ($1,$2,'active','LQ Campaign',1000) RETURNING id`,
    [cust.rows[0].id, adAcct.rows[0].id],
  );
  return camp.rows[0].id;
}

d("lead-quality-review (DB)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_lq_%'`);
    await pool.end();
  });

  it("watermark is zero with no reviews; pending equals leads-to-date", async () => {
    const campaignId = await seed("empty");
    const status = await getLeadQualityStatus(pool, campaignId, 6, new Date());
    expect(status).toMatchObject({ reviewedSoFar: 0, relevantSoFar: 0, pending: 6 });
  });

  it("a review advances the watermark; the same leads are never asked about again", async () => {
    const campaignId = await seed("advance");
    await recordLeadQualityReview(pool, campaignId, { leadsDelta: 6, relevantDelta: 4 });
    let status = await getLeadQualityStatus(pool, campaignId, 6, new Date());
    expect(status).toMatchObject({ reviewedSoFar: 6, relevantSoFar: 4, pending: 0 });

    // 3 more leads arrive (9 to date) — pending is the DELTA only (3), not 9.
    status = await getLeadQualityStatus(pool, campaignId, 9, new Date());
    expect(status.pending).toBe(3);

    await recordLeadQualityReview(pool, campaignId, { leadsDelta: 3, relevantDelta: 1 });
    status = await getLeadQualityStatus(pool, campaignId, 9, new Date());
    // Cumulative across both reviews: 4 + 1 = 5, never re-counted.
    expect(status).toMatchObject({ reviewedSoFar: 9, relevantSoFar: 5, pending: 0 });
  });

  // Attribution lag: Meta's attribution window can revise a lead count
  // downward after the fact. The watermark must never go negative or throw —
  // it just reads as caught up until the real total climbs back past it.
  it("a retroactive dip in leads-to-date never produces a negative pending count", async () => {
    const campaignId = await seed("laggy");
    await recordLeadQualityReview(pool, campaignId, { leadsDelta: 10, relevantDelta: 7 });
    const status = await getLeadQualityStatus(pool, campaignId, 8, new Date()); // dipped from 10 to 8
    expect(status.pending).toBe(0);
    expect(status.reviewedSoFar).toBe(10); // the watermark itself is untouched
  });

  it("'this week' only counts reviews whose reviewed_at falls in the current calendar week", async () => {
    const campaignId = await seed("thisweek");
    // Backdate one review to well before this week, insert one for "now".
    await pool.query(
      `INSERT INTO lead_quality_reviews (campaign_id, reviewed_at, leads_delta, relevant_delta)
       VALUES ($1, now() - interval '30 days', 20, 15)`,
      [campaignId],
    );
    await recordLeadQualityReview(pool, campaignId, { leadsDelta: 4, relevantDelta: 3 });

    const status = await getLeadQualityStatus(pool, campaignId, 24, new Date());
    expect(status.reviewedSoFar).toBe(24); // all-time, includes the old review
    expect(status).toMatchObject({ leadsThisWeek: 4, relevantThisWeek: 3 }); // only the recent one
  });

  // Real migration 027 backfill SQL, run here against a freshly-seeded
  // campaign to pin its correctness independent of when it happened to run
  // against production data.
  it("migration backfill: existing per-week values become the initial watermark", async () => {
    const campaignId = await seed("migrate");
    await pool.query(
      `INSERT INTO lead_quality_feedback (campaign_id, week_start, leads_reported, relevant_count)
       VALUES ($1,'2026-07-06',4,3), ($1,'2026-07-13',6,5)`,
      [campaignId],
    );
    await pool.query(
      `INSERT INTO lead_quality_reviews (campaign_id, reviewed_at, leads_delta, relevant_delta)
       SELECT campaign_id, now(), SUM(leads_reported), LEAST(SUM(relevant_count), SUM(leads_reported))
       FROM lead_quality_feedback WHERE campaign_id = $1
       GROUP BY campaign_id HAVING SUM(leads_reported) > 0`,
      [campaignId],
    );
    const status = await getLeadQualityStatus(pool, campaignId, 10, new Date());
    expect(status).toMatchObject({ reviewedSoFar: 10, relevantSoFar: 8, pending: 0 });
  });

  it("a campaign with no lead_quality_feedback history gets no backfill row (still zero, not an error)", async () => {
    const campaignId = await seed("nohistory");
    await pool.query(
      `INSERT INTO lead_quality_reviews (campaign_id, reviewed_at, leads_delta, relevant_delta)
       SELECT campaign_id, now(), SUM(leads_reported), LEAST(SUM(relevant_count), SUM(leads_reported))
       FROM lead_quality_feedback WHERE campaign_id = $1
       GROUP BY campaign_id HAVING SUM(leads_reported) > 0`,
      [campaignId],
    );
    const status = await getLeadQualityStatus(pool, campaignId, 5, new Date());
    expect(status).toMatchObject({ reviewedSoFar: 0, pending: 5 });
  });
});
