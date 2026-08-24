// AIC-128: does every ad's creative actually carry the DESTINATION its ad set
// promises?
//
// The failure this exists to catch, found live on a real customer: a
// Click-to-WhatsApp campaign whose ad sets were correctly
// `destination_type: WHATSAPP` / `optimization_goal: CONVERSATIONS`, whose
// creatives reported `call_to_action_type: WHATSAPP_MESSAGE` — and whose
// `call_to_action` was `{type: "WHATSAPP_MESSAGE"}` with NO `value`, so no
// phone number. Meta derives the TYPE from the ad set, so every surface we
// had said the ad was fine; but with no number there is nothing for a tap to
// open, and Meta renders a generic "See more" that goes nowhere. The customer
// found it before we did and paused both ads.
//
// WHY THIS IS ITS OWN CHECK. Nothing existing could see it. Delivery-health
// asks "is Meta showing this ad" — yes. Tracking-health asks "does the lead
// definition match the optimization goal" — it did. Insights showed real
// spend. Every signal was green while every click was wasted. The gap is
// specifically BETWEEN the ad set's promise and the creative's payload, and
// only a comparison of the two can see it.
//
// A CONFIG COMPARISON, like tracking-health and for the same reasons: exact,
// no spend required, no attribution lag, and it fires on a PAUSED campaign —
// so a rebuild can be verified before it costs anything.
import { classifyAdState } from "./ad-state.js";

// One ad's creative, reduced to the fields that decide this.
export interface AdCreativeDestination {
  adId: string;
  adName?: string | null;
  adSetId: string;
  // AIC-65's rule, one level down: an ad that can never serve again must not be
  // judged. Without this an ARCHIVED ad keeps the campaign flagged forever —
  // which would make "archive the broken ad" a fix that never clears the alert,
  // i.e. exactly the wrong advice to give an operator.
  effectiveStatus?: string | null;
  // The ad set's promise.
  destinationType: string | null; // WHATSAPP | WEBSITE | UNDEFINED | …
  // The creative's payload. `ctaType` without `ctaValue` is the exact live
  // failure — Meta reports a type it inferred, with nothing behind it.
  ctaType: string | null;
  whatsappNumber: string | null; // call_to_action.value.whatsapp_number
  link: string | null; // call_to_action.value.link
}

export interface CtaReader {
  getAdCreativeDestinations(metaCampaignId: string): Promise<AdCreativeDestination[]>;
}

// Four-valued, matching TrackingState and for the same reason: `unknown` is
// not a soft `ok` (it must never overwrite a real prior verdict), and
// `not_applicable` is not `ok` either — an engagement ad has no destination
// by design, so claiming "healthy" would imply a check we never ran.
export type CtaState = "ok" | "broken" | "unknown" | "not_applicable";

export interface BrokenAd {
  adId: string;
  adName: string | null;
  destinationType: string;
  reason: "missing_whatsapp_number" | "missing_link" | "missing_cta";
}

export interface CtaSummary {
  state: CtaState;
  reason: string | null;
  brokenAdIds: string[];
  detail: Record<string, unknown>;
}

// Ad sets whose destination is a real click target. UNDEFINED/null is an
// engagement or on-platform ad set — nothing to click through to.
const ACTIONABLE = new Set(["WHATSAPP", "MESSENGER", "WEBSITE", "INSTAGRAM_DIRECT", "PHONE_CALL"]);

function judge(ad: AdCreativeDestination): BrokenAd | null {
  const dest = (ad.destinationType ?? "").toUpperCase();
  if (!ACTIONABLE.has(dest)) return null; // not applicable to this ad

  // A messaging destination needs a number in the creative. Meta will happily
  // report ctaType WHATSAPP_MESSAGE without one — that is the whole bug.
  if (dest === "WHATSAPP") {
    if (!ad.whatsappNumber || !ad.whatsappNumber.trim()) {
      return {
        adId: ad.adId,
        adName: ad.adName ?? null,
        destinationType: dest,
        reason: ad.ctaType ? "missing_whatsapp_number" : "missing_cta",
      };
    }
    return null;
  }

  if (dest === "WEBSITE") {
    if (!ad.link || !ad.link.trim()) {
      return {
        adId: ad.adId,
        adName: ad.adName ?? null,
        destinationType: dest,
        reason: ad.ctaType ? "missing_link" : "missing_cta",
      };
    }
    return null;
  }

  // MESSENGER / INSTAGRAM_DIRECT / PHONE_CALL are actionable but their payload
  // shapes are not modelled here yet. Judging them on the WhatsApp rule would
  // flag every one of them as broken, so they are deliberately left alone —
  // a false alarm on a working ad is worse than a gap we have written down.
  return null;
}

// DELETED/ARCHIVED map to "gone" — an ad that cannot serve again. PAUSED is
// deliberately NOT excluded: a paused ad can be resumed, so a broken button on
// one is a real problem waiting to happen (and is exactly the state the live
// failure was found in).
function canStillServe(ad: AdCreativeDestination): boolean {
  return !ad.effectiveStatus || classifyAdState(ad.effectiveStatus) !== "gone";
}

export function summarizeCta(input: AdCreativeDestination[]): CtaSummary {
  const ads = input.filter(canStillServe);
  if (ads.length === 0) {
    // No ads read. NOT "ok" — there is nothing to have checked, and a campaign
    // mid-build legitimately has none yet.
    return { state: "unknown", reason: "no ads to check", brokenAdIds: [], detail: {} };
  }

  const judgeable = ads.filter((a) => ACTIONABLE.has((a.destinationType ?? "").toUpperCase()));
  if (judgeable.length === 0) {
    return {
      state: "not_applicable",
      reason: "no ad set has a click-through destination (engagement or on-platform)",
      brokenAdIds: [],
      detail: { adsChecked: ads.length },
    };
  }

  const broken = judgeable.map(judge).filter((b): b is BrokenAd => b !== null);
  if (broken.length === 0) {
    return { state: "ok", reason: null, brokenAdIds: [], detail: { adsChecked: judgeable.length } };
  }

  const first = broken[0];
  return {
    state: "broken",
    // Names the ad, because an operator's next question is always "which one".
    reason: `${broken.length} of ${judgeable.length} ad(s) have a ${first.destinationType} destination with no working button (${first.reason})`,
    brokenAdIds: broken.map((b) => b.adId),
    detail: { adsChecked: judgeable.length, broken },
  };
}
