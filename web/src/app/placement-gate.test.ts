import { describe, it, expect } from "vitest";
import { placementBlocker, placementFallback } from "./placement-gate";

describe("placementBlocker (AIC-177)", () => {
  it("blocks Instagram only when no Instagram account is connected", () => {
    expect(placementBlocker("instagram", { hasInstagram: false })).toBe("no_instagram");
    expect(placementBlocker("instagram", { hasInstagram: true })).toBeNull();
  });

  it("never blocks Advantage+ or Facebook", () => {
    // A Page is required to create ANY ad set, so a Facebook placement can
    // never be the unavailable one — and Advantage+ is Meta's own default.
    for (const has of [true, false]) {
      expect(placementBlocker("advantage", { hasInstagram: has })).toBeNull();
      expect(placementBlocker("facebook", { hasInstagram: has })).toBeNull();
    }
  });
});

describe("placementFallback (AIC-177)", () => {
  it("returns to Advantage+ when the held choice became unavailable", () => {
    // The customer picked Instagram, then it disconnected. Submitting would
    // fail server-side with a reason invisible from this screen.
    expect(placementFallback("instagram", { hasInstagram: false })).toBe("advantage");
  });

  it("leaves a still-valid choice alone", () => {
    expect(placementFallback("instagram", { hasInstagram: true })).toBeNull();
    expect(placementFallback("advantage", { hasInstagram: false })).toBeNull();
    expect(placementFallback("facebook", { hasInstagram: false })).toBeNull();
  });
});
