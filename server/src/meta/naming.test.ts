import { describe, it, expect } from "vitest";
import { adName, adSetName, campaignName, nextAdIndex, OUR_PREFIX } from "./naming.js";
import { composeAudienceLabel } from "./audience-label.js";

describe("campaignName", () => {
  it("names what the campaign does and when we started it, not just who we are", () => {
    // The bug: every self-serve campaign was `strings.he.appName` and nothing
    // else, so a customer who built twice got two rows both called "Ads Agent".
    expect(campaignName({ destination: "whatsapp", createdAt: new Date("2026-08-30T12:00:00Z") }))
      .toBe("Ads Agent · וואטסאפ · 2026-08");
    expect(campaignName({ destination: "website", createdAt: new Date("2026-01-04T00:00:00Z") }))
      .toBe("Ads Agent · אתר · 2026-01");
  });

  it("keeps the prefix — the account also holds the customer's own campaigns", () => {
    expect(campaignName({ destination: "engagement", createdAt: new Date("2026-08-30T12:00:00Z") }))
      .toContain(OUR_PREFIX);
  });

  it("pads the month, so names sort", () => {
    expect(campaignName({ destination: "whatsapp", createdAt: new Date("2026-09-01T00:00:00Z") }))
      .toMatch(/2026-09$/);
  });

  it("THROWS on a destination it has no word for", () => {
    // Same posture as resolveDestinationShape: a destination nobody named is
    // an unfinished change, and a generic fallback would ship it silently onto
    // a customer's ad account.
    expect(() => campaignName({ destination: "sms", createdAt: new Date("2026-08-30T00:00:00Z") }))
      .toThrow(/no Hebrew name known/);
  });
});

describe("adSetName", () => {
  it("is the audience, in the customer's own words", () => {
    expect(adSetName({ genders: "female", ageMin: 35, ageMax: 55, countries: ["IL"] }))
      .toBe("נשים · 35–55 · ישראל");
  });

  it("is the SAME string the dashboard label composer produces", () => {
    // The whole reason it delegates: an operator comparing our dashboard to
    // Ads Manager must not have to wonder whether different wording means a
    // different audience.
    const targeting = { genders: "male" as const, ageMin: 25, ageMax: 44, countries: ["IL"] };
    expect(adSetName(targeting)).toBe(
      composeAudienceLabel({ genders: "male", ageMin: 25, ageMax: 44, geoSummary: "ישראל" }),
    );
  });

  it("omits gender when it targets everyone", () => {
    expect(adSetName({ genders: "all", ageMin: 18, ageMax: 65, countries: ["IL"] }))
      .toBe("18–65 · ישראל");
  });

  it("falls back to the generic label when there is no structured targeting", () => {
    expect(adSetName({ genders: "all", ageMin: null, ageMax: null, countries: [] })).toBe("קהל כללי");
  });

  it("no longer repeats the campaign name", () => {
    // Was `${campaign name} — קהל 1`, where the 1 was a literal: every build
    // produced the same ad-set name, and the campaign half was already shown
    // by Meta's own nesting.
    expect(adSetName({ genders: "female", ageMin: 35, ageMax: 55, countries: ["IL"] }))
      .not.toContain(OUR_PREFIX);
  });
});

describe("nextAdIndex / adName", () => {
  it("continues from the ads already in the ad set", () => {
    // THE COLLISION. The index used to be counted per drafting session, so
    // add-content put a second "מודעה 1" beside the existing one — and those
    // two are indistinguishable in the digest for post-based ads, which have
    // neither headline nor primary text to fall back on.
    expect(adName(nextAdIndex(["מודעה 1", "מודעה 2"]))).toBe("מודעה 3");
  });

  it("starts at 1 in a fresh ad set", () => {
    expect(adName(nextAdIndex([]))).toBe("מודעה 1");
  });

  it("never reuses an index in an ad set we did not name", () => {
    // An adopted ad set whose ads carry the customer's own names has no
    // parsable index; starting from 1 would produce a name that reads like the
    // first of six.
    expect(nextAdIndex(["Summer promo", "Video test", null])).toBe(4);
  });

  it("takes the higher of the biggest index and the count", () => {
    // One of ours plus one of theirs: 2 would collide with nothing, but 3 is
    // the honest position and stays right if the list grows out of order.
    expect(nextAdIndex(["מודעה 1", "Their ad"])).toBe(3);
    expect(nextAdIndex(["מודעה 7"])).toBe(8);
  });

  it("ignores names that merely start like ours", () => {
    expect(nextAdIndex(["מודעה 3 של הלקוח"])).toBe(2);
  });
});
