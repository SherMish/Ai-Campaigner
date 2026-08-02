import { describe, it, expect } from "vitest";
import { InMemoryRecommendationStore } from "./recommendation-store.js";
import {
  RecommendationService,
  StaleRecommendationError,
} from "./recommendation-service.js";
import { IllegalTransitionError } from "./state-machine.js";
import type { RecommendationDraft } from "./types.js";

const FIXED = new Date("2026-08-03T00:00:00Z");

function draft(over: Partial<RecommendationDraft> = {}): RecommendationDraft {
  return {
    campaignId: "camp-1",
    type: "increase_budget",
    targetMetaId: "meta_camp_1",
    evidence: { cplAgorot: 3600 },
    currentBudgetAgorot: 7000,
    proposedBudgetAgorot: 8000,
    maxSpendImpactAgorot: 1000,
    rationale: "CPL below target, delivery healthy",
    ...over,
  };
}

function svc() {
  const store = new InMemoryRecommendationStore();
  return { store, service: new RecommendationService(store, () => FIXED) };
}

describe("RecommendationService lifecycle", () => {
  it("proposes then approves, stamping approver + time", async () => {
    const { service } = svc();
    const rec = await service.propose(draft());
    expect(rec.state).toBe("proposed");
    const approved = await service.approve(rec.id, "cust-1");
    expect(approved.state).toBe("approved");
    expect(approved.approvedBy).toBe("cust-1");
    expect(approved.approvedAt).toEqual(FIXED);
  });

  it("runs a full execution and logs it to action_history", async () => {
    const { store, service } = svc();
    const rec = await service.propose(draft({ type: "pause_creative", targetMetaId: "ad_3" }));
    await service.approve(rec.id, "cust-1");
    await service.beginExecution(rec.id);
    const done = await service.completeExecution(rec.id, {
      result: "success",
      what: "paused ad_3",
      why: "spent ₪180 for 1 lead",
      previousState: { status: "active" },
      newState: { status: "paused" },
      approvedBy: "cust-1",
      humanInvolved: false,
    });
    expect(done.state).toBe("executed");
    expect(store.actionHistory).toHaveLength(1);
    expect(store.actionHistory[0]).toMatchObject({
      actionType: "pause_creative",
      targetMetaId: "ad_3",
      result: "success",
      approvedBy: "cust-1",
    });
  });

  it("records no_action + dismissed as first-class, un-actionable states", async () => {
    const { service } = svc();
    const noAction = await service.propose(draft({ type: "no_action", targetMetaId: null }));
    await service.dismiss(noAction.id);
    // dismissed is terminal — approving it must be rejected.
    await expect(service.approve(noAction.id, "cust-1")).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
  });

  it("cannot approve an expired recommendation", async () => {
    const { service } = svc();
    const rec = await service.propose(draft());
    await service.expire(rec.id);
    await expect(service.approve(rec.id, "cust-1")).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
  });

  it("cannot execute a recommendation that was never approved", async () => {
    const { service } = svc();
    const rec = await service.propose(draft());
    await expect(service.beginExecution(rec.id)).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
  });

  it("throws StaleRecommendationError when the optimistic guard loses a race", async () => {
    const { store, service } = svc();
    const rec = await service.propose(draft());
    // Simulate the race: our read still sees 'proposed' (legal to approve), but
    // the guarded write fails because the row moved underneath us.
    store.setState = async () => null;
    await expect(service.approve(rec.id, "cust-1")).rejects.toBeInstanceOf(
      StaleRecommendationError,
    );
  });
});
