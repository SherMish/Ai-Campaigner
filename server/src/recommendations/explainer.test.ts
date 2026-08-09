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

  it("distinguishes stable vs insufficient-evidence no_action", () => {
    expect(explain(rec({ type: "no_action", evidence: { reason: "stable" } }))).toContain("יציב");
    expect(explain(rec({ type: "no_action", evidence: { reason: "insufficient_evidence" } }))).toContain("מספיק מידע");
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
