// Meta create-write shapes (AIC-50) — the builder's write surface, separate
// from ExecWriter (safe-executor.ts): these create NEW objects, never modify
// an existing recommendation's target, so they don't belong on that
// interface. Implemented by the same GraphCampaignAdapter class (multiple
// interfaces on one class is the existing pattern — see MetaReader/ExecWriter/
// DeliveryReader already there).

export interface CreateCampaignParams {
  adAccountId: string; // real Meta ad account id, e.g. "act_123456789"
  name: string;
  dailyBudgetAgorot: number; // CBO — P0 never sets an ad-set-level budget
  specialAdCategories: string[]; // [] for none; else e.g. ["HOUSING"]
  bidStrategy: string;
}

export interface CreateAdSetTargeting {
  ageMin: number;
  ageMax: number;
  genders: number[]; // Meta shape: [] = all, [1] = male, [2] = female
  countries: string[];
}

export interface CreateAdSetParams {
  adAccountId: string; // Meta creates ad sets on the AD ACCOUNT's edge, not the campaign's
  metaCampaignId: string;
  name: string;
  targeting: CreateAdSetTargeting;
  pageId: string; // the connected Page — Meta routes WhatsApp destination via its connected number
}

export interface CreateAdParams {
  adAccountId: string; // Meta creates ads on the AD ACCOUNT's edge, not the ad set's
  metaAdSetId: string;
  name: string;
  creativeId: string; // an existing Meta ad creative id (AIC-51 produces these)
}

export interface BuilderWriter {
  createCampaign(params: CreateCampaignParams): Promise<string>; // → new meta_campaign_id
  createAdSet(params: CreateAdSetParams): Promise<string>; // → new meta_ad_set_id
  createAd(params: CreateAdParams): Promise<string>; // → new meta_ad_id
}

// Deterministic fake for tests: records every create call (so a test can
// assert the created-paused invariant and idempotent-call-count), and can be
// told to fail the next N calls (partial-failure simulation).
export class FakeBuilderWriter implements BuilderWriter {
  public campaignCalls: CreateCampaignParams[] = [];
  public adSetCalls: CreateAdSetParams[] = [];
  public adCalls: CreateAdParams[] = [];
  public failNextCreateAdSet = 0;
  public failNextCreateAd = 0;
  private counter = 0;

  async createCampaign(params: CreateCampaignParams): Promise<string> {
    this.campaignCalls.push(params);
    return `meta_camp_${++this.counter}`;
  }
  async createAdSet(params: CreateAdSetParams): Promise<string> {
    if (this.failNextCreateAdSet > 0) {
      this.failNextCreateAdSet--;
      throw new Error("simulated Meta create-adset failure");
    }
    this.adSetCalls.push(params);
    return `meta_adset_${++this.counter}`;
  }
  async createAd(params: CreateAdParams): Promise<string> {
    if (this.failNextCreateAd > 0) {
      this.failNextCreateAd--;
      throw new Error("simulated Meta create-ad failure");
    }
    this.adCalls.push(params);
    return `meta_ad_${++this.counter}`;
  }
}
