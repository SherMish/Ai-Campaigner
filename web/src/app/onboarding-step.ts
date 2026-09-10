// AIC-187 — which onboarding card a customer sees.
//
// Lived inline in Onboarding.tsx as a Record lookup with a `?? "A"` fallback.
// Extracted because that fallback was wrong in the one case that matters most,
// and a component is not reachable by these tests (web tests run in `node`,
// there is no DOM).

export type OnboardingStep = "A" | "C" | "D" | "F";

const BY_STATUS: Record<string, OnboardingStep> = {
  call_scheduled: "A",
  meta_connection_required: "C",
  campaign_under_review: "D",
  ready: "F",
};

export const STEP_INDEX: Record<OnboardingStep, number> = { A: 1, C: 2, D: 3, F: 4 };

/**
 * A user who has just registered has **no customer row at all** — signup writes
 * `app_users` with `customer_id = NULL`, and the customer is created when they
 * connect Meta.
 *
 * The old code read `customer?.onboardingStatus ?? ""` and fell back to "A",
 * so that user was shown "מתחילים בשיחת היכרות" — book a call — and the connect
 * button was unreachable. Which is the opposite of the flow: connecting is what
 * CREATES the customer, so it cannot require one to already exist.
 *
 * `null` therefore means "connect", not "unknown". An unrecognised STATUS is
 * still "A": that is a real customer whose state we do not know, and guessing
 * "connect" for someone who may already be connected would be worse.
 */
export function onboardingStep(customer: { onboardingStatus: string } | null | undefined): OnboardingStep {
  if (!customer) return "C";
  return BY_STATUS[customer.onboardingStatus] ?? "A";
}
