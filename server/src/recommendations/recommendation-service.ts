import type { RecommendationState } from "@aic/shared";
import type { RecommendationRecord, RecommendationDraft } from "./types.js";
import type { RecommendationStore } from "./recommendation-store.js";
import { assertTransition, IllegalTransitionError } from "./state-machine.js";

export class StaleRecommendationError extends Error {
  constructor(public readonly id: string) {
    super(`recommendation ${id} changed state concurrently`);
    this.name = "StaleRecommendationError";
  }
}

// Coordinates recommendation lifecycle transitions. Every mutation goes through
// the state machine (illegal transitions throw before any write) and the store's
// optimistic guard (a concurrent change throws rather than clobbering).
export class RecommendationService {
  constructor(
    private readonly store: RecommendationStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  propose(draft: RecommendationDraft, expiresAt: Date | null = null): Promise<RecommendationRecord> {
    return this.store.create(draft, expiresAt);
  }

  private async transition(
    id: string,
    to: RecommendationState,
    patch: Parameters<RecommendationStore["setState"]>[3] = {},
  ): Promise<RecommendationRecord> {
    const current = await this.store.getById(id);
    if (!current) throw new Error(`recommendation ${id} not found`);
    assertTransition(current.state, to); // throws IllegalTransitionError
    const updated = await this.store.setState(id, current.state, to, patch);
    if (!updated) throw new StaleRecommendationError(id); // guard lost a race
    return updated;
  }

  approve(id: string, approvedBy: string): Promise<RecommendationRecord> {
    return this.transition(id, "approved", { approvedBy, approvedAt: this.now() });
  }

  dismiss(id: string): Promise<RecommendationRecord> {
    return this.transition(id, "dismissed");
  }

  expire(id: string): Promise<RecommendationRecord> {
    return this.transition(id, "expired");
  }

  beginExecution(id: string): Promise<RecommendationRecord> {
    return this.transition(id, "executing");
  }

  // Finish execution and record the real change in action_history. `result`
  // decides executed vs failed; both are logged (PRD §23 audit fields).
  async completeExecution(
    id: string,
    args: {
      result: "success" | "failed";
      what: string;
      why: string;
      previousState: Record<string, unknown>;
      newState: Record<string, unknown>;
      approvedBy: string | null;
      humanInvolved: boolean;
    },
  ): Promise<RecommendationRecord> {
    const to: RecommendationState = args.result === "success" ? "executed" : "failed";
    const rec = await this.transition(id, to, { executedAt: this.now() });
    await this.store.writeActionHistory({
      campaignId: rec.campaignId,
      recommendationId: rec.id,
      what: args.what,
      actionType: rec.type,
      targetMetaId: rec.targetMetaId,
      previousState: args.previousState,
      newState: args.newState,
      why: args.why,
      approvedBy: args.approvedBy,
      humanInvolved: args.humanInvolved,
      result: args.result,
    });
    return rec;
  }
}

export { IllegalTransitionError };
