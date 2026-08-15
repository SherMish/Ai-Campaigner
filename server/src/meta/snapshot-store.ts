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
  // AIC-95: the range-switcher's per-object equivalent of dailySeries — SUMS
  // only the disjoint daily rows for each creative/ad set within [start, end],
  // never the overlapping rolling row creativeStats/adsetStats return. Those
  // two answer "this object's current standing" (always ~7 days, no window
  // choice); these answer "what did this object do in the window the
  // customer picked" — a genuinely different question needing its own method,
  // not a parameter on the existing ones.
  creativeRangeStats(
    campaignId: string,
    start: string,
    end: string,
  ): Promise<CreativeStatRow[]>;
  adsetRangeStats(
    campaignId: string,
    start: string,
    end: string,
  ): Promise<AdsetStatRow[]>;
  // The most recent day (YYYY-MM-DD) we have ANY disjoint-daily adset/creative
  // row for — null if never. Distinguishes, for the "why is this empty"
  // message: a campaign that started delivering today (most recent = today,
  // but the selected window doesn't include enough of it) from one that's
  // been paused for weeks (most recent = a real past date) from one that's
  // never had real per-object data at all (null). Campaign-grain excluded —
  // that grain having data says nothing about ad-set/creative data existing.
  mostRecentObjectDataDate(campaignId: string): Promise<string | null>;
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
      // Sums the DAILY VIEW, never the table — a rolling-window row and the
      // per-day rows covering the same days would both fall inside this window
      // and double-count (migration 030; the engine really read 8 leads where
      // the customer had 4). The view makes that arithmetically impossible
      // rather than relying on every caller to remember a filter.
      `SELECT COALESCE(SUM(spend_agorot),0) AS spend,
              COALESCE(SUM(leads),0)        AS leads
       FROM insight_snapshot_daily
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
      `SELECT DISTINCT ON (meta_object_id)
              meta_object_id, parent_meta_id, creative_name, spend_agorot, leads, cpl_agorot, delivery_status
       FROM insight_snapshots
       WHERE campaign_id = $1 AND grain = 'creative'
         AND period_start >= $2 AND period_end <= $3
         AND period_start != period_end
       ORDER BY meta_object_id, period_end DESC, created_at DESC, spend_agorot DESC`,
      [campaignId, start, end],
    );
    return rows
      .map((r) => ({
        metaObjectId: r.meta_object_id,
        adSetId: r.parent_meta_id,
        creativeName: r.creative_name,
        spendAgorot: Number(r.spend_agorot),
        leads: Number(r.leads),
        cplAgorot: r.cpl_agorot === null ? null : Number(r.cpl_agorot),
        deliveryStatus: r.delivery_status,
      }))
      .sort((a, b) => b.spendAgorot - a.spendAgorot);
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
      `SELECT DISTINCT ON (meta_object_id)
              meta_object_id, spend_agorot, leads, cpl_agorot, delivery_status
       FROM insight_snapshots
       WHERE campaign_id = $1 AND grain = 'adset'
         AND period_start >= $2 AND period_end <= $3
         AND period_start != period_end
       ORDER BY meta_object_id, period_end DESC, created_at DESC, spend_agorot DESC`,
      [campaignId, start, end],
    );
    return rows
      .map((r) => ({
        adSetId: r.meta_object_id,
        spendAgorot: Number(r.spend_agorot),
        leads: Number(r.leads),
        cplAgorot: r.cpl_agorot === null ? null : Number(r.cpl_agorot),
        deliveryStatus: r.delivery_status,
      }))
      .sort((a, b) => b.spendAgorot - a.spendAgorot);
  }

  async dailySeries(campaignId: string, start: string, end: string): Promise<DailyPoint[]> {
    const { rows } = await this.pool.query<{ d: string; spend_agorot: number; leads: number }>(
      // Reads insight_snapshot_daily (migration 030), not the table — this
      // query already filtered to period_start = period_end by hand before
      // the view existed; now it goes through the same single door every
      // other windowed SUM does.
      `SELECT to_char(period_start, 'YYYY-MM-DD') AS d,
              SUM(spend_agorot)::int AS spend_agorot,
              SUM(leads)::int        AS leads
       FROM insight_snapshot_daily
       WHERE campaign_id = $1 AND grain = 'campaign'
         AND period_start >= $2 AND period_start <= $3
       GROUP BY period_start
       ORDER BY period_start ASC`,
      [campaignId, start, end],
    );
    return rows.map((r) => ({ date: r.d, spendAgorot: Number(r.spend_agorot), leads: Number(r.leads) }));
  }

  async creativeRangeStats(campaignId: string, start: string, end: string): Promise<CreativeStatRow[]> {
    const { rows } = await this.pool.query<{
      meta_object_id: string;
      parent_meta_id: string | null;
      creative_name: string | null;
      spend_agorot: string;
      leads: string;
      delivery_status: string;
    }>(
      // insight_snapshot_daily (migration 030) already excludes the rolling
      // row by construction (period_start = period_end) — no separate
      // DISTINCT ON needed here the way creativeStats needs it; there's only
      // ever one row per object per day to begin with.
      `SELECT meta_object_id,
              (array_agg(parent_meta_id ORDER BY period_start DESC))[1] AS parent_meta_id,
              (array_agg(creative_name ORDER BY period_start DESC))[1] AS creative_name,
              SUM(spend_agorot)::int AS spend_agorot,
              SUM(leads)::int        AS leads,
              (array_agg(delivery_status ORDER BY period_start DESC))[1] AS delivery_status
       FROM insight_snapshot_daily
       WHERE campaign_id = $1 AND grain = 'creative'
         AND period_start >= $2 AND period_start <= $3
       GROUP BY meta_object_id`,
      [campaignId, start, end],
    );
    return rows
      .map((r) => {
        const spendAgorot = Number(r.spend_agorot);
        const leads = Number(r.leads);
        return {
          metaObjectId: r.meta_object_id,
          adSetId: r.parent_meta_id,
          creativeName: r.creative_name,
          spendAgorot,
          leads,
          cplAgorot: computeCpl(spendAgorot, leads),
          deliveryStatus: r.delivery_status,
        };
      })
      .sort((a, b) => b.spendAgorot - a.spendAgorot);
  }

  async adsetRangeStats(campaignId: string, start: string, end: string): Promise<AdsetStatRow[]> {
    const { rows } = await this.pool.query<{
      meta_object_id: string;
      spend_agorot: string;
      leads: string;
      delivery_status: string;
    }>(
      `SELECT meta_object_id,
              SUM(spend_agorot)::int AS spend_agorot,
              SUM(leads)::int        AS leads,
              (array_agg(delivery_status ORDER BY period_start DESC))[1] AS delivery_status
       FROM insight_snapshot_daily
       WHERE campaign_id = $1 AND grain = 'adset'
         AND period_start >= $2 AND period_start <= $3
       GROUP BY meta_object_id`,
      [campaignId, start, end],
    );
    return rows
      .map((r) => {
        const spendAgorot = Number(r.spend_agorot);
        const leads = Number(r.leads);
        return {
          adSetId: r.meta_object_id,
          spendAgorot,
          leads,
          cplAgorot: computeCpl(spendAgorot, leads),
          deliveryStatus: r.delivery_status,
        };
      })
      .sort((a, b) => b.spendAgorot - a.spendAgorot);
  }

  async mostRecentObjectDataDate(campaignId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ d: string | null }>(
      `SELECT to_char(MAX(period_start), 'YYYY-MM-DD') AS d
       FROM insight_snapshot_daily
       WHERE campaign_id = $1 AND grain IN ('adset', 'creative')`,
      [campaignId],
    );
    return rows[0]?.d ?? null;
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
        // Mirrors the insight_snapshot_daily view (migration 030): disjoint
        // per-day rows only, so an overlapping rolling-window row can never be
        // summed alongside the days it covers.
        r.periodStart === r.periodEnd &&
        r.periodStart >= start &&
        r.periodEnd <= end
      ) {
        spendAgorot += r.spendAgorot;
        leads += r.leads;
      }
    }
    return { spendAgorot, leads, cplAgorot: computeCpl(spendAgorot, leads) };
  }

  // Mirrors PgSnapshotStore's DISTINCT ON fix: a single-day row is a slice,
  // never an object's totals for the requested window — only the
  // rolling/aggregate row (period_start != period_end) qualifies. Kept as
  // one shared helper so creativeStats/adsetStats can't drift apart.
  private latestPerObject(rows: SnapshotUpsert[], start: string, end: string, keyOf: (r: SnapshotUpsert) => string): SnapshotUpsert[] {
    const byObject = new Map<string, SnapshotUpsert>();
    for (const r of rows) {
      if (r.periodStart < start || r.periodEnd > end || r.periodStart === r.periodEnd) continue;
      const key = keyOf(r);
      const existing = byObject.get(key);
      if (!existing || r.periodEnd > existing.periodEnd) byObject.set(key, r);
    }
    return [...byObject.values()];
  }

  async creativeStats(
    campaignId: string,
    start: string,
    end: string,
  ): Promise<CreativeStatRow[]> {
    const rows = [...this.rows.values()].filter((r) => r.campaignId === campaignId && r.grain === "creative");
    return this.latestPerObject(rows, start, end, (r) => r.metaObjectId)
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
    const rows = [...this.rows.values()].filter((r) => r.campaignId === campaignId && r.grain === "adset");
    return this.latestPerObject(rows, start, end, (r) => r.metaObjectId)
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

  // Shared by creativeRangeStats/adsetRangeStats — disjoint daily rows only
  // (mirrors dailySeries above), grouped per object instead of summed campaign-
  // wide. Keeping this a shared private helper is what keeps the two methods
  // from drifting the way the Pg queries deliberately share one predicate.
  private sumDailyPerObject(campaignId: string, grain: SnapshotUpsert["grain"], start: string, end: string) {
    const byObject = new Map<string, { spendAgorot: number; leads: number; parentMetaId: string | null; creativeName: string | null; deliveryStatus: string; latestDate: string }>();
    for (const r of this.rows.values()) {
      if (r.campaignId !== campaignId || r.grain !== grain) continue;
      if (r.periodStart !== r.periodEnd) continue; // rolling row — excluded
      if (r.periodStart < start || r.periodStart > end) continue;
      const cur = byObject.get(r.metaObjectId) ?? { spendAgorot: 0, leads: 0, parentMetaId: null, creativeName: null, deliveryStatus: r.deliveryStatus, latestDate: "" };
      cur.spendAgorot += r.spendAgorot;
      cur.leads += r.leads;
      if (r.periodStart >= cur.latestDate) {
        cur.parentMetaId = r.parentMetaId;
        cur.creativeName = r.creativeName;
        cur.deliveryStatus = r.deliveryStatus;
        cur.latestDate = r.periodStart;
      }
      byObject.set(r.metaObjectId, cur);
    }
    return byObject;
  }

  async creativeRangeStats(campaignId: string, start: string, end: string): Promise<CreativeStatRow[]> {
    const byObject = this.sumDailyPerObject(campaignId, "creative", start, end);
    return [...byObject.entries()]
      .map(([metaObjectId, v]) => ({
        metaObjectId,
        adSetId: v.parentMetaId,
        creativeName: v.creativeName,
        spendAgorot: v.spendAgorot,
        leads: v.leads,
        cplAgorot: computeCpl(v.spendAgorot, v.leads),
        deliveryStatus: v.deliveryStatus,
      }))
      .sort((a, b) => b.spendAgorot - a.spendAgorot);
  }

  async adsetRangeStats(campaignId: string, start: string, end: string): Promise<AdsetStatRow[]> {
    const byObject = this.sumDailyPerObject(campaignId, "adset", start, end);
    return [...byObject.entries()]
      .map(([adSetId, v]) => ({
        adSetId,
        spendAgorot: v.spendAgorot,
        leads: v.leads,
        cplAgorot: computeCpl(v.spendAgorot, v.leads),
        deliveryStatus: v.deliveryStatus,
      }))
      .sort((a, b) => b.spendAgorot - a.spendAgorot);
  }

  async mostRecentObjectDataDate(campaignId: string): Promise<string | null> {
    let latest: string | null = null;
    for (const r of this.rows.values()) {
      if (r.campaignId !== campaignId) continue;
      if (r.grain !== "adset" && r.grain !== "creative") continue;
      if (r.periodStart !== r.periodEnd) continue; // rolling row — excluded
      if (!latest || r.periodStart > latest) latest = r.periodStart;
    }
    return latest;
  }
}
