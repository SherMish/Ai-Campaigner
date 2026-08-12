// The write surface for adding an ad/ad-set to an EXISTING campaign (AIC-63).
// Reuses BuilderWriter (createAdSet/createAd, always PAUSED — AIC-50) and
// CreativeWriter (AIC-51) unchanged; this module adds only what's genuinely
// new: reading an existing campaign's ad sets to pick from, and activating a
// single ad/ad-set once the customer approves (the AIC-53 activation
// pattern, generalized below campaign level — activating a campaign doesn't
// activate the ad sets/ads under it, and vice versa).

import type { AdSetMeta } from "../meta/audience-label.js";
import type { MetaCampaignStatus } from "../launch/types.js";

export interface AdditionWriter {
  // Live, not cached — a customer picking where to add an ad needs the
  // current ad-set list, including one they created moments ago via this
  // same flow (the ad_set_meta cache only refreshes on the hourly engine tick).
  getAdSetMeta(metaCampaignId: string): Promise<AdSetMeta[]>;
  getAdSetStatus(adSetId: string): Promise<MetaCampaignStatus>;
  getAdStatus(adId: string): Promise<MetaCampaignStatus>;
  // Both hardcode ACTIVE internally — no caller-supplied status, same
  // single-purpose-method pattern as LaunchWriter.activateCampaign.
  activateAdSet(adSetId: string): Promise<void>;
  activateAd(adId: string): Promise<void>;
}

// Deterministic fake for tests.
export class FakeAdditionWriter implements AdditionWriter {
  public adSets: AdSetMeta[] = [];
  public statuses = new Map<string, MetaCampaignStatus>(); // adSetId/adId → status
  public activateAdSetCalls: string[] = [];
  public activateAdCalls: string[] = [];
  public failNextActivateAdSet = 0;
  public failNextActivateAd = 0;

  async getAdSetMeta(_metaCampaignId: string): Promise<AdSetMeta[]> {
    return this.adSets;
  }
  async getAdSetStatus(adSetId: string): Promise<MetaCampaignStatus> {
    return this.statuses.get(adSetId) ?? "PAUSED";
  }
  async getAdStatus(adId: string): Promise<MetaCampaignStatus> {
    return this.statuses.get(adId) ?? "PAUSED";
  }
  async activateAdSet(adSetId: string): Promise<void> {
    if (this.failNextActivateAdSet > 0) {
      this.failNextActivateAdSet--;
      throw new Error("simulated Meta activate-adset failure");
    }
    this.activateAdSetCalls.push(adSetId);
    this.statuses.set(adSetId, "ACTIVE");
  }
  async activateAd(adId: string): Promise<void> {
    if (this.failNextActivateAd > 0) {
      this.failNextActivateAd--;
      throw new Error("simulated Meta activate-ad failure");
    }
    this.activateAdCalls.push(adId);
    this.statuses.set(adId, "ACTIVE");
  }
}
