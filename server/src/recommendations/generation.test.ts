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
  const r: SnapshotUpsert = {
    campaignId: "camp-1", metaObjectId: "x", parentMetaId: null, creativeName: null,
    periodStart: CUR.start, periodEnd: CUR.end, spendAgorot: 0, leads: 0, cplAgorot: null,
    impressions: 0, linkClicks: 0, deliveryStatus: "active", raw: {}, ...o,
  };
  // Campaign-grain rows are SUMMED over the window, so they must be disjoint
  // per-day rows — that's what real ingestion writes, and what campaignTotals
  // reads via the insight_snapshot_daily view (migration 030). Collapsing to a
  // single day inside the window expresses the window's totals without the
  // overlap that made the engine read 8 leads where the customer had 4.
  // Creative/ad-set grains are selected per object rather than summed over
  // time, so they keep the rolling window they're really ingested with.
  return r.grain === "campaign" ? { ...r, periodEnd: r.periodStart } : r;
}

// Splits an aggregate CURRENT-window campaign total into 3 distinct days
// inside CUR, so daysActive/deliveryDaysActive (features.ts — real per-day
// counts, not window length) clear MIN_DAYS_DATA/MIN_DELIVERY_DAYS the same
// way real ingestion does for an established campaign. A single-day fixture
// used to pass this gate too, back when `days` was a window-length
// approximation (see rule-evaluator.ts's deleted periodDays()); now it
// genuinely only has 1 day of data and correctly reads "collecting".
function campaignDailyRows(totalSpendAgorot: number, totalLeads: number): SnapshotUpsert[] {
  const dates = ["2026-07-27", "2026-07-29", "2026-07-31"];
  const spends = [
    Math.round(totalSpendAgorot / 3),
    Math.round(totalSpendAgorot / 3),
    0,
  ];
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

// A weak creative (cr_weak) that the rules should flag for a pause.
async function seedWeak(store: InMemorySnapshotStore) {
  await store.upsert([
    ...campaignDailyRows(68000, 20),
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

  // AIC-77b: proves the real wiring, not just staleness.ts's filtering logic —
  // getCampaignState's adStatuses (already fetched every tick, previously
  // discarded after reading only the budget) must actually reach the rules
  // through runGenerationTick's own plumbing.
  it("does not propose pausing a creative the live Meta reader reports as paused", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeak(snapshots); // cr_weak fires pause_creative under okReader()
    const recs = new InMemoryRecommendationStore();
    const pausedReader: MetaReader = {
      getCampaignState: async () => ({ dailyBudgetAgorot: 7000, adStatuses: { cr_weak: "paused" }, adSetStatuses: {} }),
    };

    const res = await tick([CAMP], pausedReader, snapshots, recs);
    expect(res).toMatchObject({ evaluated: 1, created: 0 });
    expect([...recs.records.values()]).toHaveLength(0);
  });

  it("zero creative-level data (day-one-shaped): AIC-86 fires add_creatives_for_comparison instead of yielding nothing", async () => {
    // Before AIC-86 this yielded no recommendation at all — exactly the
    // dead end the ticket exists to close: thin/no creative data is when
    // "add creatives" is most worth saying, not a reason to say nothing.
    const snapshots = new InMemorySnapshotStore();
    await snapshots.upsert([
      snap({ grain: "campaign", metaObjectId: "camp", spendAgorot: 200, leads: 0, cplAgorot: null }),
    ]);
    const recs = new InMemoryRecommendationStore();
    const res = await tick([CAMP], okReader(), snapshots, recs);
    expect(res).toMatchObject({ evaluated: 1, created: 1 });
    const rec = [...recs.records.values()][0];
    expect(rec.type).toBe("add_creatives_for_comparison");
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
    ...campaignDailyRows(80000, 25),
    snap({ grain: "campaign", metaObjectId: "camp", periodStart: PREV.start, periodEnd: PREV.end, spendAgorot: 80000, leads: 25, cplAgorot: 3200 }),
    snap({ grain: "adset", metaObjectId: "as_A", spendAgorot: 40000, leads: 20, cplAgorot: 2000 }),
    snap({ grain: "adset", metaObjectId: "as_B", spendAgorot: 40000, leads: 5, cplAgorot: 8000 }),
  ]);
}

describe("runGenerationTick — audience rule + AIC-39 delivery exclusion", () => {
  it("proposes pause_adset on the worse audience when both deliver", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedAudience(snapshots);
    // Two real, comparable creatives (AIC-86 fires ahead of every RULES-array
    // rule, including the audience rule this test is actually about, when
    // there aren't) — irrelevant to what this test tests.
    await snapshots.upsert([
      snap({ grain: "creative", metaObjectId: "cr_1", spendAgorot: 20000, leads: 12, cplAgorot: 1667 }),
      snap({ grain: "creative", metaObjectId: "cr_2", spendAgorot: 20000, leads: 13, cplAgorot: 1538 }),
    ]);
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
        { adSetId: "as_A", name: null, state: "delivering", reason: null, deliveringAdCount: 1 },
        { adSetId: "as_B", name: null, state: "not_delivering", reason: "Ad set not delivering", deliveringAdCount: 0 },
      ] },
      recordDelivery: async (_c, s) => { recorded = s; },
    });
    expect(res.deliveryProblems).toBe(1);
    expect(recorded).toMatchObject({ ok: false, problemAdSetIds: ["as_B"] });
    // as_B excluded → only one delivering audience → audience rule can't fire.
    expect([...recs.records.values()].some((r) => r.type === "pause_adset")).toBe(false);
  });
});

// Real bug (2026-08-12): GelNails' second ad set is a deleted/never-published
// draft with historical snapshot rows — it was being treated as a real
// audience (false 2-ad-set count) AND flagged as a needs-attention delivery
// problem, when a deleted object not delivering is expected, not a problem.
describe("runGenerationTick — exclude dead/draft ad sets (AIC-65)", () => {
  it("a deleted/draft ad set is excluded from the audience count, even with real historical spend", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedAudience(snapshots); // as_A real, as_B has spend but is actually dead
    const recs = new InMemoryRecommendationStore();
    let recordedReason: string | null = null;
    const res = await runGenerationTick({
      campaigns: [CAMP], reader: okReader(),
      snapshotStore: snapshots, recommendationStore: recs,
      recommendationService: new RecommendationService(recs), ref: REF,
      audienceMetaReader: { getAdSetMeta: async () => [
        adSetMeta("as_A", false, true),
        adSetMeta("as_B", false, false), // AIC-65: dead — effective_status ACTIVE, zero ads
      ] },
      recordNoRecReason: async (_c, draft) => { recordedReason = (draft.evidence as { reason: string }).reason; },
    });
    // as_B excluded → only one real audience → can't compare → can't pause.
    expect([...recs.records.values()].some((r) => r.type === "pause_adset")).toBe(false);
    // Excluding a dead object is NOT a delivery problem — never delivery_blocked.
    expect(recordedReason).not.toBe("delivery_blocked");
    expect(res.deliveryProblems).toBe(0);
  });

  it("a dead ad set's leftover not-delivering issue never raises a needs-attention item", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedAudience(snapshots);
    const recs = new InMemoryRecommendationStore();
    let recorded: DeliverySummary | null = null;
    await runGenerationTick({
      campaigns: [CAMP], reader: okReader(),
      snapshotStore: snapshots, recommendationStore: recs,
      recommendationService: new RecommendationService(recs), ref: REF,
      audienceMetaReader: { getAdSetMeta: async () => [
        adSetMeta("as_A", false, true),
        adSetMeta("as_B", false, false),
      ] },
      deliveryReader: { getDeliveryHealth: async () => [
        { adSetId: "as_A", name: null, state: "delivering", reason: null, deliveringAdCount: 1 },
        { adSetId: "as_B", name: null, state: "not_delivering", reason: "stale issue from before deletion", deliveringAdCount: 0 },
      ] },
      recordDelivery: async (_c, s) => { recorded = s; },
    });
    expect(recorded).toMatchObject({ ok: true, problemAdSetIds: [] });
  });

  it("regression: a genuinely real not-delivering ad set is STILL flagged (not swept up by the dead-ad-set filter)", async () => {
    const snapshots = new InMemorySnapshotStore();
    await snapshots.upsert([
      snap({ grain: "campaign", metaObjectId: "camp", spendAgorot: 80000, leads: 25, cplAgorot: 3200 }),
      snap({ grain: "adset", metaObjectId: "as_real_broken", spendAgorot: 40000, leads: 5, cplAgorot: 8000 }),
      snap({ grain: "adset", metaObjectId: "as_dead", spendAgorot: 235, leads: 0, cplAgorot: null }),
    ]);
    const recs = new InMemoryRecommendationStore();
    let recorded: DeliverySummary | null = null;
    await runGenerationTick({
      campaigns: [CAMP], reader: okReader(),
      snapshotStore: snapshots, recommendationStore: recs,
      recommendationService: new RecommendationService(recs), ref: REF,
      audienceMetaReader: { getAdSetMeta: async () => [
        adSetMeta("as_real_broken", false, true), // real ad set, managed
        adSetMeta("as_dead", false, false), // dead, unmanaged
      ] },
      deliveryReader: { getDeliveryHealth: async () => [
        { adSetId: "as_real_broken", name: null, state: "not_delivering", reason: "Ad set not delivering", deliveringAdCount: 0 },
        { adSetId: "as_dead", name: null, state: "not_delivering", reason: "stale", deliveringAdCount: 0 },
      ] },
      recordDelivery: async (_c, s) => { recorded = s; },
    });
    expect(recorded).toMatchObject({ ok: false, problemAdSetIds: ["as_real_broken"] });
  });
});

// A weak-looking creative that lives under an ad set Meta reports as running
// Dynamic/Advantage+ creative (AIC-36) — the tick must fetch is_dynamic_creative
// via the audienceMetaReader and thread it all the way into the rule so it never
// proposes pausing "peers" Meta itself can't reliably attribute.
async function seedFlexibleCreative(store: InMemorySnapshotStore) {
  await store.upsert([
    ...campaignDailyRows(68000, 20),
    snap({ grain: "campaign", metaObjectId: "camp", periodStart: PREV.start, periodEnd: PREV.end, spendAgorot: 68000, leads: 20, cplAgorot: 3400 }),
    snap({ grain: "creative", metaObjectId: "cr_a", parentMetaId: "as_flex", spendAgorot: 25000, leads: 10, cplAgorot: 2500 }),
    snap({ grain: "creative", metaObjectId: "cr_weak", parentMetaId: "as_flex", spendAgorot: 18000, leads: 1, cplAgorot: 18000 }),
  ]);
}

function adSetMeta(adSetId: string, isDynamicCreative: boolean, isManaged = true): AdSetMeta {
  return { adSetId, name: adSetId, ageMin: null, ageMax: null, genders: "all", geoSummary: "", isDynamicCreative, status: "active", isManaged };
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

});

// AIC-64: the engine caches WHY it had nothing to propose, so the dashboard/ops
// console can show a real reason instead of a blank "no recommendation."
describe("runGenerationTick — recordNoRecReason (AIC-64)", () => {
  it("records collecting for thin evidence with a healthy budget", async () => {
    const snapshots = new InMemorySnapshotStore();
    await snapshots.upsert([
      snap({ grain: "campaign", metaObjectId: "camp", spendAgorot: 200, leads: 0, cplAgorot: null }),
      // Two real, comparable creatives (AIC-86 fires ahead of the day/lead-
      // count gate this test is actually about) — thinness under test is days.
      snap({ grain: "creative", metaObjectId: "cr_a", spendAgorot: 100, leads: 0, cplAgorot: null }),
      snap({ grain: "creative", metaObjectId: "cr_b", spendAgorot: 100, leads: 0, cplAgorot: null }),
    ]);
    const recs = new InMemoryRecommendationStore();
    let recorded: { campaignId: string; reason: string } | null = null;
    await runGenerationTick({
      campaigns: [CAMP], reader: okReader(),
      snapshotStore: snapshots, recommendationStore: recs,
      recommendationService: new RecommendationService(recs), ref: REF,
      recordNoRecReason: async (c, draft) => {
        recorded = { campaignId: c.id, reason: (draft.evidence as { reason: string }).reason };
      },
    });
    expect(recorded).toEqual({ campaignId: "camp-1", reason: "collecting" });
  });

  it("records delivery_blocked when a not-delivering ad set was excluded from evidence", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedAudience(snapshots);
    const recs = new InMemoryRecommendationStore();
    let recordedReason: string | null = null;
    await runGenerationTick({
      campaigns: [CAMP], reader: okReader(),
      snapshotStore: snapshots, recommendationStore: recs,
      recommendationService: new RecommendationService(recs), ref: REF,
      deliveryReader: { getDeliveryHealth: async () => [
        { adSetId: "as_A", name: null, state: "delivering", reason: null, deliveringAdCount: 1 },
        { adSetId: "as_B", name: null, state: "not_delivering", reason: "Ad set not delivering", deliveringAdCount: 0 },
      ] },
      recordNoRecReason: async (_c, draft) => {
        recordedReason = (draft.evidence as { reason: string }).reason;
      },
    });
    expect(recordedReason).toBe("delivery_blocked");
  });

  it("clears the reason (calls with an acting draft) when a recommendation IS proposed", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeak(snapshots);
    const recs = new InMemoryRecommendationStore();
    let recordedType: string | null = null;
    await runGenerationTick({
      campaigns: [CAMP], reader: okReader(),
      snapshotStore: snapshots, recommendationStore: recs,
      recommendationService: new RecommendationService(recs), ref: REF,
      recordNoRecReason: async (_c, draft) => { recordedType = draft.type; },
    });
    expect(recordedType).toBe("pause_creative");
  });

  it("a failure recording the reason doesn't fail the tick", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeak(snapshots);
    const recs = new InMemoryRecommendationStore();
    const res = await runGenerationTick({
      campaigns: [CAMP], reader: okReader(),
      snapshotStore: snapshots, recommendationStore: recs,
      recommendationService: new RecommendationService(recs), ref: REF,
      recordNoRecReason: async () => { throw new Error("db down"); },
    });
    expect(res.evaluated).toBe(1);
    expect(res.created).toBe(1);
  });

  // REGRESSION (real, found 2026-08-13 against production). The customer's
  // dashboard read "הכל עובד כרגיל" (all working normally / `stable`) while the
  // campaign had only 4 leads against a MIN_CAMPAIGN_LEADS gate of 5.
  //
  // Root cause was NOT the classifier — it was the evidence. Ingestion writes a
  // rolling 7-day campaign row AND per-day rows covering the same days, and
  // campaignTotals summed both, so the engine saw exactly 2x (8 leads). That
  // inflation passed a gate the real figure fails, and `stable` is the
  // fall-through once the gate passes and no rule fires.
  //
  // `stable` and `collecting` are opposite messages to a customer: one says
  // "nothing needs doing", the other "we don't know enough yet". Seeds the real
  // production shape — overlapping rolling + daily rows — and pins the honest
  // classification.
  it("an overlapping rolling row never inflates evidence past the gate (stable vs collecting)", async () => {
    const snapshots = new InMemorySnapshotStore();
    await snapshots.upsert([
      // The rolling 7-day row ingestion writes: 4 real leads. `snap` collapses
      // campaign rows to a day, so build this one explicitly to keep the overlap.
      {
        campaignId: "camp-1", grain: "campaign", metaObjectId: "camp", parentMetaId: null,
        creativeName: null, periodStart: CUR.start, periodEnd: CUR.end,
        spendAgorot: 3921, leads: 4, cplAgorot: 980,
        impressions: 0, linkClicks: 0, deliveryStatus: "active", raw: {},
      },
      // ...and the per-day rows for the same days — the SAME 4 leads, not 4 more.
      snap({ grain: "campaign", metaObjectId: "camp", periodStart: "2026-07-28", spendAgorot: 369, leads: 1, cplAgorot: 369 }),
      snap({ grain: "campaign", metaObjectId: "camp", periodStart: "2026-07-30", spendAgorot: 813, leads: 0, cplAgorot: null }),
      snap({ grain: "campaign", metaObjectId: "camp", periodStart: "2026-07-31", spendAgorot: 2739, leads: 3, cplAgorot: 913 }),
      // Two real, comparable creatives (AIC-86 fires ahead of the day/lead-
      // count gate this regression test is actually pinning) — irrelevant to
      // the double-counting bug this test proves is fixed.
      snap({ grain: "creative", metaObjectId: "cr_a", spendAgorot: 2000, leads: 2, cplAgorot: 1000 }),
      snap({ grain: "creative", metaObjectId: "cr_b", spendAgorot: 1900, leads: 2, cplAgorot: 950 }),
    ]);
    const recs = new InMemoryRecommendationStore();
    let reason: string | null = null;
    await runGenerationTick({
      campaigns: [CAMP], reader: okReader(3000), // ₪30/day: 7×3000 clears the budget gate
      snapshotStore: snapshots, recommendationStore: recs,
      recommendationService: new RecommendationService(recs), ref: REF,
      recordNoRecReason: async (_c, draft) => { reason = (draft.evidence as { reason: string }).reason; },
    });

    // 4 real leads < MIN_CAMPAIGN_LEADS (5) → honestly still collecting.
    // Before the fix this read `stable` off 8 phantom leads.
    expect(reason).toBe("collecting");
  });
});

// Real bug (2026-08-12): the dashboard showed a stale, manually-set budget
// number instead of what's actually live on Meta — the engine already reads
// it every tick but was discarding it. This is the fix: cache it for display.
describe("runGenerationTick — recordLiveBudget", () => {
  it("records the live-read budget on every successful tick", async () => {
    const snapshots = new InMemorySnapshotStore();
    await snapshots.upsert([snap({ grain: "campaign", metaObjectId: "camp", spendAgorot: 200, leads: 0, cplAgorot: null })]);
    const recs = new InMemoryRecommendationStore();
    let recorded: { campaignId: string; agorot: number } | null = null;
    await runGenerationTick({
      campaigns: [CAMP], reader: okReader(3000),
      snapshotStore: snapshots, recommendationStore: recs,
      recommendationService: new RecommendationService(recs), ref: REF,
      recordLiveBudget: async (c, agorot) => { recorded = { campaignId: c.id, agorot }; },
    });
    expect(recorded).toEqual({ campaignId: "camp-1", agorot: 3000 });
  });

  it("does NOT record when the budget read fails (nothing live to cache)", async () => {
    const snapshots = new InMemorySnapshotStore();
    const recs = new InMemoryRecommendationStore();
    let called = false;
    const badReader: MetaReader = { getCampaignState: async () => { throw new Error("meta down"); } };
    await runGenerationTick({
      campaigns: [CAMP], reader: badReader,
      snapshotStore: snapshots, recommendationStore: recs,
      recommendationService: new RecommendationService(recs), ref: REF,
      recordLiveBudget: async () => { called = true; },
    });
    expect(called).toBe(false);
  });

  it("a failure recording the live budget doesn't fail the tick", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeak(snapshots);
    const recs = new InMemoryRecommendationStore();
    const res = await runGenerationTick({
      campaigns: [CAMP], reader: okReader(),
      snapshotStore: snapshots, recommendationStore: recs,
      recommendationService: new RecommendationService(recs), ref: REF,
      recordLiveBudget: async () => { throw new Error("db down"); },
    });
    expect(res.evaluated).toBe(1);
    expect(res.created).toBe(1);
  });
});

// AIC-67 follow-up (real bug, 2026-08-12): the lead-quality watermark's
// "leads to date" must come from a single cached lifetime read, never a sum
// over insight_snapshots (those are overlapping rolling windows).
describe("runGenerationTick — leadsReader/recordLeadsToDate", () => {
  it("records the lifetime lead count on every successful tick", async () => {
    const snapshots = new InMemorySnapshotStore();
    await snapshots.upsert([snap({ grain: "campaign", metaObjectId: "camp", spendAgorot: 200, leads: 0, cplAgorot: null })]);
    const recs = new InMemoryRecommendationStore();
    let recorded: { campaignId: string; leadsToDate: number } | null = null;
    await runGenerationTick({
      campaigns: [CAMP], reader: okReader(3000),
      snapshotStore: snapshots, recommendationStore: recs,
      recommendationService: new RecommendationService(recs), ref: REF,
      leadsReader: { getLifetimeLeads: async () => 4 },
      recordLeadsToDate: async (c, leadsToDate) => { recorded = { campaignId: c.id, leadsToDate }; },
    });
    expect(recorded).toEqual({ campaignId: "camp-1", leadsToDate: 4 });
  });

  // AIC-87: leads_to_date is the SECOND independent site that calls
  // extractLeads (the first is ingestion) — a Pixel campaign's lead_event_types
  // must reach getLifetimeTotals too, or leads_to_date silently reads 0 for a
  // campaign whose real leads render correctly everywhere else.
  it("threads the campaign's lead_event_types to getLifetimeTotals", async () => {
    const snapshots = new InMemorySnapshotStore();
    const recs = new InMemoryRecommendationStore();
    const pixelCamp: GenCampaign = { ...CAMP, leadEventTypes: ["offsite_conversion.fb_pixel_complete_registration"] };
    let seenTypes: readonly string[] | undefined;
    await runGenerationTick({
      campaigns: [pixelCamp], reader: okReader(3000),
      snapshotStore: snapshots, recommendationStore: recs,
      recommendationService: new RecommendationService(recs), ref: REF,
      leadsReader: {
        getLifetimeLeads: async () => 0,
        getLifetimeTotals: async (_id, leadEventTypes) => {
          seenTypes = leadEventTypes;
          return { leads: 26, spendAgorot: 20506 };
        },
      },
      recordLeadsToDate: async () => {},
    });
    expect(seenTypes).toEqual(["offsite_conversion.fb_pixel_complete_registration"]);
  });

  it("a lifetime-leads read failure doesn't fail the tick", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeak(snapshots);
    const recs = new InMemoryRecommendationStore();
    const res = await runGenerationTick({
      campaigns: [CAMP], reader: okReader(),
      snapshotStore: snapshots, recommendationStore: recs,
      recommendationService: new RecommendationService(recs), ref: REF,
      leadsReader: { getLifetimeLeads: async () => { throw new Error("meta down"); } },
      recordLeadsToDate: async () => { throw new Error("should never be called"); },
    });
    expect(res.evaluated).toBe(1);
    expect(res.created).toBe(1);
  });
});

describe("runGenerationTick — flexible/Advantage+ creative exclusion (AIC-36), continued", () => {
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
