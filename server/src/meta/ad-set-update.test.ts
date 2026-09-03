import { describe, it, expect } from "vitest";
import { validateAdSetPatch, mergeTargeting, diffApplied } from "./ad-set-update.js";

describe("validateAdSetPatch (AIC-185)", () => {
  it("refuses Meta's own out-of-bounds ages here, not by a 400 mid-write", () => {
    expect(validateAdSetPatch({ ageMin: 12, ageMax: 40 })).toBe("age_out_of_range");
    expect(validateAdSetPatch({ ageMin: 18, ageMax: 66 })).toBe("age_out_of_range");
    expect(validateAdSetPatch({ ageMin: 40, ageMax: 30 })).toBe("age_inverted");
    expect(validateAdSetPatch({ ageMin: 18, ageMax: 40 })).toBeNull();
  });

  it("refuses an empty name but allows leaving the name alone", () => {
    expect(validateAdSetPatch({ name: "   " })).toBe("empty_name");
    expect(validateAdSetPatch({ ageMin: 18, ageMax: 40 })).toBeNull();
  });

  it("refuses a patch that changes nothing", () => {
    expect(validateAdSetPatch({})).toBe("nothing_to_change");
  });
});

describe("mergeTargeting (AIC-185)", () => {
  // The real shape from Liam's proven ad set, including the Advantage+ block
  // that a naive rebuild would have destroyed.
  const current = {
    age_min: 18, age_max: 65, age_range: [21, 46], genders: [2],
    geo_locations: { cities: [{ key: "1014712" }], location_types: ["home", "recent"] },
    brand_safety_content_filter_levels: ["FACEBOOK_RELAXED"],
    targeting_automation: { advantage_audience: 1, individual_setting: { age: 1 } },
    user_age_unknown: false,
  };

  it("preserves every key it was not asked to change", () => {
    // Meta REPLACES targeting wholesale, so anything not copied is destroyed.
    // Rebuilding from a known field list is how an edit silently turns off a
    // setting nobody was discussing.
    const next = mergeTargeting(current, { ageMin: 25 });
    expect(next.targeting_automation).toEqual(current.targeting_automation);
    expect(next.brand_safety_content_filter_levels).toEqual(current.brand_safety_content_filter_levels);
    expect(next.user_age_unknown).toBe(false);
  });

  it("drops Meta's derived age_range when the age changes", () => {
    // Sending a stale echo alongside a new range asks two different questions.
    const next = mergeTargeting(current, { ageMin: 25, ageMax: 45 });
    expect(next).not.toHaveProperty("age_range");
    expect(next.age_min).toBe(25);
    expect(next.age_max).toBe(45);
  });

  it("DELETES publisher_platforms for advantage, never sends an empty array", () => {
    // Supplying the key at all is what turns Advantage+ placements off.
    const withPlacement = mergeTargeting(current, { placement: "instagram" });
    expect(withPlacement.publisher_platforms).toEqual(["instagram"]);
    const back = mergeTargeting(withPlacement, { placement: "advantage" });
    expect(back).not.toHaveProperty("publisher_platforms");
  });

  it("restores the country when the last city is removed", () => {
    // Cities REPLACE countries (AIC-157), so clearing them without restoring
    // the country would leave an ad set targeting nowhere.
    const next = mergeTargeting(current, { cities: [] });
    const geo = next.geo_locations as Record<string, unknown>;
    expect(geo.countries).toEqual(["IL"]);
    expect(geo).not.toHaveProperty("cities");
    // The location_types the customer never touched survive.
    expect(geo.location_types).toEqual(["home", "recent"]);
  });

  it("sends only Meta's keys for places, never the names we display", () => {
    const next = mergeTargeting(current, {
      cities: [{ key: "1014712", name: "רמת גן", type: "city" }, { key: "777", name: "מרכז", type: "region" }],
    });
    const geo = next.geo_locations as { cities: unknown[]; regions: unknown[] };
    expect(geo.cities).toEqual([{ key: "1014712" }]);
    expect(geo.regions).toEqual([{ key: "777" }]);
  });
});

describe("diffApplied (AIC-185)", () => {
  const stored = { name: "נשים", ageMin: 18, ageMax: 40, genders: "female" as const, placement: "instagram" };

  it("is empty when Meta stored what was asked", () => {
    expect(diffApplied({ ageMin: 18, ageMax: 40 }, stored)).toEqual([]);
  });

  it("names the field Meta stored differently", () => {
    // The lived case: age 20–35 was sent and 18–65 came back. A 200 is not
    // evidence the write applied.
    const diff = diffApplied({ ageMin: 20, ageMax: 35 }, stored);
    expect(diff).toEqual([
      { field: "ageMin", asked: "20", stored: "18" },
      { field: "ageMax", asked: "35", stored: "40" },
    ]);
  });

  it("ignores fields the edit never touched", () => {
    // Meta normalizes things we did not ask about — reporting those would make
    // every successful edit look broken.
    expect(diffApplied({ name: "נשים" }, { ...stored, ageMin: 99 })).toEqual([]);
  });
});
