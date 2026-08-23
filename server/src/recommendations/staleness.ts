import type { InsightsPeriod } from "../meta/types.js";
import type { SnapshotStore } from "../meta/snapshot-store.js";
import type { RecommendationStore } from "./recommendation-store.js";
import type { RecommendationService } from "./recommendation-service.js";
import type { RecommendationRecord, RecommendationDraft } from "./types.js";
import { evaluateCampaign, resolveThresholds, resolveCooldownClasses } from "./rules.js";
import { buildCampaignEvidence, type EvaluableCampaign } from "./rule-evaluator.js";

// A proposed recommendation is still valid iff the same gated rules, run on
// CURRENT evidence, still produce an equivalent recommendation (same type +
// target). This is the "material divergence" test: if the weak creative
// recovered, CPL swung back, or delivery changed such that the rules no longer
// call for this action, the recommendation is stale. Rules are the single source
// of truth for both producing and invalidating a recommendation.
export function stillSupported(
  fresh: RecommendationDraft,
  rec: RecommendationRecord,
): boolean {
  return fresh.type === rec.type && fresh.targetMetaId === rec.targetMetaId;
}

export interface RefreshResult {
  freshDraft: RecommendationDraft;
  expiredIds: string[];
  createdId?: string;
}

// The canonical evaluation tick (AIC-9 + AIC-11): re-derive current evidence,
// expire any proposed rec the rules no longer support, and — if an action is
// still warranted and not already proposed — create the fresh one. An expired
// rec is un-approvable by construction (the AIC-8 state machine).
export async function refreshRecommendations(deps: {
  snapshotStore: SnapshotStore;
  recommendationStore: RecommendationStore;
  recommendationService: RecommendationService;
  campaign: EvaluableCampaign;
  current: InsightsPeriod;
  previous: InsightsPeriod;
  expiresAt?: Date | null;
  excludeAdSetIds?: Set<string>; // errored/not-delivering ad sets (AIC-39) ∪ dead/draft ad sets (AIC-65)
  adSetLabels?: Map<string, string>; // human audience labels (AIC-37)
  flexibleCreativeAdSetIds?: Set<string>; // Dynamic/Advantage+ creative ad sets (AIC-36)
  deliveryProblemAdSetIds?: Set<string>; // the real-delivery-problem subset of excludeAdSetIds (AIC-65)
  trackingBroken?: boolean; // lead definition doesn't match Meta's config (AIC-88)
  liveCreativeCount?: number; // ads actually running now, from delivery-health (AIC-117)
  adStatuses?: Record<string, "active" | "paused">; // live per-ad status (AIC-77b)
  adSetStatuses?: Record<string, "active" | "paused">; // live per-ad-set status (AIC-77b)
  now?: Date; // AIC-77b: what "now" is for cooldown, injectable for tests — defaults to new Date()
}): Promise<RefreshResult> {
  const { snapshotStore, recommendationStore, recommendationService, campaign } = deps;

  const evidence = await buildCampaignEvidence(
    snapshotStore, campaign, deps.current, deps.previous,
    deps.excludeAdSetIds, deps.adSetLabels, deps.flexibleCreativeAdSetIds, deps.deliveryProblemAdSetIds,
    deps.adStatuses, deps.adSetStatuses, deps.trackingBroken, deps.liveCreativeCount,
  );
  const thresholds = resolveThresholds(campaign.thresholdOverrides, campaign.currentBudgetAgorot);
  const cooldownClasses = resolveCooldownClasses(campaign.lastActionAtByType, thresholds.COOLDOWN_DAYS, deps.now ?? new Date());
  const fresh = evaluateCampaign(evidence, thresholds, {
    classes: cooldownClasses,
    lastActionAtByType: campaign.lastActionAtByType ?? {},
  });

  const proposed = await recommendationStore.listProposed(campaign.id);
  const expiredIds: string[] = [];
  for (const rec of proposed) {
    if (!stillSupported(fresh, rec)) {
      await recommendationService.expire(rec.id);
      expiredIds.push(rec.id);
    }
  }

  let createdId: string | undefined;
  if (fresh.type !== "no_action") {
    const stillProposed = proposed.filter((r) => !expiredIds.includes(r.id));
    const already = stillProposed.some(
      (r) => r.type === fresh.type && r.targetMetaId === fresh.targetMetaId,
    );
    if (!already) {
      const rec = await recommendationStore.create(fresh, deps.expiresAt ?? null);
      createdId = rec.id;
    }
  }

  return { freshDraft: fresh, expiredIds, createdId };
}
