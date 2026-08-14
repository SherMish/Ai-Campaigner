// Outcome measurement (AIC-76): did the recommendation actually help?
//
// PURE. No DB, no Meta, no clock of its own — every input is passed in, so
// every rule here is testable without a database or fake timers (the same
// split features.ts follows, and the same reason: the interesting logic
// shouldn't need infrastructure to exercise).
//
// ── Attribution honesty (the rule everything else here serves) ──────────────
// We measure CORRELATION AFTER our change, never causation. Meta's own
// optimisation, seasonality, budget edits and competitor activity all move
// CPL. Nothing in this module — and nothing built on it — may say our change
// CAUSED the delta. The verdict names below are observations about a window,
// not claims about a mechanism.
import type { RecommendationType } from "@aic/shared";
import type { PeriodAgg, DailyPoint } from "../meta/snapshot-store.js";
import { campaignCpl, daysActive } from "./features.js";
import { RULE_THRESHOLDS, type RuleThresholds } from "./rules.js";

export type OutcomeVerdict =
  | "improved"
  | "degraded"
  | "neutral"
  | "confounded"
  | "insufficient_data"
  | "not_measurable";

export interface OutcomeWindow {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD, inclusive
}

export interface OutcomeFeatures {
  spendAgorot: number;
  leads: number;
  cplAgorot: number | null; // null-honest: null when leads = 0, never 0 or ∞
  daysActive: number;
}

export interface OutcomeDelta {
  cplPct: number | null; // null when the before value was 0 — no comparison
  leadsPct: number | null;
  spendPct: number | null;
}

// ── Windows ─────────────────────────────────────────────────────────────────
// Anchored on executed_at (never created_at — the change lands at execution,
// so that's the only moment a before/after boundary means anything).
//
// The EXECUTION DAY ITSELF is in neither window. The change landed part-way
// through it, so that day is a blend of both states — contaminated by
// construction. Excluding it is the same "complete days only" discipline the
// engine's evidence gates already follow (docs/features/customer-overview.md's
// today-vs-engine-window split).
export function measurementWindows(
  executedAt: Date,
  windowDays: number,
): { before: OutcomeWindow; after: OutcomeWindow } {
  const day = 24 * 60 * 60 * 1000;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  // Midnight UTC of the execution day, so window edges are whole dates and
  // match how snapshots are keyed (rollingPeriods uses the same iso() slice).
  const execDay = new Date(`${iso(executedAt)}T00:00:00.000Z`);
  return {
    before: {
      start: iso(new Date(execDay.getTime() - windowDays * day)),
      end: iso(new Date(execDay.getTime() - day)),
    },
    after: {
      start: iso(new Date(execDay.getTime() + day)),
      end: iso(new Date(execDay.getTime() + windowDays * day)),
    },
  };
}

// Measurable once the after-window has fully passed — i.e. its last day is
// behind us, so every day in it has been ingested.
//
// ── THE INVARIANT (deliberate, not coincidental) ────────────────────────────
// `windowDays` here is RULE_THRESHOLDS.COOLDOWN_DAYS — the SAME key the
// cooldown uses (rules.ts). That is not two policies sharing a duration by
// luck; it is ONE policy: the engine may not act again on a class until it
// can tell whether the last action worked. So:
//
//     a recommendation becomes measurable at exactly the moment
//     the engine may act on its class again.
//
// Two separate keys would allow an incoherent config (measure at 7, cool down
// at 3 → re-recommend against an outcome that's still provisional) that
// nothing would flag. If asymmetric windows are ever genuinely needed, adding
// a second key is a lookup change — callers already resolve through
// resolveThresholds. Pinned by a test in outcomes.test.ts so a future split
// breaks a build rather than drifting silently. See docs/RULES.md.
export function isDueForMeasurement(executedAt: Date, windowDays: number, now: Date): boolean {
  const { after } = measurementWindows(executedAt, windowDays);
  return now.toISOString().slice(0, 10) > after.end;
}

// ── Features ────────────────────────────────────────────────────────────────
// Built from the AIC-75 feature layer so both sides of the comparison use
// IDENTICAL definitions — the stated reason the feature layer had to land
// before this ticket.
export function outcomeFeatures(totals: PeriodAgg, daily: DailyPoint[]): OutcomeFeatures {
  return {
    spendAgorot: totals.spendAgorot,
    leads: totals.leads,
    cplAgorot: campaignCpl(totals.spendAgorot, totals.leads),
    daysActive: daysActive(daily),
  };
}

// Signed percentage movement, or null when there's no baseline to compare
// against (before = 0). Mirrors readout.ts's deltaPct contract exactly —
// a null is an honest "no comparison", never a fake +100%.
function pct(before: number, after: number): number | null {
  if (before === 0) return null;
  return Math.round(((after - before) / before) * 100);
}

export function outcomeDelta(before: OutcomeFeatures, after: OutcomeFeatures): OutcomeDelta {
  return {
    cplPct: before.cplAgorot === null || after.cplAgorot === null ? null : pct(before.cplAgorot, after.cplAgorot),
    leadsPct: pct(before.leads, after.leads),
    spendPct: pct(before.spendAgorot, after.spendAgorot),
  };
}

// ── Verdict ─────────────────────────────────────────────────────────────────
export interface ConfoundDetail {
  otherActions?: Array<{ actionType: string; occurredAt: string; humanInvolved: boolean }>;
  zeroSpendDays?: string[];
}

export function hasConfound(c: ConfoundDetail | null | undefined): boolean {
  if (!c) return false;
  return (c.otherActions?.length ?? 0) > 0 || (c.zeroSpendDays?.length ?? 0) > 0;
}

// `replace_creative` executes with result:'success' but makes NO Meta write —
// it raises an ops item for a human (safe-executor.ts). There is no event to
// measure from: the human may act tomorrow, next week, or never, so scoring a
// fixed window after *filing a ticket* would credit the engine for an action
// that may not exist. Recorded as not_measurable rather than skipped, so the
// ops aggregate shows the type honestly instead of omitting it.
//
// TEMPORARY — a property of that rule's current implementation, not of
// creative replacement. When AIC-63/AIC-79 give replacement a real tracked
// execution with a real timestamp, revisit this.
export function isMeasurableType(type: RecommendationType): boolean {
  return type !== "replace_creative" && type !== "no_action";
}

export function classifyOutcome(input: {
  type: RecommendationType;
  before: OutcomeFeatures;
  after: OutcomeFeatures;
  delta: OutcomeDelta;
  confound?: ConfoundDetail | null;
  thresholds?: RuleThresholds;
}): OutcomeVerdict {
  const t = input.thresholds ?? RULE_THRESHOLDS;

  // 1. Nothing was changed on Meta at all.
  if (!isMeasurableType(input.type)) return "not_measurable";

  // 2. Couldn't compute a comparison. Terminal, never retried: the window is
  //    fixed and has already passed, so waiting adds nothing to it.
  const comparable =
    input.before.cplAgorot !== null &&
    input.after.cplAgorot !== null &&
    input.after.daysActive >= t.MIN_DAYS_DATA;
  if (!comparable) return "insufficient_data";

  // 3. Could compute, but can't attribute. Checked AFTER the data gate: if
  //    there wasn't enough data to judge, that's the more basic fact.
  if (hasConfound(input.confound)) return "confounded";

  // 4. Bucket the movement. The band is BUDGET_CPL_RISE_PCT — the engine's
  //    OWN existing bar for "CPL moved enough to act on" — reused rather than
  //    a second materiality number invented against zero real outcomes.
  //    Inherited, not derived: PROVISIONAL, and the first real outcomes this
  //    ticket produces are exactly what should recalibrate it (including
  //    whether the improve/degrade bars should be asymmetric — a worsening
  //    may deserve attention sooner than a gain deserves celebration, since
  //    the downside is a customer's money). See docs/features/outcome-measurement.md.
  //
  //    Whatever the bucket, `delta` is stored raw alongside it — the bucket is
  //    a VIEW, the delta is the DATA. A real −11% stays visible as
  //    "neutral (−11%)", and re-bucketing later is a recomputation, not a
  //    re-collection.
  const cplPct = input.delta.cplPct;
  if (cplPct === null) return "insufficient_data";
  const bandPct = t.BUDGET_CPL_RISE_PCT * 100;
  if (cplPct <= -bandPct) return "improved"; // CPL DOWN is better
  if (cplPct >= bandPct) return "degraded";
  return "neutral";
}
