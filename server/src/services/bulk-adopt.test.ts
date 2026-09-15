import { describe, it, expect } from "vitest";
import { planBulkAdoption } from "./bulk-adopt.js";
import type { DiscoveredCampaign } from "../meta/campaign-discovery.js";

const wa = (over: Partial<DiscoveredCampaign> = {}): DiscoveredCampaign => ({
  id: "c-wa", name: "השמה - סופרים", status: "ACTIVE", effectiveStatus: "ACTIVE",
  objective: "OUTCOME_LEADS", dailyBudgetAgorot: 3000,
  destination: { supported: true, destinationType: "whatsapp", messagingChannel: "whatsapp" },
  ...over,
});

const shared = { whatsappDestination: "972501234567", fallbackBudgetAgorot: 2000 };

describe("planBulkAdoption", () => {
  it("imports a WhatsApp campaign with Meta's own budget", () => {
    const { adopt, skip } = planBulkAdoption([wa()], shared);
    expect(skip).toEqual([]);
    expect(adopt[0]).toMatchObject({
      metaCampaignId: "c-wa", destinationType: "whatsapp", objective: "leads",
      agreedBudgetAgorot: 3000, budgetSource: "meta", messagingChannel: "whatsapp",
    });
  });

  it("uses the operator's ceiling for a boost with no campaign budget — and says so", () => {
    // Boosted posts and ad-set budgets have nothing at campaign level. Moshe's
    // five campaigns are all boosts.
    const { adopt } = planBulkAdoption([wa({ dailyBudgetAgorot: null })], shared);
    expect(adopt[0]).toMatchObject({ agreedBudgetAgorot: 2000, budgetSource: "fallback" });
  });

  it("skips a campaign with no budget anywhere rather than inventing one", () => {
    const { adopt, skip } = planBulkAdoption(
      [wa({ dailyBudgetAgorot: null })],
      { ...shared, fallbackBudgetAgorot: null },
    );
    expect(adopt).toEqual([]);
    expect(skip[0].reason).toBe("no_budget");
  });

  it("skips an undetectable destination — never imports it as WhatsApp by default", () => {
    // A guessed destination counts the wrong action as a lead and reports a
    // working campaign as failing.
    for (const reason of ["no_ad_sets", "mixed_ad_sets", "unrecognized_objective"] as const) {
      const { adopt, skip } = planBulkAdoption([wa({ destination: { supported: false, reason } })], shared);
      expect(adopt).toEqual([]);
      expect(skip[0].reason).toBe(reason);
    }
  });

  it("skips deleted and archived campaigns", () => {
    const { skip } = planBulkAdoption(
      [wa({ id: "d", effectiveStatus: "DELETED" }), wa({ id: "a", status: "ARCHIVED", effectiveStatus: "ARCHIVED" })],
      shared,
    );
    expect(skip.map((s) => s.reason)).toEqual(["deleted", "deleted"]);
  });

  it("imports a PAUSED campaign — paused is a state, not a reason to hide it", () => {
    const { adopt } = planBulkAdoption([wa({ effectiveStatus: "CAMPAIGN_PAUSED" })], shared);
    expect(adopt).toHaveLength(1);
  });

  it("skips WhatsApp campaigns when no number was given, but still imports the rest", () => {
    const eng = wa({
      id: "c-eng", dailyBudgetAgorot: 1500,
      destination: { supported: true, destinationType: "engagement", leadEventTypes: ["post_engagement"] },
    });
    const { adopt, skip } = planBulkAdoption([wa(), eng], { ...shared, whatsappDestination: "  " });
    expect(skip).toEqual([{ metaCampaignId: "c-wa", campaignName: "השמה - סופרים", reason: "missing_whatsapp" }]);
    expect(adopt.map((a) => a.metaCampaignId)).toEqual(["c-eng"]);
    expect(adopt[0]).toMatchObject({ objective: "engagement", leadEventTypes: ["post_engagement"], messagingChannel: null });
  });

  it("carries a website campaign's detected pixel and event", () => {
    const web = wa({
      id: "c-web",
      destination: { supported: true, destinationType: "website", trackingPixelId: "984664453249037", leadEventTypes: ["offsite_conversion.fb_pixel_complete_registration"] },
    });
    const { adopt } = planBulkAdoption([web], shared);
    expect(adopt[0]).toMatchObject({
      destinationType: "website", trackingPixelId: "984664453249037",
      leadEventTypes: ["offsite_conversion.fb_pixel_complete_registration"],
    });
  });

  it("rejects a non-positive fallback instead of importing at ₪0", () => {
    const { skip } = planBulkAdoption([wa({ dailyBudgetAgorot: null })], { ...shared, fallbackBudgetAgorot: 0 });
    expect(skip[0].reason).toBe("no_budget");
  });
});
