import { describe, it, expect } from "vitest";
import {
  evaluateCampaign,
  resolveThresholds,
  ruleClassOf,
  resolveCooldownClasses,
  comparableCreatives,
  comparableAdsets,
  __rulesForTest,
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

// AIC-85/86: "comparable" is relative to campaign spend (shareOfCampaignSpend),
// not raw presence — the real bug this fixes: a dormant object still counts
// toward `ev.adsets.length`/`ev.creatives.length` today, so it silently
// passes the old `adSetCount < 2` check and the account falls through to the
// dishonest "stable" catch-all instead of reporting it can't compare anything.
describe("comparableAdsets / comparableCreatives (AIC-85/86)", () => {
  it("GelNails-shaped: a real ad set + a dormant one (₪2.35 of ₪46.29 ≈ 5%) — the dormant one must NOT count as comparable", () => {
    const ev = baseEvidence({
      current: { spendAgorot: 4629, leads: 5, cplAgorot: 926, days: 7 },
      adsets: [
        { adSetId: "as_real", spendAgorot: 4394, leads: 5, cplAgorot: 879, deliveryStatus: "active" },
        { adSetId: "as_dormant", spendAgorot: 235, leads: 0, cplAgorot: null, deliveryStatus: "active" },
      ],
    });
    const c = comparableAdsets(ev, T);
    expect(c.comparableCount).toBe(1); // NOT 2 — the old adSetCount-based check would say 2
    expect(c.comparableIds).toEqual(["as_real"]);
    expect(c.dormantIds).toEqual(["as_dormant"]);
  });

  it("two real, roughly-split ad sets are both comparable", () => {
    const ev = baseEvidence({
      current: { spendAgorot: 70000, leads: 20, cplAgorot: 3500, days: 7 },
      adsets: [
        { adSetId: "as_1", spendAgorot: 35000, leads: 10, cplAgorot: 3500, deliveryStatus: "active" },
        { adSetId: "as_2", spendAgorot: 35000, leads: 10, cplAgorot: 3500, deliveryStatus: "active" },
      ],
    });
    expect(comparableAdsets(ev, T).comparableCount).toBe(2);
  });

  it("no adsets at all → comparableCount 0, not a crash", () => {
    const ev = baseEvidence({ adsets: undefined });
    expect(comparableAdsets(ev, T).comparableCount).toBe(0);
  });

  it("zero campaign spend → nothing is comparable (null share, not a divide-by-zero)", () => {
    const ev = baseEvidence({
      current: { spendAgorot: 0, leads: 0, cplAgorot: null, days: 3 },
      adsets: [{ adSetId: "as_1", spendAgorot: 0, leads: 0, cplAgorot: null, deliveryStatus: "active" }],
    });
    expect(comparableAdsets(ev, T).comparableCount).toBe(0);
  });

  it("comparableCreatives: GelNails-shaped single real creative — comparableCount 1, not 3", () => {
    const ev = baseEvidence({
      current: { spendAgorot: 4629, leads: 5, cplAgorot: 926, days: 7 },
      creatives: [cr("cr_only", 4394, 5, 879)],
    });
    expect(comparableCreatives(ev, T).comparableCount).toBe(1);
  });

  it("withEvidenceCount separately tracks the absolute ₪150/₪300 gate — comparable but still thin", () => {
    // Two real (non-dormant, 50/50 split) creatives, both under MIN_CREATIVE_SPEND_AGOROT.
    const ev = baseEvidence({
      current: { spendAgorot: 10000, leads: 2, cplAgorot: 5000, days: 3 },
      creatives: [cr("cr_a", 5000, 1, 5000), cr("cr_b", 5000, 1, 5000)],
    });
    const c = comparableCreatives(ev, T);
    expect(c.comparableCount).toBe(2); // both real, 50/50 split
    expect(c.withEvidenceCount).toBe(0); // neither cleared ₪150 yet
  });
});

describe("add_creatives_for_comparison (AIC-86)", () => {
  it("fires on day one — zero leads, zero days, no evidence gate at all", () => {
    const ev = baseEvidence({
      current: { spendAgorot: 0, leads: 0, cplAgorot: null, days: 0 },
      deliveryDays: 0,
      creatives: [],
      // AIC-117: this used to omit the live count, which made the test assert
      // that the rule fires knowing NOTHING about how many ads exist — the
      // blind spot that let it tell a two-ad customer they had one. Production
      // always has this number on day one (delivery-health runs every tick), so
      // the fixture now models that rather than the degraded case. The point of
      // the test is unchanged: zero leads and zero days do not hold it back.
      liveCreativeCount: 1,
    });
    const d = evaluateCampaign(ev);
    expect(d.type).toBe("add_creatives_for_comparison");
  });

  // The degraded case, split out from the above because it is a different
  // claim: when delivery-health is unavailable (a Meta read failure — observed
  // live as rate-limit code 17) and nothing has data yet, the rule knows
  // nothing about the ad count and must stay silent rather than guess. An
  // earlier version of this fix treated the missing count as zero and fired.
  it("stays silent when the live count is unavailable and nothing has data yet", () => {
    const ev = baseEvidence({
      current: { spendAgorot: 0, leads: 0, cplAgorot: null, days: 0 },
      deliveryDays: 0,
      creatives: [],
    });
    expect(evaluateCampaign(ev).type).not.toBe("add_creatives_for_comparison");
  });

  // ...but a single creative WITH data is still positive evidence of one ad,
  // so the original evidence-based case survives a missing live count.
  it("still fires with no live count when exactly one creative has data", () => {
    const ev = baseEvidence({
      current: { spendAgorot: 4629, leads: 5, cplAgorot: 926, days: 7 },
      creatives: [cr("cr_only", 4394, 5, 879)],
    });
    expect(evaluateCampaign(ev).type).toBe("add_creatives_for_comparison");
  });

  it("does NOT fire once 2 real (non-dormant) creatives exist", () => {
    const ev = baseEvidence(); // default 3 creatives, all comparable
    const d = evaluateCampaign(ev);
    expect(d.type).not.toBe("add_creatives_for_comparison");
  });

  // AIC-117, found live 2026-08-23. A real customer with TWO ads running was
  // told "כרגע רצה מודעה אחת בלבד" and advised to add 2–3 more.
  //
  // The rule counts COMPARABLE creatives — ones with enough measured data to
  // judge against each other. On a campaign built hours earlier that is 0, and
  // 0 < 2, so the rule fired. Its own comment argues it may skip the evidence
  // gates because "'there is only one creative' is a COUNT, and no amount of
  // additional data makes a count more true" — correct, but the code was
  // counting creatives WITH DATA, which is not that count at all.
  //
  // `deliveringAdCount` is the honest number (delivery-health computes it in
  // the same tick, from real ad/ad-set status) and it already said 2. The rule
  // simply was never given it.
  it("does NOT fire when the ads exist but have no data yet — the count is of ADS, not of data", () => {
    const ev = baseEvidence({
      current: { spendAgorot: 0, leads: 0, cplAgorot: null, days: 0 },
      deliveryDays: 0,
      creatives: [], // nothing measured yet — Meta hasn't reported
      liveCreativeCount: 2, // ...but two ads are genuinely running
    });
    expect(evaluateCampaign(ev).type).not.toBe("add_creatives_for_comparison");
  });

  it("still fires on day one when only ONE ad actually exists", () => {
    const ev = baseEvidence({
      current: { spendAgorot: 0, leads: 0, cplAgorot: null, days: 0 },
      deliveryDays: 0,
      creatives: [],
      liveCreativeCount: 1,
    });
    expect(evaluateCampaign(ev).type).toBe("add_creatives_for_comparison");
  });

  it("names the flexible-ad case explicitly (AIC-36) instead of the generic phrasing", () => {
    const ev = baseEvidence({
      current: { spendAgorot: 4629, leads: 5, cplAgorot: 926, days: 7 },
      creatives: [cr("cr_only", 4394, 5, 879)],
      flexibleCreativeAdSetIds: new Set(["as_flex"]),
    });
    ev.creatives[0].adSetId = "as_flex";
    const d = evaluateCampaign(ev);
    expect(d.type).toBe("add_creatives_for_comparison");
    expect(d.evidence.isFlexibleAd).toBe(true);
  });

  it("does not name flexible-ad when the sole comparable creative is in a normal ad set", () => {
    const ev = baseEvidence({
      current: { spendAgorot: 4629, leads: 5, cplAgorot: 926, days: 7 },
      creatives: [{ ...cr("cr_only", 4394, 5, 879), adSetId: "as_normal" }],
      flexibleCreativeAdSetIds: new Set(["as_other_flex"]),
    });
    const d = evaluateCampaign(ev);
    expect(d.evidence.isFlexibleAd).toBe(false);
  });

  it("is suppressed when a delivery problem is active — delivery_blocked still wins", () => {
    const ev = baseEvidence({ creatives: [], deliveryProblemAdSetIds: ["as_broken"] });
    const d = evaluateCampaign(ev);
    expect(d.type).toBe("no_action");
    expect(d.evidence.reason).toBe("delivery_blocked");
  });

  it("takes priority over a budget rule even when hasMinimumEvidence is true", () => {
    // CPL clearly rising (would fire decrease_budget) AND only one creative —
    // the structural gap wins, since you can't judge on a budget move made
    // blind to which creative is actually driving the cost.
    const ev = baseEvidence({
      current: { spendAgorot: 70000, leads: 10, cplAgorot: 7000, days: 7 },
      previous: { spendAgorot: 70000, leads: 20, cplAgorot: 3500, days: 7 },
      creatives: [cr("cr_only", 70000, 10, 7000)],
    });
    const d = evaluateCampaign(ev);
    expect(d.type).toBe("add_creatives_for_comparison");
  });

  it("evidence carries both creative and audience facts — the ops console's full picture", () => {
    const ev = baseEvidence({
      current: { spendAgorot: 4629, leads: 5, cplAgorot: 926, days: 7 },
      creatives: [cr("cr_only", 4394, 5, 879)],
      adsets: [
        { adSetId: "as_real", spendAgorot: 4394, leads: 5, cplAgorot: 879, deliveryStatus: "active" },
        { adSetId: "as_dormant", spendAgorot: 235, leads: 0, cplAgorot: null, deliveryStatus: "active" },
      ],
    });
    const d = evaluateCampaign(ev);
    expect(d.evidence.comparableCreativeCount).toBe(1);
    expect(d.evidence.comparableAdsetCount).toBe(1);
    expect(d.evidence.dormantAdsetIds).toEqual(["as_dormant"]);
    expect(d.currentBudgetAgorot).toBeNull();
    expect(d.proposedBudgetAgorot).toBeNull();
    expect(d.maxSpendImpactAgorot).toBeNull();
    expect(d.targetMetaId).toBeNull();
  });

  it("never enters cooldown accounting — ruleClassOf returns null for it", () => {
    expect(ruleClassOf("add_creatives_for_comparison")).toBeNull();
  });
});

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

  // AIC-88: the lead count itself is wrong, so nothing may fire. Every other
  // reason describes how much evidence we have; this one says the evidence is
  // a lie, which no amount of waiting fixes.
  it("tracking_broken suppresses a rule that WOULD otherwise have fired", () => {
    // Control: this exact evidence produces a real acting recommendation.
    const control = evaluateCampaign(baseEvidence({ creatives: [cr("cr_a", 25000, 10, 2500), cr("cr_b", 25000, 1, 25000)] }));
    expect(control.type).not.toBe("no_action");

    const d = evaluateCampaign(
      baseEvidence({ creatives: [cr("cr_a", 25000, 10, 2500), cr("cr_b", 25000, 1, 25000)], trackingBroken: true }),
    );
    expect(d.type).toBe("no_action");
    expect(d.evidence.reason).toBe("tracking_broken");
  });

  // AIC-128, the live failure: a Click-to-WhatsApp campaign whose creatives
  // had a CTA type but no whatsapp_number — Meta rendered a dead button, every
  // click was wasted, and delivery/tracking both reported healthy. Nothing may
  // fire while the funnel is broken at the click.
  it("cta_broken suppresses a rule that WOULD otherwise have fired", () => {
    const control = evaluateCampaign(baseEvidence({ creatives: [cr("cr_a", 25000, 10, 2500), cr("cr_b", 25000, 1, 25000)] }));
    expect(control.type).not.toBe("no_action");

    const d = evaluateCampaign(
      baseEvidence({ creatives: [cr("cr_a", 25000, 10, 2500), cr("cr_b", 25000, 1, 25000)], ctaBroken: true }),
    );
    expect(d.type).toBe("no_action");
    expect(d.evidence.reason).toBe("cta_broken");
  });

  it("cta_broken also suppresses the AIC-86 pre-gate advisory", () => {
    // "Add 2–3 more ads" would produce MORE ads with the same dead button.
    const ev = baseEvidence({ creatives: [cr("cr_a", 46000, 0, null)], current: { spendAgorot: 46000, leads: 0, cplAgorot: null, days: 7 } });
    expect(evaluateCampaign(ev).type).toBe("add_creatives_for_comparison");

    const d = evaluateCampaign({ ...ev, ctaBroken: true });
    expect(d.type).toBe("no_action");
    expect(d.evidence.reason).toBe("cta_broken");
  });

  // Delivery is checked first (an ad set that isn't showing at all is the more
  // fundamental problem), and tracking before CTA — the order is deliberate,
  // so a campaign with several problems always names the same one.
  it("ranks below delivery_blocked and tracking_broken when several are true at once", () => {
    const ev = baseEvidence({ creatives: [cr("cr_a", 25000, 10, 2500)], ctaBroken: true, trackingBroken: true });
    expect(evaluateCampaign(ev).evidence.reason).toBe("tracking_broken");
  });

  it("tracking_broken also suppresses the AIC-86 pre-gate advisory", () => {
    // One creative would normally produce add_creatives_for_comparison, which
    // fires BEFORE the evidence gate. "Add more ads" is wrong advice when the
    // real problem is that conversions aren't being counted at all.
    const ev = baseEvidence({ creatives: [cr("cr_a", 46000, 0, null)], current: { spendAgorot: 46000, leads: 0, cplAgorot: null, days: 7 } });
    expect(evaluateCampaign(ev).type).toBe("add_creatives_for_comparison");

    const d = evaluateCampaign({ ...ev, trackingBroken: true });
    expect(d.type).toBe("no_action");
    expect(d.evidence.reason).toBe("tracking_broken");
  });

  it("delivery_blocked still outranks tracking_broken (fix the breakage first)", () => {
    const d = evaluateCampaign(baseEvidence({ trackingBroken: true, deliveryProblemAdSetIds: ["as_broken"] }));
    expect(d.evidence.reason).toBe("delivery_blocked");
  });

  it("tracking_broken outranks collecting — thin data and WRONG data are different", () => {
    const d = evaluateCampaign(
      baseEvidence({
        current: { spendAgorot: 700, leads: 0, cplAgorot: null, days: 1 },
        trackingBroken: true,
      }),
    );
    expect(d.evidence.reason).toBe("tracking_broken");
  });

  it("trackingBroken absent/false changes nothing (the regression case)", () => {
    const withFalse = evaluateCampaign(baseEvidence({ trackingBroken: false }));
    const without = evaluateCampaign(baseEvidence({}));
    expect(withFalse.type).toBe(without.type);
    expect(withFalse.evidence.reason).toBe(without.evidence.reason);
  });

  it("no_comparable_audiences when the gate passes, no rule fires, and there's only one audience with data", () => {
    const d = evaluateCampaign(baseEvidence({ adsets: [{ adSetId: "as_1", spendAgorot: 70000, leads: 20, cplAgorot: 3500, deliveryStatus: "active" }] }));
    expect(d.evidence.reason).toBe("no_comparable_audiences");
  });

  it("stable (not no_comparable_audiences) when ≥2 audiences have data and nothing fires", () => {
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

  it("below_object_evidence_floor (creative) — 2 real, comparable creatives, neither cleared ₪150 yet", () => {
    const d = evaluateCampaign(
      baseEvidence({
        current: { spendAgorot: 20000, leads: 5, cplAgorot: 4000, days: 7 },
        creatives: [cr("cr_a", 10000, 3, 3333), cr("cr_b", 10000, 2, 5000)],
        adsets: [
          { adSetId: "as_1", spendAgorot: 20000, leads: 5, cplAgorot: 4000, deliveryStatus: "active" },
          { adSetId: "as_2", spendAgorot: 20000, leads: 5, cplAgorot: 4000, deliveryStatus: "active" },
        ],
      }),
    );
    expect(d.evidence.reason).toBe("below_object_evidence_floor");
    expect((d.evidence.detail as Record<string, unknown>).kind).toBe("creative");
  });

  it("below_object_evidence_floor (audience) — creatives cleared, but audiences didn't", () => {
    const d = evaluateCampaign(
      baseEvidence({
        adsets: [
          { adSetId: "as_1", spendAgorot: 10000, leads: 2, cplAgorot: 5000, deliveryStatus: "active" },
          { adSetId: "as_2", spendAgorot: 10000, leads: 2, cplAgorot: 5000, deliveryStatus: "active" },
        ],
      }),
    );
    expect(d.evidence.reason).toBe("below_object_evidence_floor");
    expect((d.evidence.detail as Record<string, unknown>).kind).toBe("audience");
  });

  it("no_comparable_creatives is reachable directly from classifyNoAction (defensive — AIC-86's advisory rule intercepts it in normal evaluateCampaign flow)", () => {
    const ev = baseEvidence({ creatives: [cr("cr_only", 25000, 8, 3125)] });
    const result = __rulesForTest.classifyNoAction(ev, T);
    expect(result.reason).toBe("no_comparable_creatives");
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

  // AIC-107: the SAME evidence that fires for a lead campaign must NOT fire
  // for an engagement one. "Cost per engagement is good, spend more" would
  // push real money at a metric with no business outcome behind it — the one
  // capability the ticket deliberately excludes from this campaign type.
  it("REFUSES to fire for an engagement campaign, on evidence that would fire for leads", () => {
    const evidence = {
      current: { spendAgorot: 70000, leads: 24, cplAgorot: 2900, days: 7 },
      previous: { spendAgorot: 70000, leads: 20, cplAgorot: 3500, days: 7 },
      creatives: [cr("cr_a", 35000, 12, 2916), cr("cr_b", 35000, 12, 2916)],
    };
    // Sanity: this evidence really does produce the recommendation for leads.
    expect(evaluateCampaign(baseEvidence(evidence)).type).toBe("increase_budget");
    // …and never does once the campaign is engagement.
    expect(evaluateCampaign(baseEvidence({ ...evidence, isEngagement: true })).type)
      .not.toBe("increase_budget");
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

  // Asymmetry vs decrease_budget (below): decreaseBudget explicitly bails on
  // prev===0; increaseBudget has no such guard. Harmless today only because
  // increaseBudget never divides by prev — it compares via <=/</>. Pinning so
  // a feature-layer refactor doesn't accidentally "fix" this into a behaviour
  // change: with prev CPL 0 and leads improving, it fires.
  it("fires off a zero previous CPL via the leads axis (no prev===0 guard, unlike decrease_budget)", () => {
    const d = evaluateCampaign(
      baseEvidence({
        current: { spendAgorot: 70000, leads: 21, cplAgorot: 0, days: 7 },
        previous: { spendAgorot: 70000, leads: 20, cplAgorot: 0, days: 7 },
      }),
    );
    expect(d.type).toBe("increase_budget");
  });
});

describe("decrease_budget — the prev===0 guard increase_budget lacks", () => {
  it("does NOT fire on a zero previous CPL, even with a nominal CPL rise", () => {
    const d = evaluateCampaign(
      baseEvidence({
        current: { spendAgorot: 70000, leads: 20, cplAgorot: 100, days: 7 },
        previous: { spendAgorot: 70000, leads: 20, cplAgorot: 0, days: 7 },
      }),
    );
    expect(d.type).not.toBe("decrease_budget");
  });
});

// Behaviour that's real today but has NO test pinning it — characterized here
// BEFORE the AIC-75 feature-layer refactor so "no behaviour change" is checkable,
// not just asserted. Every case below quotes the exact mechanism from rules.ts.
describe("engine internals (characterization — pin before the feature-layer refactor)", () => {
  // rules.ts:360-366 — RULES array order is the ONLY precedence mechanism.
  // Build evidence where pauseWeakCreative AND decreaseBudget would both fire;
  // the earlier array entry must win.
  it("first-match-wins across rule TYPES: a weak creative pre-empts a budget decrease it would otherwise trigger", () => {
    const d = evaluateCampaign(
      baseEvidence({
        current: { spendAgorot: 70000, leads: 14, cplAgorot: 5000, days: 7 }, // would fire decrease_budget alone
        previous: { spendAgorot: 70000, leads: 20, cplAgorot: 3500, days: 7 },
        creatives: [cr("cr_a", 25000, 10, 2500), cr("cr_b", 24000, 9, 2667), cr("cr_weak", 18000, 1, 18000)],
      }),
    );
    expect(d.type).toBe("pause_creative"); // not decrease_budget, despite CPL having risen materially
    expect(d.targetMetaId).toBe("cr_weak");
  });

  // rules.ts:218-229 — byAdSet is a Map built by iterating ev.creatives in
  // order, and `for (const group of byAdSet.values())` returns the FIRST
  // group (by insertion order) that produces a draft. Insertion order = the
  // order creatives arrive in the evidence — which the store populates
  // spend-desc, so in production this means "the highest-spending ad set's
  // group is examined first." Two groups, both containing a qualifying weak
  // creative: the one appearing FIRST in ev.creatives must win, not
  // "whichever is objectively weakest."
  it("ad-set group order = ev.creatives array order: the first group with a match wins, not the worst overall", () => {
    const d = evaluateCampaign(
      baseEvidence({
        creatives: [
          // Group "as_1" listed first — its weak creative is only just past
          // the 2x threshold (bestPeerCpl 2500 × 2 = 5000).
          { metaObjectId: "as1_a", adSetId: "as_1", creativeName: "as1_a", spendAgorot: 25000, leads: 10, cplAgorot: 2500, deliveryStatus: "active" },
          { metaObjectId: "as1_weak", adSetId: "as_1", creativeName: "as1_weak", spendAgorot: 18000, leads: 1, cplAgorot: 5000, deliveryStatus: "active" },
          // Group "as_2" listed second — its weak creative is FAR worse in
          // absolute terms, but array order means it's never reached.
          { metaObjectId: "as2_a", adSetId: "as_2", creativeName: "as2_a", spendAgorot: 25000, leads: 10, cplAgorot: 2500, deliveryStatus: "active" },
          { metaObjectId: "as2_weak", adSetId: "as_2", creativeName: "as2_weak", spendAgorot: 18000, leads: 1, cplAgorot: 50000, deliveryStatus: "active" },
        ],
      }),
    );
    expect(d.type).toBe("pause_creative");
    expect(d.targetMetaId).toBe("as1_weak"); // the first GROUP's candidate, not the globally-worst one
  });

  // rules.ts:186-189 — the sort comparator `(b.cplAgorot ?? Infinity) - (a.cplAgorot ?? Infinity)`
  // means a null-CPL creative (spent, zero leads) sorts as INFINITELY worse
  // than any finite CPL, so it's picked over a merely-expensive peer.
  it("a null-CPL (spent, zero-lead) creative outranks a finite-but-bad CPL as \"weakest\"", () => {
    const d = evaluateCampaign(
      baseEvidence({
        creatives: [
          cr("cr_a", 25000, 10, 2500), // sets bestPeerCpl = 2500
          cr("cr_bad", 20000, 1, 20000), // finite, 8x — clears the 2x bar
          cr("cr_dead", 16000, 0, null), // null — sorts as worse than ANY finite value
        ],
      }),
    );
    expect(d.type).toBe("pause_creative");
    expect(d.targetMetaId).toBe("cr_dead");
  });

  // rules.ts:181-183 vs :243-245 — a DOCUMENTED asymmetry, not a bug: the
  // creative rule's peer baseline (`performers`) is drawn from ALL creatives
  // with leads>0, not from `withData` (the spend-gated set) — so a tiny-spend
  // creative CAN set bestPeerCpl. The audience rule's baseline is drawn from
  // `withData` — a tiny-spend ad set CANNOT set the audience baseline.
  it("creative rule: an under-spend creative CAN set the peer baseline that judges others", () => {
    const d = evaluateCampaign(
      baseEvidence({
        creatives: [
          // Never reaches MIN_CREATIVE_SPEND_AGOROT (15000) — excluded from
          // `withData` (the pause candidates) but NOT from `performers` (the
          // baseline), so its cheap CPL still sets bestPeerCpl = 100.
          cr("cr_tiny", 500, 5, 100),
          // 150 < 100×2 (200) — stays healthy against the tiny baseline.
          cr("cr_a", 25000, 10, 150),
          // 2500 ≥ 100×2 — weak ONLY because the baseline came from cr_tiny;
          // against a normal peer (cr_a, 150) it would need to be ≥300 to fire.
          cr("cr_now_weak", 20000, 8, 2500),
        ],
      }),
    );
    expect(d.type).toBe("pause_creative");
    expect(d.targetMetaId).toBe("cr_now_weak");
  });

  it("audience rule: an under-spend ad set CANNOT set the audience baseline (mirrors the asymmetry above)", () => {
    const d = evaluateCampaign(
      baseEvidence({
        adsets: [
          // Below AUDIENCE_MIN_SPEND_AGOROT (30000) — excluded from `withData`
          // entirely, so unlike the creative-rule case above, this cheap CPL
          // can never become the baseline.
          { adSetId: "as_tiny", spendAgorot: 500, leads: 1, cplAgorot: 500, deliveryStatus: "active" },
          { adSetId: "as_a", spendAgorot: 35000, leads: 10, cplAgorot: 3500, deliveryStatus: "active" },
          { adSetId: "as_b", spendAgorot: 35000, leads: 9, cplAgorot: 3888, deliveryStatus: "active" },
        ],
      }),
    );
    expect(d.type).not.toBe("pause_adset"); // as_a/as_b are close; as_tiny is invisible to this rule
  });
});

describe("resolveThresholds (AIC-77a — configurable thresholds)", () => {
  it("at a typical small/medium budget, every threshold resolves to the plain global default (no behaviour change)", () => {
    const resolved = resolveThresholds(null, 7000); // ₪70/day, same as baseEvidence()
    expect(resolved).toEqual(T);
  });

  it("a large budget scales UP only the two minimum-evidence spend gates, nothing else", () => {
    const resolved = resolveThresholds(null, 30000); // ₪300/day — the "hair-triggered studio"
    expect(resolved.MIN_CREATIVE_SPEND_AGOROT).toBe(45000); // 1.5 × 30000, exceeds the 15000 floor
    expect(resolved.AUDIENCE_MIN_SPEND_AGOROT).toBe(45000); // 1.5 × 30000, exceeds the 30000 floor
    // Every other key is untouched by budget — scaling a %, a count, or a
    // multiplier by budget wouldn't mean anything.
    const { MIN_CREATIVE_SPEND_AGOROT, AUDIENCE_MIN_SPEND_AGOROT, ...rest } = resolved;
    const { MIN_CREATIVE_SPEND_AGOROT: _a, AUDIENCE_MIN_SPEND_AGOROT: _b, ...expectedRest } = T;
    expect(rest).toEqual(expectedRest);
  });

  it("an explicit account override wins outright over the budget-relative formula", () => {
    const resolved = resolveThresholds({ MIN_CREATIVE_SPEND_AGOROT: 5000 }, 30000);
    // Formula alone would push this to 45000 (see above) — the override says
    // an operator decided otherwise, and that decision is never second-guessed.
    expect(resolved.MIN_CREATIVE_SPEND_AGOROT).toBe(5000);
    expect(resolved.AUDIENCE_MIN_SPEND_AGOROT).toBe(45000); // unrelated key, formula still applies
  });

  it("an override on a non-budget-relative key applies directly, everything else stays default", () => {
    const resolved = resolveThresholds({ MIN_DAYS_DATA: 1 }, 7000);
    expect(resolved.MIN_DAYS_DATA).toBe(1);
    expect(resolved.MIN_CAMPAIGN_LEADS).toBe(T.MIN_CAMPAIGN_LEADS);
  });

  it("silently ignores an unknown key and a non-finite value — a bad row must never crash evaluation", () => {
    const resolved = resolveThresholds(
      { NOT_A_REAL_THRESHOLD: 999, MIN_DAYS_DATA: Number.NaN } as never,
      7000,
    );
    expect(resolved).toEqual(T);
    expect((resolved as Record<string, unknown>).NOT_A_REAL_THRESHOLD).toBeUndefined();
  });
});

describe("evaluateCampaign(ev, thresholds) — per-account overrides change the outcome (AIC-77a)", () => {
  it("a stricter override PREVENTS a rule that fires under the global default", () => {
    const ev = baseEvidence({
      creatives: [cr("cr_a", 25000, 10, 2500), cr("cr_b", 24000, 9, 2667), cr("cr_weak", 18000, 1, 18000)],
    });
    expect(evaluateCampaign(ev).type).toBe("pause_creative"); // default thresholds: fires

    const strict = resolveThresholds({ MIN_CAMPAIGN_LEADS: 25 }, ev.currentBudgetAgorot); // ev has 20 leads
    const d = evaluateCampaign(ev, strict);
    expect(d.type).toBe("no_action");
    expect(d.evidence.reason).toBe("collecting");
  });

  it("a looser override LETS a rule fire that the global default's gate would have blocked", () => {
    const ev = baseEvidence({
      current: { spendAgorot: 70000, leads: T.MIN_CAMPAIGN_LEADS - 1, cplAgorot: 3684, days: 7 },
      creatives: [cr("cr_a", 25000, 10, 2500), cr("cr_b", 24000, 9, 2667), cr("cr_weak", 18000, 1, 18000)],
    });
    expect(evaluateCampaign(ev).evidence.reason).toBe("collecting"); // default: below the leads gate

    const loose = resolveThresholds({ MIN_CAMPAIGN_LEADS: 1 }, ev.currentBudgetAgorot);
    const d = evaluateCampaign(ev, loose);
    expect(d.type).toBe("pause_creative");
    expect(d.targetMetaId).toBe("cr_weak");
  });
});

describe("ruleClassOf (AIC-77b)", () => {
  it("maps each acting recommendation type to its cooldown class", () => {
    expect(ruleClassOf("pause_creative")).toBe("creative");
    expect(ruleClassOf("replace_creative")).toBe("creative");
    expect(ruleClassOf("pause_adset")).toBe("audience");
    expect(ruleClassOf("decrease_budget")).toBe("budget");
    expect(ruleClassOf("increase_budget")).toBe("budget");
  });

  it("no_action has no class — it can never itself be suppressed", () => {
    expect(ruleClassOf("no_action")).toBeNull();
  });
});

describe("resolveCooldownClasses (AIC-77b)", () => {
  const NOW = new Date("2026-08-14T00:00:00Z");

  it("a recent successful engine action puts its class in cooldown", () => {
    const classes = resolveCooldownClasses(
      { pause_creative: new Date("2026-08-10T00:00:00Z") }, // 4 days ago
      7,
      NOW,
    );
    expect(classes).toEqual(new Set(["creative"]));
  });

  it("an action older than COOLDOWN_DAYS is no longer cooling down", () => {
    const classes = resolveCooldownClasses(
      { pause_creative: new Date("2026-08-01T00:00:00Z") }, // 13 days ago
      7,
      NOW,
    );
    expect(classes.size).toBe(0);
  });

  it("exactly at the cutoff is still cooling (inclusive boundary)", () => {
    const sevenDaysAgo = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    const classes = resolveCooldownClasses({ pause_creative: sevenDaysAgo }, 7, NOW);
    expect(classes.has("creative")).toBe(true);
  });

  it("null/undefined/empty input is an empty set, never throws", () => {
    expect(resolveCooldownClasses(null, 7, NOW)).toEqual(new Set());
    expect(resolveCooldownClasses(undefined, 7, NOW)).toEqual(new Set());
    expect(resolveCooldownClasses({}, 7, NOW)).toEqual(new Set());
  });

  it("multiple recent classes all cool down independently", () => {
    const classes = resolveCooldownClasses(
      {
        pause_creative: new Date("2026-08-12T00:00:00Z"),
        decrease_budget: new Date("2026-08-13T00:00:00Z"),
        pause_adset: new Date("2026-08-01T00:00:00Z"), // outside the window
      },
      7,
      NOW,
    );
    expect(classes).toEqual(new Set(["creative", "budget"]));
  });
});

describe("evaluateCampaign — cooldown suppression (AIC-77b)", () => {
  const weakCreativeEv = () =>
    baseEvidence({
      creatives: [cr("cr_a", 25000, 10, 2500), cr("cr_b", 24000, 9, 2667), cr("cr_weak", 18000, 1, 18000)],
    });

  it("with no cooldown context, behaviour is identical to before (backward compatible)", () => {
    const d = evaluateCampaign(weakCreativeEv());
    expect(d.type).toBe("pause_creative");
  });

  it("a rule that WOULD fire is suppressed when its class is cooling down, and reports cooling_down", () => {
    const d = evaluateCampaign(weakCreativeEv(), T, {
      classes: new Set(["creative"]),
      lastActionAtByType: { pause_creative: new Date("2026-08-10T00:00:00Z") },
    });
    expect(d.type).toBe("no_action");
    expect(d.evidence.reason).toBe("cooling_down");
    expect((d.evidence.detail as Record<string, unknown>).suppressedType).toBe("pause_creative");
  });

  it("a DIFFERENT class not in cooldown still fires normally", () => {
    const d = evaluateCampaign(weakCreativeEv(), T, {
      classes: new Set(["budget"]), // creative is unaffected
      lastActionAtByType: { decrease_budget: new Date("2026-08-10T00:00:00Z") },
    });
    expect(d.type).toBe("pause_creative");
  });

  it("when nothing would have fired anyway, cooldown never invents a reason — stays collecting/stable", () => {
    // Thin evidence: no rule can fire regardless of cooldown.
    const thin = baseEvidence({ current: { spendAgorot: 20000, leads: 2, cplAgorot: 10000, days: 2 } });
    const d = evaluateCampaign(thin, T, {
      classes: new Set(["creative", "audience", "budget"]), // everything cooling — irrelevant here
      lastActionAtByType: { pause_creative: new Date("2026-08-10T00:00:00Z") },
    });
    expect(d.evidence.reason).not.toBe("cooling_down");
    expect(d.evidence.reason).toBe("collecting");
  });

  it("a stable campaign (gate passes, nothing warranted) also never reports cooling_down", () => {
    const stable = baseEvidence({
      adsets: [
        { adSetId: "as_1", spendAgorot: 70000, leads: 20, cplAgorot: 3500, deliveryStatus: "active" },
        { adSetId: "as_2", spendAgorot: 70000, leads: 20, cplAgorot: 3500, deliveryStatus: "active" },
      ],
    }); // healthy, fires no rule, ≥2 ad sets
    const d = evaluateCampaign(stable, T, {
      classes: new Set(["creative", "audience", "budget"]),
      lastActionAtByType: { pause_creative: new Date("2026-08-10T00:00:00Z") },
    });
    expect(d.evidence.reason).toBe("stable");
  });
});
