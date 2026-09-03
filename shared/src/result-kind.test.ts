import { describe, it, expect } from "vitest";
import { resultKindOf } from "./recommended-defaults.js";

describe("resultKindOf (AIC-188)", () => {
  it("calls an engagement campaign's results engagements", () => {
    expect(resultKindOf("engagement")).toBe("engagement");
  });

  it("calls everything else leads", () => {
    // WhatsApp and website campaigns both produce a lead; only engagement is
    // a different KIND of outcome.
    expect(resultKindOf("whatsapp")).toBe("leads");
    expect(resultKindOf("website")).toBe("leads");
  });

  it("defaults to leads for an unknown or missing destination", () => {
    // Every row that predates the destination column genuinely is a leads
    // campaign, so this default is correct rather than merely safe.
    expect(resultKindOf(null)).toBe("leads");
    expect(resultKindOf(undefined)).toBe("leads");
    expect(resultKindOf("something_new")).toBe("leads");
  });
});
