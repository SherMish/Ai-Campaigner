import type { RecommendationState } from "@aic/shared";

// The one legal transition set for a recommendation. Modeled explicitly because a
// recommendation moves real ad spend: "approved but stale" and "approved and
// executed" must be distinguishable, and an expired/dismissed rec must be
// un-actionable. Ad-hoc status strings drift; this doesn't.
//
//   proposed → approved | dismissed | expired
//   approved → executing
//   executing → executed | failed
//   (executed, failed, dismissed, expired are terminal)
export const LEGAL_TRANSITIONS: Record<
  RecommendationState,
  readonly RecommendationState[]
> = {
  proposed: ["approved", "dismissed", "expired"],
  approved: ["executing"],
  executing: ["executed", "failed"],
  executed: [],
  failed: [],
  dismissed: [],
  expired: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: RecommendationState,
    public readonly to: RecommendationState,
  ) {
    super(`illegal recommendation transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function canTransition(
  from: RecommendationState,
  to: RecommendationState,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function assertTransition(
  from: RecommendationState,
  to: RecommendationState,
): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}

export function isTerminal(state: RecommendationState): boolean {
  return LEGAL_TRANSITIONS[state].length === 0;
}
