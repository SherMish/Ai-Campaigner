import type { AccessHealth } from "@aic/shared";

// The Meta assets we hold access to. Ad account is always required; Page + IG are
// needed where we touch creatives (P0.2/P0.3).
export type AssetKind = "ad_account" | "page" | "instagram";

// Result of checking whether our System User token can operate one asset. The
// client classifies access problems into a health value — it never throws for
// them, so a revoked grant is data, not an exception.
export interface AssetAccessResult {
  kind: AssetKind;
  id: string;
  health: AccessHealth; // ok | revoked | invalid | needs_reconnect
  detail?: string; // internal explanation (never customer-facing)
}

// The slice of Meta the connection layer needs. Insights/writes are added by
// later tickets (AIC-6 ingestion, AIC-12/13 execution) on the same interface.
export interface MetaClient {
  verifyAssetAccess(kind: AssetKind, id: string): Promise<AssetAccessResult>;
}
