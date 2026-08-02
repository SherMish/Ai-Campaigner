import type pg from "pg";
import type { Agorot } from "@aic/shared";
import type { SnapshotUpsert } from "./insights.js";
import { computeCpl } from "./insights.js";

// Aggregate campaign-grain totals for a window (period-over-period comparison).
export interface PeriodAgg {
  spendAgorot: Agorot;
  leads: number;
  cplAgorot: Agorot | null;
}

export interface SnapshotStore {
  // Idempotent per (campaign, grain, object, period): a re-run updates in place
  // rather than duplicating.
  upsert(rows: SnapshotUpsert[]): Promise<number>;
  // Campaign-grain totals within [start, end] (inclusive).
  campaignTotals(
    campaignId: string,
    start: string,
    end: string,
  ): Promise<PeriodAgg>;
}

export class PgSnapshotStore implements SnapshotStore {
  constructor(private readonly pool: pg.Pool) {}

  async upsert(rows: SnapshotUpsert[]): Promise<number> {
    let n = 0;
    for (const r of rows) {
      await this.pool.query(
        `INSERT INTO insight_snapshots
           (campaign_id, grain, meta_object_id, parent_meta_id, creative_name,
            period_start, period_end, spend_agorot, leads, cpl_agorot,
            impressions, link_clicks, delivery_status, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (campaign_id, grain, meta_object_id, period_start, period_end)
         DO UPDATE SET
           parent_meta_id = EXCLUDED.parent_meta_id,
           creative_name  = EXCLUDED.creative_name,
           spend_agorot   = EXCLUDED.spend_agorot,
           leads          = EXCLUDED.leads,
           cpl_agorot     = EXCLUDED.cpl_agorot,
           impressions    = EXCLUDED.impressions,
           link_clicks    = EXCLUDED.link_clicks,
           delivery_status= EXCLUDED.delivery_status,
           raw            = EXCLUDED.raw`,
        [
          r.campaignId,
          r.grain,
          r.metaObjectId,
          r.parentMetaId,
          r.creativeName,
          r.periodStart,
          r.periodEnd,
          r.spendAgorot,
          r.leads,
          r.cplAgorot,
          r.impressions,
          r.linkClicks,
          r.deliveryStatus,
          JSON.stringify(r.raw),
        ],
      );
      n++;
    }
    return n;
  }

  async campaignTotals(
    campaignId: string,
    start: string,
    end: string,
  ): Promise<PeriodAgg> {
    const { rows } = await this.pool.query<{
      spend: string | null;
      leads: string | null;
    }>(
      `SELECT COALESCE(SUM(spend_agorot),0) AS spend,
              COALESCE(SUM(leads),0)        AS leads
       FROM insight_snapshots
       WHERE campaign_id = $1 AND grain = 'campaign'
         AND period_start >= $2 AND period_end <= $3`,
      [campaignId, start, end],
    );
    const spendAgorot = Number(rows[0]?.spend ?? 0);
    const leads = Number(rows[0]?.leads ?? 0);
    return { spendAgorot, leads, cplAgorot: computeCpl(spendAgorot, leads) };
  }
}

// In-memory store for unit tests.
export class InMemorySnapshotStore implements SnapshotStore {
  public rows = new Map<string, SnapshotUpsert>();
  private key(r: SnapshotUpsert) {
    return `${r.campaignId}|${r.grain}|${r.metaObjectId}|${r.periodStart}|${r.periodEnd}`;
  }
  async upsert(rows: SnapshotUpsert[]): Promise<number> {
    for (const r of rows) this.rows.set(this.key(r), r);
    return rows.length;
  }
  async campaignTotals(
    campaignId: string,
    start: string,
    end: string,
  ): Promise<PeriodAgg> {
    let spendAgorot = 0;
    let leads = 0;
    for (const r of this.rows.values()) {
      if (
        r.campaignId === campaignId &&
        r.grain === "campaign" &&
        r.periodStart >= start &&
        r.periodEnd <= end
      ) {
        spendAgorot += r.spendAgorot;
        leads += r.leads;
      }
    }
    return { spendAgorot, leads, cplAgorot: computeCpl(spendAgorot, leads) };
  }
}
