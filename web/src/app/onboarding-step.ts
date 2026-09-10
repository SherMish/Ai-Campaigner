// AIC-188 — which onboarding step a customer is on, and whether the dashboard
// is open to them yet.
//
// One function answers both, because they are the same question asked from
// opposite sides: onboarding asks "what do I show", the app shell asks "should
// this person be here at all". Two implementations of that would drift, and the
// drift is a customer bounced between two screens forever.

export type OnboardingStep = "B" | "C" | "F";

/** The three steps, in order. Index into `strings.he.app.onboarding.steps`. */
export const STEP_INDEX: Record<OnboardingStep, number> = { B: 1, C: 2, F: 3 };

export interface StepInput {
  customer: { onboardingStatus: string } | null | undefined;
  connection: { accessHealth: string } | null | undefined;
}

/**
 * - **B — פרטים על העסק.** No customer row yet. Signup writes `app_users` with
 *   `customer_id = NULL`; the business-details step is what creates the customer,
 *   so this is where a newly registered user starts.
 * - **C — חיבור Meta.** A customer with no working connection.
 * - **F — done.** Connected. The dashboard is theirs.
 *
 * `campaign_under_review` and `call_scheduled` are gone: both belonged to an
 * operator-led flow — an intro call, then a human reviewing the campaign —
 * and neither happens for a customer who connects themselves. A step nobody
 * advances is a wall, not a step.
 */
export function onboardingStep({ customer, connection }: StepInput): OnboardingStep {
  if (!customer) return "B";
  if (!connection) return "C";
  // A HEALTHY connection is the signal, not `onboardingStatus`.
  //
  // The status is a claim we wrote down once; the health is re-verified every
  // tick. They can disagree — access revoked in Meta after the fact leaves a
  // 'ready' customer with a dead connection — and when they do, the connect
  // step is the only screen where the customer can act. An earlier draft here
  // read the status first and called a revoked connection "done"; the test for
  // that case is the one that caught it.
  return connection.accessHealth === "ok" ? "F" : "C";
}

/**
 * Whether the dashboard should open, or bounce back to onboarding.
 *
 * Deliberately derived from the SAME function rather than from a status string:
 * a customer who is on step B or C has no campaigns to look at, and letting
 * them reach /app shows an empty dashboard that reads as "your account is
 * broken" rather than "you have one thing left to do".
 */
export function dashboardIsOpen(input: StepInput): boolean {
  return onboardingStep(input) === "F";
}
