import { describe, it, expect } from "vitest";
import { extractLeads, computeCpl, normalizeRow } from "./insights.js";
import type { RawInsightRow } from "./types.js";

describe("extractLeads (Click-to-WhatsApp lead definition)", () => {
  it("counts messaging_conversation_started", () => {
    expect(
      extractLeads([
        { action_type: "onsite_conversion.messaging_conversation_started", value: "5" },
        { action_type: "link_click", value: "40" },
      ]),
    ).toBe(5);
  });

  it("prefers the 7d variant and does NOT double-count with the base type", () => {
    expect(
      extractLeads([
        { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "7" },
        { action_type: "onsite_conversion.messaging_conversation_started", value: "5" },
      ]),
    ).toBe(7);
  });

  it("is 0 when there are no messaging actions", () => {
    expect(extractLeads([{ action_type: "link_click", value: "10" }])).toBe(0);
    expect(extractLeads(undefined)).toBe(0);
  });
});

describe("computeCpl", () => {
  it("is spend/leads in agorot", () => {
    expect(computeCpl(18000, 5)).toBe(3600); // ₪180 / 5 = ₪36
  });
  it("is null when there are no leads (honest no-data, not 0 or divide-by-zero)", () => {
    expect(computeCpl(18000, 0)).toBeNull();
  });
});

describe("normalizeRow", () => {
  const period = { start: "2026-07-27", end: "2026-08-02" };
  const row: RawInsightRow = {
    grain: "ad",
    objectId: "ad_1",
    parentId: "adset_1",
    name: "Creative A",
    spend: "180.00",
    impressions: "12000",
    inlineLinkClicks: "150",
    actions: [
      { action_type: "onsite_conversion.messaging_conversation_started", value: "5" },
    ],
    deliveryStatus: "active",
  };

  it("converts spend to integer agorot and computes leads + CPL", () => {
    const s = normalizeRow(row, "camp-uuid", period);
    expect(s.spendAgorot).toBe(18000);
    expect(s.leads).toBe(5);
    expect(s.cplAgorot).toBe(3600);
    expect(s.impressions).toBe(12000);
    expect(s.linkClicks).toBe(150);
    expect(s.creativeName).toBe("Creative A");
    expect(s.grain).toBe("ad");
    expect(s.periodStart).toBe("2026-07-27");
  });

  it("leaves CPL null when a creative got spend but no leads", () => {
    const s = normalizeRow({ ...row, actions: [] }, "camp-uuid", period);
    expect(s.leads).toBe(0);
    expect(s.cplAgorot).toBeNull();
  });
});
