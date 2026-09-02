// Unit coverage for InMemorySnapshotStore's AIC-95 range methods — the real
// DB behaviour is proven in snapshot-store.integration.test.ts; this pins the
// in-memory twin so it can't silently drift from it (the same class of bug
// AIC-70/75 both hit: one implementation fixed, the other one missed).
import { describe, it, expect } from "vitest";
import { InMemorySnapshotStore } from "./snapshot-store.js";
import type { SnapshotUpsert } from "./insights.js";

function snap(over: Partial<SnapshotUpsert> = {}): SnapshotUpsert {
  return {
    campaignId: "camp-1",
    grain: "creative",
    metaObjectId: "cr_1",
    parentMetaId: "as_1",
    creativeName: "Ad One",
    periodStart: "2026-08-10",
    periodEnd: "2026-08-10",
    spendAgorot: 1000,
    leads: 1,
    cplAgorot: 1000,
    impressions: 100,
    linkClicks: 5,
    deliveryStatus: "active",
    raw: {},
    ...over,
  };
}

describe("InMemorySnapshotStore — creativeRangeStats/adsetRangeStats (AIC-95)", () => {
  it("sums disjoint daily rows per object, never the overlapping rolling row", async () => {
    const store = new InMemorySnapshotStore();
    await store.upsert([
      // rolling row — must be excluded
      snap({ periodStart: "2026-08-06", periodEnd: "2026-08-12", spendAgorot: 99999, leads: 99 }),
      snap({ periodStart: "2026-08-10", periodEnd: "2026-08-10", spendAgorot: 1000, leads: 1 }),
      snap({ periodStart: "2026-08-11", periodEnd: "2026-08-11", spendAgorot: 2000, leads: 2 }),
      snap({ metaObjectId: "cr_2", creativeName: "Ad Two", periodStart: "2026-08-11", periodEnd: "2026-08-11", spendAgorot: 500, leads: 0 }),
      // outside the window
      snap({ periodStart: "2026-07-01", periodEnd: "2026-07-01", spendAgorot: 777, leads: 7 }),
    ]);

    const rows = await store.creativeRangeStats("camp-1", "2026-08-08", "2026-08-14");
    expect(rows).toHaveLength(2);
    const cr1 = rows.find((r) => r.metaObjectId === "cr_1")!;
    expect(cr1).toMatchObject({ spendAgorot: 3000, leads: 3, creativeName: "Ad One", adSetId: "as_1" });
    expect(cr1.cplAgorot).toBe(1000); // 3000/3
  });

  it("adsetRangeStats sums per ad set the same way", async () => {
    const store = new InMemorySnapshotStore();
    await store.upsert([
      snap({ grain: "adset", metaObjectId: "as_1", parentMetaId: null, creativeName: null, periodStart: "2026-08-10", periodEnd: "2026-08-10", spendAgorot: 1500, leads: 1, impressions: 400, linkClicks: 12 }),
      snap({ grain: "adset", metaObjectId: "as_1", parentMetaId: null, creativeName: null, periodStart: "2026-08-11", periodEnd: "2026-08-11", spendAgorot: 2500, leads: 2, impressions: 900, linkClicks: 25 }),
    ]);
    const rows = await store.adsetRangeStats("camp-1", "2026-08-08", "2026-08-14");
    // AIC-180: impressions and clicks SUM across days exactly as spend and
    // leads do — they are counts of events, not a status to take the latest of.
    expect(rows).toEqual([{ adSetId: "as_1", spendAgorot: 4000, leads: 3, cplAgorot: 1333, impressions: 1300, linkClicks: 37, deliveryStatus: "active" }]);
  });

  it("returns nothing for a window with no rows, even if the object has data elsewhere", async () => {
    const store = new InMemorySnapshotStore();
    await store.upsert([snap({ periodStart: "2026-08-10", periodEnd: "2026-08-10" })]);
    expect(await store.creativeRangeStats("camp-1", "2026-01-01", "2026-01-07")).toEqual([]);
  });
});

describe("InMemorySnapshotStore — mostRecentObjectDataDate (AIC-95)", () => {
  it("is null when the campaign has no adset/creative daily rows", async () => {
    const store = new InMemorySnapshotStore();
    expect(await store.mostRecentObjectDataDate("camp-1")).toBeNull();
  });

  it("ignores campaign grain and rolling rows, returns the latest real daily row", async () => {
    const store = new InMemorySnapshotStore();
    await store.upsert([
      snap({ grain: "campaign", metaObjectId: "meta_camp_1", periodStart: "2026-08-14", periodEnd: "2026-08-14" }),
      snap({ periodStart: "2026-08-06", periodEnd: "2026-08-12" }), // rolling — ignored
      snap({ grain: "adset", metaObjectId: "as_1", parentMetaId: null, creativeName: null, periodStart: "2026-08-10", periodEnd: "2026-08-10" }),
      snap({ periodStart: "2026-08-12", periodEnd: "2026-08-12" }),
    ]);
    expect(await store.mostRecentObjectDataDate("camp-1")).toBe("2026-08-12");
  });
});
