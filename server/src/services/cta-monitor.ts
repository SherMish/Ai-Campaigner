import type pg from "pg";
import type { OpsQueue } from "./ops-queue.js";
import type { CtaSummary } from "../meta/cta-health.js";

// Persist a campaign's CTA health (AIC-128) and raise an ops item when an ad's
// button has no destination behind it.
//
// Mirrors recordCampaignTracking exactly, including both of the corrections
// that pattern made to the older delivery-monitor:
//
// 1. `unknown` NEVER writes `cta_ok`. Four-valued summariser; "we couldn't
//    determine this" is not "it's fine", and writing ok on a failed Meta read
//    would silently clear a real prior alarm. Only `cta_checked_at` advances.
//
// 2. The ops item is raised IDEMPOTENTLY — "broken AND no open item" — not on
//    the ok→broken edge. An edge-based raise loses the alert permanently if
//    ops.create throws after the flag UPDATE has already landed (a CHECK
//    constraint not yet widened is precisely how that happens here; see
//    migration 042).
export async function recordCampaignCta(deps: {
  pool: pg.Pool;
  ops: OpsQueue;
  campaignId: string;
  customerId: string | null;
  summary: CtaSummary;
}): Promise<{ raisedOps: boolean }> {
  const { pool, ops, campaignId, customerId, summary } = deps;

  // not_applicable is the settled truth for an engagement campaign, so it is
  // persisted as ok-with-a-reason — that clears a stale `broken` flag left by
  // an earlier configuration. `unknown` is not, for the reason above.
  if (summary.state === "not_applicable") {
    await pool.query(
      `UPDATE managed_campaigns
       SET cta_ok = true, cta_reason = $2, cta_detail = $3, cta_checked_at = now()
       WHERE id = $1`,
      [campaignId, summary.reason, JSON.stringify(summary.detail)],
    );
    return { raisedOps: false };
  }

  if (summary.state === "unknown") {
    await pool.query(`UPDATE managed_campaigns SET cta_checked_at = now() WHERE id = $1`, [campaignId]);
    return { raisedOps: false };
  }

  const ok = summary.state === "ok";
  await pool.query(
    `UPDATE managed_campaigns
     SET cta_ok = $2, cta_reason = $3, cta_detail = $4, cta_checked_at = now()
     WHERE id = $1`,
    [campaignId, ok, ok ? null : summary.reason, ok ? null : JSON.stringify(summary.detail)],
  );

  if (ok) return { raisedOps: false };

  const open = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM ops_queue_items
     WHERE campaign_id = $1 AND type = 'campaign_cta_broken' AND status <> 'resolved'`,
    [campaignId],
  );
  if (Number(open.rows[0]?.n ?? 0) > 0) return { raisedOps: false };

  await ops.create({
    customerId,
    campaignId,
    type: "campaign_cta_broken",
    // high: the ads are live and spending on clicks that cannot arrive. This
    // is not degraded measurement, it is 100% wasted budget.
    severity: "high",
    detail: summary.reason ?? "an ad's button has no destination",
  });
  return { raisedOps: true };
}
