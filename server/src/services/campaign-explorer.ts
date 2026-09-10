import type pg from "pg";
import { tokenForCampaign } from "../meta/token-resolver.js";
import { rollingPeriods } from "../meta/scheduled-ingestion.js";
import { GraphExplorerReader, type ExplorerCampaign, type ExplorerReader } from "../meta/explorer.js";

// The operator's deep-view service (AIC-45): assembles the full campaign→
// ad-set→ad→creative tree for one managed campaign, fetched live from Meta.
// Deliberately NOT read from insight_snapshots — this is the raw-truth
// diagnostic surface, always current, gated behind an explicit admin action
// (opening the explorer / hitting refresh), not the normal navigation path
// AIC-7's "no live Meta calls at render" rule protects.

export type ExplorerUnavailableReason = "no_meta_campaign" | "no_token" | "meta_error";

export interface ExplorerResult {
  campaignId: string;
  name: string;
  metaCampaignId: string | null;
  tree: ExplorerCampaign | null;
  unavailableReason: ExplorerUnavailableReason | null;
  errorDetail?: string;
}

export async function buildCampaignExplorer(
  pool: pg.Pool,
  campaignId: string,
  opts: { reader?: ExplorerReader; ref?: Date } = {},
): Promise<ExplorerResult | null> {
  const { rows } = await pool.query<{ name: string; meta_campaign_id: string | null }>(
    `SELECT name, meta_campaign_id FROM managed_campaigns WHERE id = $1`,
    [campaignId],
  );
  const camp = rows[0];
  if (!camp) return null;

  const base: ExplorerResult = {
    campaignId,
    name: camp.name,
    metaCampaignId: camp.meta_campaign_id,
    tree: null,
    unavailableReason: null,
  };
  if (!camp.meta_campaign_id) return { ...base, unavailableReason: "no_meta_campaign" };

  // AIC-187: the operator explorer must read through the SAME credential the
  // customer view uses, or the two can disagree about a customer's own account.
  const resolved = await tokenForCampaign(pool, campaignId);
  const reader = opts.reader ?? (resolved ? new GraphExplorerReader(resolved.token) : null);
  if (!reader) return { ...base, unavailableReason: "no_token" };

  const { current } = rollingPeriods(opts.ref ?? new Date());
  try {
    const tree = await reader.getExplorerTree(camp.meta_campaign_id, current);
    return { ...base, tree };
  } catch (err) {
    return { ...base, unavailableReason: "meta_error", errorDetail: (err as Error).message };
  }
}
