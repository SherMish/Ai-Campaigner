import { describe, it, expect } from "vitest";
import { InMemorySnapshotStore } from "../meta/snapshot-store.js";
import { InMemoryRecommendationStore } from "./recommendation-store.js";
import { RecommendationService } from "./recommendation-service.js";
import { IllegalTransitionError } from "./state-machine.js";
import { refreshRecommendations } from "./staleness.js";
import type { SnapshotUpsert } from "../meta/insights.js";

const CUR = { start: "2026-07-26", end: "2026-08-01" };
const PREV = { start: "2026-07-19", end: "2026-07-25" };

function snap(o: Partial<SnapshotUpsert> & Pick<SnapshotUpsert, "grain">): SnapshotUpsert {
  const r: SnapshotUpsert = {
    campaignId: "camp-1", metaObjectId: "x", parentMetaId: null, creativeName: null,
    periodStart: CUR.start, periodEnd: CUR.end, spendAgorot: 0, leads: 0, cplAgorot: null,
    impressions: 0, linkClicks: 0, deliveryStatus: "active", raw: {}, ...o,
  };
  // Campaign-grain rows are summed, so they must be disjoint per-day rows —
  // see the same note in generation.test.ts (migration 030).
  return r.grain === "campaign" ? { ...r, periodEnd: r.periodStart } : r;
}

// Splits an aggregate CURRENT-window campaign total into 3 distinct days
// inside CUR, so daysActive/deliveryDaysActive (features.ts — real per-day
// counts, not window length) clear MIN_DAYS_DATA/MIN_DELIVERY_DAYS. See the
// same helper in generation.test.ts.
function campaignDailyRows(totalSpendAgorot: number, totalLeads: number): SnapshotUpsert[] {
  const dates = ["2026-07-27", "2026-07-29", "2026-07-31"];
  const spends = [Math.round(totalSpendAgorot / 3), Math.round(totalSpendAgorot / 3), 0];
  spends[2] = totalSpendAgorot - spends[0] - spends[1];
  const leadsArr = [Math.round(totalLeads / 3), Math.round(totalLeads / 3), 0];
  leadsArr[2] = totalLeads - leadsArr[0] - leadsArr[1];
  return dates.map((periodStart, i) =>
    snap({
      grain: "campaign",
      metaObjectId: "camp",
      periodStart,
      spendAgorot: spends[i],
      leads: leadsArr[i],
      cplAgorot: leadsArr[i] > 0 ? Math.round(spends[i] / leadsArr[i]) : null,
    }),
  );
}

// Snapshots with cr_weak as a clear pause candidate.
async function seedWeak(store: InMemorySnapshotStore, weakLeads: number, weakCpl: number | null) {
  store.rows.clear();
  await store.upsert([
    ...campaignDailyRows(68000, 20),
    snap({ grain: "creative", metaObjectId: "cr_a", spendAgorot: 25000, leads: 10, cplAgorot: 2500 }),
    snap({ grain: "creative", metaObjectId: "cr_b", spendAgorot: 24000, leads: 9, cplAgorot: 2667 }),
    snap({ grain: "creative", metaObjectId: "cr_weak", spendAgorot: 18000, leads: weakLeads, cplAgorot: weakCpl }),
    snap({ grain: "campaign", metaObjectId: "camp", periodStart: PREV.start, periodEnd: PREV.end, spendAgorot: 68000, leads: 20, cplAgorot: 3400 }),
  ]);
}

function deps(snapshots: InMemorySnapshotStore, recs: InMemoryRecommendationStore) {
  return {
    snapshotStore: snapshots,
    recommendationStore: recs,
    recommendationService: new RecommendationService(recs),
    campaign: { id: "camp-1", currentBudgetAgorot: 7000 },
    current: CUR,
    previous: PREV,
  };
}

describe("refreshRecommendations (staleness/expiry)", () => {
  it("evidence holds → the proposed rec stays, nothing expired or duplicated", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeak(snapshots, 1, 18000); // cr_weak weak
    const recs = new InMemoryRecommendationStore();
    const d = deps(snapshots, recs);

    const first = await refreshRecommendations(d);
    expect(first.createdId).toBeDefined();

    const second = await refreshRecommendations(d); // evidence unchanged
    expect(second.expiredIds).toHaveLength(0);
    expect(second.createdId).toBeUndefined();
    expect([...recs.records.values()].filter((r) => r.state === "proposed")).toHaveLength(1);
  });

  it("AIC-86: an advisory add_creatives_for_comparison rec is created like any other draft", async () => {
    const snapshots = new InMemorySnapshotStore();
    await snapshots.upsert([
      ...campaignDailyRows(4629, 5),
      snap({ grain: "creative", metaObjectId: "cr_only", spendAgorot: 4394, leads: 5, cplAgorot: 879 }),
    ]);
    const recs = new InMemoryRecommendationStore();
    const d = deps(snapshots, recs);

    const result = await refreshRecommendations(d);
    expect(result.createdId).toBeDefined();
    const rec = recs.records.get(result.createdId!)!;
    expect(rec.type).toBe("add_creatives_for_comparison");
    expect(rec.state).toBe("proposed");
  });

  it("AIC-86: the advisory rec auto-expires once a second real creative restores comparability", async () => {
    const snapshots = new InMemorySnapshotStore();
    await snapshots.upsert([
      ...campaignDailyRows(4629, 5),
      snap({ grain: "creative", metaObjectId: "cr_only", spendAgorot: 4394, leads: 5, cplAgorot: 879 }),
    ]);
    const recs = new InMemoryRecommendationStore();
    const d = deps(snapshots, recs);

    const first = await refreshRecommendations(d);
    expect(first.createdId).toBeDefined();

    // The customer adds a second creative — same "material divergence" test
    // every other rec type uses, no special-case code needed for this type.
    await snapshots.upsert([
      snap({ grain: "creative", metaObjectId: "cr_second", spendAgorot: 4394, leads: 4, cplAgorot: 1099 }),
    ]);
    const second = await refreshRecommendations(d);
    expect(second.expiredIds).toContain(first.createdId);
    expect(second.freshDraft.type).not.toBe("add_creatives_for_comparison");
  });

  it("a per-account threshold override (AIC-77a) reaches refreshRecommendations end-to-end", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeak(snapshots, 1, 18000); // fires pause_creative under the default deps() below
    const recs = new InMemoryRecommendationStore();
    const d = {
      ...deps(snapshots, recs),
      campaign: { id: "camp-1", currentBudgetAgorot: 7000, thresholdOverrides: { MIN_CAMPAIGN_LEADS: 999 } },
    };

    const result = await refreshRecommendations(d);
    expect(result.freshDraft.type).toBe("no_action");
    expect(result.freshDraft.evidence.reason).toBe("collecting");
    expect(result.createdId).toBeUndefined();
  });

  it("evidence diverged (weak creative recovered) → the rec expires", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeak(snapshots, 1, 18000);
    const recs = new InMemoryRecommendationStore();
    const d = deps(snapshots, recs);

    const first = await refreshRecommendations(d);
    const recId = first.createdId!;

    // cr_weak recovers to a healthy CPL → rules no longer call for a pause.
    await seedWeak(snapshots, 9, 2000);
    const after = await refreshRecommendations(d);

    expect(after.expiredIds).toContain(recId);
    const rec = await recs.getById(recId);
    expect(rec?.state).toBe("expired");
  });

  it("an expired recommendation cannot be approved", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeak(snapshots, 1, 18000);
    const recs = new InMemoryRecommendationStore();
    const d = deps(snapshots, recs);
    const first = await refreshRecommendations(d);
    const recId = first.createdId!;

    await seedWeak(snapshots, 9, 2000);
    await refreshRecommendations(d); // expires it

    await expect(d.recommendationService.approve(recId, "cust-1")).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
  });

  it("replaces an expired rec with a fresh one when a different action is now warranted", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeak(snapshots, 1, 18000); // → pause_creative
    const recs = new InMemoryRecommendationStore();
    const d = deps(snapshots, recs);
    const first = await refreshRecommendations(d);
    expect(first.freshDraft.type).toBe("pause_creative");

    // Now: no weak creative, but campaign CPL rose sharply → decrease_budget.
    snapshots.rows.clear();
    await snapshots.upsert([
      ...campaignDailyRows(70000, 14),
      snap({ grain: "creative", metaObjectId: "cr_a", spendAgorot: 35000, leads: 7, cplAgorot: 5000 }),
      snap({ grain: "creative", metaObjectId: "cr_b", spendAgorot: 35000, leads: 7, cplAgorot: 5000 }),
      snap({ grain: "campaign", metaObjectId: "camp", periodStart: PREV.start, periodEnd: PREV.end, spendAgorot: 70000, leads: 20, cplAgorot: 3500 }),
    ]);
    const after = await refreshRecommendations(d);
    expect(after.expiredIds).toContain(first.createdId);
    expect(after.freshDraft.type).toBe("decrease_budget");
    expect(after.createdId).toBeDefined();
  });
});

// AIC-77b real bug: no rule filtered on live delivery status, so an ad Meta
// already reports as paused (by us or by the operator, AIC-66) still carried
// its historical spend/leads and stayed eligible to be flagged "weak" —
// the engine proposing to pause an ad that's already paused. On the only
// live account, whose entire action_history is manual pauses, this was the
// single most likely first-ever recommendation.
describe("refreshRecommendations — already-paused exclusion (AIC-77b)", () => {
  it("does NOT propose pausing a creative Meta already reports as paused", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeak(snapshots, 1, 18000); // cr_weak fires pause_creative under default deps()
    const recs = new InMemoryRecommendationStore();
    const d = {
      ...deps(snapshots, recs),
      adStatuses: { cr_weak: "paused" as const },
    };

    const result = await refreshRecommendations(d);
    // Not just "doesn't target cr_weak" — no OTHER creative is weak in this
    // fixture either, so the honest outcome is no_action, not a different pause.
    expect(result.freshDraft.type).toBe("no_action");
    expect(result.createdId).toBeUndefined();
  });

  it("still proposes pausing a DIFFERENT creative that is genuinely active and weak", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeak(snapshots, 1, 18000); // cr_weak is the weak one
    const recs = new InMemoryRecommendationStore();
    const d = {
      ...deps(snapshots, recs),
      // cr_a is active and fine — excluding it (it isn't even a candidate)
      // must not suppress the real, still-live weak creative.
      adStatuses: { cr_a: "active" as const },
    };

    const result = await refreshRecommendations(d);
    expect(result.freshDraft.type).toBe("pause_creative");
    expect(result.freshDraft.targetMetaId).toBe("cr_weak");
  });

  it("an unknown/missing status is judgeable, not excluded — absence is not 'paused'", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeak(snapshots, 1, 18000);
    const recs = new InMemoryRecommendationStore();
    const d = deps(snapshots, recs); // no adStatuses at all — the pre-existing shape

    const result = await refreshRecommendations(d);
    expect(result.freshDraft.type).toBe("pause_creative");
    expect(result.freshDraft.targetMetaId).toBe("cr_weak");
  });
});

// AIC-77b: proves cooldown reaches the real production path
// (refreshRecommendations), not just evaluateCampaign's pure logic.
describe("refreshRecommendations — cooldown (AIC-77b)", () => {
  const NOW = new Date("2026-08-14T00:00:00Z");

  it("suppresses a rule whose class executed successfully within COOLDOWN_DAYS, reports cooling_down", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeak(snapshots, 1, 18000); // fires pause_creative without cooldown
    const recs = new InMemoryRecommendationStore();
    const d = {
      ...deps(snapshots, recs),
      campaign: {
        id: "camp-1",
        currentBudgetAgorot: 7000,
        lastActionAtByType: { pause_creative: new Date("2026-08-10T00:00:00Z") }, // 4 days ago
      },
      now: NOW,
    };

    const result = await refreshRecommendations(d);
    expect(result.freshDraft.type).toBe("no_action");
    expect(result.freshDraft.evidence.reason).toBe("cooling_down");
    expect(result.createdId).toBeUndefined();
  });

  it("does not suppress once the cooldown window has passed", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeak(snapshots, 1, 18000);
    const recs = new InMemoryRecommendationStore();
    const d = {
      ...deps(snapshots, recs),
      campaign: {
        id: "camp-1",
        currentBudgetAgorot: 7000,
        lastActionAtByType: { pause_creative: new Date("2026-08-01T00:00:00Z") }, // 13 days ago
      },
      now: NOW,
    };

    const result = await refreshRecommendations(d);
    expect(result.freshDraft.type).toBe("pause_creative");
  });

  it("a per-account COOLDOWN_DAYS override (AIC-77a's mechanism) shortens the window", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeak(snapshots, 1, 18000);
    const recs = new InMemoryRecommendationStore();
    const d = {
      ...deps(snapshots, recs),
      campaign: {
        id: "camp-1",
        currentBudgetAgorot: 7000,
        thresholdOverrides: { COOLDOWN_DAYS: 2 },
        lastActionAtByType: { pause_creative: new Date("2026-08-10T00:00:00Z") }, // 4 days ago — outside a 2-day window
      },
      now: NOW,
    };

    const result = await refreshRecommendations(d);
    expect(result.freshDraft.type).toBe("pause_creative"); // 2-day cooldown already elapsed
  });
});
