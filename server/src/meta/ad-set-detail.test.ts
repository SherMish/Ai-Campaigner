import { describe, it, expect } from "vitest";
import { normalizeAdSetDetail, placementOf } from "./ad-set-detail.js";

describe("placementOf (AIC-184)", () => {
  it("reads an ABSENT publisher_platforms as Advantage+", () => {
    // Supplying the field at all is what turns Advantage+ off, so its absence
    // is the value — the same asymmetry publisherPlatforms writes.
    expect(placementOf(undefined)).toBe("advantage");
    expect(placementOf([])).toBe("advantage");
  });

  it("names the two placements we can set", () => {
    expect(placementOf(["instagram"])).toBe("instagram");
    expect(placementOf(["facebook"])).toBe("facebook");
  });

  it("calls anything else custom rather than guessing", () => {
    // An ad set built in Ads Manager can carry any combination. Claiming it
    // matches one of our three would be a confident lie about where the money
    // goes.
    expect(placementOf(["facebook", "instagram"])).toBe("custom");
    expect(placementOf(["audience_network"])).toBe("custom");
  });
});

describe("normalizeAdSetDetail (AIC-184)", () => {
  it("lists every place, uncapped and localized", () => {
    // The label above this panel shows at most two; the whole point of the
    // panel is the full answer to "who am I paying to reach".
    const d = normalizeAdSetDetail({
      id: "as_1",
      targeting: { geo_locations: { cities: [{ name: "Ramat Gan" }, { name: "Giv'atayim" }], countries: ["IL"] } },
    });
    expect(d.places).toHaveLength(3);
    expect(d.places[0]).toBe("רמת גן");
  });

  it("keeps 'no ad-set budget' distinct from zero", () => {
    // Absent means the ad set draws from the campaign budget (CBO). Rendering
    // that as ₪0 would read as "this audience gets nothing".
    expect(normalizeAdSetDetail({ id: "as_1" }).dailyBudgetAgorot).toBeNull();
    expect(normalizeAdSetDetail({ id: "as_1", daily_budget: "3000" }).dailyBudgetAgorot).toBe(3000);
  });

  it("reports an unrecognised gender array as everyone, never a guess", () => {
    expect(normalizeAdSetDetail({ id: "a", targeting: { genders: [1] } }).genders).toBe("male");
    expect(normalizeAdSetDetail({ id: "a", targeting: { genders: [2] } }).genders).toBe("female");
    expect(normalizeAdSetDetail({ id: "a", targeting: { genders: [1, 2] } }).genders).toBe("all");
    expect(normalizeAdSetDetail({ id: "a", targeting: {} }).genders).toBe("all");
  });
});
