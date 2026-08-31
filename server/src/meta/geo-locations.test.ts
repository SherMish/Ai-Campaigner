import { describe, it, expect } from "vitest";
import { geoLocations } from "./campaign-adapter.js";
import { adSetName } from "./naming.js";

describe("geoLocations (AIC-157)", () => {
  it("targets the country when nothing was chosen — the old, only behaviour", () => {
    expect(geoLocations({ countries: ["IL"] })).toEqual({ countries: ["IL"] });
    expect(geoLocations({ countries: ["IL"], cities: [] })).toEqual({ countries: ["IL"] });
  });

  it("DROPS the country once cities are chosen", () => {
    // The expensive mistake this guards. Meta UNIONS the fields inside
    // geo_locations, so sending cities AND countries targets the cities plus
    // the whole country — the nationwide spend the picker exists to stop,
    // wearing the appearance of a narrowed audience. It would look right on
    // every screen and only show up in the bill.
    const r = geoLocations({ countries: ["IL"], cities: [{ key: "1014712", type: "city" }] });
    expect(r).toEqual({ cities: [{ key: "1014712" }] });
    expect(r.countries).toBeUndefined();
  });

  it("separates cities from regions — Meta keys them differently", () => {
    expect(geoLocations({
      countries: ["IL"],
      cities: [{ key: "1014712", type: "city" }, { key: "1721", type: "region" }],
    })).toEqual({ cities: [{ key: "1014712" }], regions: [{ key: "1721" }] });
  });

  it("sends only Meta's key, never a name", () => {
    // A name is not a targetable value: Meta's geo search answers in English
    // whatever you ask in, so a transcribed name is both wrong and untargetable.
    const r = geoLocations({ countries: ["IL"], cities: [{ key: "1013235", type: "city" }] }) as { cities: object[] };
    expect(Object.keys(r.cities[0])).toEqual(["key"]);
  });
});

describe("adSetName with places (AIC-157)", () => {
  it("names the cities, not the country, once they are chosen", () => {
    expect(adSetName({
      genders: "female", ageMin: 35, ageMax: 55, countries: ["IL"],
      cities: [{ name: "רמת גן" }],
    })).toBe("נשים · 35–55 · רמת גן");
  });

  it("still says ישראל when the ad set really is nationwide", () => {
    expect(adSetName({ genders: "female", ageMin: 35, ageMax: 55, countries: ["IL"], cities: [] }))
      .toBe("נשים · 35–55 · ישראל");
  });

  it("caps at two places, the same as the dashboard's audience label", () => {
    expect(adSetName({
      genders: "all", ageMin: 18, ageMax: 65, countries: ["IL"],
      cities: [{ name: "רמת גן" }, { name: "גבעתיים" }, { name: "תל אביב" }],
    })).toBe("18–65 · רמת גן, גבעתיים");
  });
});
