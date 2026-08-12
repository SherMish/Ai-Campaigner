import { describe, it, expect } from "vitest";
import {
  evaluateCampaign,
  RULE_THRESHOLDS as T,
  type CampaignEvidence,
  type CreativeStat,
} from "./rules.js";

// A healthy, stable baseline that fires NO rule — each test perturbs one thing.
function baseEvidence(over: Partial<CampaignEvidence> = {}): CampaignEvidence {
  return {
    campaignId: "camp-1",
    current: { spendAgorot: 70000, leads: 20, cplAgorot: 3500, days: 7 },
    previous: { spendAgorot: 70000, leads: 20, cplAgorot: 3500, days: 7 },
    creatives: [
      cr("cr_a", 25000, 8, 3125),
      cr("cr_b", 25000, 7, 3571),
      cr("cr_c", 20000, 5, 4000),
    ],
    currentBudgetAgorot: 7000,
    deliveryDays: 7,
    ...over,
  };
}
function cr(id: string, spend: number, leads: number, cpl: number | null): CreativeStat {
  return { metaObjectId: id, creativeName: id, spendAgorot: spend, leads, cplAgorot: cpl, deliveryStatus: "active" };
}

describe("minimum-evidence gate (doing nothing is valid)", () => {
  it("returns no_action/collecting below the day gate", () => {
    const d = evaluateCampaign(baseEvidence({ current: { spendAgorot: 20000, leads: 20, cplAgorot: 1000, days: 2 } }));
    expect(d.type).toBe("no_action");
    expect(d.evidence.reason).toBe("collecting");
  });

  it("returns no_action/collecting below the campaign-leads gate", () => {
    const d = evaluateCampaign(baseEvidence({ current: { spendAgorot: 70000, leads: T.MIN_CAMPAIGN_LEADS - 1, cplAgorot: 3500, days: 7 } }));
    expect(d.evidence.reason).toBe("collecting");
  });

  it("returns no_action/collecting below the delivery-days gate (learning phase)", () => {
    const d = evaluateCampaign(baseEvidence({ deliveryDays: 2 }));
    expect(d.evidence.reason).toBe("collecting");
  });

  it("healthy campaign yields no_action, not a manufactured change (exact reason covered below, AIC-64)", () => {
    const d = evaluateCampaign(baseEvidence());
    expect(d.type).toBe("no_action");
  });
});

describe("no_action reason classification (AIC-64)", () => {
  it("budget_below_threshold when 7×daily budget can't reach the smallest rule threshold, even with thin data", () => {
    // GelNails-shaped: ₪10/day budget → 7×1000 = 7000 agorot, well under
    // MIN_CREATIVE_SPEND_AGOROT (15000) — no amount of extra time fixes this.
    const d = evaluateCampaign(
      baseEvidence({ currentBudgetAgorot: 1000, current: { spendAgorot: 700, leads: 1, cplAgorot: 700, days: 2 } }),
    );
    expect(d.evidence.reason).toBe("budget_below_threshold");
    expect((d.evidence.detail as Record<string, unknown>).maxWindowSpendAgorot).toBe(7000);
  });

  it("collecting (not budget_below_threshold) when data is thin but the budget could reach the threshold in time", () => {
    const d = evaluateCampaign(
      baseEvidence({ currentBudgetAgorot: 7000, current: { spendAgorot: 2000, leads: 1, cplAgorot: 2000, days: 1 } }),
    );
    expect(d.evidence.reason).toBe("collecting");
  });

  it("delivery_blocked when an ad set was excluded from evidence, even if data would otherwise pass the gate", () => {
    const d = evaluateCampaign(baseEvidence({ deliveryProblemAdSetIds: ["as_broken"] }));
    expect(d.evidence.reason).toBe("delivery_blocked");
    expect((d.evidence.detail as Record<string, unknown>).problemAdSetIds).toEqual(["as_broken"]);
  });

  it("delivery_blocked outranks budget_below_threshold when both are true", () => {
    const d = evaluateCampaign(
      baseEvidence({
        currentBudgetAgorot: 1000,
        current: { spendAgorot: 700, leads: 1, cplAgorot: 700, days: 2 },
        deliveryProblemAdSetIds: ["as_broken"],
      }),
    );
    expect(d.evidence.reason).toBe("delivery_blocked");
  });

  it("single_ad_set when the gate passes, no rule fires, and there's only one audience with data", () => {
    const d = evaluateCampaign(baseEvidence({ adsets: [{ adSetId: "as_1", spendAgorot: 70000, leads: 20, cplAgorot: 3500, deliveryStatus: "active" }] }));
    expect(d.evidence.reason).toBe("single_ad_set");
  });

  it("stable (not single_ad_set) when ≥2 audiences have data and nothing fires", () => {
    const d = evaluateCampaign(
      baseEvidence({
        adsets: [
          { adSetId: "as_1", spendAgorot: 70000, leads: 20, cplAgorot: 3500, deliveryStatus: "active" },
          { adSetId: "as_2", spendAgorot: 70000, leads: 20, cplAgorot: 3500, deliveryStatus: "active" },
        ],
      }),
    );
    expect(d.evidence.reason).toBe("stable");
  });
});

describe("pause_weak_creative", () => {
  it("fires on a creative that spent a lot for far fewer leads than peers", () => {
    const d = evaluateCampaign(
      baseEvidence({
        creatives: [cr("cr_a", 25000, 10, 2500), cr("cr_b", 24000, 9, 2667), cr("cr_weak", 18000, 1, 18000)],
      }),
    );
    expect(d.type).toBe("pause_creative");
    expect(d.targetMetaId).toBe("cr_weak");
    expect(d.maxSpendImpactAgorot).toBe(0);
  });

  it("fires on a creative that spent past threshold with ZERO leads", () => {
    const d = evaluateCampaign(
      baseEvidence({ creatives: [cr("cr_a", 25000, 10, 2500), cr("cr_b", 24000, 9, 2667), cr("cr_dead", 16000, 0, null)] }),
    );
    expect(d.type).toBe("pause_creative");
    expect(d.targetMetaId).toBe("cr_dead");
  });

  it("does NOT fire when the weak creative hasn't spent enough to judge", () => {
    const d = evaluateCampaign(
      baseEvidence({
        creatives: [cr("cr_a", 25000, 10, 2500), cr("cr_b", 24000, 9, 2667), cr("cr_new", T.MIN_CREATIVE_SPEND_AGOROT - 5000, 0, null)],
      }),
    );
    expect(d.type).not.toBe("pause_creative");
  });

  it("does NOT fire with only one creative (no peers to compare)", () => {
    const d = evaluateCampaign(baseEvidence({ creatives: [cr("cr_solo", 40000, 1, 40000)] }));
    expect(d.type).not.toBe("pause_creative");
  });
});

describe("replace_creative (decay vs its own past)", () => {
  it("fires when a creative's CPL decayed ≥ threshold vs its previous window (but isn't weak-vs-peers)", () => {
    // cr_decay current CPL 4000 is worse than its own past (2500 → 1.6×) but NOT
    // ≥2× the best peer (3125), so pause doesn't pre-empt replace.
    const d = evaluateCampaign(
      baseEvidence({
        creatives: [cr("cr_a", 25000, 8, 3125), cr("cr_b", 25000, 7, 3571), cr("cr_decay", 20000, 5, 4000)],
        creativesPrevious: [cr("cr_decay", 20000, 8, 2500)],
      }),
    );
    expect(d.type).toBe("replace_creative");
    expect(d.targetMetaId).toBe("cr_decay");
  });

  it("does NOT fire without previous-window data", () => {
    const d = evaluateCampaign(
      baseEvidence({ creatives: [cr("cr_a", 25000, 8, 3125), cr("cr_b", 25000, 7, 3571), cr("cr_x", 20000, 2, 10000)] }),
    );
    expect(d.type).not.toBe("replace_creative");
  });
});

describe("decrease_budget", () => {
  it("fires when CPL rose materially window-over-window", () => {
    const d = evaluateCampaign(
      baseEvidence({
        current: { spendAgorot: 70000, leads: 14, cplAgorot: 5000, days: 7 },
        previous: { spendAgorot: 70000, leads: 20, cplAgorot: 3500, days: 7 },
        creatives: [cr("cr_a", 35000, 7, 5000), cr("cr_b", 35000, 7, 5000)],
      }),
    );
    expect(d.type).toBe("decrease_budget");
    expect(d.proposedBudgetAgorot).toBe(Math.round(7000 * (1 - T.BUDGET_DECREASE_STEP)));
    expect(d.maxSpendImpactAgorot).toBeLessThan(0);
  });

  it("does NOT fire on a small CPL wobble under the threshold", () => {
    const d = evaluateCampaign(
      baseEvidence({
        current: { spendAgorot: 70000, leads: 19, cplAgorot: 3700, days: 7 },
        previous: { spendAgorot: 70000, leads: 20, cplAgorot: 3500, days: 7 },
      }),
    );
    expect(d.type).not.toBe("decrease_budget");
  });
});

describe("increase_budget", () => {
  it("fires when CPL is stable/improving and leads are growing", () => {
    const d = evaluateCampaign(
      baseEvidence({
        current: { spendAgorot: 70000, leads: 24, cplAgorot: 2900, days: 7 },
        previous: { spendAgorot: 70000, leads: 20, cplAgorot: 3500, days: 7 },
        creatives: [cr("cr_a", 35000, 12, 2916), cr("cr_b", 35000, 12, 2916)],
      }),
    );
    expect(d.type).toBe("increase_budget");
    expect(d.proposedBudgetAgorot).toBe(Math.round(7000 * (1 + T.BUDGET_INCREASE_STEP)));
    expect(d.maxSpendImpactAgorot).toBeGreaterThan(0);
  });

  it("does NOT fire when CPL is worsening", () => {
    const d = evaluateCampaign(
      baseEvidence({
        current: { spendAgorot: 70000, leads: 18, cplAgorot: 3900, days: 7 },
        previous: { spendAgorot: 70000, leads: 20, cplAgorot: 3500, days: 7 },
      }),
    );
    expect(["increase_budget"]).not.toContain(d.type);
  });
});
