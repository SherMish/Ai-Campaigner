import type pg from "pg";
import type { InsightsPeriod } from "../meta/types.js";
import type { SnapshotStore } from "../meta/snapshot-store.js";
import type { MetaReader } from "../execution/safe-executor.js";
import type { RecommendationDraft } from "./types.js";
import { GraphCampaignAdapter } from "../meta/campaign-adapter.js";
import { PgSnapshotStore } from "../meta/snapshot-store.js";
import { PgRecommendationStore, type RecommendationStore } from "./recommendation-store.js";
import { RecommendationService } from "./recommendation-service.js";
import { refreshRecommendations } from "./staleness.js";
import { rollingPeriods } from "../meta/scheduled-ingestion.js";
import { summarize, type DeliveryReader, type DeliverySummary } from "../meta/delivery-health.js";
import { recordCampaignDelivery } from "../services/delivery-monitor.js";
import { deriveAudienceLabels, type AdSetMeta } from "../meta/audience-label.js";
import { upsertAdSetMeta } from "../services/audience-meta-cache.js";
import { recordNoRecReason } from "../services/evaluation-reason.js";
import { recordLiveBudget } from "../services/live-budget.js";
import { recordLeadsToDate } from "../services/leads-to-date.js";
import { OpsQueue } from "../services/ops-queue.js";
import { consoleLogger, type Logger } from "../services/logger.js";

export interface AudienceMetaReader {
  getAdSetMeta(metaCampaignId: string): Promise<AdSetMeta[]>;
}

// AIC-67 follow-up: a TRUE lifetime lead count, distinct from any
// insight_snapshots aggregation (those rows are overlapping rolling
// windows — see leads-to-date.ts).
export interface LeadsReader {
  getLifetimeLeads(metaCampaignId: string): Promise<number>;
  // Lifetime leads + spend in one call. Optional so existing doubles that
  // only implement getLifetimeLeads keep working.
  getLifetimeTotals?(metaCampaignId: string): Promise<{ leads: number; spendAgorot: number }>;
}

// The scheduled recommendation evaluator (AIC-9). It closes the engine loop:
// ingestion writes fresh snapshots, then this runs the deterministic rules over
// each managed campaign and persists/expire `proposed` recommendations via the
// canonical `refreshRecommendations` tick. It NEVER executes anything — a
// recommendation only becomes a real Meta change when the customer approves it
// (AIC-23 → AIC-12). LLM is not involved (it only explains, AIC-10).

export interface GenCampaign {
  id: string;
  metaCampaignId: string;
  customerId: string | null;
}

export interface GenerationSummary {
  evaluated: number; // campaigns whose rules ran
  created: number; // fresh recommendations proposed
  expired: number; // proposed recs the rules no longer support
  skipped: number; // eligible but couldn't read live budget
  deliveryProblems: number; // campaigns with a not-delivering ad set (AIC-39)
}

// Campaigns eligible for generation: actively managed, automation on, linked to a
// Meta campaign, and a healthy connection. Execution-frozen still generates
// (freeze blocks execution, not proposals — PRD §23); unmanaged/paused/off do not.
export async function listEligibleForGeneration(pool: pg.Pool): Promise<GenCampaign[]> {
  const { rows } = await pool.query<{ id: string; meta_campaign_id: string; customer_id: string | null }>(
    `SELECT mc.id, mc.meta_campaign_id, mc.customer_id
     FROM managed_campaigns mc
     JOIN meta_connections conn ON conn.customer_id = mc.customer_id
     WHERE mc.status = 'active'
       AND mc.automation_enabled = true
       AND mc.meta_campaign_id IS NOT NULL
       AND conn.access_health = 'ok'`,
  );
  return rows.map((r) => ({ id: r.id, metaCampaignId: r.meta_campaign_id, customerId: r.customer_id }));
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
  // AIC-39: per-campaign delivery health. When provided, errored/not-delivering
  // ad sets are recorded (via `recordDelivery`) and excluded from the rules'
  // evidence, so the audience rule never proposes pausing a broken ad set.
  deliveryReader?: DeliveryReader;
  recordDelivery?: (campaign: GenCampaign, summary: DeliverySummary) => Promise<void>;
  // AIC-37: ad-set metadata (name + targeting), used to derive human audience
  // labels and cache them (via recordAudienceMeta) for the customer surface.
  audienceMetaReader?: AudienceMetaReader;
  recordAudienceMeta?: (campaign: GenCampaign, adsets: AdSetMeta[]) => Promise<void>;
  // AIC-64: cache WHY this tick had nothing to propose (or clear it when
  // something did), so the dashboard/ops console can show a real reason.
  recordNoRecReason?: (campaign: GenCampaign, draft: RecommendationDraft) => Promise<void>;
  // Cache the live-read daily budget for display, so the dashboard never goes
  // stale when someone changes the budget directly on Meta.
  recordLiveBudget?: (campaign: GenCampaign, liveBudgetAgorot: number) => Promise<void>;
  // AIC-67 follow-up: cache the TRUE lifetime lead count for the lead-quality
  // watermark. A read failure just means the watermark doesn't advance this
  // tick — never guessed from snapshot sums.
  leadsReader?: LeadsReader;
  recordLeadsToDate?: (campaign: GenCampaign, leadsToDate: number, spendToDate?: number) => Promise<void>;
  ref?: Date;
  logger?: Logger;
}): Promise<GenerationSummary> {
  const { campaigns, reader, snapshotStore, recommendationStore, recommendationService } = deps;
  const { current, previous }: { current: InsightsPeriod; previous: InsightsPeriod } =
    rollingPeriods(deps.ref);
  const log = deps.logger;

  const summary: GenerationSummary = { evaluated: 0, created: 0, expired: 0, skipped: 0, deliveryProblems: 0 };

  for (const campaign of campaigns) {
    let currentBudgetAgorot: number;
    try {
      currentBudgetAgorot = (await reader.getCampaignState(campaign.metaCampaignId)).dailyBudgetAgorot;
    } catch (e) {
      summary.skipped++;
      log?.error(`[generation] ${campaign.id}: could not read live budget — ${(e as Error).message}`);
      continue;
    }
    try {
      await deps.recordLiveBudget?.(campaign, currentBudgetAgorot);
    } catch (e) {
      log?.error(`[generation] ${campaign.id}: could not record live budget — ${(e as Error).message}`);
    }

    if (deps.leadsReader) {
      try {
        const r = deps.leadsReader.getLifetimeTotals
          ? await deps.leadsReader.getLifetimeTotals(campaign.metaCampaignId)
          : { leads: await deps.leadsReader.getLifetimeLeads(campaign.metaCampaignId), spendAgorot: undefined };
        await deps.recordLeadsToDate?.(campaign, r.leads, r.spendAgorot);
      } catch (e) {
        log?.error(`[generation] ${campaign.id}: could not read/record lifetime totals — ${(e as Error).message}`);
      }
    }

    // Audience labels + dynamic-creative flags + managed-ad-set filtering
    // (AIC-65): fetch ad-set metadata FIRST (before delivery-health), so a
    // deleted/archived/never-published-draft ad set (isManaged=false — the
    // real GelNails case: effective_status ACTIVE but zero ads) is known
    // before delivery-health runs, and never counted as a real ad set, never
    // cached, never labeled. A read failure just means no label/exclusion
    // this tick (rules fall back to the raw id).
    let adSetLabels: Map<string, string> | undefined;
    let flexibleCreativeAdSetIds: Set<string> | undefined;
    let unmanagedAdSetIds = new Set<string>();
    if (deps.audienceMetaReader) {
      try {
        const allAdsets = await deps.audienceMetaReader.getAdSetMeta(campaign.metaCampaignId);
        const managedAdsets = allAdsets.filter((a) => a.isManaged);
        unmanagedAdSetIds = new Set(allAdsets.filter((a) => !a.isManaged).map((a) => a.adSetId));
        adSetLabels = deriveAudienceLabels(managedAdsets);
        flexibleCreativeAdSetIds = new Set(managedAdsets.filter((a) => a.isDynamicCreative).map((a) => a.adSetId));
        await deps.recordAudienceMeta?.(campaign, managedAdsets);
      } catch (e) {
        log?.error(`[generation] ${campaign.id}: audience-meta read failed — ${(e as Error).message}`);
      }
    }

    // Delivery health: record it + exclude any not-delivering ad set from the
    // evidence. A health-read failure doesn't block generation (exclude
    // nothing). Dead/draft ad sets (unmanagedAdSetIds, just computed above)
    // are dropped from the health check entirely — a deleted ad set not
    // delivering is expected, never a needs-attention item (AIC-65).
    let deliveryProblemAdSetIds: Set<string> | undefined;
    if (deps.deliveryReader) {
      try {
        const health = await deps.deliveryReader.getDeliveryHealth(campaign.metaCampaignId);
        const realHealth = health.filter((h) => !unmanagedAdSetIds.has(h.adSetId));
        const del = summarize(realHealth);
        if (!del.ok) {
          summary.deliveryProblems++;
          deliveryProblemAdSetIds = new Set(del.problemAdSetIds);
          log?.info(`[generation] ${campaign.id}: delivery problem — ${del.reason} [${del.problemAdSetIds.join(", ")}]`);
        }
        await deps.recordDelivery?.(campaign, del);
      } catch (e) {
        log?.error(`[generation] ${campaign.id}: delivery-health read failed — ${(e as Error).message}`);
      }
    }

    // Evidence excludes BOTH real delivery problems and unmanaged ad sets —
    // but only the former is a "delivery problem" for AIC-64's no-rec reason
    // (classifyNoAction), so the two stay separate all the way through.
    const excludeAdSetIds = new Set([...(deliveryProblemAdSetIds ?? []), ...unmanagedAdSetIds]);

    const result = await refreshRecommendations({
      snapshotStore,
      recommendationStore,
      recommendationService,
      campaign: { id: campaign.id, currentBudgetAgorot },
      current,
      previous,
      expiresAt: null,
      excludeAdSetIds: excludeAdSetIds.size > 0 ? excludeAdSetIds : undefined,
      // Explicit, even when empty: buildCampaignEvidence falls back to the
      // FULL exclude set (delivery ∪ unmanaged) when this is omitted, which
      // would wrongly call an unmanaged-only exclusion "delivery_blocked".
      deliveryProblemAdSetIds: deliveryProblemAdSetIds ?? new Set(),
      adSetLabels,
      flexibleCreativeAdSetIds,
    });

    summary.evaluated++;
    summary.expired += result.expiredIds.length;
    if (result.createdId) {
      summary.created++;
      log?.info(`[generation] ${campaign.id}: proposed ${result.freshDraft.type}`);
    }
    try {
      await deps.recordNoRecReason?.(campaign, result.freshDraft);
    } catch (e) {
      log?.error(`[generation] ${campaign.id}: could not record no-rec reason — ${(e as Error).message}`);
    }
  }

  return summary;
}

// Bind a generation tick to the DB + a real Meta reader. Returns null (inert)
// when no System User token is set, mirroring the ingestion scheduler.
export function buildGenerationTick(pool: pg.Pool): (() => Promise<GenerationSummary>) | null {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) return null;
  const adapter = new GraphCampaignAdapter(token, process.env.META_GRAPH_VERSION || "v21.0");
  const snapshotStore = new PgSnapshotStore(pool);
  const recommendationStore = new PgRecommendationStore(pool);
  const recommendationService = new RecommendationService(recommendationStore);
  const ops = new OpsQueue(pool, consoleLogger);

  return async () => {
    const campaigns = await listEligibleForGeneration(pool);
    return runGenerationTick({
      campaigns,
      reader: adapter,
      deliveryReader: adapter,
      recordDelivery: async (campaign, del) => {
        await recordCampaignDelivery({ pool, ops, campaignId: campaign.id, customerId: campaign.customerId, summary: del });
      },
      audienceMetaReader: adapter,
      recordAudienceMeta: async (campaign, adsets) => {
        await upsertAdSetMeta(pool, campaign.id, adsets);
      },
      recordNoRecReason: async (campaign, draft) => {
        await recordNoRecReason({ pool, campaignId: campaign.id, draft });
      },
      recordLiveBudget: async (campaign, liveBudgetAgorot) => {
        await recordLiveBudget({ pool, campaignId: campaign.id, liveBudgetAgorot });
      },
      leadsReader: adapter,
      recordLeadsToDate: async (campaign, leadsToDate, spendToDate) => {
        await recordLeadsToDate({ pool, campaignId: campaign.id, leadsToDate, spendToDate });
      },
      snapshotStore,
      recommendationStore,
      recommendationService,
      logger: consoleLogger,
    });
  };
}
