import { describe, it, expect } from "vitest";
import { extractLeads, computeCpl, normalizeRow, LEAD_ACTION_PRIORITY } from "./insights.js";
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

// AIC-87: the lead definition is per-campaign, not a module-level constant. A
// campaign whose leads are Pixel conversions reports a completely different
// action type; under the old hardcoded constant it counted ZERO no matter how
// well it performed. These actions are the REAL shape returned by the live
// `free_beta_signups_leads` campaign (26 registrations on ₪205.06).
describe("extractLeads with a per-campaign priority list (AIC-87)", () => {
  const pixelActions = [
    { action_type: "offsite_complete_registration_add_meta_leads", value: "26" },
    { action_type: "link_click", value: "156" },
    { action_type: "omni_complete_registration", value: "26" },
    { action_type: "offsite_conversion.fb_pixel_complete_registration", value: "26" },
    { action_type: "landing_page_view", value: "45" },
    { action_type: "complete_registration", value: "26" },
  ];

  it("counts a Pixel conversion event when the campaign declares it", () => {
    expect(
      extractLeads(pixelActions, ["offsite_conversion.fb_pixel_complete_registration"]),
    ).toBe(26);
  });

  it("REGRESSION: the same actions count 0 under the WhatsApp default", () => {
    // This is the bug — a working campaign rendered as a failing one.
    expect(extractLeads(pixelActions)).toBe(0);
  });

  it("still takes the first match only — never sums across aliases", () => {
    // Meta reports the same 26 conversions under four different action names.
    // Summing them would report 104 leads for 26 real registrations.
    expect(
      extractLeads(pixelActions, [
        "offsite_conversion.fb_pixel_complete_registration",
        "omni_complete_registration",
        "complete_registration",
      ]),
    ).toBe(26);
  });

  it("falls through the list in order, like the WhatsApp pair does", () => {
    expect(
      extractLeads(pixelActions, ["not_present_at_all", "complete_registration"]),
    ).toBe(26);
  });

  it("omitting the argument is byte-identical to today's behaviour", () => {
    const wa = [
      { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "7" },
      { action_type: "onsite_conversion.messaging_conversation_started", value: "5" },
    ];
    expect(extractLeads(wa)).toBe(extractLeads(wa, LEAD_ACTION_PRIORITY));
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

  // AIC-87
  it("honors a per-campaign lead-event list when passed", () => {
    const pixelRow: RawInsightRow = {
      ...row,
      actions: [{ action_type: "offsite_conversion.fb_pixel_complete_registration", value: "26" }],
    };
    const s = normalizeRow(pixelRow, "camp-uuid", period, ["offsite_conversion.fb_pixel_complete_registration"]);
    expect(s.leads).toBe(26);
  });

  it("without a lead-event list, falls back to the WhatsApp default (unchanged)", () => {
    const s = normalizeRow(row, "camp-uuid", period);
    expect(s.leads).toBe(5);
  });
});
