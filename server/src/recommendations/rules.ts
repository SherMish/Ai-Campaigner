import type { RecommendationDraft } from "./types.js";
import type { RecommendationType } from "@aic/shared";
import { bestPeerCpl, groupCreativesByAdSet, spendWithoutLead, shareOfCampaignSpend } from "./features.js";

// ── Minimum-evidence gates ("doing nothing is valid") ─────────────────────────
// The gates matter more than the rules. A rule that fires on one lead of data is
// worse than no product — it erodes the trust the ₪299/mo proposition depends on.
// All thresholds live here and are documented in docs/RULES.md.
export const RULE_THRESHOLDS = {
  MIN_DAYS_DATA: 3, // don't judge anything on < 3 days
  MIN_DELIVERY_DAYS: 3, // give delivery time to leave the learning phase
  MIN_CAMPAIGN_LEADS: 5, // a campaign needs some volume before we act
  MIN_CREATIVE_SPEND_AGOROT: 15000, // ₪150 before judging a single creative
  PAUSE_MIN_PEERS: 2, // need peers to call one creative "weak"
  PAUSE_WEAK_CPL_MULTIPLIER: 2.0, // weak = CPL ≥ 2× the best peer
  BUDGET_CPL_RISE_PCT: 0.25, // CPL up ≥ 25% window-over-window → decrease
  BUDGET_INCREASE_STEP: 0.15, // +15% when scaling
  BUDGET_DECREASE_STEP: 0.2, // −20% when pulling back
  REPLACE_DECAY_MULTIPLIER: 1.5, // creative CPL worsened ≥ 50% vs its own past
  // Audience (ad-set) rule — deliberately STRICTER than the creative gate:
  // pausing a whole audience is a bigger move than pausing one ad.
  AUDIENCE_MIN_SPEND_AGOROT: 30000, // ₪300 per audience before comparing
  AUDIENCE_MIN_LEADS: 5, // the winning audience must have real volume
  AUDIENCE_CPL_MULTIPLIER: 2.0, // worse audience = CPL ≥ 2× the best audience
  // AIC-77b: after an engine-authored action of a class executes, suppress
  // re-proposing that class for this many days — the engine shouldn't
  // recommend against an outcome it hasn't had time to measure yet. 7 =
  // Meta's documented learning-phase length, an external fact, not a
  // preference. A 14th threshold key (not a fixed constant) so it inherits
  // resolveThresholds' per-account override for free, same as every other
  // value here — see docs/RULES.md.
  COOLDOWN_DAYS: 7,
} as const;

// A resolved, mutable-shaped set of thresholds — what every rule function
// actually reads. `RULE_THRESHOLDS` is the global default; `resolveThresholds`
// (AIC-77a, below) produces the per-campaign effective set.
export type RuleThresholds = Record<keyof typeof RULE_THRESHOLDS, number>;

// ── Configurable thresholds (AIC-77a) ──────────────────────────────────────────
// The two minimum-evidence SPEND gates — how much must be spent on one
// object before the engine trusts evidence about it — scale up with a large
// campaign's own daily budget. The flat global default (₪150 / ₪300) was
// calibrated around a small/medium account; a ₪300/day account would clear
// ₪150 of spend on a single creative within hours, judging it on almost no
// signal. `Math.max` with the global default means this is a pure no-op for
// every account whose relative figure doesn't exceed it — today's small
// accounts see byte-identical behaviour. Every other threshold (day counts,
// % moves, multipliers, peer counts) stays flat: scaling a percentage or a
// count by budget doesn't mean anything. See docs/RULES.md.
const BUDGET_RELATIVE_MULTIPLIER = 1.5; // ~1.5 days of the campaign's own budget
const BUDGET_RELATIVE_KEYS = ["MIN_CREATIVE_SPEND_AGOROT", "AUDIENCE_MIN_SPEND_AGOROT"] as const;

// Resolves the EFFECTIVE thresholds for one campaign: an explicit per-account
// override (managed_campaigns.threshold_overrides) always wins outright — an
// operator's explicit decision is never second-guessed by a formula; the two
// budget-relative keys above apply next; everything else is the flat global
// default. `overrides` is trusted to already be validated (customer-admin.ts
// rejects unknown keys / non-finite values at write time) — this function is
// still defensive about it (silently ignores anything malformed) because it
// runs on every generation tick and a bad row must never crash evaluation.
export function resolveThresholds(
  overrides: Partial<RuleThresholds> | null | undefined,
  dailyBudgetAgorot: number,
): RuleThresholds {
  const resolved = { ...RULE_THRESHOLDS } as RuleThresholds;
  for (const key of BUDGET_RELATIVE_KEYS) {
    resolved[key] = Math.max(RULE_THRESHOLDS[key], Math.round(BUDGET_RELATIVE_MULTIPLIER * dailyBudgetAgorot));
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (key in RULE_THRESHOLDS && typeof value === "number" && Number.isFinite(value)) {
        (resolved as Record<string, number>)[key] = value;
      }
    }
  }
  return resolved;
}

export interface CreativeStat {
  metaObjectId: string;
  adSetId?: string | null; // the parent ad set — compare creatives within it
  creativeName: string | null;
  spendAgorot: number;
  leads: number;
  cplAgorot: number | null;
  deliveryStatus: string;
}

// Ad-set (audience) aggregate for the audience rule.
export interface AdsetStat {
  adSetId: string;
  label?: string; // human audience label (AIC-37); falls back to adSetId if absent
  spendAgorot: number;
  leads: number;
  cplAgorot: number | null;
  deliveryStatus: string;
}

export interface WindowAgg {
  spendAgorot: number;
  leads: number;
  cplAgorot: number | null;
  days: number;
}

export interface CampaignEvidence {
  campaignId: string;
  current: WindowAgg;
  previous: WindowAgg;
  creatives: CreativeStat[]; // current window
  creativesPrevious?: CreativeStat[]; // previous window (decay detection)
  adsets?: AdsetStat[]; // current-window per-audience (AIC-36)
  // Ad sets running Meta's Dynamic/Advantage+ creative (AIC-36): Meta doesn't
  // expose reliable per-asset CPL for these, so pause_weak_creative must never
  // compare "peers" inside one — the audience rule is unaffected (the ad-set-
  // level CPL these ad sets report is still real, only the per-creative
  // breakdown within them isn't).
  flexibleCreativeAdSetIds?: Set<string>;
  currentBudgetAgorot: number; // daily budget
  deliveryDays: number;
  // Ad sets AIC-39 excluded from this evidence because they aren't delivering
  // (buildCampaignEvidence's excludeAdSetIds, threaded through) — carried here
  // so a resulting no_action can honestly say WHY evidence is thin, instead of
  // looking identical to "just needs more time" (AIC-64).
  deliveryProblemAdSetIds?: string[];
  // AIC-88: the campaign's declared lead definition doesn't match what Meta is
  // configured to optimize for, so `leads` (and therefore CPL, and therefore
  // every comparative judgement) is structurally wrong — not merely thin.
  // Every rule here reasons over leads or CPL, so NOTHING may fire while this
  // is true; acting on it would be acting on a number we know is a lie.
  trackingBroken?: boolean;
}

// ── Comparability (AIC-85/86) ──────────────────────────────────────────────
// "Comparable" is relative to campaign spend, not raw presence — a dormant
// object (technically nonzero spend, but Meta isn't really delivering to it)
// must not silently count toward "we have 2 to compare". Reused by BOTH the
// no_action reason classifier below and the add_creatives_for_comparison rule
// (rules.ts's RULES array) — one definition, so they can't drift apart.
//
// Two independent questions, deliberately not conflated into one number:
//   - comparable (this)  = is Meta actually delivering to this object at all?
//     Relative (share of campaign spend), because a fixed shekel floor breaks
//     across account sizes — ₪20/week is dormant in a ₪210/week campaign,
//     but half the campaign's real delivery in a ₪50/week one.
//   - withEvidence (below) = has this SPECIFIC object individually cleared
//     the existing absolute MIN_CREATIVE_SPEND_AGOROT/AUDIENCE_MIN_SPEND_AGOROT
//     gate? Two real, comparable objects can both still be too thin to judge.
//
// DORMANT_SHARE_THRESHOLD is a chosen, scale-free number — provisional,
// same treatment as BUDGET_CPL_RISE_PCT (docs/RULES.md): recalibrate once
// AIC-76 has produced real outcomes to look at, not before.
const DORMANT_SHARE_THRESHOLD = 0.1; // < 10% of campaign spend = not really running

export interface ComparabilityCheck {
  comparableCount: number;
  comparableIds: string[];
  dormantIds: string[];
  withEvidenceCount: number;
}

function isDormant(objectSpendAgorot: number, campaignSpendAgorot: number): boolean {
  const share = shareOfCampaignSpend(objectSpendAgorot, campaignSpendAgorot);
  return share === null || share < DORMANT_SHARE_THRESHOLD;
}

export function comparableCreatives(ev: CampaignEvidence, thresholds: RuleThresholds = RULE_THRESHOLDS): ComparabilityCheck {
  const campaignSpend = ev.current.spendAgorot;
  const comparableIds: string[] = [];
  const dormantIds: string[] = [];
  let withEvidenceCount = 0;
  for (const c of ev.creatives) {
    if (isDormant(c.spendAgorot, campaignSpend)) {
      dormantIds.push(c.metaObjectId);
      continue;
    }
    comparableIds.push(c.metaObjectId);
    if (c.spendAgorot >= thresholds.MIN_CREATIVE_SPEND_AGOROT) withEvidenceCount++;
  }
  return { comparableCount: comparableIds.length, comparableIds, dormantIds, withEvidenceCount };
}

export function comparableAdsets(ev: CampaignEvidence, thresholds: RuleThresholds = RULE_THRESHOLDS): ComparabilityCheck {
  const campaignSpend = ev.current.spendAgorot;
  const comparableIds: string[] = [];
  const dormantIds: string[] = [];
  let withEvidenceCount = 0;
  for (const a of ev.adsets ?? []) {
    if (isDormant(a.spendAgorot, campaignSpend)) {
      dormantIds.push(a.adSetId);
      continue;
    }
    comparableIds.push(a.adSetId);
    if (a.spendAgorot >= thresholds.AUDIENCE_MIN_SPEND_AGOROT) withEvidenceCount++;
  }
  return { comparableCount: comparableIds.length, comparableIds, dormantIds, withEvidenceCount };
}

// Internal reason codes carried on a no_action draft (AIC-64). The customer-
// facing Hebrew is rendered from these in web/src/strings.ts (`home.noRec`);
// the ops-console detail is rendered from `detail` in AdminCustomers.tsx.
// `insufficient_evidence` split into three distinguishable reasons: `collecting`
// (just needs more calendar time), `budget_below_threshold` (structurally can't
// ever gather enough evidence at this budget — no amount of time fixes it), and
// `delivery_blocked` (an ad set is excluded, so evidence is artificially thin).
// `cooling_down` (AIC-77b): a rule genuinely WOULD have fired, but its class
// executed recently and is still within COOLDOWN_DAYS — reported ONLY when a
// rule actually would have fired and was suppressed (see evaluateCampaign);
// never a placeholder when nothing was warranted anyway.
export type NoActionReason =
  | "stable"
  | "collecting"
  | "budget_below_threshold"
  | "delivery_blocked"
  | "tracking_broken" // AIC-88 — the lead count itself is wrong; see classifyNoAction
  | "no_comparable_audiences" // AIC-85, replaces single_ad_set — see classifyNoAction
  | "cooling_down"
  | "below_object_evidence_floor" // AIC-85
  | "no_comparable_creatives"; // AIC-85 — see classifyNoAction's comment: rarely
  // actually STORED, since the AIC-86 advisory rule intercepts this exact
  // condition before classifyNoAction is ever reached (see evaluateCampaign).
  // Kept for completeness/defensive correctness, not dead by design.

// ── Cooldown (AIC-77b) ──────────────────────────────────────────────────────
// Which "class" a recommendation type belongs to — cooldown suppresses at
// this granularity (campaign-wide, not per-target): pausing creative A shifts
// spend to its siblings, so judging B on pre-change evidence is stale in a
// new place. `no_action` has no class — it can never itself be suppressed.
export type RuleClass = "creative" | "audience" | "budget";
export function ruleClassOf(type: RecommendationType): RuleClass | null {
  switch (type) {
    case "pause_creative":
    case "replace_creative":
      return "creative";
    case "pause_adset":
      return "audience";
    case "decrease_budget":
    case "increase_budget":
      return "budget";
    default:
      return null;
  }
}

// Which classes are currently cooling down for one campaign: for each class
// with a recent successful engine-authored execution (`lastActionAtByType`,
// one entry per RecommendationType — see services/action-history.ts's
// getLatestEngineActionByType), true iff `now` is still within
// `cooldownDays` of it. Pure — the DB read and the "now" both happen in the
// caller, so this is trivially testable without a clock or a database.
export function resolveCooldownClasses(
  lastActionAtByType: Record<string, Date> | null | undefined,
  cooldownDays: number,
  now: Date,
): Set<RuleClass> {
  const classes = new Set<RuleClass>();
  if (!lastActionAtByType) return classes;
  const cutoffMs = now.getTime() - cooldownDays * 24 * 60 * 60 * 1000;
  for (const [type, at] of Object.entries(lastActionAtByType)) {
    if (at.getTime() < cutoffMs) continue; // outside the window — not cooling
    const cls = ruleClassOf(type as RecommendationType);
    if (cls) classes.add(cls);
  }
  return classes;
}

function cooldownDetail(
  suppressedType: RecommendationType,
  lastActionAtByType: Record<string, Date>,
  thresholds: RuleThresholds,
): Record<string, unknown> {
  const at = lastActionAtByType[suppressedType];
  const resumesAt = at ? new Date(at.getTime() + thresholds.COOLDOWN_DAYS * 24 * 60 * 60 * 1000) : null;
  return {
    suppressedType,
    cooldownDays: thresholds.COOLDOWN_DAYS,
    lastActionAt: at?.toISOString() ?? null,
    resumesAt: resumesAt?.toISOString() ?? null,
  };
}

function noAction(
  campaignId: string,
  reason: NoActionReason,
  rationale: string,
  detail: Record<string, unknown> = {},
): RecommendationDraft {
  return {
    campaignId,
    type: "no_action",
    targetMetaId: null,
    evidence: { reason, detail },
    currentBudgetAgorot: null,
    proposedBudgetAgorot: null,
    maxSpendImpactAgorot: null,
    rationale,
  };
}

// Global gate shared by every acting rule. Below it, nothing fires.
function hasMinimumEvidence(ev: CampaignEvidence, thresholds: RuleThresholds = RULE_THRESHOLDS): boolean {
  const t = thresholds;
  return (
    ev.current.days >= t.MIN_DAYS_DATA &&
    ev.deliveryDays >= t.MIN_DELIVERY_DAYS &&
    ev.current.leads >= t.MIN_CAMPAIGN_LEADS
  );
}

// The smallest agorot spend an acting rule ever judges on (MIN_CREATIVE_SPEND_AGOROT,
// ₪150 — cheaper than the ₪300 audience gate). At 7 days of the campaign's own
// daily budget, if even that can't be reached, no rule can EVER fire — raising
// the budget is the only fix, more calendar time never helps (AIC-64).
function isBudgetBelowThreshold(dailyBudgetAgorot: number, thresholds: RuleThresholds = RULE_THRESHOLDS): boolean {
  return dailyBudgetAgorot * 7 < thresholds.MIN_CREATIVE_SPEND_AGOROT;
}

function evidenceGapDetail(ev: CampaignEvidence, thresholds: RuleThresholds = RULE_THRESHOLDS): Record<string, unknown> {
  const t = thresholds;
  return {
    daysSoFar: ev.current.days,
    daysNeeded: t.MIN_DAYS_DATA,
    deliveryDaysSoFar: ev.deliveryDays,
    deliveryDaysNeeded: t.MIN_DELIVERY_DAYS,
    leadsSoFar: ev.current.leads,
    leadsNeeded: t.MIN_CAMPAIGN_LEADS,
  };
}

function budgetDetail(ev: CampaignEvidence, thresholds: RuleThresholds = RULE_THRESHOLDS): Record<string, unknown> {
  return {
    currentBudgetAgorot: ev.currentBudgetAgorot,
    maxWindowSpendAgorot: ev.currentBudgetAgorot * 7,
    requiredSpendAgorot: thresholds.MIN_CREATIVE_SPEND_AGOROT,
  };
}

function deliveryDetail(ev: CampaignEvidence): Record<string, unknown> {
  return { problemAdSetIds: ev.deliveryProblemAdSetIds ?? [] };
}

function comparabilityDetail(check: ComparabilityCheck): Record<string, unknown> {
  return {
    comparableCount: check.comparableCount,
    comparableIds: check.comparableIds,
    dormantIds: check.dormantIds,
  };
}

function evidenceFloorDetail(kind: "creative" | "audience", check: ComparabilityCheck, requiredAgorot: number): Record<string, unknown> {
  return { kind, comparableCount: check.comparableCount, withEvidenceCount: check.withEvidenceCount, requiredSpendAgorot: requiredAgorot };
}

// Classify WHY there's no recommendation this tick (AIC-64/85) — called both
// when the minimum-evidence gate fails and when the gate passes but no rule
// fires. By the time this runs, the AIC-86 advisory rule has ALREADY had its
// chance (evaluateCampaign calls it first, unconditionally) — so
// `no_comparable_creatives` below is reachable only in the delivery-blocked
// branch's absence AND the advisory rule somehow still not firing; kept for
// completeness, not because it's expected to be common. See docs/RULES.md.
//
// Priority: a delivery problem is usually the root cause of thin evidence
// (and worth surfacing even once evidence is otherwise fine), so it outranks
// everything below; a structurally-too-low budget outranks "just needs more
// time" because more time never fixes it; comparability (can we judge
// ANYTHING at all) outranks the absolute evidence floor (comparable objects
// exist, just still thin) — the more basic fact wins, same ordering
// principle as insufficient_data outranking confounded in AIC-76.
function classifyNoAction(
  ev: CampaignEvidence,
  thresholds: RuleThresholds = RULE_THRESHOLDS,
): { reason: NoActionReason; rationale: string; detail: Record<string, unknown> } {
  if (ev.deliveryProblemAdSetIds?.length) {
    return { reason: "delivery_blocked", rationale: "ad set(s) excluded from evidence — not delivering", detail: deliveryDetail(ev) };
  }
  // AIC-88, second only to delivery: every reason below this line describes
  // how much evidence we have. `tracking_broken` says the evidence is WRONG —
  // the lead count is structurally zero because the declared lead definition
  // doesn't match Meta's config. Reporting "still collecting" there would be
  // a lie that never resolves, however long you wait.
  if (ev.trackingBroken) {
    return {
      reason: "tracking_broken",
      rationale: "declared lead definition doesn't match the ad sets' Meta configuration — leads are not being counted",
      detail: {},
    };
  }
  if (!hasMinimumEvidence(ev, thresholds)) {
    if (isBudgetBelowThreshold(ev.currentBudgetAgorot, thresholds)) {
      return { reason: "budget_below_threshold", rationale: "7-day max spend below the smallest actionable threshold", detail: budgetDetail(ev, thresholds) };
    }
    return { reason: "collecting", rationale: "below minimum-evidence gate", detail: evidenceGapDetail(ev, thresholds) };
  }

  const creatives = comparableCreatives(ev, thresholds);
  if (creatives.comparableCount < 2) {
    return { reason: "no_comparable_creatives", rationale: "fewer than 2 real creatives; can't compare", detail: comparabilityDetail(creatives) };
  }
  const adsets = comparableAdsets(ev, thresholds);
  if (adsets.comparableCount < 2) {
    return { reason: "no_comparable_audiences", rationale: "fewer than 2 real audiences; can't compare", detail: comparabilityDetail(adsets) };
  }

  // Comparable objects exist on both sides, but haven't individually cleared
  // the absolute spend gate the acting rules themselves require
  // (PAUSE_MIN_PEERS / the audience rule's `withData.length < 2` check) —
  // genuinely different from "nothing to compare at all".
  if (creatives.withEvidenceCount < 2) {
    return { reason: "below_object_evidence_floor", rationale: "comparable creatives exist but haven't cleared the spend gate yet", detail: evidenceFloorDetail("creative", creatives, thresholds.MIN_CREATIVE_SPEND_AGOROT) };
  }
  if (adsets.withEvidenceCount < 2) {
    return { reason: "below_object_evidence_floor", rationale: "comparable audiences exist but haven't cleared the spend gate yet", detail: evidenceFloorDetail("audience", adsets, thresholds.AUDIENCE_MIN_SPEND_AGOROT) };
  }

  return { reason: "stable", rationale: "stable; no change warranted", detail: {} };
}

// ── Rules (each returns a draft or null) ──────────────────────────────────────

// AIC-86: advisory, not a Meta write — "add more creatives" so pause_creative/
// replace_creative eventually have something to compare. Deliberately NOT one
// of the RULES tried below `hasMinimumEvidence` (evaluateCampaign calls this
// separately, first): the evidence gates exist for COMPARATIVE claims
// ("creative A underperforms B" needs statistical power) — "there is only one
// creative" is a COUNT, and no amount of additional data makes a count more
// true. Firing from day one is deliberate: this is most valuable BEFORE a
// customer burns weeks of budget on one untested creative, not after. It's
// advisory and dismissible, so the cost of firing early is mild redundancy;
// the cost of waiting for 5 leads is a customer who already did the thing it
// warns against. See docs/RULES.md.
function addCreativesForComparison(
  ev: CampaignEvidence,
  thresholds: RuleThresholds = RULE_THRESHOLDS,
): RecommendationDraft | null {
  const creatives = comparableCreatives(ev, thresholds);
  if (creatives.comparableCount >= 2) return null;

  const adsets = comparableAdsets(ev, thresholds);
  // Names the AIC-36 flexible-ad case explicitly: Meta collapses N assets
  // inside one flexible ad into a single comparable object, so "add creatives"
  // there really means "split the flexible ad", not "there is no ad at all".
  const soleId = creatives.comparableIds[0];
  const soleCreative = soleId ? ev.creatives.find((c) => c.metaObjectId === soleId) : undefined;
  const isFlexibleAd = !!(soleCreative?.adSetId && ev.flexibleCreativeAdSetIds?.has(soleCreative.adSetId));

  return {
    campaignId: ev.campaignId,
    type: "add_creatives_for_comparison",
    targetMetaId: null, // advice about the campaign's structure, not one object
    // Carries BOTH the creative and audience facts, deliberately — the ops
    // console's whole picture of a structurally-un-optimizable account (AIC-85),
    // even though the customer-facing copy only ever mentions creatives.
    evidence: {
      comparableCreativeCount: creatives.comparableCount,
      isFlexibleAd,
      comparableAdsetCount: adsets.comparableCount,
      dormantAdsetIds: adsets.dormantIds,
      currentLeads: ev.current.leads,
      currentCplAgorot: ev.current.cplAgorot,
    },
    currentBudgetAgorot: null,
    proposedBudgetAgorot: null,
    maxSpendImpactAgorot: null, // no spend change
    rationale: `only ${creatives.comparableCount} comparable creative(s) — pause_creative/replace_creative have nothing to judge against`,
  };
}

// Within one ad set, find a creative that spent meaningfully more than its peers
// for far fewer leads. Comparing WITHIN an ad set is the AIC-36 fix — the same
// creative under two audiences must never be pitted against itself.
function weakestInGroup(
  campaignId: string,
  creatives: CreativeStat[],
  thresholds: RuleThresholds = RULE_THRESHOLDS,
): RecommendationDraft | null {
  const t = thresholds;
  const withData = creatives.filter((c) => c.spendAgorot >= t.MIN_CREATIVE_SPEND_AGOROT);
  if (withData.length < t.PAUSE_MIN_PEERS) return null;

  // The creative rule's baseline is NOT spend-gated (unlike the audience rule
  // below) — a cheap-but-real peer can still set the bar. See features.ts.
  const bestCpl = bestPeerCpl(creatives, null);
  if (bestCpl === null) return null;

  // Weakest = highest CPL (spent-without-a-lead treated as worst).
  const weak = withData
    .filter(
      (c) =>
        spendWithoutLead(c.spendAgorot, c.leads, t.MIN_CREATIVE_SPEND_AGOROT) ||
        (c.cplAgorot as number) >= bestCpl * t.PAUSE_WEAK_CPL_MULTIPLIER,
    )
    .filter(
      (c) => spendWithoutLead(c.spendAgorot, c.leads, t.MIN_CREATIVE_SPEND_AGOROT) || (c.cplAgorot as number) > bestCpl,
    )
    .sort((a, b) => (b.cplAgorot ?? Infinity) - (a.cplAgorot ?? Infinity))[0];
  if (!weak) return null;

  return {
    campaignId,
    type: "pause_creative",
    targetMetaId: weak.metaObjectId,
    evidence: {
      creativeName: weak.creativeName,
      adSetId: weak.adSetId ?? null,
      spendAgorot: weak.spendAgorot,
      leads: weak.leads,
      cplAgorot: weak.cplAgorot,
      bestPeerCplAgorot: bestCpl,
    },
    currentBudgetAgorot: null,
    proposedBudgetAgorot: null,
    maxSpendImpactAgorot: 0, // pausing only reduces spend
    rationale: `creative ${weak.metaObjectId} spent ${weak.spendAgorot} for ${weak.leads} lead(s); best peer CPL ${bestCpl}`,
  };
}

// Pause a weak creative — evaluated per ad set so creative quality is never
// conflated with audience. Creatives with no known ad set fall into one group
// (single-ad-set campaigns behave exactly as before). Ad sets running Dynamic/
// Advantage+ creative are skipped entirely (AIC-36) — Meta's per-asset CPL for
// those isn't reliable enough to pit "peers" against each other.
function pauseWeakCreative(ev: CampaignEvidence, thresholds: RuleThresholds = RULE_THRESHOLDS): RecommendationDraft | null {
  const byAdSet = groupCreativesByAdSet(ev.creatives, ev.flexibleCreativeAdSetIds);
  for (const group of byAdSet.values()) {
    const draft = weakestInGroup(ev.campaignId, group, thresholds);
    if (draft) return draft;
  }
  return null;
}

// Pause an underperforming AUDIENCE (ad set): when one audience's cost-per-lead is
// materially worse than the best over enough data, propose pausing it. Under CBO
// the campaign budget then shifts to the winner — a real delivery change, so it's
// approval-gated (AIC-23 → AIC-12). Stricter gate than the creative rule.
function pauseUnderperformingAudience(
  ev: CampaignEvidence,
  thresholds: RuleThresholds = RULE_THRESHOLDS,
): RecommendationDraft | null {
  const t = thresholds;
  const adsets = ev.adsets ?? [];
  const withData = adsets.filter((a) => a.spendAgorot >= t.AUDIENCE_MIN_SPEND_AGOROT);
  if (withData.length < 2) return null; // need ≥ 2 audiences to compare

  // Unlike the creative rule, the audience baseline IS spend-gated — pausing a
  // whole audience is a bigger move (see AUDIENCE_MIN_SPEND_AGOROT above).
  // withData is already gated, so no further gate here (null).
  const performers = withData.filter((a) => a.leads > 0 && a.cplAgorot !== null);
  const bestCpl = bestPeerCpl(withData, null);
  if (bestCpl === null) return null;
  const bestAdset = performers.find((a) => (a.cplAgorot as number) === bestCpl)!;
  // The winner must have real volume, so we're not scaling into a fluke.
  if (bestAdset.leads < t.AUDIENCE_MIN_LEADS) return null;

  const worst = withData
    .filter(
      (a) =>
        spendWithoutLead(a.spendAgorot, a.leads, t.AUDIENCE_MIN_SPEND_AGOROT) ||
        (a.cplAgorot as number) >= bestCpl * t.AUDIENCE_CPL_MULTIPLIER,
    )
    .filter(
      (a) => spendWithoutLead(a.spendAgorot, a.leads, t.AUDIENCE_MIN_SPEND_AGOROT) || (a.cplAgorot as number) > bestCpl,
    )
    .sort((a, b) => (b.cplAgorot ?? Infinity) - (a.cplAgorot ?? Infinity))[0];
  if (!worst) return null;

  return {
    campaignId: ev.campaignId,
    type: "pause_adset",
    targetMetaId: worst.adSetId,
    evidence: {
      adSetId: worst.adSetId,
      audienceLabel: worst.label ?? worst.adSetId,
      adSetCplAgorot: worst.cplAgorot,
      adSetSpendAgorot: worst.spendAgorot,
      adSetLeads: worst.leads,
      bestAdSetId: bestAdset.adSetId,
      bestAudienceLabel: bestAdset.label ?? bestAdset.adSetId,
      bestAdSetCplAgorot: bestCpl,
    },
    currentBudgetAgorot: null,
    proposedBudgetAgorot: null,
    maxSpendImpactAgorot: 0, // CBO shifts budget to the winner; no new spend
    rationale: `ad set ${worst.adSetId} CPL ${worst.cplAgorot ?? "∅"} vs best audience ${bestCpl} (≥${t.AUDIENCE_CPL_MULTIPLIER}×)`,
  };
}

// Replace a creative whose own performance has decayed vs its previous window.
function replaceCreative(ev: CampaignEvidence, thresholds: RuleThresholds = RULE_THRESHOLDS): RecommendationDraft | null {
  const t = thresholds;
  if (!ev.creativesPrevious?.length) return null;
  const prevById = new Map(ev.creativesPrevious.map((c) => [c.metaObjectId, c]));

  for (const cur of ev.creatives) {
    if (cur.spendAgorot < t.MIN_CREATIVE_SPEND_AGOROT || cur.cplAgorot === null) continue;
    const prev = prevById.get(cur.metaObjectId);
    if (!prev || prev.cplAgorot === null) continue;
    if ((cur.cplAgorot as number) >= (prev.cplAgorot as number) * t.REPLACE_DECAY_MULTIPLIER) {
      return {
        campaignId: ev.campaignId,
        type: "replace_creative",
        targetMetaId: cur.metaObjectId,
        evidence: {
          creativeName: cur.creativeName,
          previousCplAgorot: prev.cplAgorot,
          currentCplAgorot: cur.cplAgorot,
        },
        currentBudgetAgorot: null,
        proposedBudgetAgorot: null,
        maxSpendImpactAgorot: 0,
        rationale: `creative ${cur.metaObjectId} CPL decayed ${prev.cplAgorot} → ${cur.cplAgorot}`,
      };
    }
  }
  return null;
}

// Decrease budget when CPL has risen materially window-over-window.
function decreaseBudget(ev: CampaignEvidence, thresholds: RuleThresholds = RULE_THRESHOLDS): RecommendationDraft | null {
  const t = thresholds;
  const cur = ev.current.cplAgorot;
  const prev = ev.previous.cplAgorot;
  if (cur === null || prev === null || prev === 0) return null;
  if (cur < prev * (1 + t.BUDGET_CPL_RISE_PCT)) return null;

  const proposed = Math.round(ev.currentBudgetAgorot * (1 - t.BUDGET_DECREASE_STEP));
  return {
    campaignId: ev.campaignId,
    type: "decrease_budget",
    targetMetaId: null,
    evidence: { currentCplAgorot: cur, previousCplAgorot: prev },
    currentBudgetAgorot: ev.currentBudgetAgorot,
    proposedBudgetAgorot: proposed,
    maxSpendImpactAgorot: proposed - ev.currentBudgetAgorot, // negative (spend down)
    rationale: `CPL rose ${prev} → ${cur} (≥${t.BUDGET_CPL_RISE_PCT * 100}%)`,
  };
}

// Increase budget when CPL is stable-or-improving and volume is healthy/growing.
function increaseBudget(ev: CampaignEvidence, thresholds: RuleThresholds = RULE_THRESHOLDS): RecommendationDraft | null {
  const t = thresholds;
  const cur = ev.current.cplAgorot;
  const prev = ev.previous.cplAgorot;
  if (cur === null || prev === null) return null;
  // Not worse on either axis, AND strictly better on at least one — a flat,
  // stable campaign is no_action, not a manufactured "scale up".
  const notWorse = cur <= prev && ev.current.leads >= ev.previous.leads;
  const strictlyBetter = cur < prev || ev.current.leads > ev.previous.leads;
  if (!notWorse || !strictlyBetter) return null;

  const proposed = Math.round(ev.currentBudgetAgorot * (1 + t.BUDGET_INCREASE_STEP));
  return {
    campaignId: ev.campaignId,
    type: "increase_budget",
    targetMetaId: null,
    evidence: { currentCplAgorot: cur, previousCplAgorot: prev, currentLeads: ev.current.leads },
    currentBudgetAgorot: ev.currentBudgetAgorot,
    proposedBudgetAgorot: proposed,
    maxSpendImpactAgorot: proposed - ev.currentBudgetAgorot, // positive (per day)
    rationale: `CPL ${prev} → ${cur} (stable/improving), leads ${ev.previous.leads} → ${ev.current.leads}`,
  };
}

// Priority order: targeted creative fixes, then the audience (ad-set) fix, then
// blunt budget moves; scaling last.
//
// `pauseUnderperformingAudience` is safe to run live now that AIC-39 excludes
// errored/not-delivering ad sets from the evidence (buildCampaignEvidence's
// excludeAdSetIds) — so the rule only ever compares genuinely-delivering
// audiences and never proposes pausing a broken one.
const RULES: Array<(ev: CampaignEvidence, thresholds: RuleThresholds) => RecommendationDraft | null> = [
  pauseWeakCreative,
  replaceCreative,
  pauseUnderperformingAudience,
  decreaseBudget,
  increaseBudget,
];

// Bundles what evaluateCampaign needs to know about cooldown (AIC-77b): which
// classes are currently cooling down (resolveCooldownClasses, above — already
// resolved by the caller, which has `now` and the DB read), and the raw
// per-type timestamps so a suppressed draft's detail block can say when it
// resumes. Optional — omitting it (every pre-77b test, evaluateCampaign(ev)
// or evaluateCampaign(ev, thresholds)) means cooldown never applies, byte-
// identical to before.
export interface CooldownContext {
  classes: Set<RuleClass>;
  lastActionAtByType: Record<string, Date>;
}

// Evaluate one campaign → exactly one draft. Below the evidence gate, or when no
// rule fires, returns a no_action draft with a structured reason code (AIC-64).
// `thresholds` defaults to the global constant — every existing caller (and all
// tests) that doesn't pass one keeps working unchanged (AIC-77a). Callers that
// resolve per-account thresholds (rule-evaluator.ts, staleness.ts) pass the
// resolved set explicitly via `resolveThresholds`.
//
// Cooldown (AIC-77b) does NOT simply skip a cooling-down rule — it keeps
// trying LOWER-priority rules first (a genuinely different, non-cooling class
// can still fire and take precedence), and only reports `cooling_down` if
// something WOULD have fired and every firing candidate was suppressed. If
// nothing would have fired regardless of cooldown, the reason stays
// stable/collecting — claiming "cooling down" when there was nothing to do
// would be a different dishonesty.
export function evaluateCampaign(
  ev: CampaignEvidence,
  thresholds: RuleThresholds = RULE_THRESHOLDS,
  cooldown?: CooldownContext,
): RecommendationDraft {
  // AIC-88: nothing may fire while the lead count itself is wrong. Placed
  // above even the pre-gate advisory: telling a customer "add more ads" when
  // the real problem is that their conversions aren't being counted at all is
  // confidently wrong advice, and it would bury the actual fix. Fixing the
  // tracking comes first; every judgement below reads leads or CPL.
  if (ev.trackingBroken) {
    const t = classifyNoAction(ev, thresholds);
    return noAction(ev.campaignId, t.reason, t.rationale, t.detail);
  }

  // AIC-86: checked BEFORE the evidence gate, deliberately — see
  // addCreativesForComparison's own comment. Still respects delivery-blocked
  // precedence (AIC-77's "fix the breakage first" — classifyNoAction below
  // checks the same condition first too).
  if (!ev.deliveryProblemAdSetIds?.length) {
    const advisory = addCreativesForComparison(ev, thresholds);
    if (advisory) return advisory;
  }

  if (hasMinimumEvidence(ev, thresholds)) {
    let suppressed: RecommendationDraft | null = null;
    for (const rule of RULES) {
      const draft = rule(ev, thresholds);
      if (!draft) continue;
      const cls = ruleClassOf(draft.type);
      if (cls && cooldown?.classes.has(cls)) {
        if (!suppressed) suppressed = draft; // keep the highest-priority one
        continue;
      }
      return draft;
    }
    if (suppressed) {
      const detail = cooldownDetail(suppressed.type, cooldown!.lastActionAtByType, thresholds);
      return noAction(
        ev.campaignId,
        "cooling_down",
        `${suppressed.type} would fire but its class changed recently — cooling down`,
        detail,
      );
    }
  }
  const { reason, rationale, detail } = classifyNoAction(ev, thresholds);
  return noAction(ev.campaignId, reason, rationale, detail);
}

export const __rulesForTest = {
  pauseWeakCreative,
  replaceCreative,
  pauseUnderperformingAudience,
  decreaseBudget,
  increaseBudget,
  addCreativesForComparison,
  hasMinimumEvidence,
  classifyNoAction,
  isBudgetBelowThreshold,
};
