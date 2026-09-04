import type pg from "pg";
import type { InsightsPeriod } from "./types.js";
import { GraphMetaClient } from "./client.js";
import { PgSnapshotStore } from "./snapshot-store.js";
import { PgConnectionStore } from "./connection-store.js";
import { track } from "../analytics/mixpanel.js";
import { ConnectionService } from "./connection-service.js";
import {
  IngestionService,
  runIngestionTick,
  type TickSummary,
  type ManagedCampaignRef,
} from "./ingestion-service.js";
import { consoleLogger } from "../services/logger.js";
import { GraphCampaignAdapter } from "./campaign-adapter.js";
import { upsertAdSetMeta } from "../services/audience-meta-cache.js";
import { refreshAdMetaNow } from "../services/ad-meta-cache.js";

// Managed campaigns joined to their connection, for a tick.
async function listManagedCampaigns(
  pool: pg.Pool,
): Promise<Array<ManagedCampaignRef & { connectionId: string | null }>> {
  const { rows } = await pool.query(
    `SELECT mc.id,
            mc.meta_campaign_id,
            mc.lead_event_types,
            conn.id AS connection_id
     FROM managed_campaigns mc
     JOIN customers c        ON c.id = mc.customer_id
     LEFT JOIN meta_connections conn ON conn.customer_id = mc.customer_id
     -- AIC-191: NOT gated on automation_enabled, deliberately.
     --
     -- That flag means "the engine may ACT on this campaign". Ingestion does
     -- not act — it reads Meta's insights and writes snapshots, spending
     -- nothing and changing nothing. Coupling the two meant turning automation
     -- off silently stopped DATA COLLECTION, so a customer who asked us not to
     -- touch their budget also lost their dashboard. Found live the moment a
     -- second campaign was connected with automation off: every number read
     -- "—" and the reason was invisible.
     --
     -- status <> unmanaged still excludes campaigns nobody is watching,
     -- which is the real "should we spend API calls on this" question.
     WHERE mc.status <> 'unmanaged'`,
  );
  return rows.map((r) => ({
    id: r.id,
    metaCampaignId: r.meta_campaign_id ?? null,
    connectionId: r.connection_id ?? null,
    // AIC-87: threaded to every ingest call in runIngestionTick.
    leadEventTypes: r.lead_event_types ?? undefined,
  }));
}

// Today-only window. Deliberately SEPARATE from rollingPeriods (below), which
// stops at yesterday: the engine must evaluate on COMPLETE days — a
// half-finished day looks like underperformance and would produce bad
// recommendations. But the customer dashboard has the opposite need: someone
// who got 3 leads today must see them, or the product looks broken (the real
// complaint: 3 leads today, headline still read "1 פניות"). So today is
// ingested as its own snapshot row and surfaced only on the customer surface,
// clearly marked provisional — Meta's same-day conversion data is incomplete
// and revises upward.
export function todayPeriod(ref: Date = new Date()): InsightsPeriod {
  const iso = ref.toISOString().slice(0, 10);
  return { start: iso, end: iso };
}

// How far back per-day rows are pulled each tick. Comfortably covers the
// customer's widest bounded range (month) plus the leads-per-week graph, with
// slack for Meta's attribution revising recent days upward. "All time" does
// NOT come from these — it's the cached lifetime read (leads_to_date /
// spend_to_date), so this window never has to grow with campaign age.
export const DAILY_LOOKBACK_DAYS = 45;

export function dailyPeriod(ref: Date = new Date()): InsightsPeriod {
  const day = 24 * 60 * 60 * 1000;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(new Date(ref.getTime() - DAILY_LOOKBACK_DAYS * day)), end: iso(ref) };
}

// Yesterday-inclusive 7-day window and the 7 days before it, from a reference
// date (defaults to now). Dates as YYYY-MM-DD in UTC.
export function rollingPeriods(ref: Date = new Date()): {
  current: InsightsPeriod;
  previous: InsightsPeriod;
} {
  const day = 24 * 60 * 60 * 1000;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const end = new Date(ref.getTime() - day); // through yesterday
  const curStart = new Date(end.getTime() - 6 * day);
  const prevEnd = new Date(curStart.getTime() - day);
  const prevStart = new Date(prevEnd.getTime() - 6 * day);
  return {
    current: { start: iso(curStart), end: iso(end) },
    previous: { start: iso(prevStart), end: iso(prevEnd) },
  };
}

// Assemble one tick bound to the DB + a real Meta client. Returns null (and logs)
// when no System User token is configured, so the scheduler stays inert until
// Meta is wired up — never a background job hammering an API it can't reach.
export function buildIngestionTick(
  pool: pg.Pool,
): (() => Promise<TickSummary>) | null {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) {
    consoleLogger.info(
      "ingestion scheduler inert: META_SYSTEM_USER_TOKEN not set",
    );
    return null;
  }
  const client = new GraphMetaClient(token);
  const ingestion = new IngestionService(new PgSnapshotStore(pool), client);
  const connectionService = new ConnectionService(
    new PgConnectionStore(pool),
    client,
    undefined,
    // AIC-28: only the SCHEDULED check reports connection transitions. The
    // on-demand recheck (customer-actions, admin) runs the same verify and
    // would double-count the same real-world event from a button press.
    ({ customerId, from, to }) => {
      void (async () => {
        const { rows } = await pool.query<{ is_test: boolean | null }>(
          `SELECT is_test FROM customers WHERE id = $1`,
          [customerId],
        );
        track({
          event: to === "ok" ? "meta_connection_restored" : "meta_connection_lost",
          customerId,
          isTest: rows[0]?.is_test === true,
          props: { from_health: from, to_health: to },
        });
      })().catch(() => {});
    },
  );
  // AIC-196 — the ad-set and ad META CACHES are refreshed here, with
  // ingestion, and no longer only inside the generation tick.
  //
  // Those caches are what הצג פירוט iterates to draw its rows: an ad set with
  // no cache row simply does not appear, however much measured data it has.
  // They were written by the generation tick, which requires
  // automation_enabled — so a customer who turned automation off kept their
  // numbers (AIC-191 fixed ingestion) and lost their AD SETS AND ADS. Found
  // live on a campaign connected with automation off: twelve snapshots, zero
  // cache rows, and a panel that said the campaign had only started today.
  //
  // Same principle as AIC-191, applied one layer further: a cache the CUSTOMER
  // reads is observation, not action, and must not depend on our permission to
  // act on their behalf.
  const adapter = new GraphCampaignAdapter(token);
  return async () => {
    const campaigns = await listManagedCampaigns(pool);
    const { current } = rollingPeriods();
    const summary = await runIngestionTick({
      campaigns,
      ingestion,
      period: current,
      extraPeriods: [todayPeriod()], // customer dashboard only — see todayPeriod
      dailyPeriod: dailyPeriod(), // disjoint per-day rows for the range switcher + graph
      logger: consoleLogger,
      connectionService,
    });

    for (const c of campaigns) {
      if (!c.metaCampaignId) continue;
      // Isolated per campaign and per cache: this is a display refresh, and
      // one customer's unreadable ad set must not cost everyone else theirs
      // — nor fail an ingestion tick that has already stored real data.
      try {
        const adsets = await adapter.getAdSetMeta(c.metaCampaignId);
        await upsertAdSetMeta(pool, c.id, adsets.filter((a) => a.existsOnMeta));
      } catch (e) {
        consoleLogger.error(`[ingestion] ad-set meta refresh failed for ${c.id}`, e);
      }
      try {
        await refreshAdMetaNow(pool, adapter, c.id, c.metaCampaignId);
      } catch (e) {
        consoleLogger.error(`[ingestion] ad meta refresh failed for ${c.id}`, e);
      }
    }
    return summary;
  };
}
