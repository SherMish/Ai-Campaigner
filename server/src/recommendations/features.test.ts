import { describe, it, expect } from "vitest";
import {
  campaignCpl,
  adCpl,
  spendWithoutLead,
  shareOfCampaignSpend,
  daysActive,
  deliveryDaysActive,
  bestPeerCpl,
  groupCreativesByAdSet,
  periodOverPeriodDeltaPct,
  leadQualityRate,
  type PeerLike,
} from "./features.js";
import type { DailyPoint } from "../meta/snapshot-store.js";
import type { CreativeStat } from "./rules.js";

describe("campaignCpl / adCpl (computeCpl wrappers)", () => {
  it("is null on zero leads — never 0 or Infinity (null-honesty)", () => {
    expect(campaignCpl(50000, 0)).toBeNull();
    expect(adCpl(50000, 0)).toBeNull();
  });

  it("divides spend by leads and rounds", () => {
    expect(campaignCpl(10000, 3)).toBe(3333);
  });

  it("is null when spend is zero and leads is zero (no data, not zero cost)", () => {
    expect(campaignCpl(0, 0)).toBeNull();
  });
});

describe("spendWithoutLead", () => {
  it("is true once spend clears the bar with zero leads", () => {
    expect(spendWithoutLead(15000, 0, 15000)).toBe(true);
  });

  it("is false below the spend bar, even with zero leads (too new to know)", () => {
    expect(spendWithoutLead(14999, 0, 15000)).toBe(false);
  });

  it("is false once there's at least one lead, no matter the spend", () => {
    expect(spendWithoutLead(50000, 1, 15000)).toBe(false);
  });
});

describe("shareOfCampaignSpend", () => {
  it("is null when the campaign spent nothing — not 0% (null-honesty)", () => {
    expect(shareOfCampaignSpend(5000, 0)).toBeNull();
  });

  it("computes the object's fraction of campaign spend", () => {
    expect(shareOfCampaignSpend(25000, 100000)).toBe(0.25);
  });

  it("a single sibling that IS the whole campaign spend reads as a 100% share", () => {
    expect(shareOfCampaignSpend(40000, 40000)).toBe(1);
  });
});

describe("daysActive / deliveryDaysActive", () => {
  const day = (date: string, spendAgorot: number, leads: number): DailyPoint => ({ date, spendAgorot, leads });

  it("counts zero days as zero — an empty series is not '7 days of nothing'", () => {
    expect(daysActive([])).toBe(0);
    expect(deliveryDaysActive([])).toBe(0);
  });

  it("counts a day active on leads alone, even with zero spend that day (e.g. an organic-attributed lead)", () => {
    expect(daysActive([day("2026-07-27", 0, 1)])).toBe(1);
  });

  it("a partial window (some days with no spend or leads at all) only counts the days with real data", () => {
    const daily = [
      day("2026-07-26", 1000, 1),
      day("2026-07-27", 0, 0), // no delivery, no lead — not active
      day("2026-07-28", 500, 0),
    ];
    expect(daysActive(daily)).toBe(2);
  });

  it("deliveryDaysActive requires spend specifically — a lead with no spend that day doesn't count as delivery", () => {
    const daily = [day("2026-07-26", 0, 1), day("2026-07-27", 1000, 0)];
    expect(deliveryDaysActive(daily)).toBe(1);
  });
});

describe("bestPeerCpl", () => {
  const peer = (spendAgorot: number, leads: number, cplAgorot: number | null): PeerLike => ({
    spendAgorot,
    leads,
    cplAgorot,
  });

  it("is null when nothing has a lead yet — no baseline to compare against", () => {
    expect(bestPeerCpl([peer(20000, 0, null), peer(20000, 0, null)], null)).toBeNull();
  });

  it("a single sibling with a lead sets the baseline by itself", () => {
    expect(bestPeerCpl([peer(20000, 3, 4000)], null)).toBe(4000);
  });

  it("picks the minimum CPL among performers (leads > 0, cplAgorot not null)", () => {
    const items = [peer(10000, 2, 5000), peer(10000, 5, 2000), peer(10000, 1, 9000)];
    expect(bestPeerCpl(items, null)).toBe(2000);
  });

  it("gate=null includes every item regardless of spend (the creative rule's ungated baseline)", () => {
    const items = [peer(1, 1, 100), peer(50000, 1, 9000)];
    expect(bestPeerCpl(items, null)).toBe(100);
  });

  it("a numeric gate excludes under-spend items from setting the baseline (the audience rule's gated baseline)", () => {
    const items = [peer(1, 1, 100), peer(50000, 1, 9000)];
    expect(bestPeerCpl(items, 30000)).toBe(9000);
  });

  it("zero-spend, zero-lead items never set the baseline", () => {
    expect(bestPeerCpl([peer(0, 0, null)], null)).toBeNull();
  });
});

describe("groupCreativesByAdSet", () => {
  const cr = (id: string, adSetId: string | null): CreativeStat => ({
    metaObjectId: id,
    adSetId,
    creativeName: null,
    spendAgorot: 0,
    leads: 0,
    cplAgorot: null,
    deliveryStatus: "active",
  });

  it("groups by adSetId, preserving insertion order (load-bearing: spend-desc from the store)", () => {
    const byAdSet = groupCreativesByAdSet([cr("a", "as_1"), cr("b", "as_2"), cr("c", "as_1")]);
    expect([...byAdSet.keys()]).toEqual(["as_1", "as_2"]);
    expect(byAdSet.get("as_1")!.map((c) => c.metaObjectId)).toEqual(["a", "c"]);
  });

  it("creatives with no ad set fall into one '__none__' group (single-ad-set campaigns)", () => {
    const byAdSet = groupCreativesByAdSet([cr("a", null), cr("b", null)]);
    expect([...byAdSet.keys()]).toEqual(["__none__"]);
    expect(byAdSet.get("__none__")).toHaveLength(2);
  });

  it("drops creatives under a flexible/Advantage+ ad set entirely (AIC-36) — no group is created for it", () => {
    const byAdSet = groupCreativesByAdSet([cr("a", "as_flex"), cr("b", "as_real")], new Set(["as_flex"]));
    expect([...byAdSet.keys()]).toEqual(["as_real"]);
  });

  it("with no flexible set passed at all, nothing is dropped", () => {
    const byAdSet = groupCreativesByAdSet([cr("a", "as_1")]);
    expect(byAdSet.get("as_1")).toHaveLength(1);
  });
});

describe("periodOverPeriodDeltaPct (re-export of readout.ts's deltaPct)", () => {
  it("is null when the previous period was zero — no baseline to compare against", () => {
    expect(periodOverPeriodDeltaPct(500, 0)).toBeNull();
  });

  it("rounds to a whole percent", () => {
    expect(periodOverPeriodDeltaPct(125, 100)).toBe(25);
  });
});

describe("leadQualityRate", () => {
  it("is null with zero reviewed leads — 'no signal yet', not a 0% rate", () => {
    expect(leadQualityRate(0, 0)).toBeNull();
  });

  it("computes relevant / reviewed", () => {
    expect(leadQualityRate(10, 7)).toBe(0.7);
  });
});
