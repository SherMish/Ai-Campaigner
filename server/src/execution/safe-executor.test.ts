import { describe, it, expect } from "vitest";
import { InMemoryRecommendationStore } from "../recommendations/recommendation-store.js";
import { RecommendationService } from "../recommendations/recommendation-service.js";
import type { RecommendationDraft } from "../recommendations/types.js";
import {
  SafeExecutor,
  type LiveCampaignState,
  type ExecCampaign,
  type OpsRaiser,
  type AccessGuard,
} from "./safe-executor.js";

// A fake Meta that is both reader and writer; writes mutate its live state so
// read-back reflects them (unless noApply simulates a lost/ineffective write).
class FakeMeta {
  public noApply = false;
  constructor(public state: LiveCampaignState) {}
  async getCampaignState(): Promise<LiveCampaignState> {
    return { dailyBudgetAgorot: this.state.dailyBudgetAgorot, adStatuses: { ...this.state.adStatuses } };
  }
  async setDailyBudget(_id: string, agorot: number): Promise<void> {
    if (!this.noApply) this.state.dailyBudgetAgorot = agorot;
  }
  async pauseAd(adId: string): Promise<void> {
    if (!this.noApply) this.state.adStatuses[adId] = "paused";
  }
}

class FakeOps implements OpsRaiser {
  public items: Array<{ type: string; detail: string }> = [];
  async raise(item: { type: string; detail: string }): Promise<void> {
    this.items.push({ type: item.type, detail: item.detail });
  }
}

const OK_GUARD: AccessGuard = { assertExecutable: async () => {} };
const BLOCK_GUARD: AccessGuard = { assertExecutable: async () => { throw new Error("blocked"); } };

const CAMPAIGN: ExecCampaign = {
  id: "camp-1", metaCampaignId: "meta_camp_1", connectionId: "conn-1",
  customerId: "cust-1", agreedBudgetAgorot: 10000,
};

function setup(opts: {
  meta: FakeMeta;
  connectionGuard?: AccessGuard;
  controlGate?: AccessGuard;
}) {
  const store = new InMemoryRecommendationStore();
  const service = new RecommendationService(store);
  const ops = new FakeOps();
  const executor = new SafeExecutor({
    store, service,
    campaigns: { load: async () => CAMPAIGN },
    reader: opts.meta, writer: opts.meta,
    connectionGuard: opts.connectionGuard ?? OK_GUARD,
    controlGate: opts.controlGate ?? OK_GUARD,
    ops,
  });
  return { store, service, ops, executor };
}

function draft(over: Partial<RecommendationDraft> = {}): RecommendationDraft {
  return {
    campaignId: "camp-1", type: "increase_budget", targetMetaId: null,
    evidence: {}, currentBudgetAgorot: 7000, proposedBudgetAgorot: 8000,
    maxSpendImpactAgorot: 1000, rationale: "healthy + improving", ...over,
  };
}

async function approvedRec(service: RecommendationService, d: RecommendationDraft) {
  const rec = await service.propose(d);
  await service.approve(rec.id, "cust-1");
  return rec;
}

describe("SafeExecutor — happy paths", () => {
  it("executes a budget increase and verifies the read-back", async () => {
    const meta = new FakeMeta({ dailyBudgetAgorot: 7000, adStatuses: {} });
    const { service, store, executor } = setup({ meta });
    const rec = await approvedRec(service, draft());

    const res = await executor.execute(rec.id);
    expect(res.outcome).toBe("executed");
    expect(meta.state.dailyBudgetAgorot).toBe(8000);
    expect((await store.getById(rec.id))?.state).toBe("executed");
    expect(store.actionHistory.at(-1)).toMatchObject({ result: "success" });
  });

  it("executes a pause and verifies the ad is paused", async () => {
    const meta = new FakeMeta({ dailyBudgetAgorot: 7000, adStatuses: { ad_3: "active" } });
    const { service, executor } = setup({ meta });
    const rec = await approvedRec(service, draft({ type: "pause_creative", targetMetaId: "ad_3", currentBudgetAgorot: null, proposedBudgetAgorot: null, evidence: { spendAgorot: 18000, leads: 1 } }));

    const res = await executor.execute(rec.id);
    expect(res.outcome).toBe("executed");
    expect(meta.state.adStatuses.ad_3).toBe("paused");
  });

  it("escalates replace_creative to ops as a human task (no Meta write)", async () => {
    const meta = new FakeMeta({ dailyBudgetAgorot: 7000, adStatuses: { ad_x: "active" } });
    const { service, store, ops, executor } = setup({ meta });
    const rec = await approvedRec(service, draft({ type: "replace_creative", targetMetaId: "ad_x", currentBudgetAgorot: null, proposedBudgetAgorot: null }));

    const res = await executor.execute(rec.id);
    expect(res.outcome).toBe("executed");
    expect(res.opsRaised).toBe(true);
    expect(ops.items.some((i) => i.type === "missing_creative")).toBe(true);
    expect(store.actionHistory.at(-1)).toMatchObject({ humanInvolved: true, result: "success" });
  });
});

describe("SafeExecutor — aborts and failures (never a silent success)", () => {
  it("aborts a rec that is not approved, changing nothing", async () => {
    const meta = new FakeMeta({ dailyBudgetAgorot: 7000, adStatuses: {} });
    const { service, store, executor } = setup({ meta });
    const rec = await service.propose(draft()); // still 'proposed'
    const res = await executor.execute(rec.id);
    expect(res.outcome).toBe("aborted");
    expect((await store.getById(rec.id))?.state).toBe("proposed");
  });

  it("fails and cancels on an external change (live budget ≠ captured)", async () => {
    const meta = new FakeMeta({ dailyBudgetAgorot: 7500, adStatuses: {} }); // changed from 7000
    const { service, store, ops, executor } = setup({ meta });
    const rec = await approvedRec(service, draft());

    const res = await executor.execute(rec.id);
    expect(res.outcome).toBe("failed");
    expect(res.customerMessage).toContain("השתנה");
    expect((await store.getById(rec.id))?.state).toBe("failed");
    expect(ops.items.length).toBe(1);
    expect(meta.state.dailyBudgetAgorot).toBe(7500); // untouched
  });

  it("fails on an external change for a pause (ad already not active)", async () => {
    const meta = new FakeMeta({ dailyBudgetAgorot: 7000, adStatuses: { ad_3: "paused" } });
    const { service, executor } = setup({ meta });
    const rec = await approvedRec(service, draft({ type: "pause_creative", targetMetaId: "ad_3", currentBudgetAgorot: null, proposedBudgetAgorot: null }));
    const res = await executor.execute(rec.id);
    expect(res.outcome).toBe("failed");
  });

  it("blocks an over-budget change before it reaches Meta", async () => {
    const meta = new FakeMeta({ dailyBudgetAgorot: 7000, adStatuses: {} });
    const { service, store, executor } = setup({ meta });
    const rec = await approvedRec(service, draft({ proposedBudgetAgorot: 12000 })); // > agreed 10000

    const res = await executor.execute(rec.id);
    expect(res.outcome).toBe("failed");
    expect(res.reason).toContain("exceeds agreed");
    expect(meta.state.dailyBudgetAgorot).toBe(7000); // never written
    expect((await store.getById(rec.id))?.state).toBe("failed");
  });

  it("fails when the read-back doesn't match (write didn't land)", async () => {
    const meta = new FakeMeta({ dailyBudgetAgorot: 7000, adStatuses: {} });
    meta.noApply = true; // write is a no-op → read-back stays 7000 ≠ 8000
    const { service, store, executor } = setup({ meta });
    const rec = await approvedRec(service, draft());

    const res = await executor.execute(rec.id);
    expect(res.outcome).toBe("failed");
    expect(res.reason).toContain("read-back");
    expect((await store.getById(rec.id))?.state).toBe("failed");
  });

  it("holds (aborts, stays approved) when access is lost mid-flight, raising ops", async () => {
    const meta = new FakeMeta({ dailyBudgetAgorot: 7000, adStatuses: {} });
    const { service, store, ops, executor } = setup({ meta, connectionGuard: BLOCK_GUARD });
    const rec = await approvedRec(service, draft());

    const res = await executor.execute(rec.id);
    expect(res.outcome).toBe("aborted");
    expect(res.customerMessage).toContain("הרשאה");
    expect((await store.getById(rec.id))?.state).toBe("approved"); // retryable
    expect(ops.items.some((i) => i.type === "meta_connection_failure")).toBe(true);
  });

  it("holds when automation is stopped (no failure, no ops noise)", async () => {
    const meta = new FakeMeta({ dailyBudgetAgorot: 7000, adStatuses: {} });
    const { service, store, ops, executor } = setup({ meta, controlGate: BLOCK_GUARD });
    const rec = await approvedRec(service, draft());

    const res = await executor.execute(rec.id);
    expect(res.outcome).toBe("aborted");
    expect((await store.getById(rec.id))?.state).toBe("approved");
    expect(ops.items.length).toBe(0);
  });
});
