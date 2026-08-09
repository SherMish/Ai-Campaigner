import type pg from "pg";
import type { InsightsPeriod } from "../meta/types.js";
import type { SnapshotStore } from "../meta/snapshot-store.js";
import type { MetaReader } from "../execution/safe-executor.js";
import { GraphCampaignAdapter } from "../meta/campaign-adapter.js";
import { PgSnapshotStore } from "../meta/snapshot-store.js";
import { PgRecommendationStore, type RecommendationStore } from "./recommendation-store.js";
import { RecommendationService } from "./recommendation-service.js";
import { refreshRecommendations } from "./staleness.js";
import { rollingPeriods } from "../meta/scheduled-ingestion.js";
import { consoleLogger, type Logger } from "../services/logger.js";

// The scheduled recommendation evaluator (AIC-9). It closes the engine loop:
// ingestion writes fresh snapshots, then this runs the deterministic rules over
// each managed campaign and persists/expire `proposed` recommendations via the
// canonical `refreshRecommendations` tick. It NEVER executes anything — a
// recommendation only becomes a real Meta change when the customer approves it
// (AIC-23 → AIC-12). LLM is not involved (it only explains, AIC-10).

export interface GenCampaign {
  id: string;
  metaCampaignId: string;
}

export interface GenerationSummary {
  evaluated: number; // campaigns whose rules ran
  created: number; // fresh recommendations proposed
  expired: number; // proposed recs the rules no longer support
  skipped: number; // eligible but couldn't read live budget
}

// Campaigns eligible for generation: actively managed, automation on, linked to a
// Meta campaign, and a healthy connection. Execution-frozen still generates
// (freeze blocks execution, not proposals — PRD §23); unmanaged/paused/off do not.
export async function listEligibleForGeneration(pool: pg.Pool): Promise<GenCampaign[]> {
  const { rows } = await pool.query<{ id: string; meta_campaign_id: string }>(
    `SELECT mc.id, mc.meta_campaign_id
     FROM managed_campaigns mc
     JOIN meta_connections conn ON conn.customer_id = mc.customer_id
     WHERE mc.status = 'active'
       AND mc.automation_enabled = true
       AND mc.meta_campaign_id IS NOT NULL
       AND conn.access_health = 'ok'`,
  );
  return rows.map((r) => ({ id: r.id, metaCampaignId: r.meta_campaign_id }));
}

// Evaluate a fixed set of campaigns. Pure over its deps (the reader + stores are
// injected) so it unit-tests without Postgres or Meta. The live daily budget
// comes from the reader (the rules propose relative to it); a campaign whose
// budget can't be read is skipped, not guessed.
export async function runGenerationTick(deps: {
  campaigns: GenCampaign[];
  reader: MetaReader;
  snapshotStore: SnapshotStore;
  recommendationStore: RecommendationStore;
  recommendationService: RecommendationService;
  ref?: Date;
  logger?: Logger;
}): Promise<GenerationSummary> {
  const { campaigns, reader, snapshotStore, recommendationStore, recommendationService } = deps;
  const { current, previous }: { current: InsightsPeriod; previous: InsightsPeriod } =
    rollingPeriods(deps.ref);
  const log = deps.logger;

  const summary: GenerationSummary = { evaluated: 0, created: 0, expired: 0, skipped: 0 };

  for (const campaign of campaigns) {
    let currentBudgetAgorot: number;
    try {
      currentBudgetAgorot = (await reader.getCampaignState(campaign.metaCampaignId)).dailyBudgetAgorot;
    } catch (e) {
      summary.skipped++;
      log?.error(`[generation] ${campaign.id}: could not read live budget — ${(e as Error).message}`);
      continue;
    }

    const result = await refreshRecommendations({
      snapshotStore,
      recommendationStore,
      recommendationService,
      campaign: { id: campaign.id, currentBudgetAgorot },
      current,
      previous,
      expiresAt: null,
    });

    summary.evaluated++;
    summary.expired += result.expiredIds.length;
    if (result.createdId) {
      summary.created++;
      log?.info(`[generation] ${campaign.id}: proposed ${result.freshDraft.type}`);
    }
  }

  return summary;
}

// Bind a generation tick to the DB + a real Meta reader. Returns null (inert)
// when no System User token is set, mirroring the ingestion scheduler.
export function buildGenerationTick(pool: pg.Pool): (() => Promise<GenerationSummary>) | null {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) return null;
  const reader = new GraphCampaignAdapter(token, process.env.META_GRAPH_VERSION || "v21.0");
  const snapshotStore = new PgSnapshotStore(pool);
  const recommendationStore = new PgRecommendationStore(pool);
  const recommendationService = new RecommendationService(recommendationStore);

  return async () => {
    const campaigns = await listEligibleForGeneration(pool);
    return runGenerationTick({
      campaigns,
      reader,
      snapshotStore,
      recommendationStore,
      recommendationService,
      logger: consoleLogger,
    });
  };
}
