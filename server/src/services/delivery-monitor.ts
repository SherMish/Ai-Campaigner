import type pg from "pg";
import type { OpsQueue } from "./ops-queue.js";
import { summarize, type DeliverySummary, type DeliveryReader } from "../meta/delivery-health.js";

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
     SET delivery_ok = $2, delivery_reason = $3, delivery_checked_at = now(),
         delivering = $4, delivering_ad_count = $5
     WHERE id = $1`,
    [campaignId, summary.ok, summary.ok ? null : summary.reason, summary.delivering, summary.deliveringAdCount],
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

// AIC-71 follow-up (found live, same day): the customer-facing "מצב" headline
// reads `delivering`, which was only ever recomputed on the hourly engine
// tick — a customer who pauses their own ad/ad set via the manual controls
// (AIC-66) still saw "פעיל" for up to an hour after, silently contradicting
// the action they'd just taken. Called from the pause/resume/archive/delete
// routes right after a real write, so the headline catches up within the
// same request instead of waiting for the next tick. Best-effort: a read
// failure here must never fail the manual action that triggered it — the
// write already succeeded and was already verified by setObjectStatus.
export async function refreshDeliveryNow(deps: {
  pool: pg.Pool;
  ops: OpsQueue;
  deliveryReader: DeliveryReader;
  campaignId: string;
  customerId: string | null;
  metaCampaignId: string;
}): Promise<void> {
  const { pool, ops, deliveryReader, campaignId, customerId, metaCampaignId } = deps;
  try {
    const health = await deliveryReader.getDeliveryHealth(metaCampaignId);
    const summary = summarize(health);
    await recordCampaignDelivery({ pool, ops, campaignId, customerId, summary });
  } catch (e) {
    console.error(`[delivery-monitor] refreshDeliveryNow failed for ${campaignId}`, e);
  }
}
