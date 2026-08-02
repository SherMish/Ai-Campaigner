import { describe, it, expect } from "vitest";
import { InMemorySnapshotStore } from "../meta/snapshot-store.js";
import { InMemoryRecommendationStore } from "./recommendation-store.js";
import { evaluateAndPersist } from "./rule-evaluator.js";
import type { SnapshotUpsert } from "../meta/insights.js";

const CUR = { start: "2026-07-26", end: "2026-08-01" };
const PREV = { start: "2026-07-19", end: "2026-07-25" };

function snap(o: Partial<SnapshotUpsert> & Pick<SnapshotUpsert, "grain">): SnapshotUpsert {
  return {
    campaignId: "camp-1",
    metaObjectId: "x",
    parentMetaId: null,
    creativeName: null,
    periodStart: CUR.start,
    periodEnd: CUR.end,
    spendAgorot: 0,
    leads: 0,
    cplAgorot: null,
    impressions: 0,
    linkClicks: 0,
    deliveryStatus: "active",
    raw: {},
    ...o,
  };
}

async function seedWeakCreative(store: InMemorySnapshotStore) {
  await store.upsert([
    snap({ grain: "campaign", metaObjectId: "camp", spendAgorot: 68000, leads: 20, cplAgorot: 3400 }),
    snap({ grain: "creative", metaObjectId: "cr_a", spendAgorot: 25000, leads: 10, cplAgorot: 2500 }),
    snap({ grain: "creative", metaObjectId: "cr_b", spendAgorot: 24000, leads: 9, cplAgorot: 2667 }),
    snap({ grain: "creative", metaObjectId: "cr_weak", spendAgorot: 18000, leads: 1, cplAgorot: 18000 }),
    // previous window campaign total
    snap({ grain: "campaign", metaObjectId: "camp", periodStart: PREV.start, periodEnd: PREV.end, spendAgorot: 68000, leads: 20, cplAgorot: 3400 }),
  ]);
}

describe("evaluateAndPersist", () => {
  it("stores a pause_creative rec when a weak creative is present", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeakCreative(snapshots);
    const recs = new InMemoryRecommendationStore();

    const result = await evaluateAndPersist({
      snapshotStore: snapshots,
      recommendationStore: recs,
      campaign: { id: "camp-1", currentBudgetAgorot: 7000 },
      current: CUR,
      previous: PREV,
    });

    expect(result.created).toBe(true);
    expect(result.draft.type).toBe("pause_creative");
    expect(result.draft.targetMetaId).toBe("cr_weak");
    expect(recs.records.size).toBe(1);
  });

  it("does not duplicate an equivalent proposed rec on a repeat tick", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeakCreative(snapshots);
    const recs = new InMemoryRecommendationStore();
    const deps = {
      snapshotStore: snapshots,
      recommendationStore: recs,
      campaign: { id: "camp-1", currentBudgetAgorot: 7000 },
      current: CUR,
      previous: PREV,
    };
    await evaluateAndPersist(deps);
    const second = await evaluateAndPersist(deps);
    expect(second.created).toBe(false);
    expect(recs.records.size).toBe(1);
  });

  it("returns no_action without storing a row when evidence is thin", async () => {
    const snapshots = new InMemorySnapshotStore();
    await snapshots.upsert([
      snap({ grain: "campaign", metaObjectId: "camp", spendAgorot: 4000, leads: 1, cplAgorot: 4000 }),
    ]);
    const recs = new InMemoryRecommendationStore();
    const result = await evaluateAndPersist({
      snapshotStore: snapshots,
      recommendationStore: recs,
      campaign: { id: "camp-1", currentBudgetAgorot: 7000 },
      current: CUR,
      previous: PREV,
    });
    expect(result.draft.type).toBe("no_action");
    expect(result.created).toBe(false);
    expect(recs.records.size).toBe(0);
  });
});
