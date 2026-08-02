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
  return {
    campaignId: "camp-1", metaObjectId: "x", parentMetaId: null, creativeName: null,
    periodStart: CUR.start, periodEnd: CUR.end, spendAgorot: 0, leads: 0, cplAgorot: null,
    impressions: 0, linkClicks: 0, deliveryStatus: "active", raw: {}, ...o,
  };
}

// Snapshots with cr_weak as a clear pause candidate.
async function seedWeak(store: InMemorySnapshotStore, weakLeads: number, weakCpl: number | null) {
  store.rows.clear();
  await store.upsert([
    snap({ grain: "campaign", metaObjectId: "camp", spendAgorot: 68000, leads: 20, cplAgorot: 3400 }),
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
      snap({ grain: "campaign", metaObjectId: "camp", spendAgorot: 70000, leads: 14, cplAgorot: 5000 }),
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
