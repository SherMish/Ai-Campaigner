import { describe, it, expect } from "vitest";
import {
  explain,
  explainWithLlm,
  explainWeeklyStatus,
  requiredFigures,
  FORBIDDEN_JARGON,
  type LlmRephraser,
} from "./explainer.js";
import type { RecommendationRecord } from "./types.js";

function rec(over: Partial<RecommendationRecord>): RecommendationRecord {
  return {
    id: "r1", campaignId: "c1", type: "no_action", state: "proposed",
    targetMetaId: null, evidence: {}, currentBudgetAgorot: null,
    proposedBudgetAgorot: null, maxSpendImpactAgorot: null, rationale: "",
    expiresAt: null, approvedBy: null, approvedAt: null, executedAt: null, ...over,
  };
}

const PAUSE = rec({ type: "pause_creative", targetMetaId: "ad_3", evidence: { spendAgorot: 18000, leads: 1 } });
const INCREASE = rec({ type: "increase_budget", currentBudgetAgorot: 7000, proposedBudgetAgorot: 8000 });

describe("add_creatives_for_comparison (AIC-86) — with-data vs day-one vs flexible-ad copy", () => {
  it("with real leads: opens on performance, never phrased as 'nothing to do'", () => {
    const text = explain(rec({ type: "add_creatives_for_comparison", evidence: { currentLeads: 5, currentCplAgorot: 1390, isFlexibleAd: false } }));
    expect(text).toContain("5");
    expect(text).not.toContain("אין מה לעשות");
  });

  it("day one, zero leads: skips the performance line, still actionable", () => {
    const text = explain(rec({ type: "add_creatives_for_comparison", evidence: { currentLeads: 0, currentCplAgorot: null, isFlexibleAd: false } }));
    expect(text).toContain("להוסיף");
    expect(text).not.toContain("פניות בעלות ממוצעת"); // no performance line to open on
  });

  it("names the flexible-ad case explicitly instead of the generic 'only one ad' phrasing", () => {
    const withData = explain(rec({ type: "add_creatives_for_comparison", evidence: { currentLeads: 5, currentCplAgorot: 1390, isFlexibleAd: true } }));
    const noData = explain(rec({ type: "add_creatives_for_comparison", evidence: { currentLeads: 0, currentCplAgorot: null, isFlexibleAd: true } }));
    expect(withData).toContain("גמישה");
    expect(noData).toContain("גמישה");
  });

  // AIC-117, reported by a real customer: "wrong status. we have 2 ads running".
  // The sentence "כרגע רצה מודעה אחת בלבד" was unconditional, printed off a
  // count of ads WITH DATA. On a young campaign that is 0 while two ads run.
  it("never claims one ad is running when the live count says otherwise", () => {
    const two = explain(rec({ type: "add_creatives_for_comparison", evidence: { currentLeads: 0, currentCplAgorot: null, isFlexibleAd: false, liveCreativeCount: 2 } }));
    expect(two).not.toContain("מודעה אחת בלבד");
    expect(two).toContain("להוסיף"); // still actionable, just not a false count

    const none = explain(rec({ type: "add_creatives_for_comparison", evidence: { currentLeads: 0, currentCplAgorot: null, isFlexibleAd: false, liveCreativeCount: 0 } }));
    expect(none).not.toContain("מודעה אחת בלבד");

    const one = explain(rec({ type: "add_creatives_for_comparison", evidence: { currentLeads: 0, currentCplAgorot: null, isFlexibleAd: false, liveCreativeCount: 1 } }));
    expect(one).toContain("מודעה אחת בלבד"); // true here, so still said
  });

  it("falls back to the comparable count for rows written before the live count existed", () => {
    const legacy = explain(rec({ type: "add_creatives_for_comparison", evidence: { currentLeads: 0, currentCplAgorot: null, isFlexibleAd: false, comparableCreativeCount: 1 } }));
    expect(legacy).toContain("מודעה אחת בלבד");
  });

  it("requiredFigures: no leads yet → no figures to guard; with leads → leads + CPL guarded", () => {
    expect(requiredFigures(rec({ type: "add_creatives_for_comparison", evidence: { currentLeads: 0, currentCplAgorot: null } }))).toEqual([]);
    const figures = requiredFigures(rec({ type: "add_creatives_for_comparison", evidence: { currentLeads: 5, currentCplAgorot: 1390 } }));
    expect(figures).toContain("5");
  });
});

describe("pause_adset — named by its human audience dimension (AIC-37)", () => {
  it("names the audience when a label is present in evidence", () => {
    const withLabel = rec({ type: "pause_adset", targetMetaId: "as_2", evidence: { audienceLabel: "35–45" } });
    expect(explain(withLabel)).toContain("35–45");
  });

  it("falls back to generic phrasing when no label was derivable", () => {
    const noLabel = rec({ type: "pause_adset", targetMetaId: "as_2", evidence: {} });
    const text = explain(noLabel);
    expect(text).not.toContain("null");
    expect(text.length).toBeGreaterThan(0);
  });

  it("never says 'ad set' or 'ad-set N'", () => {
    const withLabel = rec({ type: "pause_adset", targetMetaId: "as_2", evidence: { audienceLabel: "נשים" } });
    expect(explain(withLabel).toLowerCase()).not.toContain("ad set");
  });
});

describe("explainer number fidelity", () => {
  it("echoes the structured figures verbatim (pause)", () => {
    const text = explain(PAUSE);
    expect(text).toContain("₪180"); // 18000 agorot
    expect(text).toContain("1");
    expect(requiredFigures(PAUSE)).toEqual(["₪180", "1"]);
  });

  it("echoes both budget figures verbatim (increase)", () => {
    const text = explain(INCREASE);
    expect(text).toContain("₪70");
    expect(text).toContain("₪80");
  });

  it("never emits Ads Manager jargon", () => {
    for (const r of [PAUSE, INCREASE, rec({ type: "replace_creative" }), rec({ type: "decrease_budget", currentBudgetAgorot: 8000, proposedBudgetAgorot: 6400 })]) {
      const lower = explain(r).toLowerCase();
      for (const j of FORBIDDEN_JARGON) expect(lower).not.toContain(j);
    }
  });

  it("distinguishes each no_action reason (AIC-64/85/88) — never the same message", () => {
    const texts = [
      "stable", "collecting", "budget_below_threshold", "delivery_blocked",
      "no_comparable_audiences", "no_comparable_creatives", "below_object_evidence_floor",
      "tracking_broken",
    ].map((reason) => explain(rec({ type: "no_action", evidence: { reason } })));
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts[0]).toContain("יציב");
    expect(texts[1]).toContain("מספיק מידע");
    expect(texts[2]).toContain("תקציב");
    expect(texts[3]).toContain("מתפרסמת");
    expect(texts[4]).toContain("קהל אחד");
    expect(texts[5]).toContain("מודעה אחת");
    expect(texts[6]).toContain("להשוות");
    // AIC-88: says the NUMBERS are wrong and it's on us — never that the
    // campaign is failing, which is what a naive "0 leads" message implies.
    expect(texts[7]).toContain("נספרות");
  });

  it("renders a weekly status summary with the figures passed in", () => {
    const text = explainWeeklyStatus({ leads: 11, avgCplAgorot: 4400 });
    expect(text).toContain("11");
    expect(text).toContain("₪44");
  });
});

describe("explainWithLlm guardrail (LLM explains, never decides)", () => {
  it("falls back to the template when no LLM is configured", async () => {
    expect(await explainWithLlm(PAUSE)).toBe(explain(PAUSE));
  });

  it("accepts an LLM rephrase that preserves every figure", async () => {
    const llm: LlmRephraser = {
      rephrase: async () => "מודעה אחת הוציאה ₪180 והביאה רק 1 פניות — כדאי לעצור אותה.",
    };
    const out = await explainWithLlm(PAUSE, llm);
    expect(out).toContain("₪180");
    expect(out).toContain("1");
    expect(out).not.toBe(explain(PAUSE)); // used the rephrase
  });

  it("REJECTS an LLM rephrase that changed a number, keeping the template", async () => {
    const llm: LlmRephraser = {
      rephrase: async () => "מודעה אחת הוציאה ₪250 והביאה 1 פניות.", // 180 → 250
    };
    expect(await explainWithLlm(PAUSE, llm)).toBe(explain(PAUSE));
  });

  it("REJECTS a rephrase that introduced jargon", async () => {
    const llm: LlmRephraser = {
      rephrase: async () => "המודעה עם CTR נמוך הוציאה ₪180 עבור 1 פניות.",
    };
    expect(await explainWithLlm(PAUSE, llm)).toBe(explain(PAUSE));
  });

  it("falls back to the template if the LLM throws", async () => {
    const llm: LlmRephraser = { rephrase: async () => { throw new Error("timeout"); } };
    expect(await explainWithLlm(PAUSE, llm)).toBe(explain(PAUSE));
  });
});

// AIC-133: "we compared lead volume" and "we compared how many leads were a
// fit" are two different claims, and the customer approves one of them.
describe("pause_adset — the copy names which basis was used (AIC-133)", () => {
  it("says lead-quality feedback when the judgement used it", () => {
    const t = explain(rec({ type: "pause_adset", targetMetaId: "as_2", evidence: { audienceLabel: "נשים 35–45", basis: "relevant_leads" } }));
    expect(t).toContain("רלוונטית");
    expect(t).toContain("המשוב שלכם");
    expect(t).not.toContain("כמות הפניות בלבד");
  });

  it("admits volume-only when there was no usable quality data", () => {
    const t = explain(rec({ type: "pause_adset", targetMetaId: "as_2", evidence: { audienceLabel: "נשים 35–45", basis: "lead_volume" } }));
    expect(t).toContain("כמות הפניות בלבד");
  });

  it("an OLD row with no basis field reads as volume-only, not as quality", () => {
    // The row was written before quality existed. Claiming it weighed customer
    // feedback would be retroactively false.
    const t = explain(rec({ type: "pause_adset", targetMetaId: "as_2", evidence: { audienceLabel: "נשים 35–45" } }));
    expect(t).toContain("כמות הפניות בלבד");
  });
});

describe("pause_creative — the copy names which basis was used (AIC-133)", () => {
  it("says lead-quality feedback when the judgement used it", () => {
    const t = explain(rec({ type: "pause_creative", targetMetaId: "ad_3", evidence: { spendAgorot: 18000, leads: 1, basis: "relevant_leads" } }));
    expect(t).toContain("רלוונטית");
    expect(t).toContain("המשוב שלכם");
  });

  it("an OLD row with no basis reads as volume-only", () => {
    const t = explain(rec({ type: "pause_creative", targetMetaId: "ad_3", evidence: { spendAgorot: 18000, leads: 1 } }));
    expect(t).toContain("כמות הפניות בלבד");
  });
});
