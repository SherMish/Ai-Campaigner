import type pg from "pg";

// Cache the engine's already-fetched TRUE lifetime lead count for the
// lead-quality watermark (AIC-67 follow-up, real bug fix). Same pattern as
// live-budget.ts's recordLiveBudget: the engine reads it once per generation
// tick; the UI reads only ever read this column, never a live Meta call and
// never a SUM across insight_snapshots (those rows are overlapping rolling
// windows, not disjoint — summing them multiplies real leads by however many
// overlapping snapshots exist).
export async function recordLeadsToDate(deps: {
  pool: pg.Pool;
  campaignId: string;
  leadsToDate: number;
  // Lifetime spend, from the same Meta call. Optional so existing callers
  // that only care about the lead watermark don't have to supply it.
  spendToDate?: number;
}): Promise<void> {
  const { pool, campaignId, leadsToDate, spendToDate } = deps;
  await pool.query(
    `UPDATE managed_campaigns
     SET leads_to_date = $2, leads_to_date_checked_at = now(),
         spend_to_date = COALESCE($3, spend_to_date)
     WHERE id = $1`,
    [campaignId, leadsToDate, spendToDate ?? null],
  );
}
