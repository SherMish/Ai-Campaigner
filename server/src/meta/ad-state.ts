// How an ad's raw Meta `effective_status` maps to a state the customer surface
// can render honestly.
//
// Origin (live, 2026-08-22): a customer added an ad from an existing post, saw
// a success confirmation, and the dashboard still listed only the old ads.
// Nothing had failed — the ad was on Meta within seconds. But the per-ad list
// is built from `insight_snapshots`, so it showed "ads that have measured
// data" while the customer read it as "my ads". A new ad has no data for its
// first hours, and `PENDING_REVIEW` — the state every new ad passes through —
// appeared NOWHERE in this codebase.
//
// The rejected case is the worse one: a DISAPPROVED ad never gains insight
// data at all, so waiting would not have fixed it. It would have stayed
// invisible forever, reading as "the create silently failed" when Meta had in
// fact refused the content and could say why.

export type AdState =
  | "active" // delivering, or eligible to
  | "in_review" // Meta hasn't finished reviewing it yet — normal for a new ad
  | "rejected" // Meta refused it; it will never deliver as-is
  | "paused" // someone paused this ad itself
  | "blocked_by_parent" // the ad is fine; its ad set or campaign is paused
  | "gone" // deleted/archived
  | "unknown"; // a status we don't recognise — still shown, never dropped

// Deliberately a lookup over Meta's documented values rather than a set of
// `includes()` guesses, so an unrecognised status falls through to "unknown"
// instead of being silently absorbed into a neighbouring bucket.
const BY_STATUS: Record<string, AdState> = {
  ACTIVE: "active",
  // Both are "Meta hasn't cleared it yet", and both are normal states for a
  // freshly-created ad rather than anything the customer must act on.
  PENDING_REVIEW: "in_review",
  PENDING_BILLING_INFO: "in_review",
  IN_PROCESS: "in_review",
  // Refused. WITH_ISSUES is grouped here deliberately: from the customer's
  // side "Meta has a problem with this ad" is the same actionable fact, and
  // the specific reason comes from issues_info, not from this classification.
  DISAPPROVED: "rejected",
  WITH_ISSUES: "rejected",
  ADSET_PAUSED: "blocked_by_parent",
  CAMPAIGN_PAUSED: "blocked_by_parent",
  PAUSED: "paused",
  DELETED: "gone",
  ARCHIVED: "gone",
};

export function classifyAdState(effectiveStatus: string): AdState {
  return BY_STATUS[effectiveStatus] ?? "unknown";
}
