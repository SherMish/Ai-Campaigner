import { isEngagementResult } from "@aic/shared";
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
import { summarizeTracking, type TrackingReader, type TrackingSummary } from "../meta/tracking-health.js";
import { summarizeCta, type CtaReader, type CtaSummary } from "../meta/cta-health.js";
import { summarizeAccount, type AccountHealthReader, type AccountSummary } from "../meta/account-health.js";
import { recordCampaignTracking } from "../services/tracking-monitor.js";
import { recordCampaignCta } from "../services/cta-monitor.js";
import { recordAccountHealth } from "../services/account-monitor.js";
import { LEAD_ACTION_PRIORITY } from "../meta/insights.js";
import { deriveAudienceLabels, type AdSetMeta } from "../meta/audience-label.js";
import { upsertAdSetMeta } from "../services/audience-meta-cache.js";
import { refreshAdMetaNow } from "../services/ad-meta-cache.js";
import { recordNoRecReason } from "../services/evaluation-reason.js";
import { recordLiveBudget } from "../services/live-budget.js";
import { recordLeadsToDate } from "../services/leads-to-date.js";
import { getLatestEngineActionByType } from "../services/action-history.js";
import { OpsQueue } from "../services/ops-queue.js";
import { consoleLogger, type Logger } from "../services/logger.js";

export interface AudienceMetaReader {
  getAdSetMeta(metaCampaignId: string): Promise<AdSetMeta[]>;
}

// AIC-77b: which recommendation TYPES this campaign's engine last executed
// successfully, and when — pure DB read (no Meta call), so this stays a
// separate injected dep from MetaReader/DeliveryReader/etc rather than
// stretching one of those interfaces to cover something unrelated to Meta.
export interface CooldownReader {
  getLatestEngineActionByType(campaignId: string): Promise<Record<string, Date>>;
}

// AIC-67 follow-up: a TRUE lifetime lead count, distinct from any
// insight_snapshots aggregation (those rows are overlapping rolling
// windows — see leads-to-date.ts).
export interface LeadsReader {
  getLifetimeLeads(metaCampaignId: string): Promise<number>;
  // Lifetime leads + spend in one call. Optional so existing doubles that
  // only implement getLifetimeLeads keep working. AIC-87: `leadEventTypes`
  // is the campaign's own lead definition — this is the SECOND independent
  // site (besides ingestion) that turns raw Insights actions into a leads
  // count, and it must use the same per-campaign definition or leads_to_date
  // silently disagrees with everything else the customer sees.
  getLifetimeTotals?(metaCampaignId: string, leadEventTypes?: readonly string[]): Promise<{ leads: number; spendAgorot: number }>;
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
  // Per-account rule threshold overrides (AIC-77a, managed_campaigns.threshold_overrides).
  thresholdOverrides?: Record<string, number> | null;
  // AIC-87: this campaign's own lead definition (managed_campaigns.lead_event_types).
  leadEventTypes?: readonly string[] | null;
  // AIC-72: the ad account to health-check, and the connection row its verdict
  // is cached on. Optional so existing callers and tests are untouched.
  connectionId?: string | null;
  metaAdAccountId?: string | null;
}

export interface GenerationSummary {
  evaluated: number; // campaigns whose rules ran
  created: number; // fresh recommendations proposed
  expired: number; // proposed recs the rules no longer support
  skipped: number; // eligible but couldn't read live budget
  deliveryProblems: number; // campaigns with a not-delivering ad set (AIC-39)
  trackingProblems: number;
  ctaProblems: number;
  accountProblems: number; // campaigns whose lead definition doesn't match Meta (AIC-88)
}

// Campaigns eligible for generation: actively managed, automation on, linked to a
// Meta campaign, and a healthy connection. Execution-frozen still generates
// (freeze blocks execution, not proposals — PRD §23); unmanaged/paused/off do not.
export async function listEligibleForGeneration(pool: pg.Pool): Promise<GenCampaign[]> {
  const { rows } = await pool.query<{
    id: string;
    meta_campaign_id: string;
    customer_id: string | null;
    threshold_overrides: Record<string, number>;
    lead_event_types: string[];
    connection_id: string;
    meta_ad_account_id: string | null;
  }>(
    // AIC-72 needs the ad account (to ask Meta if it can spend) and the
    // connection id (where that verdict is cached — one account backs N
    // campaigns, so it is a connection-level fact, not a campaign one).
    `SELECT mc.id, mc.meta_campaign_id, mc.customer_id, mc.threshold_overrides, mc.lead_event_types,
            conn.id AS connection_id, aa.meta_ad_account_id
     FROM managed_campaigns mc
     JOIN meta_connections conn ON conn.customer_id = mc.customer_id
     LEFT JOIN ad_accounts aa ON aa.id = mc.ad_account_id
     WHERE mc.status = 'active'
       AND mc.automation_enabled = true
       AND mc.meta_campaign_id IS NOT NULL
       AND conn.access_health = 'ok'`,
  );
  return rows.map((r) => ({
    id: r.id,
    metaCampaignId: r.meta_campaign_id,
    customerId: r.customer_id,
    thresholdOverrides: r.threshold_overrides,
    leadEventTypes: r.lead_event_types,
    connectionId: r.connection_id,
    metaAdAccountId: r.meta_ad_account_id ?? null,
  }));
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
  // AIC-88: compare the campaign's declared lead definition against what its
  // ad sets are configured on Meta to optimize for. A mismatch means every
  // real conversion counts as zero.
  trackingReader?: TrackingReader;
  ctaReader?: CtaReader;
  accountReader?: AccountHealthReader;
  recordTracking?: (campaign: GenCampaign, summary: TrackingSummary) => Promise<void>;
  recordCta?: (campaign: GenCampaign, summary: CtaSummary) => Promise<void>;
  recordAccount?: (campaign: GenCampaign, summary: AccountSummary) => Promise<void>;
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
  // AIC-77b: when provided, a class (creative/audience/budget) that executed
  // successfully within COOLDOWN_DAYS is suppressed — see rules.ts's
  // resolveCooldownClasses. A read failure just means no cooldown applies
  // this tick, same fail-open shape as every other optional reader here.
  cooldownReader?: CooldownReader;
  ref?: Date;
  logger?: Logger;
}): Promise<GenerationSummary> {
  const { campaigns, reader, snapshotStore, recommendationStore, recommendationService } = deps;
  const { current, previous }: { current: InsightsPeriod; previous: InsightsPeriod } =
    rollingPeriods(deps.ref);
  const log = deps.logger;

  const summary: GenerationSummary = { evaluated: 0, created: 0, expired: 0, skipped: 0, deliveryProblems: 0, trackingProblems: 0, ctaProblems: 0, accountProblems: 0 };

  for (const campaign of campaigns) {
    let currentBudgetAgorot: number;
    // AIC-77b: getCampaignState already reads adStatuses/adSetStatuses every
    // tick — previously discarded after reading only dailyBudgetAgorot. Now
    // threaded into evidence so the engine never proposes pausing an ad
    // that's already paused (by us, or manually via AIC-66).
    let adStatuses: Record<string, "active" | "paused"> = {};
    let adSetStatuses: Record<string, "active" | "paused"> = {};
    try {
      const state = await reader.getCampaignState(campaign.metaCampaignId);
      currentBudgetAgorot = state.dailyBudgetAgorot;
      adStatuses = state.adStatuses;
      adSetStatuses = state.adSetStatuses;
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
          ? await deps.leadsReader.getLifetimeTotals(campaign.metaCampaignId, campaign.leadEventTypes ?? undefined)
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
    // AIC-117: delivery-health already computes the honest count of ads that
    // are actually running. The AIC-86 advisory was reasoning from
    // `comparableCount` (ads with measured DATA) instead, which reads 0 on a
    // young campaign — so a customer with two live ads was told only one was
    // running. Captured here and handed to the rules below.
    let liveCreativeCount: number | undefined;
    if (deps.deliveryReader) {
      try {
        const health = await deps.deliveryReader.getDeliveryHealth(campaign.metaCampaignId);
        const realHealth = health.filter((h) => !unmanagedAdSetIds.has(h.adSetId));
        const del = summarize(realHealth);
        liveCreativeCount = del.deliveringAdCount;
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

    // AIC-88: does the campaign's declared lead definition match what Meta is
    // actually optimizing for? A mismatch means every real conversion counts
    // as zero, so the engine would reason over — and eventually act on — a
    // number that is structurally wrong. Deliberately NOT gated on delivery or
    // spend: this is a pure configuration comparison, so it works on a paused
    // campaign, i.e. it can catch the misconfiguration before a shekel is
    // spent. Fail-open like every other optional step.
    let trackingBroken = false;
    if (deps.trackingReader) {
      try {
        const configs = await deps.trackingReader.getAdSetTracking(campaign.metaCampaignId);
        // Judge only ad sets we actually manage — a dead/draft one's config is
        // not a live problem (the AIC-65 lesson, same filter as delivery above).
        const realConfigs = configs.filter((c) => !unmanagedAdSetIds.has(c.adSetId));
        const tr = summarizeTracking(realConfigs, campaign.leadEventTypes ?? LEAD_ACTION_PRIORITY);
        if (tr.state === "broken") {
          trackingBroken = true;
          summary.trackingProblems++;
          log?.info(`[generation] ${campaign.id}: tracking misconfigured — ${tr.reason}`);
        }
        await deps.recordTracking?.(campaign, tr);
      } catch (e) {
        // Unreadable config is `unknown`, never "broken" — never flag on a failure.
        log?.error(`[generation] ${campaign.id}: tracking-health read failed — ${(e as Error).message}`);
      }
    }

    // AIC-72: can the AD ACCOUNT spend at all? Checked FIRST among the health
    // checks, because it dominates them: a disabled or unfunded account makes
    // every campaign on it dead regardless of how well each one is configured.
    // Reporting "the button is broken" on an account that cannot pay would send
    // an operator to fix the wrong thing.
    let accountCannotSpend = false;
    if (deps.accountReader && campaign.metaAdAccountId) {
      try {
        const h = await deps.accountReader.getAdAccountHealth(campaign.metaAdAccountId);
        const acct = summarizeAccount(h);
        if (acct.state === "broken") {
          accountCannotSpend = true;
          summary.accountProblems++;
          log?.info(`[generation] ${campaign.id}: ad account cannot spend — ${acct.reason}`);
        }
        await deps.recordAccount?.(campaign, acct);
      } catch (e) {
        // Unreadable is `unknown`, never "broken" — never flag on a read failure.
        log?.error(`[generation] ${campaign.id}: account-health read failed — ${(e as Error).message}`);
      }
    }

    // AIC-128: does every ad's CREATIVE carry the destination its AD SET
    // promises? Found live — a Click-to-WhatsApp campaign whose creatives had
    // a CTA *type* (Meta derives it from the ad set) but no whatsapp_number,
    // so the button opened nothing and rendered as a dead "See more". Every
    // existing check passed: delivering, tracking matched, real spend. Only a
    // comparison of the ad set's promise against the creative's payload sees
    // it. Like tracking, a pure config comparison — no spend or delivery
    // needed, so a rebuild can be verified before it costs anything.
    let ctaBroken = false;
    if (deps.ctaReader) {
      try {
        const dests = await deps.ctaReader.getAdCreativeDestinations(campaign.metaCampaignId);
        // Same AIC-65 filter as delivery/tracking: a dead or draft ad set's
        // configuration is not a live problem.
        const realDests = dests.filter((d) => !unmanagedAdSetIds.has(d.adSetId));
        const cta = summarizeCta(realDests);
        if (cta.state === "broken") {
          ctaBroken = true;
          summary.ctaProblems++;
          log?.info(`[generation] ${campaign.id}: CTA broken — ${cta.reason}`);
        }
        await deps.recordCta?.(campaign, cta);
      } catch (e) {
        // Unreadable is `unknown`, never "broken" — never flag on a read failure.
        log?.error(`[generation] ${campaign.id}: cta-health read failed — ${(e as Error).message}`);
      }
    }

    let lastActionAtByType: Record<string, Date> | undefined;
    if (deps.cooldownReader) {
      try {
        lastActionAtByType = await deps.cooldownReader.getLatestEngineActionByType(campaign.id);
      } catch (e) {
        log?.error(`[generation] ${campaign.id}: cooldown read failed — ${(e as Error).message}`);
      }
    }

    const result = await refreshRecommendations({
      snapshotStore,
      recommendationStore,
      recommendationService,
      campaign: {
        id: campaign.id,
        currentBudgetAgorot,
        // AIC-107: derived from the campaign's own result definition — the
        // same single source of truth (managed_campaigns.lead_event_types)
        // the metrics layer uses, so the engine can never disagree with the
        // dashboard about what this campaign counts. Gates increase_budget.
        isEngagement: isEngagementResult(campaign.leadEventTypes),
        thresholdOverrides: campaign.thresholdOverrides,
        lastActionAtByType,
      },
      current,
      previous,
      expiresAt: null,
      excludeAdSetIds: excludeAdSetIds.size > 0 ? excludeAdSetIds : undefined,
      // Explicit, even when empty: buildCampaignEvidence falls back to the
      // FULL exclude set (delivery ∪ unmanaged) when this is omitted, which
      // would wrongly call an unmanaged-only exclusion "delivery_blocked".
      deliveryProblemAdSetIds: deliveryProblemAdSetIds ?? new Set(),
      trackingBroken,
      ctaBroken,
      accountCannotSpend,
      adSetLabels,
      flexibleCreativeAdSetIds,
      liveCreativeCount,
      adStatuses,
      adSetStatuses,
      now: deps.ref,
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
        // Per-AD cache alongside the per-ad-set one (2026-08-22). The
        // customer's ad list is insight-derived, so an ad with no impressions
        // yet — every ad for its first hours, and a rejected one forever — is
        // invisible without this. Isolated: a failure here must not take down
        // an otherwise-successful tick, and a stale ad cache is far less
        // harmful than a lost delivery/tracking result.
        if (campaign.metaCampaignId) {
          try {
            await refreshAdMetaNow(pool, adapter, campaign.id, campaign.metaCampaignId);
          } catch (e) {
            console.error(`[generation] ad-meta refresh failed for ${campaign.id} — ${(e as Error).message}`);
          }
        }
      },
      trackingReader: adapter,
      recordTracking: async (campaign, tr) => {
        await recordCampaignTracking({ pool, ops, campaignId: campaign.id, customerId: campaign.customerId, summary: tr });
      },
      ctaReader: adapter,
      recordCta: async (campaign, cta) => {
        await recordCampaignCta({ pool, ops, campaignId: campaign.id, customerId: campaign.customerId, summary: cta });
      },
      accountReader: adapter,
      recordAccount: async (campaign, acct) => {
        if (!campaign.connectionId) return;
        await recordAccountHealth({ pool, ops, connectionId: campaign.connectionId, customerId: campaign.customerId, summary: acct });
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
      cooldownReader: {
        getLatestEngineActionByType: (campaignId) => getLatestEngineActionByType(pool, campaignId),
      },
      snapshotStore,
      recommendationStore,
      recommendationService,
      logger: consoleLogger,
    });
  };
}
