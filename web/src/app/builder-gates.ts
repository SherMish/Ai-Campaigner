// AIC-163 — why a builder control cannot be pressed yet.
//
// Written after the same shape appeared three times in one day: AIC-155 (a
// disabled "צור קמפיין חדש" with no stated reason), AIC-158 (a verdict
// rendered without the evidence for it), AIC-161 ("יצירת הרשומות" refusing
// into a message a screen above the button). Every time, the code one layer
// down knew exactly why, and it never reached the screen.
//
// Those were all in the admin console. The sweep that followed found four more
// in the CUSTOMER-facing builder — including its Next button, the most-pressed
// control in the product, disabled by four different conditions and silent
// about all of them.
//
// Pure functions in their own module for the same reason onboarding-step4.ts
// is: this repo has no component-test tooling, so extracting the decision is
// the only way any of it gets locked in.
//
// Each returns the FIRST unmet precondition, in the order the customer has to
// act, or null when the control is live. One list per control, read by the
// disabled state AND the message, so the two cannot disagree.

export type NextBlocker =
  | "whatsapp_number_invalid"
  | "website_url_invalid"
  | "pixel_missing"
  | "conversion_event_missing"
  | "budget_missing"
  // Deliberately has NO button-level copy: the budget field already says this,
  // with the agreed ceiling in it (Builder.tsx). Kept in the list so the gate
  // stays the single description of why Next is dead — but one fact should not
  // produce two messages on one screen.
  | "budget_over_ceiling"
  | "age_invalid"
  | "no_ads";

export interface BuilderGateState {
  destination: string;
  whatsappNumber: string;
  destinationUrl: string;
  pixelId: string;
  conversionEvent: string;
  dailyBudgetShekels: number;
  budgetOverCeiling: boolean;
  ageMin: number;
  ageMax: number;
  createdAdCount: number;
}

/**
 * Why "הבא" is dead on this step — or null when it is live.
 *
 * Keyed by step index, mirroring the wizard's own `canNext` array, so the two
 * cannot describe different rules. Steps the wizard lets through
 * unconditionally (goal, special category, placements, and the review step,
 * which has its own button) have nothing to say and return null.
 *
 * The destination step reports WHICH field is wrong rather than "invalid": its
 * website branch has three separate requirements, and a single boolean leaves
 * the customer testing them one at a time.
 */
export function nextBlocker(
  step: number,
  s: BuilderGateState,
  engagementDestination: string,
  websiteDestination: string,
): NextBlocker | null {
  switch (step) {
    case 1:
      // Engagement has nothing to validate — the interaction happens on the
      // post itself, so this step asks for nothing.
      if (s.destination === engagementDestination) return null;
      if (s.destination === websiteDestination) {
        if (!/^https?:\/\/.+/.test(s.destinationUrl)) return "website_url_invalid";
        if (!s.pixelId) return "pixel_missing";
        if (!s.conversionEvent) return "conversion_event_missing";
        return null;
      }
      return /^\d{6,15}$/.test(s.whatsappNumber) ? null : "whatsapp_number_invalid";
    case 2:
      if (!Number.isFinite(s.dailyBudgetShekels) || s.dailyBudgetShekels <= 0) return "budget_missing";
      return s.budgetOverCeiling ? "budget_over_ceiling" : null;
    case 4:
      // Meta's own bounds. Refused where the range is typed rather than by a
      // Meta 400 once the build is already running.
      return s.ageMin >= 13 && s.ageMax > s.ageMin && s.ageMax <= 65 ? null : "age_invalid";
    case 6:
      return s.createdAdCount >= 1 ? null : "no_ads";
    default:
      return null;
  }
}

/**
 * The review step's own create button. Same fact as step 6's gate, at the
 * point where it costs the most: the customer has walked through eight steps
 * and the final button is dead.
 */
export function createCampaignBlocker(createdAdCount: number): "no_ads" | null {
  return createdAdCount >= 1 ? null : "no_ads";
}

export type AdCreateBlocker = "post_not_chosen" | "media_missing" | "headline_missing" | "text_missing";

/**
 * Why one ad card's create button is dead.
 *
 * Ordered as the card is laid out, top to bottom, so the message points at the
 * next empty box rather than the last one.
 */
export function adCreateBlocker(ad: {
  source: "upload" | "post";
  postId: string | null;
  hasMedia: boolean;
  headline: string;
  primaryText: string;
}): AdCreateBlocker | null {
  if (ad.source === "post") return ad.postId ? null : "post_not_chosen";
  if (!ad.hasMedia) return "media_missing";
  if (!ad.headline.trim()) return "headline_missing";
  if (!ad.primaryText.trim()) return "text_missing";
  return null;
}

export type AdSetSubmitBlocker = "set_name_missing" | "no_created_ads";

/**
 * Why add-content's "add an ad set" button is dead. Its sibling — the add-ONE-
 * ad button — got its reason in AIC-136; this one was missed, and the two sit
 * on the same screen.
 */
export function adSetSubmitBlocker(input: { setName: string; createdAdCount: number }): AdSetSubmitBlocker | null {
  if (!input.setName.trim()) return "set_name_missing";
  return input.createdAdCount >= 1 ? null : "no_created_ads";
}
