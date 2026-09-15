import type pg from "pg";
import { GraphMetaClient } from "./client.js";
import { GraphCampaignAdapter } from "./campaign-adapter.js";
import { tokenForCampaign } from "./token-resolver.js";
import { PgSnapshotStore } from "./snapshot-store.js";
import { IngestionService, runIngestionTick } from "./ingestion-service.js";
import { rollingPeriods, todayPeriod, dailyPeriod } from "./scheduled-ingestion.js";
import { upsertAdSetMeta } from "../services/audience-meta-cache.js";
import { refreshAdMetaNow } from "../services/ad-meta-cache.js";
import { recordLeadsToDate } from "../services/leads-to-date.js";
import { recordCampaignDelivery } from "../services/delivery-monitor.js";
import { OpsQueue } from "../services/ops-queue.js";
import { summarize } from "./delivery-health.js";
import { createRefresher, isRateLimit, type RefreshState } from "../services/on-demand-refresh.js";
import { consoleLogger, type Logger } from "../services/logger.js";

// AIC-191 — the production binding of the on-demand refresher: what "refresh
// this campaign" actually pulls, and against which credential.

class NoCredentialError extends Error {}

let singleton: ((campaignId: string) => Promise<RefreshState>) | null = null;

export function campaignRefresher(pool: pg.Pool): (campaignId: string) => Promise<RefreshState> {
  if (singleton) return singleton;
  const store = new PgSnapshotStore(pool);
  const ops = new OpsQueue(pool, consoleLogger);
  const ver = process.env.META_GRAPH_VERSION || "v21.0";

  singleton = createRefresher({
    load: async (campaignId) => {
      const { rows } = await pool.query<{
        id: string; meta_campaign_id: string | null; meta_ad_account_id: string | null; data_refreshed_at: Date | null;
      }>(
        `SELECT mc.id, mc.meta_campaign_id, aa.meta_ad_account_id, mc.data_refreshed_at
           FROM managed_campaigns mc
           LEFT JOIN ad_accounts aa ON aa.id = mc.ad_account_id
          WHERE mc.id = $1`,
        [campaignId],
      );
      const r = rows[0];
      return r ? {
        campaignId: r.id,
        metaCampaignId: r.meta_campaign_id,
        adAccountId: r.meta_ad_account_id,
        refreshedAt: r.data_refreshed_at,
      } : null;
    },

    refresh: async (c) => {
      const resolved = await tokenForCampaign(pool, c.campaignId);
      if (!resolved) throw new NoCredentialError(`no usable Meta credential for campaign ${c.campaignId}`);

      const { rows } = await pool.query<{ lead_event_types: string[] | null; connection_id: string | null; customer_id: string }>(
        `SELECT mc.lead_event_types, conn.id AS connection_id, mc.customer_id
           FROM managed_campaigns mc
           LEFT JOIN meta_connections conn ON conn.customer_id = mc.customer_id
          WHERE mc.id = $1 LIMIT 1`,
        [c.campaignId],
      );
      const leadEventTypes = rows[0]?.lead_event_types ?? undefined;

      // 1. Insights. runIngestionTick swallows per-window failures into its
      //    logger, which is right for a scheduler and wrong here: a rate limit
      //    has to reach the refresher so it can back the account off. So the
      //    logger captures the first rate-limit error and it is rethrown.
      let throttle: unknown = null;
      const capture: Logger = {
        info: () => {},
        error: (msg, err) => {
          if (!throttle && isRateLimit(err)) throttle = err;
          consoleLogger.error(`[refresh] ${msg}`, err);
        },
      };
      await runIngestionTick({
        campaigns: [{ id: c.campaignId, metaCampaignId: c.metaCampaignId, connectionId: null, leadEventTypes }],
        ingestionFor: async () => new IngestionService(store, new GraphMetaClient(resolved.token)),
        period: rollingPeriods().current,
        extraPeriods: [todayPeriod()],
        dailyPeriod: dailyPeriod(),
        logger: capture,
      });
      // Stop here rather than spend the next calls into an account that has
      // already said stop — each one extends the block.
      if (throttle) throw throttle;

      const adapter = new GraphCampaignAdapter(resolved.token, ver);
      const metaCampaignId = c.metaCampaignId!;

      // 2. The ad-set and ad caches the breakdown panel draws its rows from.
      const adsets = await adapter.getAdSetMeta(metaCampaignId);
      await upsertAdSetMeta(pool, c.campaignId, adsets.filter((a) => a.existsOnMeta));
      await refreshAdMetaNow(pool, adapter, c.campaignId, metaCampaignId);

      // 3. Is anything actually delivering? The dashboard's headline reads
      //    `delivering`, which only the recommendations tick wrote — and that
      //    tick skips automation-off campaigns, so a campaign paused on Meta
      //    read "הקמפיין פעיל" indefinitely (found live on GelNails). Deliberately
      //    NOT refreshDeliveryNow: that one swallows errors, and a rate limit
      //    here has to reach the refresher.
      const health = await adapter.getDeliveryHealth(metaCampaignId);
      await recordCampaignDelivery({
        pool, ops, campaignId: c.campaignId, customerId: rows[0]?.customer_id ?? null, summary: summarize(health),
      });

      // 4. The lifetime lead count. Only the recommendations tick wrote it,
      //    and that tick skips automation-off campaigns — so lead quality said
      //    "no leads yet" beside nine real ones.
      const totals = await adapter.getLifetimeTotals(metaCampaignId, leadEventTypes);
      await recordLeadsToDate({ pool, campaignId: c.campaignId, leadsToDate: totals.leads, spendToDate: totals.spendAgorot });
    },

    markRefreshed: async (campaignId, at) => {
      await pool.query(`UPDATE managed_campaigns SET data_refreshed_at = $2 WHERE id = $1`, [campaignId, at]);
    },

    isThrottle: isRateLimit,
    log: (msg, e) => (e ? consoleLogger.error(msg, e) : consoleLogger.info(msg)),
  });
  return singleton;
}
