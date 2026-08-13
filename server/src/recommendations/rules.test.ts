import { describe, it, expect } from "vitest";
import {
  evaluateCampaign,
  resolveThresholds,
  ruleClassOf,
  resolveCooldownClasses,
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
