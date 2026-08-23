import type pg from "pg";
import type { CampaignStatus, OpsQueueType, OpsSeverity } from "@aic/shared";
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

export interface TrendPoint {
  date: string; // YYYY-MM-DD
  spendAgorot: number;
  leads: number;
}

export interface AutomationSummary {
  total: number;
  automated: number;
  human: number;
  rate: number; // automated / total; 0 when there are no actions at all
}

export interface QueueHealth {
  open: number;
  openBySeverity: Partial<Record<OpsSeverity, number>>;
  // Typed as OpsQueueType, not string, so the admin UI's Hebrew label lookup
  // (Record<OpsQueueType, string>) stays exhaustively checked end-to-end
  // rather than needing a cast at the call site.
  topTypes: Array<{ type: OpsQueueType; count: number }>;
}

export interface FleetHealth {
  managed: number;
  deliveryOk: number;
  deliveryBroken: number;
  trackingOk: number;
  trackingBroken: number;
}

export interface FleetOverview {
  campaignsByStatus: Partial<Record<CampaignStatus, number>>;
  delivering: number;
  needsAttentionDelivery: number;
  spendAgorot: number; // current rolling window, across all managed campaigns
  leads: number;
  period: { start: string; end: string };
  openOpsItems: number;
  conversion: ConversionSummary;
  // AIC-122: the four analytics blocks on /admin.
  trend: TrendPoint[];
  automation: AutomationSummary;
  queueHealth: QueueHealth;
  health: FleetHealth;
}

// How far back the fleet trend chart looks. 30 days is enough to see a shape
// without the chart becoming a smear at this account volume.
const TREND_DAYS = 30;

export async function buildFleetOverview(pool: pg.Pool): Promise<FleetOverview> {
  const { current } = rollingPeriods();

  const [statusRows, deliveryRow, spendRow, opsRow, conversion, trendRows, automationRow, queueSevRows, queueTypeRows, healthRow] = await Promise.all([
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

    // AIC-122 trend. Reads insight_snapshot_daily, NOT insight_snapshots —
    // migration 030's stated rule: "any SUM over time reads
    // insight_snapshot_daily". The table mixes disjoint per-day rows with
    // OVERLAPPING rolling-window rows, and summing across both double-counts.
    // That exact mistake shipped twice before (a real lead read as 3, and the
    // engine reading 2x its true evidence), so this is the one query shape in
    // here that must not be written the obvious way.
    pool.query<{ d: string; spend: string; leads: string }>(
      `SELECT period_start::text AS d,
              COALESCE(SUM(spend_agorot),0)::int AS spend,
              COALESCE(SUM(leads),0)::int AS leads
       FROM insight_snapshot_daily
       WHERE grain = 'campaign' AND period_start >= (CURRENT_DATE - $1::int)
       GROUP BY period_start
       ORDER BY period_start`,
      [TREND_DAYS],
    ),

    // AIC-122 automation rate. human_involved is set on every action_history
    // write, so this is a byproduct of data already logged — no new
    // instrumentation. Counts every managed campaign's actions, including
    // dogfood ones, matching the operational half of this overview.
    pool.query<{ total: string; automated: string }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE NOT human_involved)::int AS automated
       FROM action_history`,
    ),

    pool.query<{ severity: string; n: string }>(
      `SELECT severity, count(*)::int AS n FROM ops_queue_items
       WHERE status <> 'resolved' GROUP BY severity`,
    ),
    pool.query<{ type: string; n: string }>(
      `SELECT type, count(*)::int AS n FROM ops_queue_items
       WHERE status <> 'resolved' GROUP BY type ORDER BY n DESC, type`,
    ),

    // AIC-122 fleet health. 'unmanaged' is excluded on purpose: it is not part
    // of the book we are responsible for, so counting its broken delivery
    // would make the health number pessimistic in a way nobody can act on.
    pool.query<{ managed: string; d_ok: string; t_ok: string }>(
      `SELECT count(*)::int AS managed,
              count(*) FILTER (WHERE delivery_ok)::int AS d_ok,
              count(*) FILTER (WHERE tracking_ok)::int AS t_ok
       FROM managed_campaigns WHERE status <> 'unmanaged'`,
    ),
  ]);

  const campaignsByStatus: Partial<Record<CampaignStatus, number>> = {};
  for (const r of statusRows.rows) campaignsByStatus[r.status] = Number(r.n);

  const automationTotal = Number(automationRow.rows[0]?.total ?? 0);
  const automated = Number(automationRow.rows[0]?.automated ?? 0);

  const openBySeverity: Partial<Record<OpsSeverity, number>> = { high: 0, medium: 0, low: 0 };
  for (const r of queueSevRows.rows) openBySeverity[r.severity as OpsSeverity] = Number(r.n);

  const managed = Number(healthRow.rows[0]?.managed ?? 0);
  const deliveryOk = Number(healthRow.rows[0]?.d_ok ?? 0);
  const trackingOk = Number(healthRow.rows[0]?.t_ok ?? 0);

  return {
    campaignsByStatus,
    delivering: Number(deliveryRow.rows[0]?.delivering ?? 0),
    needsAttentionDelivery: Number(deliveryRow.rows[0]?.needs_attention ?? 0),
    spendAgorot: Number(spendRow.rows[0]?.spend ?? 0),
    leads: Number(spendRow.rows[0]?.leads ?? 0),
    period: current,
    openOpsItems: Number(opsRow.rows[0]?.n ?? 0),
    conversion,
    trend: trendRows.rows.map((r) => ({
      // period_start is a DATE; ::text renders it YYYY-MM-DD with no timezone
      // shifting — casting in SQL rather than through a JS Date on purpose,
      // since a Date round-trip would move the day for anyone east of UTC.
      date: r.d,
      spendAgorot: Number(r.spend),
      leads: Number(r.leads),
    })),
    automation: {
      total: automationTotal,
      automated,
      human: automationTotal - automated,
      // Guarded: no actions yet is 0%, not NaN.
      rate: automationTotal > 0 ? automated / automationTotal : 0,
    },
    queueHealth: {
      open: Number(opsRow.rows[0]?.n ?? 0),
      openBySeverity,
      topTypes: queueTypeRows.rows.map((r) => ({ type: r.type as OpsQueueType, count: Number(r.n) })),
    },
    health: {
      managed,
      deliveryOk,
      deliveryBroken: managed - deliveryOk,
      trackingOk,
      trackingBroken: managed - trackingOk,
    },
  };
}
