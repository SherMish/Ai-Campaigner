import { describe, it, expect } from "vitest";
import { summarizeAngles, describeCreativeContext, type PastAd, type CreativeContext } from "./creative-context.js";

function ad(over: Partial<PastAd> = {}): PastAd {
  return {
    adId: "ad_1", name: null, headline: "כותרת", primaryText: "גוף",
    angle: "price", angles: ["price"],
    spendAgorot: 10000, leads: 5, cplAgorot: 2000,
    relevantRate: null, costPerRelevantAgorot: null, fromExistingPost: false, ...over,
  };
}

describe("summarizeAngles", () => {
  it("flags the case that matters: every readable ad arguing the same thing", () => {
    // Four ads on one angle are one test run four times. This was TRUE on two
    // of the three real accounts the first time this ran, which is why it is
    // the headline of the panel rather than a footnote.
    const r = summarizeAngles([ad({ adId: "a" }), ad({ adId: "b" }), ad({ adId: "c" })]);
    expect(r.singleAngle).toBe("price");
  });

  it("says nothing when the ads genuinely vary", () => {
    const r = summarizeAngles([ad({ adId: "a" }), ad({ adId: "b", angle: "trust", angles: ["trust"] })]);
    expect(r.singleAngle).toBeNull();
    expect(r.anglesTested).toEqual(expect.arrayContaining(["price", "trust"]));
  });

  it("does not call ONE ad a pattern", () => {
    expect(summarizeAngles([ad()]).singleAngle).toBeNull();
  });

  it("ignores unreadable ads when judging sameness, and counts them separately", () => {
    // An ad we could not classify is not evidence of variety. But it must be
    // COUNTED, or "you only ever tried price" is a claim we can't support.
    const r = summarizeAngles([ad({ adId: "a" }), ad({ adId: "b" }), ad({ adId: "c", angle: null, angles: [] })]);
    expect(r.singleAngle).toBe("price");
    expect(r.unclassifiedAds).toBe(1);
  });

  it("an ad with no copy at all is not 'unclassified' — there was nothing to read", () => {
    const r = summarizeAngles([ad({ angle: null, angles: [], headline: null, primaryText: null })]);
    expect(r.unclassifiedAds).toBe(0);
  });

  it("ranks angles by what the ad actually achieved, not by insertion order", () => {
    // The expensive ad is listed first in the input; the cheap one won.
    const r = summarizeAngles([
      ad({ adId: "pricey", angle: "trust", angles: ["trust"], cplAgorot: 9000 }),
      ad({ adId: "cheap", angle: "local", angles: ["local"], cplAgorot: 1000 }),
    ]);
    expect(r.anglesTested[0]).toBe("local");
  });

  it("an angle tried on an ad that never delivered ranks last, but is not lost", () => {
    const r = summarizeAngles([
      ad({ adId: "never_ran", angle: "speed", angles: ["speed"], spendAgorot: 0, leads: null, cplAgorot: null }),
      ad({ adId: "ran", angle: "price", angles: ["price"], cplAgorot: 3000 }),
    ]);
    expect(r.anglesTested).toEqual(["price", "speed"]);
  });
});

describe("describeCreativeContext — the operator's copy", () => {
  const base: CreativeContext = {
    business: {
      businessName: "מספרה", category: "", mainService: "", geoArea: "", primaryCustomer: "",
      offer: "תספורת ראשונה חינם", differentiators: "", objections: "", priceRange: "",
      copyConstraints: "", leadFollowup: "", contactName: "", contactPhone: "", contactEmail: "",
    },
    businessQuality: { state: "broken", missing: ["differentiators"], vague: [], reason: "missing: differentiators" },
    pastAds: [ad(), ad({ adId: "b" })],
    anglesTested: ["price"],
    unclassifiedAds: 0, adsRead: 2, adsTotal: 2, singleAngle: "price", market: null,
  };

  it("leads with the business, because that is the half a human can fix on the call", () => {
    const t = describeCreativeContext(base, { businessName: "מספרה", email: "a@b.com" });
    expect(t).toContain("מספרה");
    expect(t).toContain("תספורת ראשונה חינם");
    expect(t).toContain("missing: differentiators");
  });

  it("says out loud when every ad argues the same thing", () => {
    expect(describeCreativeContext(base, { businessName: "מספרה" })).toContain("EVERY readable ad");
  });

  it("admits when we could not read every ad, rather than under-reporting history", () => {
    const t = describeCreativeContext({ ...base, adsRead: 2, adsTotal: 7 }, { businessName: "מספרה" });
    expect(t).toContain("read 2 of 7");
  });

  it("stays inside Telegram's message limit even with long fields", () => {
    const long = "א".repeat(5000);
    const t = describeCreativeContext(
      { ...base, business: { ...base.business, offer: long, differentiators: long } },
      { businessName: long },
    );
    expect(t.length).toBeLessThanOrEqual(3800);
  });
});
