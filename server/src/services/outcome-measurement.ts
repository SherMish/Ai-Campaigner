import type pg from "pg";
import type { RecommendationType } from "@aic/shared";
import type { SnapshotStore } from "../meta/snapshot-store.js";
import { PgSnapshotStore } from "../meta/snapshot-store.js";
import { resolveThresholds } from "../recommendations/rules.js";
import {
  measurementWindows,
  isDueForMeasurement,
  outcomeFeatures,
  outcomeDelta,
  classifyOutcome,
  hasConfound,
  type ConfoundDetail,
  type OutcomeVerdict,
  type OutcomeWindow,
} from "../recommendations/outcomes.js";
import type { Logger } from "./logger.js";

// Outcome measurement (AIC-76) — the IO half. All judgement lives in the pure
// recommendations/outcomes.ts; this file only fetches, then persists.
//
// Runs as step 3 of the engine tick, AFTER ingestion and generation: it reads
// only already-ingested snapshots, and going last means an outcome recorded
// this tick is available to the next tick's rules.

export interface DueRecommendation {
  recommendationId: string;
  campaignId: string;
  type: RecommendationType;
  executedAt: Date;
  cooldownDays: number; // resolved per account — see the invariant in outcomes.ts
}

export interface OutcomeSummary {
  due: number;
  measured: number;
  failed: number;
  byVerdict: Partial<Record<OutcomeVerdict, number>>;
}

// Exclusive upper bound for a window, as YYYY-MM-DD — computed in TS and
// passed as a bound param, because this codebase has no SQL date arithmetic
// anywhere (the rollingPeriods convention).
function dayAfter(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  return new Date(d.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Executed recommendations that have no outcome row yet and whose after-window
// has fully passed.
//
// `r.state = 'executed'` is the load-bearing filter, NOT `executed_at IS NOT
// NULL` — completeExecution stamps executed_at on the FAILED path too
// (recommendation-service.ts), so a failed Meta write would otherwise be
// measured as though the change had landed. The IS NOT NULL is only a guard
// for the date math below.
//
// Due-ness is resolved in TS, not SQL: the window length is per-account
// (COOLDOWN_DAYS through resolveThresholds), so there is no single cutoff to
// push into the query. The candidate set is bounded by real executions.
export async function listDueForMeasurement(
  pool: pg.Pool,
  now: Date,
): Promise<DueRecommendation[]> {
  const { rows } = await pool.query<{
    id: string;
    campaign_id: string;
    type: RecommendationType;
    executed_at: Date;
    threshold_overrides: Record<string, number> | null;
    live_budget_agorot: number | null;
    agreed_budget_agorot: number | null;
  }>(
    `SELECT r.id, r.campaign_id, r.type, r.executed_at,
            mc.threshold_overrides, mc.live_budget_agorot, mc.agreed_budget_agorot
     FROM recommendations r
     JOIN managed_campaigns mc ON mc.id = r.campaign_id
     LEFT JOIN recommendation_outcomes o ON o.recommendation_id = r.id
     WHERE r.state = 'executed'
       AND r.executed_at IS NOT NULL
       AND o.id IS NULL`,
  );

  const due: DueRecommendation[] = [];
  for (const r of rows) {
    // Same budget precedence the dashboard and engine use: the live-synced
    // figure, falling back to the agreed ceiling before the first tick.
    const budget = r.live_budget_agorot ?? r.agreed_budget_agorot ?? 0;
    const { COOLDOWN_DAYS } = resolveThresholds(r.threshold_overrides, budget);
    if (!isDueForMeasurement(r.executed_at, COOLDOWN_DAYS, now)) continue;
    due.push({
      recommendationId: r.id,
      campaignId: r.campaign_id,
      type: r.type,
      executedAt: r.executed_at,
      cooldownDays: COOLDOWN_DAYS,
    });
  }
  return due;
}

// Anything else that could explain the movement. Reported with WHAT and WHEN
// so an operator can judge, rather than trusting an opaque flag.
export async function detectConfounds(
  pool: pg.Pool,
  opts: {
    campaignId: string;
    recommendationId: string;
    before: OutcomeWindow;
    after: OutcomeWindow;
    afterDaily: Array<{ date: string; spendAgorot: number }>;
  },
): Promise<ConfoundDetail | null> {
  // Any OTHER action on this campaign across the whole measured span — a
  // manual AIC-66 pause, a budget edit, another executed recommendation, a
  // builder/launch write. A change inside the BEFORE window matters too: it
  // makes the baseline unrepresentative.
  const { rows } = await pool.query<{ action_type: string; occurred_at: Date; human_involved: boolean }>(
    `SELECT action_type, occurred_at, human_involved
     FROM action_history
     WHERE campaign_id = $1
       AND (recommendation_id IS NULL OR recommendation_id <> $2)
       AND occurred_at >= $3 AND occurred_at < $4
     ORDER BY occurred_at`,
    [opts.campaignId, opts.recommendationId, opts.before.start, dayAfter(opts.after.end)],
  );

  // A day inside the after-window where the campaign spent nothing at all —
  // a real, positively-observed delivery interruption. (Days MISSING from the
  // series entirely aren't counted here; thin data is already handled by the
  // daysActive gate, and one signal should mean one thing.)
  const zeroSpendDays = opts.afterDaily.filter((d) => d.spendAgorot === 0).map((d) => d.date);

  const detail: ConfoundDetail = {
    otherActions: rows.map((r) => ({
      actionType: r.action_type,
      occurredAt: r.occurred_at.toISOString(),
      humanInvolved: r.human_involved,
    })),
    zeroSpendDays,
  };
  return hasConfound(detail) ? detail : null;
}

// AIC-67 reviews falling inside a window. RECORDED, never a verdict input:
// reviewed_at is when the CUSTOMER reviewed, and leads_delta covers everything
// since their previous review, so a review inside the after-window may well
// describe leads from before execution. Honest to record, dishonest to score.
async function leadQualityIn(
  pool: pg.Pool,
  campaignId: string,
  w: OutcomeWindow,
): Promise<{ reviewedLeads: number; relevantLeads: number } | null> {
  const { rows } = await pool.query<{ leads: string; relevant: string }>(
    `SELECT COALESCE(SUM(leads_delta),0) AS leads, COALESCE(SUM(relevant_delta),0) AS relevant
     FROM lead_quality_reviews
     WHERE campaign_id = $1 AND reviewed_at >= $2 AND reviewed_at < $3`,
    [campaignId, w.start, dayAfter(w.end)],
  );
  const reviewedLeads = Number(rows[0]?.leads ?? 0);
  if (reviewedLeads === 0) return null; // no feedback in this window — null, not a fake 0%
  return { reviewedLeads, relevantLeads: Number(rows[0]?.relevant ?? 0) };
}

// Measure one due recommendation and persist exactly one outcome row.
// Both windows are computed HERE, together, after the after-window closed —
// deliberately, not at execution time. Meta revises attribution for ~45 days,
// so a "before" captured live at execution and an "after" captured a week
// later would have had unequal settling time. Computing both now makes them
// equally settled, and therefore actually comparable.
export async function measureOne(deps: {
  pool: pg.Pool;
  snapshotStore: SnapshotStore;
  due: DueRecommendation;
}): Promise<OutcomeVerdict> {
  const { pool, snapshotStore, due } = deps;
  const { before, after } = measurementWindows(due.executedAt, due.cooldownDays);

  const [beforeTotals, afterTotals, beforeDaily, afterDaily] = await Promise.all([
    snapshotStore.campaignTotals(due.campaignId, before.start, before.end),
    snapshotStore.campaignTotals(due.campaignId, after.start, after.end),
    snapshotStore.dailySeries(due.campaignId, before.start, before.end),
    snapshotStore.dailySeries(due.campaignId, after.start, after.end),
  ]);

  const beforeF = outcomeFeatures(beforeTotals, beforeDaily);
  const afterF = outcomeFeatures(afterTotals, afterDaily);
  const delta = outcomeDelta(beforeF, afterF);

  const confound = await detectConfounds(pool, {
    campaignId: due.campaignId,
    recommendationId: due.recommendationId,
    before,
    after,
    afterDaily,
  });

  // Per-account thresholds again — the materiality band is overridable too.
  const { rows: mc } = await pool.query<{
    threshold_overrides: Record<string, number> | null;
    live_budget_agorot: number | null;
    agreed_budget_agorot: number | null;
  }>(
    `SELECT threshold_overrides, live_budget_agorot, agreed_budget_agorot
     FROM managed_campaigns WHERE id = $1`,
    [due.campaignId],
  );
  const thresholds = resolveThresholds(
    mc[0]?.threshold_overrides,
    mc[0]?.live_budget_agorot ?? mc[0]?.agreed_budget_agorot ?? 0,
  );

  const verdict = classifyOutcome({
    type: due.type,
    before: beforeF,
    after: afterF,
    delta,
    confound,
    thresholds,
  });

  const [lqBefore, lqAfter] = await Promise.all([
    leadQualityIn(pool, due.campaignId, before),
    leadQualityIn(pool, due.campaignId, after),
  ]);

  // ON CONFLICT DO NOTHING: recommendation_id is UNIQUE (migration 033) — an
  // outcome is measured ONCE at the defined window. A concurrent or repeated
  // tick can never double-score or silently rewrite a verdict with
  // later-revised attribution.
  await pool.query(
    `INSERT INTO recommendation_outcomes
       (recommendation_id, campaign_id, before_start, before_end, after_start, after_end,
        before_features, after_features, delta, verdict, confound_detail,
        lead_quality_before, lead_quality_after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (recommendation_id) DO NOTHING`,
    [
      due.recommendationId,
      due.campaignId,
      before.start,
      before.end,
      after.start,
      after.end,
      JSON.stringify(beforeF),
      JSON.stringify(afterF),
      JSON.stringify(delta),
      verdict,
      confound ? JSON.stringify(confound) : null,
      lqBefore ? JSON.stringify(lqBefore) : null,
      lqAfter ? JSON.stringify(lqAfter) : null,
    ],
  );

  return verdict;
}

// The tick. One failing recommendation never blocks the others — same
// fail-soft shape as every other step in the engine loop.
export async function runOutcomeTick(deps: {
  pool: pg.Pool;
  snapshotStore: SnapshotStore;
  now?: Date;
  logger?: Logger;
}): Promise<OutcomeSummary> {
  const now = deps.now ?? new Date();
  const log = deps.logger;
  const summary: OutcomeSummary = { due: 0, measured: 0, failed: 0, byVerdict: {} };

  const due = await listDueForMeasurement(deps.pool, now);
  summary.due = due.length;

  for (const d of due) {
    try {
      const verdict = await measureOne({ pool: deps.pool, snapshotStore: deps.snapshotStore, due: d });
      summary.measured++;
      summary.byVerdict[verdict] = (summary.byVerdict[verdict] ?? 0) + 1;
      log?.info(`[outcome] ${d.recommendationId} (${d.type}): ${verdict}`);
    } catch (e) {
      summary.failed++;
      log?.error(`[outcome] ${d.recommendationId}: measurement failed — ${(e as Error).message}`);
    }
  }
  return summary;
}

// Bind a tick to the DB. Unlike ingestion/generation this needs no Meta token —
// it reads only snapshots we already stored — so it is never inert.
export function buildOutcomeTick(pool: pg.Pool, logger?: Logger): () => Promise<OutcomeSummary> {
  const snapshotStore = new PgSnapshotStore(pool);
  return () => runOutcomeTick({ pool, snapshotStore, logger });
}
