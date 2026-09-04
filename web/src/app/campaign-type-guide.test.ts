import { describe, expect, it } from "vitest";
import { shouldShowCampaignTypeGuide } from "./campaign-type-guide";

describe("campaign-type guide visibility", () => {
  it("shows for messaging and post-engagement campaigns", () => {
    expect(shouldShowCampaignTypeGuide("whatsapp")).toBe(true);
    expect(shouldShowCampaignTypeGuide("engagement")).toBe(true);
  });

  it("stays out of website campaigns and missing campaign state", () => {
    expect(shouldShowCampaignTypeGuide("website")).toBe(false);
    expect(shouldShowCampaignTypeGuide(null)).toBe(false);
    expect(shouldShowCampaignTypeGuide(undefined)).toBe(false);
  });
});

