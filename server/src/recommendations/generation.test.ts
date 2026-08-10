import { describe, it, expect } from "vitest";
import { InMemorySnapshotStore } from "../meta/snapshot-store.js";
import { InMemoryRecommendationStore } from "./recommendation-store.js";
import { RecommendationService } from "./recommendation-service.js";
import { runGenerationTick, type GenCampaign, type AudienceMetaReader } from "./generation.js";
import type { MetaReader } from "../execution/safe-executor.js";
import type { SnapshotUpsert } from "../meta/insights.js";
import type { DeliverySummary } from "../meta/delivery-health.js";
import type { AdSetMeta } from "../meta/audience-label.js";

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
  getCampaignState: async () => ({ dailyBudgetAgorot: agorot, adStatuses: {}, adSetStatuses: {} }),
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

const CAMP: GenCampaign = { id: "camp-1", metaCampaignId: "meta-1", customerId: "cust-1" };

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

// A clear A≫B audience split: A cheap, B ≥2× the CPL — the audience rule fires
// on B unless B is excluded for a delivery problem (AIC-39).
async function seedAudience(store: InMemorySnapshotStore) {
  await store.upsert([
    snap({ grain: "campaign", metaObjectId: "camp", spendAgorot: 80000, leads: 25, cplAgorot: 3200 }),
    snap({ grain: "campaign", metaObjectId: "camp", periodStart: PREV.start, periodEnd: PREV.end, spendAgorot: 80000, leads: 25, cplAgorot: 3200 }),
    snap({ grain: "adset", metaObjectId: "as_A", spendAgorot: 40000, leads: 20, cplAgorot: 2000 }),
    snap({ grain: "adset", metaObjectId: "as_B", spendAgorot: 40000, leads: 5, cplAgorot: 8000 }),
  ]);
}

describe("runGenerationTick — audience rule + AIC-39 delivery exclusion", () => {
  it("proposes pause_adset on the worse audience when both deliver", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedAudience(snapshots);
    const recs = new InMemoryRecommendationStore();
    const res = await runGenerationTick({
      campaigns: [CAMP], reader: okReader(),
      snapshotStore: snapshots, recommendationStore: recs,
      recommendationService: new RecommendationService(recs), ref: REF,
    });
    expect(res.created).toBe(1);
    const rec = [...recs.records.values()][0];
    expect(rec.type).toBe("pause_adset");
    expect(rec.targetMetaId).toBe("as_B");
  });

  it("does NOT propose pausing an ad set that is flagged not-delivering", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedAudience(snapshots);
    const recs = new InMemoryRecommendationStore();
    let recorded: DeliverySummary | null = null;
    const res = await runGenerationTick({
      campaigns: [CAMP], reader: okReader(),
      snapshotStore: snapshots, recommendationStore: recs,
      recommendationService: new RecommendationService(recs), ref: REF,
      deliveryReader: { getDeliveryHealth: async () => [
        { adSetId: "as_A", name: null, state: "delivering", reason: null },
        { adSetId: "as_B", name: null, state: "not_delivering", reason: "Ad set not delivering" },
      ] },
      recordDelivery: async (_c, s) => { recorded = s; },
    });
    expect(res.deliveryProblems).toBe(1);
    expect(recorded).toMatchObject({ ok: false, problemAdSetIds: ["as_B"] });
    // as_B excluded → only one delivering audience → audience rule can't fire.
    expect([...recs.records.values()].some((r) => r.type === "pause_adset")).toBe(false);
  });
});

// A weak-looking creative that lives under an ad set Meta reports as running
// Dynamic/Advantage+ creative (AIC-36) — the tick must fetch is_dynamic_creative
// via the audienceMetaReader and thread it all the way into the rule so it never
// proposes pausing "peers" Meta itself can't reliably attribute.
async function seedFlexibleCreative(store: InMemorySnapshotStore) {
  await store.upsert([
    snap({ grain: "campaign", metaObjectId: "camp", spendAgorot: 68000, leads: 20, cplAgorot: 3400 }),
    snap({ grain: "campaign", metaObjectId: "camp", periodStart: PREV.start, periodEnd: PREV.end, spendAgorot: 68000, leads: 20, cplAgorot: 3400 }),
    snap({ grain: "creative", metaObjectId: "cr_a", parentMetaId: "as_flex", spendAgorot: 25000, leads: 10, cplAgorot: 2500 }),
    snap({ grain: "creative", metaObjectId: "cr_weak", parentMetaId: "as_flex", spendAgorot: 18000, leads: 1, cplAgorot: 18000 }),
  ]);
}

function adSetMeta(adSetId: string, isDynamicCreative: boolean): AdSetMeta {
  return { adSetId, name: adSetId, ageMin: null, ageMax: null, genders: "all", geoSummary: "", isDynamicCreative };
}

describe("runGenerationTick — flexible/Advantage+ creative exclusion (AIC-36)", () => {
  it("fetches is_dynamic_creative via the audienceMetaReader and skips pause_creative for that ad set", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedFlexibleCreative(snapshots);
    const recs = new InMemoryRecommendationStore();
    const audienceMetaReader: AudienceMetaReader = { getAdSetMeta: async () => [adSetMeta("as_flex", true)] };
    let cached: AdSetMeta[] | null = null;

    const res = await runGenerationTick({
      campaigns: [CAMP], reader: okReader(),
      snapshotStore: snapshots, recommendationStore: recs,
      recommendationService: new RecommendationService(recs), ref: REF,
      audienceMetaReader,
      recordAudienceMeta: async (_c, adsets) => { cached = adsets; },
    });

    expect(res.created).toBe(0);
    expect([...recs.records.values()].some((r) => r.type === "pause_creative")).toBe(false);
    expect(cached).toEqual([adSetMeta("as_flex", true)]);
  });

  it("a genuinely weak creative in a NON-flexible ad set still fires (control)", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedFlexibleCreative(snapshots);
    const recs = new InMemoryRecommendationStore();
    const audienceMetaReader: AudienceMetaReader = { getAdSetMeta: async () => [adSetMeta("as_flex", false)] };

    const res = await runGenerationTick({
      campaigns: [CAMP], reader: okReader(),
      snapshotStore: snapshots, recommendationStore: recs,
      recommendationService: new RecommendationService(recs), ref: REF,
      audienceMetaReader,
    });

    expect(res.created).toBe(1);
    const rec = [...recs.records.values()][0];
    expect(rec.type).toBe("pause_creative");
    expect(rec.targetMetaId).toBe("cr_weak");
  });
});
