import type pg from "pg";
import type { Agorot } from "@aic/shared";
import type { CampaignStatus } from "@aic/shared";
import type { InsightsPeriod } from "../meta/types.js";
import { PgSnapshotStore, type PeriodAgg } from "../meta/snapshot-store.js";
import { rollingPeriods, todayPeriod } from "../meta/scheduled-ingestion.js";

export interface CreativeRow {
  metaObjectId: string;
  creativeName: string | null;
  spendAgorot: Agorot;
  leads: number;
  cplAgorot: Agorot | null;
  deliveryStatus: string;
}

export interface CampaignReadout {
  campaignId: string;
  name: string;
  status: CampaignStatus;
  metaCampaignId: string | null;
  period: { current: InsightsPeriod; previous: InsightsPeriod };
  current: PeriodAgg;
  previous: PeriodAgg;
  // Today so far — customer-surface only, and deliberately NOT folded into
  // `current` (which stops at yesterday). The engine evaluates on complete
  // days; blending a partial day into the 7-day CPL would make that ratio
  // noisy mid-day without helping anyone. Provisional: Meta's same-day
  // conversion data is incomplete and revises upward.
  today: PeriodAgg;
  delta: {
    spendPct: number | null;
    leadsPct: number | null;
    cplPct: number | null;
  };
  perCreative: CreativeRow[];
}

// Percent change vs a baseline, rounded. NULL when there's no baseline to
// compare against (previous = 0) — an honest "no comparison," not a fake +100%.
export function deltaPct(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

// Assemble the admin readout for one campaign entirely from insight_snapshots —
// no live Meta call at render time (AIC-7). `ref` lets tests fix the window.
export async function buildCampaignReadout(
  pool: pg.Pool,
  campaignId: string,
  ref: Date = new Date(),
): Promise<CampaignReadout | null> {
  const camp = await pool.query<{
    name: string;
    status: CampaignStatus;
    meta_campaign_id: string | null;
  }>(
    `SELECT name, status, meta_campaign_id FROM managed_campaigns WHERE id = $1`,
    [campaignId],
  );
  if (camp.rows.length === 0) return null;

  const { current, previous } = rollingPeriods(ref);
  const todayWindow = todayPeriod(ref);
  const store = new PgSnapshotStore(pool);
  const [cur, prev, today] = await Promise.all([
    store.campaignTotals(campaignId, current.start, current.end),
    store.campaignTotals(campaignId, previous.start, previous.end),
    store.campaignTotals(campaignId, todayWindow.start, todayWindow.end),
  ]);

  const creatives = await pool.query<{
    meta_object_id: string;
    creative_name: string | null;
    spend_agorot: number;
    leads: number;
    cpl_agorot: number | null;
    delivery_status: string;
  }>(
    `SELECT meta_object_id, creative_name, spend_agorot, leads, cpl_agorot, delivery_status
     FROM insight_snapshots
     WHERE campaign_id = $1 AND grain = 'creative'
       AND period_start >= $2 AND period_end <= $3
     ORDER BY spend_agorot DESC`,
    [campaignId, current.start, current.end],
  );

  return {
    campaignId,
    name: camp.rows[0].name,
    status: camp.rows[0].status,
    metaCampaignId: camp.rows[0].meta_campaign_id,
    period: { current, previous },
    current: cur,
    previous: prev,
    today,
    delta: {
      spendPct: deltaPct(cur.spendAgorot, prev.spendAgorot),
      leadsPct: deltaPct(cur.leads, prev.leads),
      cplPct:
        cur.cplAgorot !== null && prev.cplAgorot !== null
          ? deltaPct(cur.cplAgorot, prev.cplAgorot)
          : null,
    },
    perCreative: creatives.rows.map((r) => ({
      metaObjectId: r.meta_object_id,
      creativeName: r.creative_name,
      spendAgorot: Number(r.spend_agorot),
      leads: Number(r.leads),
      cplAgorot: r.cpl_agorot === null ? null : Number(r.cpl_agorot),
      deliveryStatus: r.delivery_status,
    })),
  };
}

// List managed campaigns for the admin picker.
export async function listCampaignsForAdmin(pool: pg.Pool): Promise<
  Array<{ id: string; name: string; status: CampaignStatus; business: string }>
> {
  const { rows } = await pool.query(
    `SELECT mc.id, mc.name, mc.status, c.business_name AS business
     FROM managed_campaigns mc
     JOIN customers c ON c.id = mc.customer_id
     ORDER BY c.business_name`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    business: r.business,
  }));
}
