import { describe, it, expect } from "vitest";
import { summarizeAngles, describeCreativeContext, type PastAd, type CreativeContext } from "./creative-context.js";

const names = (r: { angles: Array<{ angle: string }> }) => r.angles.map((a) => a.angle);

function ad(over: Partial<PastAd> = {}): PastAd {
  return {
    adId: "ad_1", name: null, headline: "כותרת", primaryText: "גוף",
    angle: "price", angleConfidence: "clear", angles: ["price"],
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
    expect(names(r)).toEqual(expect.arrayContaining(["price", "trust"]));
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
    expect(names(r)[0]).toBe("local");
  });

  it("an angle tried on an ad that never delivered ranks last, but is not lost", () => {
    const r = summarizeAngles([
      ad({ adId: "never_ran", angle: "speed", angles: ["speed"], spendAgorot: 0, leads: null, cplAgorot: null }),
      ad({ adId: "ran", angle: "price", angles: ["price"], cplAgorot: 3000 }),
    ]);
    expect(names(r)).toEqual(["price", "speed"]);
  });
});

// The real Ads Agent account, exactly as it looked in the ops channel: four
// ads, ₪1 + ₪16 + ₪3 + ₪6, zero leads. Reported as "every ad argues price",
// which was true — but the first version implied price had been TESTED and
// failed. Zero leads on ₪26 is the expected outcome at that spend, not a
// result, and an angle ruled out on that evidence is ruled out forever.
describe("summarizeAngles — attempted is not the same as tested", () => {
  const cheap = (id: string, spend: number) =>
    ad({ adId: id, spendAgorot: spend, leads: 0, cplAgorot: null });

  it("₪26 across four ads is ATTEMPTED, never tested", () => {
    const r = summarizeAngles([cheap("a", 100), cheap("b", 1600), cheap("c", 300), cheap("d", 600)]);
    expect(r.angles).toHaveLength(1);
    expect(r.angles[0].state).toBe("attempted");
    expect(r.angles[0].spendAgorot).toBe(2600);
  });

  it("sums spend ACROSS the ads carrying the angle", () => {
    // Three ads at ₪60 each is a real test of the angle even though no single
    // ad clears the bar on its own — the angle is what is being judged.
    const r = summarizeAngles([cheap("a", 6000), cheap("b", 6000), cheap("c", 6000)]);
    expect(r.angles[0].state).toBe("tested");
  });

  it("clears the bar at exactly the engine's own creative-spend threshold", () => {
    // Inherited, not invented: the same figure the engine already requires
    // before it will judge a single creative.
    expect(summarizeAngles([cheap("a", 15000)]).angles[0].state).toBe("tested");
    expect(summarizeAngles([cheap("a", 14999)]).angles[0].state).toBe("attempted");
  });

  it("still reports the single-angle pattern — that claim is about variety, not spend", () => {
    // "All four of your ads argue price" is true whatever they spent. What
    // changes is whether we may also say it did not work.
    const r = summarizeAngles([cheap("a", 100), cheap("b", 600)]);
    expect(r.singleAngle).toBe("price");
    expect(r.angles[0].state).toBe("attempted");
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
    angles: [{ angle: "price", adCount: 2, spendAgorot: 20000, leads: 10, state: "tested", clearAdCount: 2 }],
    unclassifiedAds: 0, adsRead: 2, adsTotal: 2, singleAngle: "price", market: null,
  };

  it("leads with the business, because that is the half a human can fix on the call", () => {
    const t = describeCreativeContext(base, { businessName: "מספרה", email: "a@b.com" });
    expect(t).toContain("מספרה");
    expect(t).toContain("תספורת ראשונה חינם");
    expect(t).toContain("missing: differentiators");
  });

  it("says out loud when every ad argues the same thing, and how many that is", () => {
    // "every readable ad" over two ads is a far weaker statement than over
    // eight, and the reader cannot tell which without being told the count.
    expect(describeCreativeContext(base, { businessName: "מספרה" })).toContain("All 2 readable ad(s) argue");
  });

  it("refuses to imply a verdict on an angle that never got the budget", () => {
    const thin: CreativeContext = {
      ...base,
      angles: [{ angle: "price", adCount: 4, spendAgorot: 2600, leads: 0, state: "attempted", clearAdCount: 4 }],
    };
    const t = describeCreativeContext(thin, { businessName: "מספרה" });
    expect(t).toContain("ATTEMPTED, not judged");
    expect(t).toContain("NOT had enough spend");
    expect(t).not.toContain("not 4 tests");
  });

  it("names the audience — copy written without knowing who it is for is guessing", () => {
    const t = describeCreativeContext(
      { ...base, business: { ...base.business, primaryCustomer: "נשים 30-50 בשרון" } },
      { businessName: "מספרה" },
    );
    expect(t).toContain("נשים 30-50 בשרון");
  });

  it("truncates on a word boundary, so a cut field never reads as corrupted data", () => {
    const t = describeCreativeContext(
      { ...base, business: { ...base.business, offer: "מילה ".repeat(80) } },
      { businessName: "מספרה" },
    );
    expect(t).toContain("…");
    expect(t).not.toContain("מיל…");
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
