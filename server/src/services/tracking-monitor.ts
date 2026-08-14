import type pg from "pg";
import type { OpsQueue } from "./ops-queue.js";
import type { TrackingSummary } from "../meta/tracking-health.js";

// Persist a campaign's tracking health (AIC-88) and raise an ops item when its
// declared lead definition doesn't match what Meta is optimizing for.
//
// TWO DELIBERATE DIFFERENCES from the delivery-monitor this otherwise mirrors —
// both fixing real flaws in that older pattern rather than inheriting them:
//
// 1. `unknown` NEVER writes `tracking_ok`. The summariser is three-valued, and
//    "we couldn't determine this" is not "it's fine". Writing `ok` on a failed
//    read would silently clear a real prior alarm. Only `tracking_checked_at`
//    advances, so an operator can still tell the check ran.
//
// 2. The ops item is raised IDEMPOTENTLY — "is it broken AND is there no open
//    item already" — not on the ok→broken edge. The edge-based version has a
//    latent failure the review surfaced: the flag UPDATE lands first, so if
//    `ops.create` then throws (a CHECK constraint not yet widened, any DB
//    error), the flag is already `false`, the next tick sees `wasOk = false`,
//    and the alert is never raised again — permanently lost, while the
//    customer-facing state still shows a problem nobody is watching. Keying
//    off an open item instead is robust to that, to write-ordering, and to an
//    operator manually resetting the flag.
export async function recordCampaignTracking(deps: {
  pool: pg.Pool;
  ops: OpsQueue;
  campaignId: string;
  customerId: string | null;
  summary: TrackingSummary;
}): Promise<{ raisedOps: boolean }> {
  const { pool, ops, campaignId, customerId, summary } = deps;

  if (summary.state === "unknown") {
    // Record only that we looked — never a verdict.
    await pool.query(
      `UPDATE managed_campaigns SET tracking_checked_at = now() WHERE id = $1`,
      [campaignId],
    );
    return { raisedOps: false };
  }

  const ok = summary.state === "ok";
  await pool.query(
    `UPDATE managed_campaigns
     SET tracking_ok = $2, tracking_reason = $3, tracking_detail = $4, tracking_checked_at = now()
     WHERE id = $1`,
    [campaignId, ok, ok ? null : summary.reason, ok ? null : JSON.stringify(summary.detail)],
  );

  if (ok) return { raisedOps: false };

  // Idempotent: one open item per campaign for this problem, however many
  // ticks it stays broken.
  const open = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM ops_queue_items
     WHERE campaign_id = $1 AND type = 'campaign_tracking_broken' AND status <> 'resolved'`,
    [campaignId],
  );
  if (Number(open.rows[0]?.n ?? 0) > 0) return { raisedOps: false };

  await ops.create({
    customerId,
    campaignId,
    type: "campaign_tracking_broken",
    severity: "high", // the campaign's headline numbers are structurally wrong
    detail: `lead tracking misconfigured: ${summary.reason ?? "unknown"}`,
  });
  return { raisedOps: true };
}
