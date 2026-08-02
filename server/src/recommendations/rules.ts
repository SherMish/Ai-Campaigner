import type { RecommendationDraft } from "./types.js";

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
} as const;

export interface CreativeStat {
  metaObjectId: string;
  creativeName: string | null;
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
  currentBudgetAgorot: number; // daily budget
  deliveryDays: number;
}

// Internal reason codes carried on a no_action draft. The customer-facing Hebrew
// is rendered by the explainer (AIC-10) from these codes.
export type NoActionReason = "insufficient_evidence" | "stable";

function noAction(campaignId: string, reason: NoActionReason, rationale: string): RecommendationDraft {
  return {
    campaignId,
    type: "no_action",
    targetMetaId: null,
    evidence: { reason },
    currentBudgetAgorot: null,
    proposedBudgetAgorot: null,
    maxSpendImpactAgorot: null,
    rationale,
  };
}

// Global gate shared by every acting rule. Below it, nothing fires.
function hasMinimumEvidence(ev: CampaignEvidence): boolean {
  const t = RULE_THRESHOLDS;
  return (
    ev.current.days >= t.MIN_DAYS_DATA &&
    ev.deliveryDays >= t.MIN_DELIVERY_DAYS &&
    ev.current.leads >= t.MIN_CAMPAIGN_LEADS
  );
}

// ── Rules (each returns a draft or null) ──────────────────────────────────────

// Pause a creative that spent meaningfully more than peers for far fewer leads.
function pauseWeakCreative(ev: CampaignEvidence): RecommendationDraft | null {
  const t = RULE_THRESHOLDS;
  const withData = ev.creatives.filter((c) => c.spendAgorot >= t.MIN_CREATIVE_SPEND_AGOROT);
  if (withData.length < t.PAUSE_MIN_PEERS) return null;

  const performers = ev.creatives.filter((c) => c.leads > 0 && c.cplAgorot !== null);
  if (performers.length === 0) return null;
  const bestPeerCpl = Math.min(...performers.map((c) => c.cplAgorot as number));

  // Weakest = highest CPL (nulls = spent-with-no-leads treated as worst).
  const weak = withData
    .filter((c) => c.cplAgorot === null || (c.cplAgorot as number) >= bestPeerCpl * t.PAUSE_WEAK_CPL_MULTIPLIER)
    // must not itself be the best performer
    .filter((c) => c.cplAgorot === null || (c.cplAgorot as number) > bestPeerCpl)
    .sort((a, b) => (b.cplAgorot ?? Infinity) - (a.cplAgorot ?? Infinity))[0];
  if (!weak) return null;

  return {
    campaignId: ev.campaignId,
    type: "pause_creative",
    targetMetaId: weak.metaObjectId,
    evidence: {
      creativeName: weak.creativeName,
      spendAgorot: weak.spendAgorot,
      leads: weak.leads,
      cplAgorot: weak.cplAgorot,
      bestPeerCplAgorot: bestPeerCpl,
    },
    currentBudgetAgorot: null,
    proposedBudgetAgorot: null,
    maxSpendImpactAgorot: 0, // pausing only reduces spend
    rationale: `creative ${weak.metaObjectId} spent ${weak.spendAgorot} for ${weak.leads} lead(s); best peer CPL ${bestPeerCpl}`,
  };
}

// Replace a creative whose own performance has decayed vs its previous window.
function replaceCreative(ev: CampaignEvidence): RecommendationDraft | null {
  const t = RULE_THRESHOLDS;
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
function decreaseBudget(ev: CampaignEvidence): RecommendationDraft | null {
  const t = RULE_THRESHOLDS;
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
function increaseBudget(ev: CampaignEvidence): RecommendationDraft | null {
  const t = RULE_THRESHOLDS;
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

// Priority order: targeted creative fixes before blunt budget moves; scaling last.
const RULES: Array<(ev: CampaignEvidence) => RecommendationDraft | null> = [
  pauseWeakCreative,
  replaceCreative,
  decreaseBudget,
  increaseBudget,
];

// Evaluate one campaign → exactly one draft. Below the evidence gate, or when no
// rule fires, returns a no_action draft with an internal reason code.
export function evaluateCampaign(ev: CampaignEvidence): RecommendationDraft {
  if (!hasMinimumEvidence(ev)) {
    return noAction(ev.campaignId, "insufficient_evidence", "below minimum-evidence gate");
  }
  for (const rule of RULES) {
    const draft = rule(ev);
    if (draft) return draft;
  }
  return noAction(ev.campaignId, "stable", "stable; no change warranted");
}

export const __rulesForTest = {
  pauseWeakCreative,
  replaceCreative,
  decreaseBudget,
  increaseBudget,
  hasMinimumEvidence,
};
