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

function meta(o: Partial<AdSetMeta> & Pick<AdSetMeta, "adSetId">): AdSetMeta {
  return { name: "", ageMin: null, ageMax: null, genders: "all", geoSummary: "", ...o };
}

describe("deriveAudienceLabels — never show a raw ad-set name or 'ad set N' when something structured differs", () => {
  it("age differs → age-range label per ad set", () => {
    const labels = deriveAudienceLabels([
      meta({ adSetId: "a", ageMin: 18, ageMax: 35 }),
      meta({ adSetId: "b", ageMin: 35, ageMax: 45 }),
    ]);
    expect(labels.get("a")).toBe("18–35");
    expect(labels.get("b")).toBe("35–45");
  });

  it("no age_max → open-ended '+' label", () => {
    const labels = deriveAudienceLabels([meta({ adSetId: "a", ageMin: 18, ageMax: 35 }), meta({ adSetId: "b", ageMin: 55 })]);
    expect(labels.get("b")).toBe("55+");
  });

  it("same age, gender differs → gender label", () => {
    const labels = deriveAudienceLabels([
      meta({ adSetId: "a", ageMin: 25, ageMax: 40, genders: "male" }),
      meta({ adSetId: "b", ageMin: 25, ageMax: 40, genders: "female" }),
    ]);
    expect(labels.get("a")).toBe("גברים");
    expect(labels.get("b")).toBe("נשים");
  });

  it("same age + gender, geo differs → geo label", () => {
    const labels = deriveAudienceLabels([
      meta({ adSetId: "a", ageMin: 25, ageMax: 40, geoSummary: "תל אביב" }),
      meta({ adSetId: "b", ageMin: 25, ageMax: 40, geoSummary: "חיפה" }),
    ]);
    expect(labels.get("a")).toBe("תל אביב");
    expect(labels.get("b")).toBe("חיפה");
  });

  it("nothing structured differs → falls back to the ad set's own name", () => {
    const labels = deriveAudienceLabels([
      meta({ adSetId: "a", ageMin: 25, ageMax: 40, name: "Set A" }),
      meta({ adSetId: "b", ageMin: 25, ageMax: 40, name: "Set B" }),
    ]);
    expect(labels.get("a")).toBe("Set A");
    expect(labels.get("b")).toBe("Set B");
  });

  it("empty input → empty map", () => {
    expect(deriveAudienceLabels([]).size).toBe(0);
  });
});
