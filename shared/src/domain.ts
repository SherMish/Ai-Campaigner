// Domain enums. Stored as TEXT in Postgres (see migrations) and validated here
// in application code — adding a value never needs a DDL migration. Each list is
// the single source of truth for its column's allowed values.

export const ONBOARDING_STATUS = [
  "call_scheduled",
  "meta_connection_required",
  "campaign_under_review",
  "ready",
] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUS)[number];

export const SUBSCRIPTION_STATUS = [
  "pending",
  "active",
  "lapsed",
  "canceled",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS)[number];

// Health of our access to a customer's Meta assets. Anything but `ok` halts
// execution (safety rule, P0.3) and raises an ops-queue item.
export const ACCESS_HEALTH = [
  "ok",
  "revoked",
  "invalid",
  "needs_reconnect",
] as const;
export type AccessHealth = (typeof ACCESS_HEALTH)[number];

export const CAMPAIGN_STATUS = [
  "under_review",
  "active",
  "paused",
  "needs_attention",
  "connection_problem",
  "unmanaged",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUS)[number];

export const BUDGET_PERIOD = ["daily", "monthly"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIOD)[number];

export const INSIGHT_GRAIN = ["campaign", "adset", "ad", "creative"] as const;
export type InsightGrain = (typeof INSIGHT_GRAIN)[number];

export const RECOMMENDATION_TYPE = [
  "pause_creative",
  "pause_adset", // pause an underperforming audience (ad set); CBO shifts budget to the winner
  "increase_budget",
  "decrease_budget",
  "replace_creative",
  "no_action",
  // AIC-86: advisory only — never a Meta write. Fires when there aren't enough
  // comparable creatives to judge one against another; the CTA sends the
  // customer to the existing add-ad flow instead of the approve/execute gate.
  "add_creatives_for_comparison",
] as const;
export type RecommendationType = (typeof RECOMMENDATION_TYPE)[number];

// Recommendation lifecycle (refined in AIC-8):
// proposed → approved → executing → executed | failed
// proposed → dismissed | expired
export const RECOMMENDATION_STATE = [
  "proposed",
  "approved",
  "executing",
  "executed",
  "failed",
  "dismissed",
  "expired",
] as const;
export type RecommendationState = (typeof RECOMMENDATION_STATE)[number];

export const OPS_QUEUE_TYPE = [
  "meta_connection_failure",
  "campaign_not_delivering",
  "campaign_rejected",
  "unusual_performance",
  "recommendation_review",
  "support_request",
  "missing_creative",
  "account_restriction",
  // AIC-88: the campaign's declared lead definition doesn't match what its ad
  // sets are configured on Meta to optimize for, so real conversions count as
  // zero. Must stay in sync with the CHECK in migration 038 — both enumerate
  // the allowed set, and missing either one throws at runtime.
  "campaign_tracking_broken",
  // AIC-128: an ad set promises a click destination (WhatsApp/website) but the
  // ad's creative carries no number/link — Meta renders a dead button. Must
  // stay in sync with the CHECK in migration 044.
  "campaign_cta_broken",
  // AIC-72: the ad ACCOUNT cannot spend (disabled, unsettled, risk review, or
  // no payment method) — every campaign on it is dead regardless of its own
  // config. Must stay in sync with the CHECK in migration 045.
  "ad_account_cannot_spend",
  // AIC-91: the campaign's lead event stopped firing on the pixel while the
  // pixel itself stayed alive. Must stay in sync with the CHECK in migration 046.
  "lead_event_stopped",
  // AIC-92: the campaign's leads look inflated (an implausible share of clicks
  // counted as conversions). Operator-first — see services/overcount-monitor.ts.
  "leads_possibly_overcounted",
  // AIC-132: we don't know enough about the BUSINESS to advertise it — no
  // offer, no differentiators, or answers too vague to write from. The only
  // ops type whose fix is ours rather than Meta's. Must stay in sync with the
  // CHECK in migration 051.
  "business_profile_incomplete",
] as const;
export type OpsQueueType = (typeof OPS_QUEUE_TYPE)[number];

export const OPS_SEVERITY = ["low", "medium", "high"] as const;
export type OpsSeverity = (typeof OPS_SEVERITY)[number];

export const OPS_STATUS = ["open", "in_progress", "resolved"] as const;
export type OpsStatus = (typeof OPS_STATUS)[number];

/** Type guard usable to validate a stored TEXT value against its enum. */
export function isOneOf<T extends readonly string[]>(
  allowed: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}
