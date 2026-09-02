import type pg from "pg";
import type { OpsQueue } from "./ops-queue.js";

// AIC-178 — an ad set that is ACTIVE and serving nothing.
//
// The gap this fills, lived on 2026-09-02: a campaign ran dark for a full day
// while Meta reported every object ACTIVE, `issues_info` empty, and our own
// `delivery_ok` stayed true. Nothing we checked was wrong, because everything
// we checked was Meta's OWN STATUS — and Meta's status said healthy the whole
// time.
//
// So this asks a different question. Not "does Meta say this is delivering"
// but "did anything measurably happen". Those disagree exactly when it matters
// most, and the second one is the question an operator actually has.
//
// Deliberately AD-SET grain, not per-ad. The ad set is the unit the customer
// can act on (pause/resume live there, the dashboard groups by it) and the
// unit whose silence is unambiguous. A single dark ad inside a serving ad set
// is usually Meta's optimizer doing its job, and alerting on it would train
// everyone to ignore the channel.

/** Silence longer than this, on an ACTIVE ad set, is worth a message. */
export const SILENT_HOURS = 12;

export interface WatchRow {
  metaObjectId: string;
  /** Impressions measured for this object in the current (today) window. */
  impressions: number;
  /** Meta's effective status, as we last cached it. */
  active: boolean;
}

export interface WatchState {
  firstSeenAt: Date;
  lastServedAt: Date | null;
  alertedAt: Date | null;
}

export type WatchVerdict =
  /** It served this tick — stamp last_served_at and clear any standing alert. */
  | { kind: "serving" }
  /** Silent, but not long enough (or already reported). Nothing to do. */
  | { kind: "quiet" }
  /** Newly dark past the threshold — raise the alert once. */
  | { kind: "alert"; silentHours: number };

/**
 * What to do about one watched ad set this tick.
 *
 * Pure, so the rule is testable without a database — the same reason
 * builder-gates.ts and cta-health's `judge` are pure.
 *
 * The grace anchor is `firstSeenAt`, not epoch: a brand-new ad set has
 * legitimately served nothing (review, learning), and paging an operator about
 * an ad set created twenty minutes ago is how a channel gets muted. An ad set
 * we have never seen serve is judged from when we STARTED WATCHING it.
 *
 * A paused ad set is never an alert. Silence is the expected outcome of
 * pausing something, and reporting it as a fault would make every deliberate
 * pause look like a failure.
 */
export function judgeServing(row: WatchRow, state: WatchState, now: Date, silentHours = SILENT_HOURS): WatchVerdict {
  if (row.impressions > 0) return { kind: "serving" };
  if (!row.active) return { kind: "quiet" };
  if (state.alertedAt) return { kind: "quiet" }; // already reported this dark spell
  const since = state.lastServedAt ?? state.firstSeenAt;
  const silentMs = now.getTime() - since.getTime();
  const hours = silentMs / 3_600_000;
  if (hours < silentHours) return { kind: "quiet" };
  return { kind: "alert", silentHours: Math.floor(hours) };
}

export interface ServingObservation {
  metaObjectId: string;
  name: string;
  impressions: number;
  active: boolean;
}

export interface ServingWatchSummary {
  watched: number;
  alerted: number;
}

/**
 * Record this tick's observations and raise an ops item for anything newly
 * dark. Best-effort by contract: this is a monitor, and a monitor that can
 * fail an engine tick is worse than no monitor.
 */
export async function recordServing(deps: {
  pool: pg.Pool;
  ops: OpsQueue;
  campaignId: string;
  customerId: string | null;
  /** Meta's campaign id — what an operator pastes into Ads Manager. */
  campaignRef: string;
  observations: ServingObservation[];
  now?: Date;
  silentHours?: number;
}): Promise<ServingWatchSummary> {
  const { pool, ops, campaignId, customerId, campaignRef, observations } = deps;
  const now = deps.now ?? new Date();
  const silentHours = deps.silentHours ?? SILENT_HOURS;
  let alerted = 0;

  for (const o of observations) {
    // Upsert first so a brand-new ad set gets its grace anchor THIS tick
    // rather than being judged against a row that does not exist yet.
    const row = await pool.query<{ first_seen_at: Date; last_served_at: Date | null; alerted_at: Date | null }>(
      `INSERT INTO ad_serving_watch (meta_object_id, campaign_id, grain, first_seen_at)
       VALUES ($1, $2, 'adset', $3)
       ON CONFLICT (meta_object_id) DO UPDATE SET campaign_id = EXCLUDED.campaign_id
       RETURNING first_seen_at, last_served_at, alerted_at`,
      [o.metaObjectId, campaignId, now],
    );
    const state: WatchState = {
      firstSeenAt: row.rows[0].first_seen_at,
      lastServedAt: row.rows[0].last_served_at,
      alertedAt: row.rows[0].alerted_at,
    };

    const verdict = judgeServing(
      { metaObjectId: o.metaObjectId, impressions: o.impressions, active: o.active },
      state,
      now,
      silentHours,
    );

    if (verdict.kind === "serving") {
      // Clearing alerted_at is what makes the NEXT dark spell reportable. A
      // recovery that leaves the flag set turns a one-off alert into the last
      // alert this ad set will ever produce.
      await pool.query(
        `UPDATE ad_serving_watch SET last_served_at = $2, alerted_at = NULL WHERE meta_object_id = $1`,
        [o.metaObjectId, now],
      );
      continue;
    }
    if (verdict.kind !== "alert") continue;

    await ops.create({
      customerId,
      campaignId,
      type: "ads_not_serving",
      severity: "high",
      detail:
        `קבוצת המודעות "${o.name}" פעילה אבל לא הציגה כלום ${verdict.silentHours} שעות. ` +
        `מטא לא מדווחת על תקלה. campaign ${campaignRef}, adset ${o.metaObjectId}.`,
    });
    await pool.query(`UPDATE ad_serving_watch SET alerted_at = $2 WHERE meta_object_id = $1`, [o.metaObjectId, now]);
    alerted++;
  }

  return { watched: observations.length, alerted };
}

/**
 * Today's impressions per ad set, straight from the daily snapshots.
 *
 * A dedicated read rather than widening `SnapshotStore.adsetRangeStats`: that
 * contract is shared by the customer dashboard and the explorer, and neither
 * wants impressions. IMPRESSIONS, not spend, is the primitive here — an ad set
 * can serve real impressions on rounding-error spend, and alerting that it is
 * "not serving" would be false.
 */
export async function todayImpressionsByAdSet(
  pool: pg.Pool,
  campaignId: string,
  start: string,
  end: string,
): Promise<Map<string, number>> {
  const { rows } = await pool.query<{ meta_object_id: string; impressions: string }>(
    `SELECT meta_object_id, COALESCE(SUM(impressions), 0)::bigint AS impressions
       FROM insight_snapshot_daily
      WHERE campaign_id = $1 AND grain = 'adset'
        AND period_start >= $2 AND period_start <= $3
      GROUP BY meta_object_id`,
    [campaignId, start, end],
  );
  return new Map(rows.map((r) => [r.meta_object_id, Number(r.impressions)]));
}
