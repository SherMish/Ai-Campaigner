import { describe, it, expect } from "vitest";
import { billingState } from "./billing-state.js";

describe("/admin billing card state (AIC-123)", () => {
  // The reported bug: two real customers, zero payments, and the card — headed
  // "paying customers" — showed 2. The count was right; calling it paying
  // wasn't.
  it("real customers who have paid nothing are NOT 'converting'", () => {
    expect(billingState({ customers: 2, setupPaid: 0, subscribed: 0 })).toBe("none_paying");
  });

  it("an empty book is its own state, not 'nobody is paying'", () => {
    expect(billingState({ customers: 0, setupPaid: 0, subscribed: 0 })).toBe("no_real_customers");
  });

  it("any real payment flips it to converting", () => {
    expect(billingState({ customers: 2, setupPaid: 1, subscribed: 0 })).toBe("converting");
  });

  // A subscription with no recorded setup payment is still revenue. Keying the
  // empty state on setupPaid alone would report a paying customer as nobody.
  it("a subscription without a recorded setup payment still counts as revenue", () => {
    expect(billingState({ customers: 2, setupPaid: 0, subscribed: 1 })).toBe("converting");
  });
});
