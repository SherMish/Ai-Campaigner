import type { RecommendationType, RecommendationState } from "@aic/shared";

// A recommendation as stored (mirrors the recommendations table, AIC-4).
export interface RecommendationRecord {
  id: string;
  campaignId: string;
  type: RecommendationType;
  state: RecommendationState;
  targetMetaId: string | null;
  evidence: Record<string, unknown>;
  currentBudgetAgorot: number | null;
  proposedBudgetAgorot: number | null;
  maxSpendImpactAgorot: number | null;
  rationale: string;
  expiresAt: Date | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  executedAt: Date | null;
}

// What a rule emits before it's persisted (no id/state/timestamps yet).
export interface RecommendationDraft {
  campaignId: string;
  type: RecommendationType;
  targetMetaId: string | null;
  evidence: Record<string, unknown>;
  currentBudgetAgorot: number | null;
  proposedBudgetAgorot: number | null;
  maxSpendImpactAgorot: number | null;
  rationale: string;
}
