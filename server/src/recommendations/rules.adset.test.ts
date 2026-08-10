import { describe, it, expect } from "vitest";
import {
  evaluateCampaign,
  __rulesForTest,
  type CampaignEvidence,
  type CreativeStat,
  type AdsetStat,
} from "./rules.js";

function cr(id: string, adSetId: string, spend: number, leads: number, cpl: number | null): CreativeStat {
  return { metaObjectId: id, adSetId, creativeName: id, spendAgorot: spend, leads, cplAgorot: cpl, deliveryStatus: "active" };
}
function ad(adSetId: string, spend: number, leads: number, cpl: number | null): AdsetStat {
  return { adSetId, spendAgorot: spend, leads, cplAgorot: cpl, deliveryStatus: "active" };
}
function base(over: Partial<CampaignEvidence> = {}): CampaignEvidence {
  return {
    campaignId: "camp-1",
    current: { spendAgorot: 80000, leads: 25, cplAgorot: 3200, days: 7 },
    previous: { spendAgorot: 80000, leads: 25, cplAgorot: 3200, days: 7 },
    creatives: [],
    currentBudgetAgorot: 7000,
    deliveryDays: 7,
    ...over,
  };
}

describe("pause_weak_creative — compared WITHIN an ad set (AIC-36)", () => {
  it("does NOT flag a creative that only looks weak across audiences", () => {
    // Ad set A is cheap; ad set B is uniformly pricier. Campaign-wide, B's
    // creatives would look 'weak' vs A's best — but within B they're peers.
    const d = evaluateCampaign(base({
      creatives: [
        cr("cr_a1", "A", 20000, 10, 2000),
        cr("cr_a2", "A", 20000, 9, 2222),
        cr("cr_b1", "B", 20000, 3, 6667),
        cr("cr_b2", "B", 20000, 3, 6667),
      ],
    }));
    expect(d.type).not.toBe("pause_creative");
  });

  it("fires on a creative genuinely weak vs its OWN ad-set peers", () => {
    const d = evaluateCampaign(base({
      creatives: [
        cr("cr_a1", "A", 20000, 10, 2000),
        cr("cr_a2", "A", 20000, 9, 2222),
        cr("cr_b1", "B", 20000, 8, 2500),
        cr("cr_b2", "B", 20000, 1, 20000), // weak within B (≥2× the 2500 peer)
      ],
    }));
    expect(d.type).toBe("pause_creative");
    expect(d.targetMetaId).toBe("cr_b2");
    expect(d.evidence.adSetId).toBe("B");
  });
});

describe("pause_weak_creative — skips ad sets running Dynamic/Advantage+ creative (AIC-36)", () => {
  it("does NOT fire for a weak-looking creative inside a flexible-creative ad set", () => {
    const d = evaluateCampaign(base({
      creatives: [
        cr("cr_f1", "F", 20000, 10, 2000),
        cr("cr_f2", "F", 20000, 1, 20000), // would be flagged weak if F weren't flexible
      ],
      flexibleCreativeAdSetIds: new Set(["F"]),
    }));
    expect(d.type).not.toBe("pause_creative");
  });

  it("still fires normally for a genuinely weak creative in a NON-flexible ad set (the flag doesn't blanket-disable the rule)", () => {
    const d = evaluateCampaign(base({
      creatives: [
        cr("cr_f1", "F", 20000, 10, 2000),
        cr("cr_f2", "F", 20000, 9, 2222), // clean peers, nothing weak in F
        cr("cr_n1", "N", 20000, 10, 2000),
        cr("cr_n2", "N", 20000, 1, 20000), // weak within N
      ],
      flexibleCreativeAdSetIds: new Set(["F"]),
    }));
    expect(d.type).toBe("pause_creative");
    expect(d.targetMetaId).toBe("cr_n2");
    expect(d.evidence.adSetId).toBe("N");
  });

  it("with no flexibleCreativeAdSetIds set, behaves exactly as before (backward compatible)", () => {
    const d = evaluateCampaign(base({
      creatives: [
        cr("cr_f1", "F", 20000, 10, 2000),
        cr("cr_f2", "F", 20000, 1, 20000),
      ],
    }));
    expect(d.type).toBe("pause_creative");
    expect(d.targetMetaId).toBe("cr_f2");
  });
});

describe("pause_underperforming_audience (AIC-36; live since AIC-39)", () => {
  const rule = __rulesForTest.pauseUnderperformingAudience;

  it("fires when one audience's CPL is ≥2× the best, targeting the worse ad set", () => {
    const d = rule(base({ adsets: [ad("A", 40000, 20, 2000), ad("B", 40000, 5, 8000)] }));
    expect(d).not.toBeNull();
    expect(d!.type).toBe("pause_adset");
    expect(d!.targetMetaId).toBe("B");
    expect(d!.maxSpendImpactAgorot).toBe(0); // CBO shifts budget; no new spend
    expect(d!.evidence.bestAdSetId).toBe("A");
  });

  it("does NOT fire when audiences perform equally", () => {
    expect(rule(base({ adsets: [ad("A", 40000, 20, 2000), ad("B", 40000, 18, 2100)] }))).toBeNull();
  });

  it("does NOT fire with only one audience that has real spend", () => {
    expect(rule(base({ adsets: [ad("A", 40000, 20, 2000), ad("B", 100, 0, null)] }))).toBeNull();
  });

  it("is LIVE: evaluateCampaign emits pause_adset for a clear A≫B split", () => {
    const d = evaluateCampaign(base({ adsets: [ad("A", 40000, 20, 2000), ad("B", 40000, 5, 8000)] }));
    expect(d.type).toBe("pause_adset");
    expect(d.targetMetaId).toBe("B");
  });
});
