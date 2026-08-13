// The feature layer (AIC-75): raw snapshot data in, named windowed metrics
// out. Rules consume ONLY features from here — never inline math — so a
// number the rules reason over is defined exactly once, tested independently
// of rule logic, and reusable by outcome measurement (AIC-76) and the
// dashboard without three drifting copies of the same arithmetic.
//
// Design rules (see docs/FEATURES.md for the full contract):
//   - Deterministic only. No LLM anywhere in this layer.
//   - Every feature that summarizes a window carries that window explicitly
//     in its own name or an explicit `window` field — a number without its
//     window is a lie (the AIC-55 lesson).
//   - Null-honest: CPL with zero leads is null, never 0 or ∞. "No data" and
//     "zero" must stay distinguishable everywhere.
//   - Pure functions only — no DB/Meta/store access. Callers (rule-evaluator.ts,
//     generation.ts) own fetching; this module only computes.
import { computeCpl } from "../meta/insights.js";
import { deltaPct } from "../services/readout.js";
import type { DailyPoint } from "../meta/snapshot-store.js";
import type { CreativeStat, AdsetStat } from "./rules.js";

// ── CPL, named by window ────────────────────────────────────────────────────
// Thin wrappers over computeCpl (meta/insights.ts) — reused, not reimplemented
// — that exist so a feature's NAME states its window instead of leaving the
// caller to remember which spend/leads pair it passed in.
export function campaignCpl(spendAgorot: number, leads: number): number | null {
  return computeCpl(spendAgorot, leads);
}
export const adCpl = campaignCpl; // same math; named separately per the ticket's starting set

// ── Spend-without-lead ──────────────────────────────────────────────────────
// Gives a name to what was previously an unnamed `cplAgorot === null`
// conjunction inlined twice in rules.ts (creative + audience rules). An
// object "spent without a lead" once it cleared a minimum-spend bar with
// zero leads to show for it — below that bar there isn't enough spend to
// judge, so it's neither "converting" nor "spending without a lead", just
// too new to know.
export function spendWithoutLead(
  spendAgorot: number,
  leads: number,
  minSpendAgorot: number,
): boolean {
  return spendAgorot >= minSpendAgorot && leads === 0;
}

// ── Share of campaign spend ──────────────────────────────────────────────────
// Null when the campaign spent nothing — "no share of nothing" is not 0%,
// it's undefined, the same null-honesty rule CPL follows.
export function shareOfCampaignSpend(
  objectSpendAgorot: number,
  campaignSpendAgorot: number,
): number | null {
  if (campaignSpendAgorot <= 0) return null;
  return objectSpendAgorot / campaignSpendAgorot;
}

// ── Days active / delivery days — the two v1 approximations this ticket fixes ──
// Previously: `days` was WINDOW LENGTH (always 7 for the rolling window,
// rule-evaluator.ts's old `periodDays`), so MIN_DAYS_DATA could never fail a
// brand-new campaign with one day of spend. `deliveryDays` was a binary
// 7-or-0 (any spend at all ⇒ "delivered all 7 days"). Both are now real
// counts over the disjoint per-day series (SnapshotStore.dailySeries, which
// reads insight_snapshot_daily — migration 030).
export function daysActive(daily: DailyPoint[]): number {
  return daily.filter((d) => d.spendAgorot > 0 || d.leads > 0).length;
}
export function deliveryDaysActive(daily: DailyPoint[]): number {
  return daily.filter((d) => d.spendAgorot > 0).length;
}

// ── Peer / sibling comparison ────────────────────────────────────────────────
// One parameterized function replacing the two independently-inlined
// duplicates in rules.ts (rules.ts:181-183 creative, :243-248 audience). The
// two call sites differ in exactly one way — the creative rule's baseline is
// NOT spend-gated, the audience rule's IS — and that's a DOCUMENTED, real
// asymmetry (pinned by "an under-spend {creative,ad set} CAN/CANNOT set the
// peer baseline" in rules.test.ts), not an oversight this refactor should
// silently unify. `spendGateAgorot` makes the choice explicit at the call
// site instead of leaving it implicit in which copy of the logic you're
// reading.
export interface PeerLike {
  spendAgorot: number;
  leads: number;
  cplAgorot: number | null;
}
export function bestPeerCpl(items: PeerLike[], spendGateAgorot: number | null): number | null {
  const pool = spendGateAgorot === null ? items : items.filter((i) => i.spendAgorot >= spendGateAgorot);
  const performers = pool.filter((i) => i.leads > 0 && i.cplAgorot !== null);
  if (performers.length === 0) return null;
  return Math.min(...performers.map((i) => i.cplAgorot as number));
}

// ── Ad-set grouping ──────────────────────────────────────────────────────────
// Named version of rules.ts:218-225's inline Map-build. Preserves insertion
// order exactly (creatives arrive spend-desc from the store in production —
// see "ad-set group order = ev.creatives array order" in rules.test.ts) since
// that order is load-bearing for which group the pause rule examines first.
export function groupCreativesByAdSet(
  creatives: CreativeStat[],
  flexibleAdSetIds: Set<string> = new Set(),
): Map<string, CreativeStat[]> {
  const byAdSet = new Map<string, CreativeStat[]>();
  for (const c of creatives) {
    const key = c.adSetId ?? "__none__";
    if (flexibleAdSetIds.has(key)) continue;
    const group = byAdSet.get(key);
    if (group) group.push(c);
    else byAdSet.set(key, [c]);
  }
  return byAdSet;
}

// ── Period-over-period ───────────────────────────────────────────────────────
// Re-exported so a future evidence field or AIC-76 outcome comparison has one
// correct definition to call, rather than reinventing the division. NOT wired
// into rules.ts's gates (decreaseBudget/increaseBudget/replaceCreative still
// compare cur/prev directly, unrounded) — deltaPct ROUNDS to a whole percent
// for display, and rounding a number a hard threshold gate compares against
// is a real way to flip a borderline case; a display-only reuse doesn't carry
// that risk, an in-gate one would.
export { deltaPct as periodOverPeriodDeltaPct };

// ── Lead quality rate (AIC-67) ───────────────────────────────────────────────
// Pure: takes the watermark counts (services/lead-quality-review.ts already
// owns fetching them), returns a rate. Null-honest — 0 reviewed leads is "no
// signal yet", not a 0% relevance rate. NOT wired into a rule's evidence yet
// (no current rule reasons over lead quality — confirmed against rules.ts);
// exists so AIC-76's outcome measurement and a future rule have one correct
// definition to call rather than reinventing the division.
export function leadQualityRate(reviewedLeads: number, relevantLeads: number): number | null {
  if (reviewedLeads <= 0) return null;
  return relevantLeads / reviewedLeads;
}
