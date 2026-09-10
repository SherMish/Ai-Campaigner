import { describe, it, expect } from "vitest";
import { onboardingStep, dashboardIsOpen, STEP_INDEX } from "./onboarding-step";

const conn = { accessHealth: "ok" };
const ready = { onboardingStatus: "ready" };

describe("onboardingStep", () => {
  it("starts a JUST-REGISTERED user on business details", () => {
    // Signup writes app_users with customer_id = NULL, so /overview returns
    // customer: null. That step is what CREATES the customer.
    expect(onboardingStep({ customer: null, connection: null })).toBe("B");
    expect(onboardingStep({ customer: undefined, connection: undefined })).toBe("B");
  });

  it("moves to connect once the business exists but Meta does not", () => {
    expect(onboardingStep({ customer: { onboardingStatus: "meta_connection_required" }, connection: null })).toBe("C");
  });

  it("is done when the customer is ready AND connected", () => {
    expect(onboardingStep({ customer: ready, connection: conn })).toBe("F");
  });

  it("keeps a 'ready' customer who lost their connection on the connect step", () => {
    // Status alone is not enough: access can be revoked in Meta after the fact,
    // and the connect step is the only screen where they can do anything about it.
    expect(onboardingStep({ customer: ready, connection: null })).toBe("C");
    expect(onboardingStep({ customer: ready, connection: { accessHealth: "revoked" } })).toBe("C");
  });

  it("treats a connected-but-unready customer as connected", () => {
    // The legacy statuses are gone; a healthy connection is the real signal.
    expect(onboardingStep({ customer: { onboardingStatus: "campaign_under_review" }, connection: conn })).toBe("F");
  });
});

describe("dashboardIsOpen", () => {
  it("is closed for anyone who has not finished business details or connect", () => {
    // An unfinished account reaching /app sees an empty dashboard, which reads
    // as "your account is broken" rather than "one thing left to do".
    expect(dashboardIsOpen({ customer: null, connection: null })).toBe(false);
    expect(dashboardIsOpen({ customer: { onboardingStatus: "meta_connection_required" }, connection: null })).toBe(false);
    expect(dashboardIsOpen({ customer: ready, connection: { accessHealth: "needs_reconnect" } })).toBe(false);
  });

  it("is open once connected", () => {
    expect(dashboardIsOpen({ customer: ready, connection: conn })).toBe(true);
  });

  it("agrees with onboardingStep on every input", () => {
    // The two must never disagree — that is a customer bounced between screens.
    const customers = [null, ready, { onboardingStatus: "meta_connection_required" }];
    const connections = [null, conn, { accessHealth: "revoked" }];
    for (const customer of customers) {
      for (const connection of connections) {
        expect(dashboardIsOpen({ customer, connection })).toBe(onboardingStep({ customer, connection }) === "F");
      }
    }
  });

  it("gives every step a stepper position", () => {
    for (const s of ["B", "C", "F"] as const) expect(STEP_INDEX[s]).toBeGreaterThan(0);
  });
});
