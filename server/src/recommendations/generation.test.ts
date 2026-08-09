import { describe, it, expect } from "vitest";
import { InMemorySnapshotStore } from "../meta/snapshot-store.js";
import { InMemoryRecommendationStore } from "./recommendation-store.js";
import { RecommendationService } from "./recommendation-service.js";
import { runGenerationTick, type GenCampaign } from "./generation.js";
import type { MetaReader } from "../execution/safe-executor.js";
import type { SnapshotUpsert } from "../meta/insights.js";

// Align with rollingPeriods(ref="2026-08-02"): current 07-26..08-01, prev 07-19..07-25.
const REF = new Date("2026-08-02T00:00:00.000Z");
const CUR = { start: "2026-07-26", end: "2026-08-01" };
const PREV = { start: "2026-07-19", end: "2026-07-25" };

function snap(o: Partial<SnapshotUpsert> & Pick<SnapshotUpsert, "grain">): SnapshotUpsert {
  return {
    campaignId: "camp-1", metaObjectId: "x", parentMetaId: null, creativeName: null,
    periodStart: CUR.start, periodEnd: CUR.end, spendAgorot: 0, leads: 0, cplAgorot: null,
    impressions: 0, linkClicks: 0, deliveryStatus: "active", raw: {}, ...o,
  };
}

// A weak creative (cr_weak) that the rules should flag for a pause.
async function seedWeak(store: InMemorySnapshotStore) {
  await store.upsert([
    snap({ grain: "campaign", metaObjectId: "camp", spendAgorot: 68000, leads: 20, cplAgorot: 3400 }),
    snap({ grain: "creative", metaObjectId: "cr_a", spendAgorot: 25000, leads: 10, cplAgorot: 2500 }),
    snap({ grain: "creative", metaObjectId: "cr_b", spendAgorot: 24000, leads: 9, cplAgorot: 2667 }),
    snap({ grain: "creative", metaObjectId: "cr_weak", spendAgorot: 18000, leads: 1, cplAgorot: 18000 }),
    snap({ grain: "campaign", metaObjectId: "camp", periodStart: PREV.start, periodEnd: PREV.end, spendAgorot: 68000, leads: 20, cplAgorot: 3400 }),
  ]);
}

const okReader = (agorot = 7000): MetaReader => ({
  getCampaignState: async () => ({ dailyBudgetAgorot: agorot, adStatuses: {} }),
});

function tick(campaigns: GenCampaign[], reader: MetaReader, snapshots: InMemorySnapshotStore, recs: InMemoryRecommendationStore) {
  return runGenerationTick({
    campaigns,
    reader,
    snapshotStore: snapshots,
    recommendationStore: recs,
    recommendationService: new RecommendationService(recs),
    ref: REF,
  });
}

const CAMP: GenCampaign = { id: "camp-1", metaCampaignId: "meta-1" };

describe("runGenerationTick", () => {
  it("proposes a recommendation from snapshots, and dedupes on a repeat tick", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeak(snapshots);
    const recs = new InMemoryRecommendationStore();

    const first = await tick([CAMP], okReader(), snapshots, recs);
    expect(first).toMatchObject({ evaluated: 1, created: 1, skipped: 0 });
    expect([...recs.records.values()].filter((r) => r.state === "proposed")).toHaveLength(1);

    // A second tick on unchanged evidence creates nothing new.
    const second = await tick([CAMP], okReader(), snapshots, recs);
    expect(second).toMatchObject({ evaluated: 1, created: 0, expired: 0 });
    expect([...recs.records.values()].filter((r) => r.state === "proposed")).toHaveLength(1);
  });

  it("stable/thin evidence yields no recommendation", async () => {
    const snapshots = new InMemorySnapshotStore();
    await snapshots.upsert([
      snap({ grain: "campaign", metaObjectId: "camp", spendAgorot: 200, leads: 0, cplAgorot: null }),
    ]);
    const recs = new InMemoryRecommendationStore();
    const res = await tick([CAMP], okReader(), snapshots, recs);
    expect(res).toMatchObject({ evaluated: 1, created: 0 });
    expect([...recs.records.values()]).toHaveLength(0);
  });

  it("skips a campaign whose live budget can't be read (never guesses)", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeak(snapshots);
    const recs = new InMemoryRecommendationStore();
    const badReader: MetaReader = { getCampaignState: async () => { throw new Error("meta down"); } };
    const res = await tick([CAMP], badReader, snapshots, recs);
    expect(res).toMatchObject({ evaluated: 0, created: 0, skipped: 1 });
    expect([...recs.records.values()]).toHaveLength(0);
  });
});
