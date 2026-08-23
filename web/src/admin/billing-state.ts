// Which state the /admin billing card is in (AIC-123). Pure, so it can be
// unit-tested — same reason as onboarding-step4.ts and ops-queue-view.ts: this
// repo has no component-test tooling.
//
// Found live: the card is headed "לקוחות משלמים" (paying customers) and its
// first row showed `customers` — the count of NON-TEST customers, whether or
// not any of them has ever paid. With two real customers and zero payments it
// rendered a "paying customers" card headlining 2. Every individual number was
// true; the framing was the lie, which is the exact failure CLAUDE.md's litmus
// test names: a number that looks like progress rather than telling the truth.
//
// The old empty-state condition was `customers === 0` — i.e. it only admitted
// "nobody is paying" when there were no real customers AT ALL. The condition it
// actually needed is "nobody has paid", which is a different thing and the
// common one early on.
export type BillingState =
  | "no_real_customers" // the whole book is internal/dogfood accounts
  | "none_paying" // real customers exist; not one has paid anything yet
  | "converting"; // at least one payment has happened

export interface BillingCounts {
  customers: number;
  setupPaid: number;
  subscribed: number;
}

export function billingState(c: BillingCounts): BillingState {
  if (c.customers === 0) return "no_real_customers";
  // Deliberately checks BOTH: a subscription without a recorded setup payment
  // is still revenue, and must not read as "nobody is paying".
  if (c.setupPaid === 0 && c.subscribed === 0) return "none_paying";
  return "converting";
}
