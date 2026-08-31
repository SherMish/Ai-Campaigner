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
  // AIC-107: the campaign objective follows the destination
  // (resolveDestinationShape), so an engagement campaign is created as
  // OUTCOME_ENGAGEMENT rather than silently as a Leads campaign. Required,
  // not optional-with-a-default: a default here is what let the old inline
  // "OUTCOME_LEADS" literal survive unnoticed.
  destination: string;
}

export interface CreateAdSetTargeting {
  ageMin: number;
  ageMax: number;
  genders: number[]; // Meta shape: [] = all, [1] = male, [2] = female
  countries: string[];
  /**
   * AIC-157 — the cities/regions this ad set actually serves.
   *
   * Empty means the whole country, which is what EVERY ad set we had ever
   * created targeted: no screen offered a geo control, so `countries: ["IL"]`
   * was not a default anyone chose. A local business on ₪15/day paying for
   * nationwide reach is the single most expensive thing the builder could get
   * wrong, and `customers.geo_area` had been collecting the right answer the
   * whole time.
   *
   * `key` is Meta's own adgeolocation key from `search?type=adgeolocation`,
   * never a name we transcribe. `name` rides along for the ad-set NAME
   * (naming.ts) and for nothing else — Meta ignores it.
   */
  cities?: Array<{ key: string; name: string; type: "city" | "region" }>;
}

export interface CreateAdSetParams {
  adAccountId: string; // Meta creates ad sets on the AD ACCOUNT's edge, not the campaign's
  metaCampaignId: string;
  name: string;
  targeting: CreateAdSetTargeting;
  pageId: string; // the connected Page — Meta routes WhatsApp destination via its connected number
  // Resolved via shared/src/recommended-defaults.ts's resolveDestinationShape
  // — NEVER a caller-hardcoded "whatsapp"/"CONVERSATIONS" literal.
  destination: string;
  // AIC-89 — only meaningful when destination resolves to the WEBSITE shape:
  // promoted_object becomes { pixel_id, custom_event_type } instead of
  // { page_id }. Absent/ignored for a WhatsApp ad set.
  pixelId?: string;
  conversionEvent?: string;
}

export interface CreateAdParams {
  adAccountId: string; // Meta creates ads on the AD ACCOUNT's edge, not the ad set's
  metaAdSetId: string;
  name: string;
  creativeId: string; // an existing Meta ad creative id (AIC-51 produces these)
}

// AIC-89 — the website-destination builder step's Pixel picker.
export interface PixelOption {
  id: string;
  name: string;
}

// null = couldn't determine (network failure, or the check itself is
// inconclusive) — never a confident "no events" from an ambiguous read, same
// discipline as AccessProbe (AIC-101).
export interface PixelRecencyCheck {
  hasRecentEvents: boolean | null;
}

export interface BuilderWriter {
  createCampaign(params: CreateCampaignParams): Promise<string>; // → new meta_campaign_id
  createAdSet(params: CreateAdSetParams): Promise<string>; // → new meta_ad_set_id
  createAd(params: CreateAdParams): Promise<string>; // → new meta_ad_id
  listPixels(adAccountId: string): Promise<PixelOption[]>;
  checkPixelEventRecency(pixelId: string, eventName: string): Promise<PixelRecencyCheck>;
  // Rollback (user decision, 2026-08-19). A build is all-or-nothing on Meta:
  // if any step fails, everything that attempt created is deleted, so the ad
  // account returns to exactly its pre-attempt state. Replaces AIC-50's
  // resume-point design, whose reasoning rested on creates being PAUSED —
  // AIC-106 made them ACTIVE, turning every resume point into a live object.
  //
  // One method for all three kinds: Meta's DELETE /{id} is the same call for
  // a campaign, an ad set and an ad.
  deleteObject(metaId: string): Promise<void>;
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
  // Rollback assertions: what the build deleted, in the order it deleted it.
  public deleted: string[] = [];
  // Simulates a cleanup call that itself fails — rollback must stay
  // best-effort and must never mask the ORIGINAL error with a cleanup error.
  public failDeletes = false;
  private counter = 0;

  async deleteObject(metaId: string): Promise<void> {
    if (this.failDeletes) throw new Error(`simulated delete failure for ${metaId}`);
    this.deleted.push(metaId);
  }

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

  public pixels: PixelOption[] = [];
  public pixelRecency: PixelRecencyCheck = { hasRecentEvents: true };
  async listPixels(_adAccountId: string): Promise<PixelOption[]> {
    return this.pixels;
  }
  async checkPixelEventRecency(_pixelId: string, _eventName: string): Promise<PixelRecencyCheck> {
    return this.pixelRecency;
  }
}
