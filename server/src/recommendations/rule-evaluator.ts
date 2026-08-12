import type { InsightsPeriod } from "../meta/types.js";
import type { SnapshotStore } from "../meta/snapshot-store.js";
import type { RecommendationStore } from "./recommendation-store.js";
import type { RecommendationRecord, RecommendationDraft } from "./types.js";
import { evaluateCampaign, type CampaignEvidence } from "./rules.js";

export interface EvaluableCampaign {
  id: string;
  currentBudgetAgorot: number;
}

// Assemble the evidence a campaign's rules need, from the snapshot store.
// deliveryDays is a v1 approximation (the current window length when there's
// spend) — a true learning-phase-exit signal from Meta is a later refinement.
export async function buildCampaignEvidence(
  store: SnapshotStore,
  campaign: EvaluableCampaign,
  current: InsightsPeriod,
  previous: InsightsPeriod,
  // Ad sets to drop from the evidence entirely (AIC-39): an errored/not-delivering
  // audience is never a "weak" one to pause — it's an error to fix. Its creatives
  // are dropped too, so the creative rule doesn't judge a stalled ad set either.
  excludeAdSetIds?: Set<string>,
  // Human audience labels (AIC-37), adSetId → label, so an acting audience draft
  // carries a real label ("18–35") instead of the raw Meta id.
  adSetLabels?: Map<string, string>,
  // Ad sets running Meta's Dynamic/Advantage+ creative (AIC-36) — passed through
  // untouched to the rules; pause_weak_creative skips these, the audience rule
  // (which reads ev.adsets, not ev.creatives) is unaffected.
  flexibleCreativeAdSetIds?: Set<string>,
  // The subset of excludeAdSetIds that's a REAL delivery problem (AIC-39), as
  // opposed to a deleted/archived/never-published ad set (AIC-65) — narrower
  // than excludeAdSetIds on purpose, so AIC-64's classifyNoAction never calls
  // a dead-object exclusion "delivery_blocked". Defaults to excludeAdSetIds
  // itself when omitted, preserving pre-AIC-65 callers' behavior.
  deliveryProblemAdSetIds?: Set<string>,
): Promise<CampaignEvidence> {
  const [curTotals, prevTotals, curCreatives, prevCreatives, curAdsets] = await Promise.all([
    store.campaignTotals(campaign.id, current.start, current.end),
    store.campaignTotals(campaign.id, previous.start, previous.end),
    store.creativeStats(campaign.id, current.start, current.end),
    store.creativeStats(campaign.id, previous.start, previous.end),
    store.adsetStats(campaign.id, current.start, current.end),
  ]);
  const excluded = excludeAdSetIds ?? new Set<string>();
  const keepCreative = (c: { adSetId?: string | null }) => !c.adSetId || !excluded.has(c.adSetId);
  const days = periodDays(current);
  return {
    campaignId: campaign.id,
    current: { ...curTotals, days },
    previous: { ...prevTotals, days: periodDays(previous) },
    creatives: curCreatives.filter(keepCreative),
    creativesPrevious: prevCreatives.filter(keepCreative),
    adsets: curAdsets
      .filter((a) => !excluded.has(a.adSetId))
      .map((a) => ({ ...a, label: adSetLabels?.get(a.adSetId) })),
    flexibleCreativeAdSetIds,
    currentBudgetAgorot: campaign.currentBudgetAgorot,
    deliveryDays: curTotals.spendAgorot > 0 ? days : 0,
    deliveryProblemAdSetIds: (() => {
      const d = deliveryProblemAdSetIds ?? excluded;
      return d.size > 0 ? [...d] : undefined;
    })(),
  };
}

function periodDays(p: InsightsPeriod): number {
  const day = 24 * 60 * 60 * 1000;
  return Math.round((Date.parse(p.end) - Date.parse(p.start)) / day) + 1;
}

// True when an equivalent proposed recommendation already exists (same type +
// target) — so a repeated tick doesn't pile up duplicates.
function isDuplicate(existing: RecommendationRecord[], draft: RecommendationDraft): boolean {
  return existing.some((r) => r.type === draft.type && r.targetMetaId === draft.targetMetaId);
}

export interface EvaluationResult {
  draft: RecommendationDraft;
  created: boolean; // false = no_action, or a duplicate already proposed
  recordId?: string;
}

// Evaluate one campaign and persist the result. no_action drafts are returned
// but not stored as rows; acting drafts are stored once (deduped against existing
// proposed recs for the same type+target).
export async function evaluateAndPersist(deps: {
  snapshotStore: SnapshotStore;
  recommendationStore: RecommendationStore;
  campaign: EvaluableCampaign;
  current: InsightsPeriod;
  previous: InsightsPeriod;
  expiresAt?: Date | null;
}): Promise<EvaluationResult> {
  const { snapshotStore, recommendationStore, campaign, current, previous } = deps;
  const evidence = await buildCampaignEvidence(snapshotStore, campaign, current, previous);
  const draft = evaluateCampaign(evidence);

  if (draft.type === "no_action") {
    return { draft, created: false };
  }

  const existing = await recommendationStore.listProposed(campaign.id);
  if (isDuplicate(existing, draft)) {
    return { draft, created: false };
  }

  const rec = await recommendationStore.create(draft, deps.expiresAt ?? null);
  return { draft, created: true, recordId: rec.id };
}
