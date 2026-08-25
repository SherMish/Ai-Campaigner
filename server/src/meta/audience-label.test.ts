import { describe, it, expect } from "vitest";
import { normalizeAdSetMeta, deriveAudienceLabels, type AdSetMeta } from "./audience-label.js";

describe("normalizeAdSetMeta", () => {
  it("normalizes age + a single gender", () => {
    const m = normalizeAdSetMeta({
      id: "as_1", name: "Women 35-45",
      targeting: { age_min: 35, age_max: 45, genders: [2] },
    });
    expect(m).toMatchObject({ adSetId: "as_1", ageMin: 35, ageMax: 45, genders: "female" });
  });

  // REGRESSION (real GelNails data, AIC-73 round 2): with Advantage+ audience
  // expansion on — the default for builder-created ad sets — Meta reports
  // age_min/age_max as the EXPANSION CEILING (18–65) while the actually
  // configured range lives in age_range. The panel confidently showed
  // "18–65", an audience the customer never chose. A confidently-wrong label
  // is worse than a raw name.
  it("prefers age_range over the Advantage+ expansion ceiling in age_min/age_max", () => {
    const m = normalizeAdSetMeta({
      id: "as_1",
      name: "IL | Ramat Gan, Givatayim | Women 18-46 | Advantage+",
      targeting: { age_min: 18, age_max: 65, age_range: [21, 46], genders: [2] },
    });
    expect(m).toMatchObject({ ageMin: 21, ageMax: 46 });
  });

  it("falls back to age_min/age_max when age_range is absent", () => {
    const m = normalizeAdSetMeta({ id: "as_1", targeting: { age_min: 25, age_max: 40 } });
    expect(m).toMatchObject({ ageMin: 25, ageMax: 40 });
  });

  it("ignores a malformed age_range rather than producing a garbage range", () => {
    const m = normalizeAdSetMeta({ id: "as_1", targeting: { age_min: 25, age_max: 40, age_range: [30] } });
    expect(m).toMatchObject({ ageMin: 25, ageMax: 40 });
  });

  it("localizes Meta's English place names to Hebrew (they're never returned localized)", () => {
    const m = normalizeAdSetMeta({
      id: "as_1",
      targeting: { geo_locations: { cities: [{ name: "Ramat Gan" }, { name: "Giv'atayim" }] } },
    });
    expect(m.geoSummary).toBe("רמת גן, גבעתיים");
  });

  it("leaves an unmapped place name unchanged rather than mangling it", () => {
    const m = normalizeAdSetMeta({
      id: "as_1",
      targeting: { geo_locations: { cities: [{ name: "Someplace New" }] } },
    });
    expect(m.geoSummary).toBe("Someplace New");
  });

  it("no genders array (or both) → 'all'", () => {
    expect(normalizeAdSetMeta({ id: "as_1", targeting: {} }).genders).toBe("all");
    expect(normalizeAdSetMeta({ id: "as_1", targeting: { genders: [1, 2] } }).genders).toBe("all");
  });

  it("joins geo places, capped at 2", () => {
    const m = normalizeAdSetMeta({
      id: "as_1",
      targeting: { geo_locations: { cities: [{ name: "תל אביב" }, { name: "רמת גן" }, { name: "חיפה" }] } },
    });
    expect(m.geoSummary).toBe("תל אביב, רמת גן");
  });
});

describe("normalizeAdSetMeta — isManaged (AIC-65: exclude dead/draft ad sets)", () => {
  it("is managed by default (no ads field requested, no deleted/archived status)", () => {
    expect(normalizeAdSetMeta({ id: "as_1", effective_status: "ACTIVE" }).isManaged).toBe(true);
  });

  it("is NOT managed when effective_status is DELETED or ARCHIVED", () => {
    expect(normalizeAdSetMeta({ id: "as_1", effective_status: "DELETED" }).isManaged).toBe(false);
    expect(normalizeAdSetMeta({ id: "as_1", effective_status: "ARCHIVED" }).isManaged).toBe(false);
  });

  it("is NOT managed when ACTIVE but has zero ads — the real GelNails case (never-published draft)", () => {
    const m = normalizeAdSetMeta({ id: "as_1", effective_status: "ACTIVE", ads: { data: [] } });
    expect(m.isManaged).toBe(false);
  });

  it("is managed when it has at least one ad", () => {
    const m = normalizeAdSetMeta({ id: "as_1", effective_status: "ACTIVE", ads: { data: [{ id: "ad_1" }] } });
    expect(m.isManaged).toBe(true);
  });

  it("a merely PAUSED ad set (customer's own deliberate pause) is still managed", () => {
    const m = normalizeAdSetMeta({ id: "as_1", effective_status: "PAUSED", ads: { data: [{ id: "ad_1" }] } });
    expect(m.isManaged).toBe(true);
  });

  // AIC-130, found live. A customer deleted both ads from a live ACTIVE ad
  // set. isManaged went false (zero ads reads as "unpublished draft"), the
  // add-an-ad picker filtered on it, and the screen said "no ad sets found in
  // the campaign" — so there was no way to put an ad back into a perfectly
  // healthy ad set. The campaign was unrecoverable through the UI.
  //
  // The two facts have to be separable: isManaged answers "is there anything
  // to SHOW", existsOnMeta answers "can I WRITE here". For an empty ad set
  // they disagree, and having no ads is the strongest reason to offer it as a
  // place to add one.
  it("an ACTIVE ad set whose ads were all deleted still EXISTS, even though it is not managed", () => {
    const m = normalizeAdSetMeta({ id: "as_1", effective_status: "ACTIVE", ads: { data: [] } });
    expect(m.isManaged).toBe(false);
    expect(m.existsOnMeta).toBe(true);
  });

  it("a deleted or archived ad set does not exist, so it is never offered", () => {
    for (const st of ["DELETED", "ARCHIVED"]) {
      const m = normalizeAdSetMeta({ id: "as_1", effective_status: st, ads: { data: [{ id: "ad_1" }] } });
      expect(m.existsOnMeta).toBe(false);
    }
  });
});

function meta(o: Partial<AdSetMeta> & Pick<AdSetMeta, "adSetId">): AdSetMeta {
  return { name: "", ageMin: null, ageMax: null, genders: "all", geoSummary: "", isDynamicCreative: false, status: "active", isManaged: true, existsOnMeta: true, ...o };
}

describe("deriveAudienceLabels — never a raw ad-set name, compose from the ad set's OWN targeting (AIC-73)", () => {
  // REGRESSION: the old rule only labeled a dimension when it DIFFERED across
  // siblings — with exactly one ad set (the most common shape: a single small
  // business with one audience), nothing ever differs, so every real account
  // fell through to the raw Meta name. That's the live bug this section pins.
  it("a SINGLE ad set gets its own composed label, never the raw Meta name", () => {
    const labels = deriveAudienceLabels([
      meta({ adSetId: "a", ageMin: 18, ageMax: 46, genders: "female", geoSummary: "רמת גן, Givatayim", name: "IL | Ramat Gan, Givatayim | Women 18-46 | Advantage+" }),
    ]);
    expect(labels.get("a")).toBe("נשים · 18–46 · רמת גן, Givatayim");
  });

  it("composes gender + age + geo together, not just the differing dimension", () => {
    const labels = deriveAudienceLabels([
      meta({ adSetId: "a", ageMin: 18, ageMax: 35, genders: "male", geoSummary: "תל אביב" }),
      meta({ adSetId: "b", ageMin: 35, ageMax: 45, genders: "male", geoSummary: "תל אביב" }),
    ]);
    expect(labels.get("a")).toBe("גברים · 18–35 · תל אביב");
    expect(labels.get("b")).toBe("גברים · 35–45 · תל אביב");
  });

  it("no age_max → open-ended '+' label", () => {
    const labels = deriveAudienceLabels([meta({ adSetId: "a", ageMin: 55 })]);
    expect(labels.get("a")).toBe("55+");
  });

  it("genders 'all' is omitted from the composition (not spelled out)", () => {
    const labels = deriveAudienceLabels([meta({ adSetId: "a", ageMin: 25, ageMax: 40, genders: "all" })]);
    expect(labels.get("a")).toBe("25–40");
  });

  it("nothing structured at all → a neutral phrase, never the raw name", () => {
    const labels = deriveAudienceLabels([meta({ adSetId: "a", name: "IL | Broad | Advantage+" })]);
    expect(labels.get("a")).toBe("קהל כללי");
  });

  it("two ad sets with identical targeting get disambiguated, still never the raw name", () => {
    const labels = deriveAudienceLabels([
      meta({ adSetId: "a", ageMin: 25, ageMax: 40, name: "Set A" }),
      meta({ adSetId: "b", ageMin: 25, ageMax: 40, name: "Set B" }),
    ]);
    expect(labels.get("a")).toBe("25–40");
    expect(labels.get("b")).toBe("25–40 (2)");
  });

  it("empty input → empty map", () => {
    expect(deriveAudienceLabels([]).size).toBe(0);
  });
});
