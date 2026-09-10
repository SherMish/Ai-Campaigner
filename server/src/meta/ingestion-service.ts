import type { MetaClient, InsightsPeriod } from "./types.js";
import type { SnapshotStore, PeriodAgg } from "./snapshot-store.js";
import { normalizeRow } from "./insights.js";
import type { ConnectionService } from "./connection-service.js";
import type { Logger } from "../services/logger.js";

export interface ManagedCampaignRef {
  id: string; // our managed_campaigns.id
  metaCampaignId: string | null; // null until linked to a Meta campaign
  connectionId: string | null;
  // AIC-87: this campaign's own lead definition (managed_campaigns.lead_event_types).
  // Undefined falls through to extractLeads' WhatsApp default.
  leadEventTypes?: readonly string[];
}

export class IngestionService {
  constructor(
    private readonly store: SnapshotStore,
    private readonly client: MetaClient,
  ) {}

  // Pull Insights for one campaign and upsert normalized snapshots. Idempotent
  // per (campaign, grain, object, period) via the store. Returns rows written.
  async ingestCampaign(
    campaign: { id: string; metaCampaignId: string; leadEventTypes?: readonly string[] },
    period: InsightsPeriod,
  ): Promise<number> {
    const raw = await this.client.getInsights(campaign.metaCampaignId, period);
    const snaps = raw.map((r) => normalizeRow(r, campaign.id, period, campaign.leadEventTypes));
    return this.store.upsert(snaps);
  }

  // Per-DAY campaign snapshots (period_start === period_end). Stored as their
  // own rows so any customer-selectable range (day/week/month) is a sum over
  // DISJOINT days — never over the overlapping rolling windows above, which
  // would double-count (a real live bug: 1 lead read as 3). Also the series
  // behind the leads-per-week graph.
  async ingestDaily(
    campaign: { id: string; metaCampaignId: string; leadEventTypes?: readonly string[] },
    period: InsightsPeriod,
  ): Promise<number> {
    if (!this.client.getDailyInsights) return 0;
    const days = await this.client.getDailyInsights(campaign.metaCampaignId, period);
    const snaps = days.map(({ date, row }) =>
      normalizeRow(row, campaign.id, { start: date, end: date }, campaign.leadEventTypes),
    );
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
  // AIC-187: a FACTORY, not an instance. There is no longer one credential per
  // tick — a manual customer is read with our shared System User token and an
  // OAuth customer with their own, so the client has to be built per campaign,
  // inside the loop. Resolving once and reusing would operate every customer
  // through whichever token came first, and would mostly work: correct for the
  // first customer, silently wrong for the rest.
  //
  // Returning null means "no usable credential for this campaign" — counted as
  // a failure for that campaign and skipped, never falling back to a token that
  // belongs to somebody else.
  ingestionFor: (c: ManagedCampaignRef) => Promise<IngestionService | null>;
  period: InsightsPeriod;
  // Extra windows ingested alongside `period`, each stored as its own snapshot
  // row. Used for the today-only window (scheduled-ingestion.ts's
  // `todayPeriod`): the engine reads only complete days, but the customer
  // dashboard needs today. A failure on an extra window never fails the
  // campaign — the primary window is what the engine depends on.
  extraPeriods?: InsightsPeriod[];
  // Window to pull per-DAY campaign rows for (disjoint; powers the customer's
  // range switcher + the leads graph). Display-only, same as extraPeriods.
  dailyPeriod?: InsightsPeriod;
  logger: Logger;
  // Also per campaign, and for a sharper reason than ingestion: verifying an
  // OAuth customer's access with OUR token reports assets we cannot see as
  // REVOKED — a false access-loss alarm that halts execution and tells the
  // customer we lost a connection that is fine.
  connectionServiceFor?: (c: ManagedCampaignRef) => Promise<ConnectionService | null>;
}): Promise<TickSummary> {
  const { campaigns, period, logger } = deps;
  const extraPeriods = deps.extraPeriods ?? [];
  const summary: TickSummary = { ok: 0, failed: 0, snapshots: 0 };

  for (const c of campaigns) {
    if (deps.connectionServiceFor && c.connectionId) {
      try {
        const svc = await deps.connectionServiceFor(c);
        if (svc) await svc.verify(c.connectionId);
      } catch (err) {
        logger.error(`health check failed for campaign ${c.id}`, err);
      }
    }

    if (!c.metaCampaignId) continue; // not linked to a Meta campaign yet

    const ingestion = await deps.ingestionFor(c);
    if (!ingestion) {
      // No credential we can use for this customer. Counted, logged, skipped —
      // the alternative is reading their account with someone else's token.
      logger.error(`no usable Meta credential for campaign ${c.id}`);
      summary.failed++;
      continue;
    }

    // AIC-87: this campaign's own lead definition, carried on every ingest
    // call below (primary window, extras, and the daily series) — a missed
    // one of these three would silently ingest the wrong lead count for
    // exactly this campaign, not fail loudly.
    const leadEventTypes = c.leadEventTypes;

    try {
      const n = await ingestion.ingestCampaign(
        { id: c.id, metaCampaignId: c.metaCampaignId, leadEventTypes },
        period,
      );
      summary.snapshots += n;
      summary.ok++;
    } catch (err) {
      summary.failed++;
      logger.error(`ingestion failed for campaign ${c.id}`, err);
      continue; // primary window failed — don't bother with the extras
    }

    for (const extra of extraPeriods) {
      try {
        summary.snapshots += await ingestion.ingestCampaign(
          { id: c.id, metaCampaignId: c.metaCampaignId, leadEventTypes },
          extra,
        );
      } catch (err) {
        // Display-only data; never counts the campaign as failed.
        logger.error(`ingestion failed for campaign ${c.id} window ${extra.start}..${extra.end}`, err);
      }
    }

    if (deps.dailyPeriod) {
      try {
        summary.snapshots += await ingestion.ingestDaily(
          { id: c.id, metaCampaignId: c.metaCampaignId, leadEventTypes },
          deps.dailyPeriod,
        );
      } catch (err) {
        logger.error(`daily ingestion failed for campaign ${c.id}`, err);
      }
    }
  }

  return summary;
}
