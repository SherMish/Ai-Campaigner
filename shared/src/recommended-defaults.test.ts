import { describe, it, expect } from "vitest";
import {
  BUSINESS_CATEGORY,
  CATEGORY_AUDIENCE_DEFAULTS,
  RECOMMENDED_SPECIAL_AD_CATEGORY,
  FIXED_DESTINATION,
  FIXED_CTA,
  WEBSITE_DESTINATION,
  WEBSITE_CTA,
  LEAD_CONVERSION_EVENTS,
  normalizeBusinessCategory,
  resolveAudienceDefault,
  resolveSpecialAdCategoryHint,
  resolveDestinationShape,
  resolveLeadActionType,
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

// AIC-89 sub-fix: FIXED_DESTINATION/FIXED_CTA had ZERO consumers — the Meta
// field literals they were meant to own ("CONVERSATIONS"/"WHATSAPP"/
// "WHATSAPP_MESSAGE") were re-hardcoded directly in campaign-adapter.ts,
// which is exactly how a Pixel campaign got a WhatsApp write (fixed
// separately by refusing at the additions chokepoint). This makes the
// constants the actual single source: every Meta-shape literal for a
// destination lives here once, and an unrecognized destination throws
// rather than silently falling back to the WhatsApp shape.
describe("resolveDestinationShape", () => {
  it("whatsapp resolves to the exact Meta fields FIXED_CTA/createAdSet need, sourced from the constants", () => {
    expect(resolveDestinationShape(FIXED_DESTINATION)).toEqual({
      optimizationGoal: "CONVERSATIONS",
      destinationType: "WHATSAPP",
      ctaType: FIXED_CTA,
    });
  });

  // AIC-102: website/Pixel is now a second recognized destination, resolved
  // from this same map — the additions/creative flow's link-CTA branch.
  it("website resolves to the link-based creative shape, sourced from the constants", () => {
    expect(resolveDestinationShape(WEBSITE_DESTINATION)).toEqual({
      optimizationGoal: "OFFSITE_CONVERSIONS",
      destinationType: "WEBSITE",
      ctaType: WEBSITE_CTA,
    });
  });

  it("REGRESSION: an unrecognized destination throws — never silently returns the WhatsApp shape", () => {
    // The exact failure mode this replaces: a Pixel campaign's write silently
    // reusing the WhatsApp shape because nothing checked the destination.
    expect(() => resolveDestinationShape("something_unrecognized")).toThrow(/something_unrecognized/);
    expect(() => resolveDestinationShape("")).toThrow();
  });
});

// AIC-89: the conversion-event picker's single source of truth for the
// Meta Insights action_type each event reports as.
describe("resolveLeadActionType", () => {
  it("resolves every curated event to its exact Insights action_type", () => {
    for (const e of LEAD_CONVERSION_EVENTS) {
      expect(resolveLeadActionType(e.value)).toBe(e.leadActionType);
    }
  });

  it("REGRESSION: COMPLETE_REGISTRATION resolves to the exact live-verified shape (free_beta_signups_leads)", () => {
    expect(resolveLeadActionType("COMPLETE_REGISTRATION")).toBe("offsite_conversion.fb_pixel_complete_registration");
  });

  it("throws for an unrecognized event rather than silently returning nothing", () => {
    expect(() => resolveLeadActionType("SOMETHING_MADE_UP")).toThrow(/SOMETHING_MADE_UP/);
  });

  it("every curated event has a non-empty, distinct leadActionType", () => {
    const seen = new Set<string>();
    for (const e of LEAD_CONVERSION_EVENTS) {
      expect(e.leadActionType.length).toBeGreaterThan(0);
      expect(seen.has(e.leadActionType)).toBe(false);
      seen.add(e.leadActionType);
    }
  });
});
