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

// A creative-grain row within a window (for the rules engine + readout).
// `adSetId` (the parent ad set) lets the rules compare creatives WITHIN an
// audience rather than conflating the same creative across ad sets (AIC-36).
export interface CreativeStatRow {
  metaObjectId: string;
  adSetId: string | null;
  creativeName: string | null;
  spendAgorot: number;
  leads: number;
  cplAgorot: number | null;
  deliveryStatus: string;
}

// An ad-set-grain (audience) row within a window (AIC-36 audience rule + AIC-37
// per-audience surfacing).
export interface AdsetStatRow {
  adSetId: string;
  spendAgorot: number;
  leads: number;
  cplAgorot: number | null;
  deliveryStatus: string;
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
  // Creative-grain rows within [start, end], ordered by spend desc.
  creativeStats(
    campaignId: string,
    start: string,
    end: string,
  ): Promise<CreativeStatRow[]>;
  // Ad-set-grain (audience) rows within [start, end], ordered by spend desc.
  adsetStats(
    campaignId: string,
    start: string,
    end: string,
  ): Promise<AdsetStatRow[]>;
  // Per-DAY campaign rows within [start, end], ascending. ONLY rows whose
  // period covers exactly one day (period_start = period_end) — the rolling
  // 7-day windows stored alongside them OVERLAP and must never be summed
  // into a range (the real bug that made 1 lead read as 3).
  dailySeries(
    campaignId: string,
    start: string,
    end: string,
  ): Promise<DailyPoint[]>;
}

// One calendar day of campaign-grain performance.
export interface DailyPoint {
  date: string; // YYYY-MM-DD
  spendAgorot: number;
  leads: number;
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

  async creativeStats(
    campaignId: string,
    start: string,
    end: string,
  ): Promise<CreativeStatRow[]> {
    const { rows } = await this.pool.query<{
      meta_object_id: string;
      parent_meta_id: string | null;
      creative_name: string | null;
      spend_agorot: number;
      leads: number;
      cpl_agorot: number | null;
      delivery_status: string;
    }>(
      `SELECT meta_object_id, parent_meta_id, creative_name, spend_agorot, leads, cpl_agorot, delivery_status
       FROM insight_snapshots
       WHERE campaign_id = $1 AND grain = 'creative'
         AND period_start >= $2 AND period_end <= $3
       ORDER BY spend_agorot DESC`,
      [campaignId, start, end],
    );
    return rows.map((r) => ({
      metaObjectId: r.meta_object_id,
      adSetId: r.parent_meta_id,
      creativeName: r.creative_name,
      spendAgorot: Number(r.spend_agorot),
      leads: Number(r.leads),
      cplAgorot: r.cpl_agorot === null ? null : Number(r.cpl_agorot),
      deliveryStatus: r.delivery_status,
    }));
  }

  async adsetStats(
    campaignId: string,
    start: string,
    end: string,
  ): Promise<AdsetStatRow[]> {
    const { rows } = await this.pool.query<{
      meta_object_id: string;
      spend_agorot: number;
      leads: number;
      cpl_agorot: number | null;
      delivery_status: string;
    }>(
      `SELECT meta_object_id, spend_agorot, leads, cpl_agorot, delivery_status
       FROM insight_snapshots
       WHERE campaign_id = $1 AND grain = 'adset'
         AND period_start >= $2 AND period_end <= $3
       ORDER BY spend_agorot DESC`,
      [campaignId, start, end],
    );
    return rows.map((r) => ({
      adSetId: r.meta_object_id,
      spendAgorot: Number(r.spend_agorot),
      leads: Number(r.leads),
      cplAgorot: r.cpl_agorot === null ? null : Number(r.cpl_agorot),
      deliveryStatus: r.delivery_status,
    }));
  }

  async dailySeries(campaignId: string, start: string, end: string): Promise<DailyPoint[]> {
    const { rows } = await this.pool.query<{ d: string; spend_agorot: number; leads: number }>(
      // period_start = period_end is what makes a row a single DAY. Without
      // it this would also sweep up the overlapping rolling-7-day rows and
      // multiply every total.
      `SELECT to_char(period_start, 'YYYY-MM-DD') AS d,
              SUM(spend_agorot)::int AS spend_agorot,
              SUM(leads)::int        AS leads
       FROM insight_snapshots
       WHERE campaign_id = $1 AND grain = 'campaign'
         AND period_start = period_end
         AND period_start >= $2 AND period_start <= $3
       GROUP BY period_start
       ORDER BY period_start ASC`,
      [campaignId, start, end],
    );
    return rows.map((r) => ({ date: r.d, spendAgorot: Number(r.spend_agorot), leads: Number(r.leads) }));
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

  async creativeStats(
    campaignId: string,
    start: string,
    end: string,
  ): Promise<CreativeStatRow[]> {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.campaignId === campaignId &&
          r.grain === "creative" &&
          r.periodStart >= start &&
          r.periodEnd <= end,
      )
      .map((r) => ({
        metaObjectId: r.metaObjectId,
        adSetId: r.parentMetaId,
        creativeName: r.creativeName,
        spendAgorot: r.spendAgorot,
        leads: r.leads,
        cplAgorot: r.cplAgorot,
        deliveryStatus: r.deliveryStatus,
      }))
      .sort((a, b) => b.spendAgorot - a.spendAgorot);
  }

  async adsetStats(
    campaignId: string,
    start: string,
    end: string,
  ): Promise<AdsetStatRow[]> {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.campaignId === campaignId &&
          r.grain === "adset" &&
          r.periodStart >= start &&
          r.periodEnd <= end,
      )
      .map((r) => ({
        adSetId: r.metaObjectId,
        spendAgorot: r.spendAgorot,
        leads: r.leads,
        cplAgorot: r.cplAgorot,
        deliveryStatus: r.deliveryStatus,
      }))
      .sort((a, b) => b.spendAgorot - a.spendAgorot);
  }

  async dailySeries(campaignId: string, start: string, end: string): Promise<DailyPoint[]> {
    const byDate = new Map<string, DailyPoint>();
    for (const r of this.rows.values()) {
      // Single-day rows only — see the Pg implementation's note.
      if (r.campaignId !== campaignId || r.grain !== "campaign") continue;
      if (r.periodStart !== r.periodEnd) continue;
      if (r.periodStart < start || r.periodStart > end) continue;
      const cur = byDate.get(r.periodStart) ?? { date: r.periodStart, spendAgorot: 0, leads: 0 };
      cur.spendAgorot += r.spendAgorot;
      cur.leads += r.leads;
      byDate.set(r.periodStart, cur);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
}
