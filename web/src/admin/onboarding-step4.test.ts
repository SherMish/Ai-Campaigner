import { describe, it, expect } from "vitest";
import { step4Branch } from "./onboarding-step4.js";

describe("step 4: which provisioning branch to show (AIC-119)", () => {
  // The bug, found live on a customer with no connection at all: the operator
  // was shown שם הקמפיין / מספר וואטסאפ / "יצירת הרשומות" — the form for
  // ADOPTING an existing Meta campaign — before picking an ad account. There
  // was no campaign to adopt, so the button could only ever fail.
  //
  // The old condition asked "is the campaign list known to be empty", which is
  // false before an account is picked, so it fell through to adopt-existing.
  // Absence of a loaded list is not evidence that a campaign exists.
  it("asks for an ad account first — neither branch's fields before then", () => {
    expect(step4Branch({ adAccountId: "", loading: false, error: null, campaigns: null }))
      .toBe("pick_account");
    // ...even if a stale list from a previously-selected account is still held.
    expect(step4Branch({ adAccountId: "", loading: false, error: null, campaigns: [{ supported: true }] }))
      .toBe("pick_account");
  });

  it("says nothing while the list is still loading", () => {
    expect(step4Branch({ adAccountId: "act_1", loading: true, error: null, campaigns: null }))
      .toBe("loading");
  });

  // A failed load must not silently become "this account has no campaigns" —
  // that would offer to build a second campaign for an account that has one.
  it("surfaces a failed load instead of guessing a branch", () => {
    expect(step4Branch({ adAccountId: "act_1", loading: false, error: "network", campaigns: null }))
      .toBe("error");
  });

  it("offers to build a new campaign only when the account is known to have none", () => {
    expect(step4Branch({ adAccountId: "act_1", loading: false, error: null, campaigns: [] }))
      .toBe("new_campaign");
  });

  it("offers to adopt only when the account actually has campaigns", () => {
    expect(step4Branch({ adAccountId: "act_1", loading: false, error: null, campaigns: [{ supported: true }] }))
      .toBe("adopt_existing");
  });

  // Unsupported campaigns still count as "this account has campaigns" — the
  // picker lists them disabled with a reason, which is more useful than
  // pretending the account is empty and offering to add another.
  it("counts unsupported campaigns as campaigns", () => {
    expect(step4Branch({ adAccountId: "act_1", loading: false, error: null, campaigns: [{ supported: false }] }))
      .toBe("adopt_existing");
  });
});
