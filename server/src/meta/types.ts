import type { AccessHealth, InsightGrain } from "@aic/shared";

// The Meta assets we hold access to. Ad account is always required; Page + IG are
// needed where we touch creatives (P0.2/P0.3).
export type AssetKind = "ad_account" | "page" | "instagram";

// A date window, inclusive, as YYYY-MM-DD (Meta Insights time_range shape).
export interface InsightsPeriod {
  start: string;
  end: string;
}

// One raw Insights row at a given grain, as close to Meta's shape as we need.
// Money fields are Meta's currency-unit strings (e.g. "180.00"); normalization
// converts them to integer agorot.
export interface RawInsightRow {
  grain: InsightGrain;
  objectId: string; // the Meta id at this grain
  parentId?: string; // e.g. an ad's ad-set
  name?: string; // creative/ad name, for the per-creative table
  spend: string;
  impressions?: string;
  inlineLinkClicks?: string;
  actions?: Array<{ action_type: string; value: string }>;
  deliveryStatus?: string;
  raw?: Record<string, unknown>;
}

// Result of checking whether our System User token can operate one asset. The
// client classifies access problems into a health value — it never throws for
// them, so a revoked grant is data, not an exception.
export interface AssetAccessResult {
  kind: AssetKind;
  id: string;
  health: AccessHealth; // ok | revoked | invalid | needs_reconnect
  detail?: string; // internal explanation (never customer-facing)
}

// The slice of Meta the backend needs. Writes are added by the execution tickets
// (AIC-12/13) on the same interface.
export interface MetaClient {
  verifyAssetAccess(kind: AssetKind, id: string): Promise<AssetAccessResult>;
  // Pull Insights for a campaign at all four grains for the given window.
  getInsights(
    campaignMetaId: string,
    period: InsightsPeriod,
  ): Promise<RawInsightRow[]>;
  // Per-day campaign rows — DISJOINT, unlike the overlapping rolling windows
  // getInsights writes. Optional so test doubles don't all have to implement
  // it; a client without it simply contributes no daily series.
  getDailyInsights?(
    campaignMetaId: string,
    period: InsightsPeriod,
  ): Promise<Array<{ date: string; row: RawInsightRow }>>;
}
