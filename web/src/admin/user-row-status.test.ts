import { describe, expect, it } from "vitest";
import { offersOnboarding } from "./user-row-status";

describe("offersOnboarding", () => {
  it("offers onboarding when the user has no business yet", () => {
    expect(offersOnboarding({ customerId: null, connectionReadiness: null })).toBe(true);
  });

  it("does NOT offer onboarding once fully connected (real regression case: Pisga, free_beta test)", () => {
    expect(offersOnboarding({ customerId: "c1", connectionReadiness: null })).toBe(false);
  });

  it("still offers onboarding for every readiness gap short of fully connected", () => {
    for (const reason of ["no_campaign", "not_launched", "missing_page", "connection_issue"] as const) {
      expect(offersOnboarding({ customerId: "c1", connectionReadiness: reason })).toBe(true);
    }
  });

  // AIC-103: found while wiring the new reason in — offering the (insert-
  // only) wizard here would create a SECOND connection/campaign trio for a
  // customer who already has a working one, just missing one field. Same
  // failure class as the null-case regression above, different trigger.
  it("does NOT offer onboarding for incomplete_config — already provisioned, re-running would duplicate it", () => {
    expect(offersOnboarding({ customerId: "c1", connectionReadiness: "incomplete_config" })).toBe(false);
  });
});
