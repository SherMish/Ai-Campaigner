import { strings } from "../strings";

// AIC-100 — real live bug: an ad showed מפרסם ("delivering") while its own
// ad set showed מושהה ("paused"). Nothing was delivering; the ad row asserted
// the opposite. Root cause: the ad's badge came from the ad's OWN status —
// its own switch is on — never resolved against its parents' status.
//
// The fix is composition, not a new Meta field: an ad's own status, its ad
// set's own status, and the campaign's own status (all already "active" /
// "paused" in ControlState — see api.ts's ControlState.campaignStatus) are
// each already fresh and instantly-updated on their own respective toggle
// (see Home.tsx's onToggle comment on why it trusts the write result over a
// live re-read). Composing three already-fresh own-statuses top-down avoids
// any read-after-write lag entirely — no dependency on Meta's own
// effective_status field, which is exactly the ambiguous shortcut this
// ticket exists to close off.
export type AdDeliveryState = "delivering" | "paused_by_you" | "blocked_by_adset" | "blocked_by_campaign";

const D = strings.he.app.home.details;

// AIC-98-style exhaustive map: a fifth delivery state fails tsc here rather
// than shipping a blank/wrong badge.
export const AD_DELIVERY_BADGE: Record<AdDeliveryState, string> = {
  delivering: D.statusRunning,
  paused_by_you: D.statusPausedByYou,
  blocked_by_adset: D.statusBlockedByAdSet,
  blocked_by_campaign: D.statusBlockedByCampaign,
};

// The pill's visual tone — "warn" (amber) for "not delivering, and it isn't
// your own pause" — deliberately distinct from both "ok" (green, delivering)
// and "neutral" (gray, you did this on purpose).
export const AD_DELIVERY_TONE: Record<AdDeliveryState, "ok" | "warn" | "neutral"> = {
  delivering: "ok",
  paused_by_you: "neutral",
  blocked_by_adset: "warn",
  blocked_by_campaign: "warn",
};

// Precedence: the ad's OWN pause always wins (most specific, and the one the
// customer just did) — never phrase a self-pause as a parent problem. Between
// the two parent causes, campaign outranks ad set: if the whole campaign is
// paused, telling the customer "resume the ad set" names a fix that won't
// actually bring the ad back — the campaign is nobody-can-act-here-from-this-
// panel, same as home's `paused` state.
export function deliveryStatus(
  ownIntent: "active" | "paused",
  adSetIntent: "active" | "paused",
  campaignIntent: "active" | "paused",
): AdDeliveryState {
  if (ownIntent === "paused") return "paused_by_you";
  if (campaignIntent === "paused") return "blocked_by_campaign";
  if (adSetIntent === "paused") return "blocked_by_adset";
  return "delivering";
}
