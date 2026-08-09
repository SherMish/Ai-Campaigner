import { describe, it, expect } from "vitest";
import {
  ControlService,
  InMemoryControlStore,
  ControlHaltedError,
  type ControlFlags,
} from "./control-service.js";
import { InMemoryRecommendationStore } from "../recommendations/recommendation-store.js";
import { RecommendationService } from "../recommendations/recommendation-service.js";
import { SafeExecutor, type ExecCampaign, type LiveCampaignState, type AccessGuard, type OpsRaiser } from "./safe-executor.js";
import type { RecommendationDraft } from "../recommendations/types.js";

const HEALTHY: ControlFlags = { automationEnabled: true, executionFrozen: false, status: "active" };

function service(flags: Partial<ControlFlags> = {}) {
  const store = new InMemoryControlStore();
  store.seed("camp-1", { ...HEALTHY, ...flags });
  return new ControlService(store);
}

describe("ControlService.assertExecutable (the control gate)", () => {
  it("passes for a healthy, automated, unfrozen campaign", async () => {
    await expect(service().assertExecutable("camp-1")).resolves.toBeUndefined();
  });

  it("halts when automation is disabled", async () => {
    await expect(service({ automationEnabled: false }).assertExecutable("camp-1")).rejects.toBeInstanceOf(ControlHaltedError);
  });

  it("halts when execution is frozen", async () => {
    await expect(service({ executionFrozen: true }).assertExecutable("camp-1")).rejects.toBeInstanceOf(ControlHaltedError);
  });

  it("halts when the account is unmanaged", async () => {
    await expect(service({ status: "unmanaged" }).assertExecutable("camp-1")).rejects.toBeInstanceOf(ControlHaltedError);
  });

  it("pauseManagement stops both generation and execution", async () => {
    const store = new InMemoryControlStore();
    store.seed("camp-1", { ...HEALTHY });
    const svc = new ControlService(store);
    await svc.pauseManagement("camp-1");
    expect(await svc.isAutomated("camp-1")).toBe(false);
    await expect(svc.assertExecutable("camp-1")).rejects.toBeInstanceOf(ControlHaltedError);
  });
});

// A no-op Meta double for the executor.
class FakeMeta {
  public state: LiveCampaignState;
  constructor(state: { dailyBudgetAgorot: number; adStatuses: Record<string, "active" | "paused">; adSetStatuses?: Record<string, "active" | "paused"> }) {
    this.state = { adSetStatuses: {}, ...state };
  }
  async getCampaignState(): Promise<LiveCampaignState> { return { dailyBudgetAgorot: this.state.dailyBudgetAgorot, adStatuses: { ...this.state.adStatuses }, adSetStatuses: { ...this.state.adSetStatuses } }; }
  async setDailyBudget(_id: string, agorot: number) { this.state.dailyBudgetAgorot = agorot; }
  async pauseAd(id: string) { this.state.adStatuses[id] = "paused"; }
  async pauseAdSet(id: string) { this.state.adSetStatuses[id] = "paused"; }
}
const OK_GUARD: AccessGuard = { assertExecutable: async () => {} };
const NOOP_OPS: OpsRaiser = { raise: async () => {} };
const CAMPAIGN: ExecCampaign = { id: "camp-1", metaCampaignId: "m1", connectionId: "c1", customerId: "cust-1", agreedBudgetAgorot: 10000 };

function draft(): RecommendationDraft {
  return { campaignId: "camp-1", type: "increase_budget", targetMetaId: null, evidence: {}, currentBudgetAgorot: 7000, proposedBudgetAgorot: 8000, maxSpendImpactAgorot: 1000, rationale: "x" };
}

describe("kill-switch halts execution mid-batch", () => {
  it("stops executing approved recs the moment the control gate is flipped", async () => {
    const recStore = new InMemoryRecommendationStore();
    const recSvc = new RecommendationService(recStore);
    const control = service(); // healthy
    const meta = new FakeMeta({ dailyBudgetAgorot: 7000, adStatuses: {} });
    const executor = new SafeExecutor({
      store: recStore, service: recSvc,
      campaigns: { load: async () => CAMPAIGN },
      reader: meta, writer: meta,
      connectionGuard: OK_GUARD, controlGate: control, ops: NOOP_OPS,
    });

    const r1 = await recSvc.propose(draft()); await recSvc.approve(r1.id, "c");
    const r2 = await recSvc.propose({ ...draft(), type: "pause_creative", targetMetaId: "ad_1", currentBudgetAgorot: null, proposedBudgetAgorot: null }); await recSvc.approve(r2.id, "c");
    meta.state.adStatuses.ad_1 = "active";

    const first = await executor.execute(r1.id);
    expect(first.outcome).toBe("executed");

    // Operator hits the brake between items.
    await control.freezeExecution("camp-1");

    const second = await executor.execute(r2.id);
    expect(second.outcome).toBe("aborted");
    expect((await recStore.getById(r2.id))?.state).toBe("approved"); // not executed, retryable
    expect(meta.state.adStatuses.ad_1).toBe("active"); // never paused
  });
});
