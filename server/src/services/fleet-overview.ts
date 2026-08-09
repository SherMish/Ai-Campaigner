import type pg from "pg";
import type { CampaignStatus } from "@aic/shared";
import { conversionSummary, type ConversionSummary } from "./billing.js";
import { rollingPeriods } from "../meta/scheduled-ingestion.js";

// The operator's landing snapshot (AIC-43): "how is the whole book of business
// doing?" in one read. Two honestly-separated halves:
//   - operational numbers (campaigns, delivery, spend/leads, queue) cover EVERY
//     managed campaign, including internal/dogfood ones — the operator watches
//     those too.
//   - billing/conversion numbers (via conversionSummary) exclude test customers
//     — MRR should never count an account that was never going to pay.
// Reads only our DB; no live Meta call at render time.

export interface FleetOverview {
  campaignsByStatus: Partial<Record<CampaignStatus, number>>;
  delivering: number;
  needsAttentionDelivery: number;
  spendAgorot: number; // current rolling window, across all managed campaigns
  leads: number;
  period: { start: string; end: string };
  openOpsItems: number;
  conversion: ConversionSummary;
}

export async function buildFleetOverview(pool: pg.Pool): Promise<FleetOverview> {
  const { current } = rollingPeriods();

  const [statusRows, deliveryRow, spendRow, opsRow, conversion] = await Promise.all([
    pool.query<{ status: CampaignStatus; n: string }>(
      `SELECT status, count(*)::int AS n FROM managed_campaigns GROUP BY status`,
    ),
    pool.query<{ delivering: string; needs_attention: string }>(
      `SELECT count(*) FILTER (WHERE delivery_ok)::int AS delivering,
              count(*) FILTER (WHERE NOT delivery_ok)::int AS needs_attention
       FROM managed_campaigns WHERE status <> 'unmanaged'`,
    ),
    pool.query<{ spend: string; leads: string }>(
      `SELECT COALESCE(SUM(s.spend_agorot),0) AS spend, COALESCE(SUM(s.leads),0) AS leads
       FROM insight_snapshots s
       JOIN managed_campaigns mc ON mc.id = s.campaign_id
       WHERE s.grain = 'campaign' AND s.period_start >= $1 AND s.period_end <= $2`,
      [current.start, current.end],
    ),
    pool.query<{ n: string }>(`SELECT count(*)::int AS n FROM ops_queue_items WHERE status <> 'resolved'`),
    conversionSummary(pool),
  ]);

  const campaignsByStatus: Partial<Record<CampaignStatus, number>> = {};
  for (const r of statusRows.rows) campaignsByStatus[r.status] = Number(r.n);

  return {
    campaignsByStatus,
    delivering: Number(deliveryRow.rows[0]?.delivering ?? 0),
    needsAttentionDelivery: Number(deliveryRow.rows[0]?.needs_attention ?? 0),
    spendAgorot: Number(spendRow.rows[0]?.spend ?? 0),
    leads: Number(spendRow.rows[0]?.leads ?? 0),
    period: current,
    openOpsItems: Number(opsRow.rows[0]?.n ?? 0),
    conversion,
  };
}
