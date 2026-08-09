import type pg from "pg";
import type { OpsQueue } from "./ops-queue.js";
import type { DeliverySummary } from "../meta/delivery-health.js";

// Persist a campaign's delivery health (AIC-39) and raise an ops item on the
// ok → not-ok transition only (so a still-broken campaign doesn't spam the queue
// every tick). Updating `delivery_ok`/`delivery_reason` — not `status` — means a
// delivery problem shows the customer "needs attention" without stopping the
// engine from optimizing the campaign's healthy ad sets.
export async function recordCampaignDelivery(deps: {
  pool: pg.Pool;
  ops: OpsQueue;
  campaignId: string;
  customerId: string | null;
  summary: DeliverySummary;
}): Promise<{ raisedOps: boolean }> {
  const { pool, ops, campaignId, customerId, summary } = deps;

  const prev = await pool.query<{ delivery_ok: boolean }>(
    `SELECT delivery_ok FROM managed_campaigns WHERE id = $1`,
    [campaignId],
  );
  const wasOk = prev.rows[0]?.delivery_ok ?? true;

  await pool.query(
    `UPDATE managed_campaigns
     SET delivery_ok = $2, delivery_reason = $3, delivery_checked_at = now()
     WHERE id = $1`,
    [campaignId, summary.ok, summary.ok ? null : summary.reason],
  );

  if (!summary.ok && wasOk) {
    await ops.create({
      customerId,
      campaignId,
      type: "campaign_not_delivering",
      severity: "high", // high → the existing alert hook fires (Telegram sink TBD)
      detail: `ad set(s) not delivering: ${summary.reason ?? "unknown"} [${summary.problemAdSetIds.join(", ")}]`,
    });
    return { raisedOps: true };
  }
  return { raisedOps: false };
}
