import { describe, expect, it } from "vitest";
import { intentStatus } from "./types.js";

// AIC-100: intentStatus is the one place a raw Meta status string becomes our
// two-value vocabulary — every own-status read (ad, ad set, campaign) goes
// through it.
describe("intentStatus", () => {
  it("ACTIVE → active", () => {
    expect(intentStatus("ACTIVE")).toBe("active");
  });

  it("PAUSED, any other Meta status string, null, and undefined → paused", () => {
    expect(intentStatus("PAUSED")).toBe("paused");
    expect(intentStatus("ARCHIVED")).toBe("paused");
    expect(intentStatus("DELETED")).toBe("paused");
    expect(intentStatus(null)).toBe("paused");
    expect(intentStatus(undefined)).toBe("paused");
  });
});
