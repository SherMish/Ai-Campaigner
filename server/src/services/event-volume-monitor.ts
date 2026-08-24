import type pg from "pg";
import type { OpsQueue } from "./ops-queue.js";
import type { EventVolumeSummary } from "../meta/event-volume.js";

// Persist whether a campaign's lead event is still firing (AIC-91) and raise an
// ops item when it has stopped. Same discipline as its three siblings:
// `unknown` never writes the flag (a failed read is not "fine"), and the ops
// item is idempotent rather than edge-triggered.
export async function recordLeadEventVolume(deps: {
  pool: pg.Pool;
  ops: OpsQueue;
  campaignId: string;
  customerId: string | null;
  summary: EventVolumeSummary;
}): Promise<{ raisedOps: boolean }> {
  const { pool, ops, campaignId, customerId, summary } = deps;

  // not_applicable (a WhatsApp campaign with no pixel event) is settled truth,
  // so it clears a stale flag; unknown is not, so it only records that we looked.
  if (summary.state === "not_applicable") {
    await pool.query(
      `UPDATE managed_campaigns
       SET lead_event_ok = true, lead_event_reason = $2, lead_event_detail = $3, lead_event_checked_at = now()
       WHERE id = $1`,
      [campaignId, summary.reason, JSON.stringify(summary.detail)],
    );
    return { raisedOps: false };
  }
  if (summary.state === "unknown") {
    await pool.query(`UPDATE managed_campaigns SET lead_event_checked_at = now() WHERE id = $1`, [campaignId]);
    return { raisedOps: false };
  }

  const ok = summary.state === "ok";
  await pool.query(
    `UPDATE managed_campaigns
     SET lead_event_ok = $2, lead_event_reason = $3, lead_event_detail = $4, lead_event_checked_at = now()
     WHERE id = $1`,
    [campaignId, ok, ok ? null : summary.reason, ok ? null : JSON.stringify(summary.detail)],
  );
  if (ok) return { raisedOps: false };

  const open = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM ops_queue_items
     WHERE campaign_id = $1 AND type = 'lead_event_stopped' AND status <> 'resolved'`,
    [campaignId],
  );
  if (Number(open.rows[0]?.n ?? 0) > 0) return { raisedOps: false };

  await ops.create({
    customerId,
    campaignId,
    type: "lead_event_stopped",
    // high: leads are still arriving in reality and we are counting zero, so
    // every number the engine and the customer see is under-reported.
    severity: "high",
    detail: summary.reason ?? "the campaign's lead event stopped firing",
  });
  return { raisedOps: true };
}
