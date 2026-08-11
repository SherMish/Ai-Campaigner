import { describe, it, expect } from "vitest";
import {
  BUSINESS_CATEGORY,
  CATEGORY_AUDIENCE_DEFAULTS,
  RECOMMENDED_SPECIAL_AD_CATEGORY,
  normalizeBusinessCategory,
  resolveAudienceDefault,
  resolveSpecialAdCategoryHint,
} from "./recommended-defaults.js";

describe("normalizeBusinessCategory", () => {
  it("matches a known category case/whitespace-insensitively", () => {
    expect(normalizeBusinessCategory("Beautician")).toBe("beautician");
    expect(normalizeBusinessCategory("  tutor  ")).toBe("tutor");
  });

  it("falls back to 'other' for anything unrecognized — never throws, never guesses", () => {
    expect(normalizeBusinessCategory("education")).toBe("other");
    expect(normalizeBusinessCategory("")).toBe("other");
    expect(normalizeBusinessCategory("something completely made up")).toBe("other");
  });
});

describe("resolveAudienceDefault", () => {
  it("resolves per business type — beautician skews female, local radius", () => {
    const d = resolveAudienceDefault("beautician");
    expect(d.genders).toBe("female");
    expect(d.radiusKm).toBeLessThanOrEqual(10);
  });

  it("resolves a different default for a different category (tutor: wider radius, all genders)", () => {
    const beautician = resolveAudienceDefault("beautician");
    const tutor = resolveAudienceDefault("tutor");
    expect(tutor.genders).toBe("all");
    expect(tutor.radiusKm).toBeGreaterThan(beautician.radiusKm);
  });

  it("every known category has a sane age range and a positive radius", () => {
    for (const cat of BUSINESS_CATEGORY) {
      const d = CATEGORY_AUDIENCE_DEFAULTS[cat];
      expect(d.ageMin).toBeLessThan(d.ageMax);
      expect(d.radiusKm).toBeGreaterThan(0);
    }
  });

  it("an unrecognized category resolves to the honest broad 'other' default, not a crash", () => {
    const d = resolveAudienceDefault("something nobody typed before");
    expect(d).toEqual(CATEGORY_AUDIENCE_DEFAULTS.other);
  });
});

describe("special ad category", () => {
  it("defaults to NONE — never inferred as a positive declaration", () => {
    expect(RECOMMENDED_SPECIAL_AD_CATEGORY).toBe("NONE");
  });

  it("hints HOUSING for real_estate but never for a category with no known compliance concern", () => {
    expect(resolveSpecialAdCategoryHint("real_estate")).toBe("HOUSING");
    expect(resolveSpecialAdCategoryHint("beautician")).toBeNull();
    expect(resolveSpecialAdCategoryHint("restaurant")).toBeNull();
  });

  it("a hint is only a prompt, never a substitute for the explicit question — every category still resolves to a real value or null, not silently skipped", () => {
    for (const cat of BUSINESS_CATEGORY) {
      const hint = resolveSpecialAdCategoryHint(cat);
      expect(hint === null || hint !== "NONE").toBe(true);
    }
  });
});
