import { describe, it, expect } from "vitest";
import { InMemorySnapshotStore } from "../meta/snapshot-store.js";
import { InMemoryRecommendationStore } from "./recommendation-store.js";
import { evaluateAndPersist, buildCampaignEvidence } from "./rule-evaluator.js";
import type { SnapshotUpsert } from "../meta/insights.js";

const CUR = { start: "2026-07-26", end: "2026-08-01" };
const PREV = { start: "2026-07-19", end: "2026-07-25" };

function snap(o: Partial<SnapshotUpsert> & Pick<SnapshotUpsert, "grain">): SnapshotUpsert {
  const r: SnapshotUpsert = {
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

async function seedWeakCreative(store: InMemorySnapshotStore) {
  await store.upsert([
    ...campaignDailyRows(68000, 20),
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

  it("a per-account threshold override (AIC-77a) reaches the rules end-to-end", async () => {
    const snapshots = new InMemorySnapshotStore();
    await seedWeakCreative(snapshots);
    const recs = new InMemoryRecommendationStore();

    // Same evidence that fires pause_creative by default (above) — an absurdly
    // strict override on this campaign alone must suppress it, proving
    // evaluateAndPersist actually resolves + passes campaign.thresholdOverrides
    // through to evaluateCampaign, not just that resolveThresholds works in isolation.
    const result = await evaluateAndPersist({
      snapshotStore: snapshots,
      recommendationStore: recs,
      campaign: { id: "camp-1", currentBudgetAgorot: 7000, thresholdOverrides: { MIN_CAMPAIGN_LEADS: 999 } },
      current: CUR,
      previous: PREV,
    });

    expect(result.draft.type).toBe("no_action");
    expect(result.draft.evidence.reason).toBe("collecting");
    expect(result.created).toBe(false);
  });

  it("returns no_action without storing a row when evidence is thin", async () => {
    const snapshots = new InMemorySnapshotStore();
    await snapshots.upsert([
      snap({ grain: "campaign", metaObjectId: "camp", spendAgorot: 4000, leads: 1, cplAgorot: 4000 }),
      // Two real, comparable creatives (AIC-86 fires independent of this gate,
      // so it would otherwise fire here instead of the day/lead-count path
      // this test is actually about) — thinness under test is days/leads.
      snap({ grain: "creative", metaObjectId: "cr_a", spendAgorot: 2000, leads: 1, cplAgorot: 2000 }),
      snap({ grain: "creative", metaObjectId: "cr_b", spendAgorot: 2000, leads: 0, cplAgorot: null }),
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

// AIC-64: the excluded-ad-set signal (AIC-39) must reach evaluateCampaign's
// reason classification, not just silently thin the evidence.
describe("buildCampaignEvidence — deliveryProblemAdSetIds (AIC-64)", () => {
  it("carries the excluded ad set ids through when some are excluded", async () => {
    const snapshots = new InMemorySnapshotStore();
    await snapshots.upsert([snap({ grain: "campaign", metaObjectId: "camp" })]);
    const ev = await buildCampaignEvidence(
      snapshots, { id: "camp-1", currentBudgetAgorot: 7000 }, CUR, PREV,
      new Set(["as_bad"]),
    );
    expect(ev.deliveryProblemAdSetIds).toEqual(["as_bad"]);
  });

  it("is undefined when nothing was excluded", async () => {
    const snapshots = new InMemorySnapshotStore();
    await snapshots.upsert([snap({ grain: "campaign", metaObjectId: "camp" })]);
    const ev = await buildCampaignEvidence(snapshots, { id: "camp-1", currentBudgetAgorot: 7000 }, CUR, PREV);
    expect(ev.deliveryProblemAdSetIds).toBeUndefined();
  });
});

// REGRESSION (real, found 2026-08-14 against production GelNails data). The
// same overlapping-window class as the campaignTotals bug (AIC-75), one level
// up: a rolling creative/adset row plus the "today" extra-period ingestion's
// leftover single-day rows for the SAME object both matched creativeStats/
// adsetStats' containment window, with no dedup — one real ad read as three.
// That's not just a display bug: buildCampaignEvidence feeds ev.creatives/
// ev.adsets straight into the rules (pauseWeakCreative's peer comparison,
// AIC-85's comparableCreatives count), so a phantom "peer" could drive a
// wrong recommendation. Fixed at snapshot-store.ts (both PgSnapshotStore and
// InMemorySnapshotStore) — this proves the fix reaches the engine's actual
// evidence, not just the store method in isolation.
describe("buildCampaignEvidence — one real object never becomes three (AIC-85/86 regression)", () => {
  it("a rolling creative row plus leftover single-day rows for the same object collapse to one entry", async () => {
    const snapshots = new InMemorySnapshotStore();
    await snapshots.upsert([
      snap({ grain: "campaign", metaObjectId: "camp" }),
      snap({ grain: "creative", metaObjectId: "cr_only", parentMetaId: "as_1", periodStart: "2026-07-26", periodEnd: "2026-08-01", spendAgorot: 4394, leads: 5, cplAgorot: 879 }),
      snap({ grain: "creative", metaObjectId: "cr_only", parentMetaId: "as_1", periodStart: "2026-07-30", periodEnd: "2026-07-30", spendAgorot: 2739, leads: 3, cplAgorot: 913 }),
      snap({ grain: "creative", metaObjectId: "cr_only", parentMetaId: "as_1", periodStart: "2026-07-31", periodEnd: "2026-07-31", spendAgorot: 706, leads: 1, cplAgorot: 706 }),
    ]);
    const ev = await buildCampaignEvidence(snapshots, { id: "camp-1", currentBudgetAgorot: 7000 }, CUR, PREV);
    expect(ev.creatives).toHaveLength(1);
    expect(ev.creatives[0]).toMatchObject({ metaObjectId: "cr_only", spendAgorot: 4394, leads: 5 });
  });
});
