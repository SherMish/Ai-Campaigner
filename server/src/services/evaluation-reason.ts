import type pg from "pg";
import type { RecommendationDraft } from "../recommendations/types.js";

// Persist why the engine had nothing to propose this tick (AIC-64), cached per
// campaign (migration 024) so the dashboard/ops console can show it without
// re-running evaluation at render time — mirrors delivery_ok/delivery_reason
// (AIC-39). Cleared when an acting recommendation exists: there's nothing to
// explain, and a stale reason next to a live proposal would be misleading.
export async function recordNoRecReason(deps: {
  pool: pg.Pool;
  campaignId: string;
  draft: RecommendationDraft;
}): Promise<void> {
  const { pool, campaignId, draft } = deps;

  if (draft.type !== "no_action") {
    await pool.query(
      `UPDATE managed_campaigns
       SET no_rec_reason = NULL, no_rec_detail = NULL, no_rec_checked_at = now()
       WHERE id = $1`,
      [campaignId],
    );
    return;
  }

  const evidence = draft.evidence as { reason: string; detail?: Record<string, unknown> };
  await pool.query(
    `UPDATE managed_campaigns
     SET no_rec_reason = $2, no_rec_detail = $3, no_rec_checked_at = now()
     WHERE id = $1`,
    [campaignId, evidence.reason, JSON.stringify(evidence.detail ?? {})],
  );
}
