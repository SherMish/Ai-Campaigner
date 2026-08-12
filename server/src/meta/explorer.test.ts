import { describe, it, expect } from "vitest";
import { normalizeMetrics, normalizeTargeting, normalizeCreative } from "./explorer.js";

describe("normalizeMetrics (AIC-45)", () => {
  it("converts currency-unit strings to agorot and passes rankings through", () => {
    const m = normalizeMetrics({
      spend: "123.45",
      impressions: "10000",
      reach: "8000",
      frequency: "1.25",
      cpm: "12.34",
      ctr: "1.5",
      cpc: "0.98",
      actions: [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "5" }],
      quality_ranking: "ABOVE_AVERAGE",
      engagement_rate_ranking: "AVERAGE",
      conversion_rate_ranking: "BELOW_AVERAGE_10",
    });
    expect(m.spendAgorot).toBe(12345);
    expect(m.impressions).toBe(10000);
    expect(m.reach).toBe(8000);
    expect(m.frequency).toBe(1.25);
    expect(m.cpmAgorot).toBe(1234);
    expect(m.ctrPct).toBe(1.5);
    expect(m.cpcAgorot).toBe(98);
    expect(m.leads).toBe(5);
    expect(m.cplAgorot).toBe(Math.round(12345 / 5));
    expect(m.qualityRanking).toBe("ABOVE_AVERAGE");
    expect(m.engagementRateRanking).toBe("AVERAGE");
    expect(m.conversionRateRanking).toBe("BELOW_AVERAGE_10");
  });

  it("returns an honest empty/null metrics object when Meta has no row (no data yet)", () => {
    const m = normalizeMetrics(undefined);
    expect(m.spendAgorot).toBe(0);
    expect(m.reach).toBeNull();
    expect(m.cplAgorot).toBeNull();
    expect(m.qualityRanking).toBeNull();
  });
});

describe("normalizeTargeting (AIC-45)", () => {
  it("reads age/gender/geo/interests, defaulting unset gender to 'all'", () => {
    const t = normalizeTargeting({
      age_min: 25,
      age_max: 45,
      genders: [2],
      geo_locations: { countries: ["IL"] },
      flexible_spec: [{ interests: [{ name: "Fitness" }, { name: "Nutrition" }] }],
    });
    expect(t.ageMin).toBe(25);
    expect(t.ageMax).toBe(45);
    expect(t.genders).toEqual(["female"]);
    expect(t.geoCountries).toEqual(["IL"]);
    expect(t.interests).toEqual(["Fitness", "Nutrition"]);
  });

  it("defaults to 'all' genders and no interests when unset", () => {
    const t = normalizeTargeting({ age_min: 18, age_max: 65, geo_locations: { countries: ["IL"] } });
    expect(t.genders).toEqual(["all"]);
    expect(t.interests).toEqual([]);
  });
});

describe("normalizeCreative (AIC-45)", () => {
  it("reads a standard single-image/video creative (object_story_spec shape)", () => {
    const c = normalizeCreative({
      id: "crea_1", name: "Winter promo", title: "20% off", body: "Book now",
      call_to_action_type: "BOOK_NOW", image_url: "https://x/img.jpg", video_id: undefined,
    });
    expect(c?.isFlexible).toBe(false);
    expect(c?.flexibleAssetCounts).toBeNull();
    expect(c?.title).toBe("20% off");
    expect(c?.imageUrl).toBe("https://x/img.jpg");
    expect(c?.pageId).toBeNull();
  });

  it("reads the Page id off object_story_spec", () => {
    const c = normalizeCreative({ id: "crea_4", object_story_spec: { page_id: "1234567890" } });
    expect(c?.pageId).toBe("1234567890");
  });

  it("recognizes a flexible/dynamic creative (asset_feed_spec with multiple assets) and counts its assets — never renders it as broken", () => {
    const c = normalizeCreative({
      id: "crea_2",
      name: "Dynamic set",
      asset_feed_spec: {
        images: [{ hash: "a" }, { hash: "b" }],
        videos: [],
        bodies: [{ text: "Body 1" }, { text: "Body 2" }],
        titles: [{ text: "Title 1" }],
      },
    });
    expect(c?.isFlexible).toBe(true);
    expect(c?.flexibleAssetCounts).toEqual({ images: 2, videos: 0, bodies: 2, titles: 1 });
  });

  it("returns null for a missing creative rather than throwing", () => {
    expect(normalizeCreative(undefined)).toBeNull();
  });

  it("falls back to the thumbnail when there's no direct image_url (e.g. a video creative)", () => {
    const c = normalizeCreative({ id: "crea_3", video_id: "v1", thumbnail_url: "https://x/thumb.jpg" });
    expect(c?.imageUrl).toBe("https://x/thumb.jpg");
    expect(c?.videoId).toBe("v1");
  });
});
