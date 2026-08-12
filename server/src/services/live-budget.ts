import type pg from "pg";

// Cache the engine's already-fetched live Meta budget for display (the fix
// for a real customer-reported bug: the dashboard showed the static agreed
// ceiling, which silently went stale the moment someone changed the daily
// budget directly on Meta). Also auto-RAISES the agreed ceiling to match —
// never lowers it, so an operator's forward-looking pre-authorization (e.g.
// raising the ceiling ahead of an intended increase_budget approval) is never
// silently reverted by a live read that just hasn't caught up yet. Without
// the raise, a live budget above the old ceiling would make the engine's own
// next decrease_budget proposal throw BudgetLimitError at execution — the
// ceiling would be blocking a change smaller than what's already live.
export async function recordLiveBudget(deps: {
  pool: pg.Pool;
  campaignId: string;
  liveBudgetAgorot: number;
}): Promise<void> {
  const { pool, campaignId, liveBudgetAgorot } = deps;
  await pool.query(
    `UPDATE managed_campaigns
     SET live_budget_agorot = $2,
         live_budget_checked_at = now(),
         agreed_budget_agorot = GREATEST(agreed_budget_agorot, $2)
     WHERE id = $1`,
    [campaignId, liveBudgetAgorot],
  );
}
