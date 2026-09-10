import { describe, it, expect } from "vitest";
import { onboardingStep, STEP_INDEX } from "./onboarding-step";

describe("onboardingStep", () => {
  it("sends a JUST-REGISTERED user (no customer yet) to the connect step", () => {
    // The bug: signup writes app_users with customer_id = NULL, so /overview
    // returns customer: null. The old `?? "A"` fallback showed "book an intro
    // call" and made the connect button unreachable — while connecting is the
    // very thing that CREATES the customer.
    expect(onboardingStep(null)).toBe("C");
    expect(onboardingStep(undefined)).toBe("C");
  });

  it("maps each real status to its card", () => {
    expect(onboardingStep({ onboardingStatus: "call_scheduled" })).toBe("A");
    expect(onboardingStep({ onboardingStatus: "meta_connection_required" })).toBe("C");
    expect(onboardingStep({ onboardingStatus: "campaign_under_review" })).toBe("D");
    expect(onboardingStep({ onboardingStatus: "ready" })).toBe("F");
  });

  it("keeps an UNRECOGNISED status on 'A', not on connect", () => {
    // A real customer whose state we cannot read is different from a user with
    // no customer. Guessing "connect" for someone who may already be connected
    // would be a worse wrong answer than the neutral first step.
    expect(onboardingStep({ onboardingStatus: "something_new" })).toBe("A");
    expect(onboardingStep({ onboardingStatus: "" })).toBe("A");
  });

  it("gives every step a stepper position", () => {
    for (const s of ["A", "C", "D", "F"] as const) {
      expect(STEP_INDEX[s]).toBeGreaterThan(0);
    }
  });
});
