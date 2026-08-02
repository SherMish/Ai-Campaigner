import type { MetaClient, InsightsPeriod } from "./types.js";
import type { SnapshotStore, PeriodAgg } from "./snapshot-store.js";
import { normalizeRow } from "./insights.js";
import type { ConnectionService } from "./connection-service.js";
import type { Logger } from "../services/logger.js";

export interface ManagedCampaignRef {
  id: string; // our managed_campaigns.id
  metaCampaignId: string | null; // null until linked to a Meta campaign
  connectionId: string | null;
}

export class IngestionService {
  constructor(
    private readonly store: SnapshotStore,
    private readonly client: MetaClient,
  ) {}

  // Pull Insights for one campaign and upsert normalized snapshots. Idempotent
  // per (campaign, grain, object, period) via the store. Returns rows written.
  async ingestCampaign(
    campaign: { id: string; metaCampaignId: string },
    period: InsightsPeriod,
  ): Promise<number> {
    const raw = await this.client.getInsights(campaign.metaCampaignId, period);
    const snaps = raw.map((r) => normalizeRow(r, campaign.id, period));
    return this.store.upsert(snaps);
  }

  // This-period vs previous-period campaign totals (PRD §14 comparison).
  async periodComparison(
    campaignId: string,
    current: InsightsPeriod,
    previous: InsightsPeriod,
  ): Promise<{ current: PeriodAgg; previous: PeriodAgg }> {
    const [cur, prev] = await Promise.all([
      this.store.campaignTotals(campaignId, current.start, current.end),
      this.store.campaignTotals(campaignId, previous.start, previous.end),
    ]);
    return { current: cur, previous: prev };
  }
}

export interface TickSummary {
  ok: number;
  failed: number;
  snapshots: number;
}

// One ingestion tick over every managed campaign. Per-campaign work is isolated:
// a Meta error is caught, logged, and the tick continues — a missed pull is
// retried next tick, never lost, and never crashes the run. Also runs the
// scheduled connection health check (AIC-5) per campaign.
export async function runIngestionTick(deps: {
  campaigns: ManagedCampaignRef[];
  ingestion: IngestionService;
  period: InsightsPeriod;
  logger: Logger;
  connectionService?: ConnectionService;
}): Promise<TickSummary> {
  const { campaigns, ingestion, period, logger, connectionService } = deps;
  const summary: TickSummary = { ok: 0, failed: 0, snapshots: 0 };

  for (const c of campaigns) {
    if (connectionService && c.connectionId) {
      try {
        await connectionService.verify(c.connectionId);
      } catch (err) {
        logger.error(`health check failed for campaign ${c.id}`, err);
      }
    }

    if (!c.metaCampaignId) continue; // not linked to a Meta campaign yet

    try {
      const n = await ingestion.ingestCampaign(
        { id: c.id, metaCampaignId: c.metaCampaignId },
        period,
      );
      summary.snapshots += n;
      summary.ok++;
    } catch (err) {
      summary.failed++;
      logger.error(`ingestion failed for campaign ${c.id}`, err);
    }
  }

  return summary;
}
