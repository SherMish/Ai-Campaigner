import type pg from "pg";
import type { InsightsPeriod } from "./types.js";
import { GraphMetaClient } from "./client.js";
import { PgSnapshotStore } from "./snapshot-store.js";
import { PgConnectionStore } from "./connection-store.js";
import { ConnectionService } from "./connection-service.js";
import {
  IngestionService,
  runIngestionTick,
  type TickSummary,
  type ManagedCampaignRef,
} from "./ingestion-service.js";
import { consoleLogger } from "../services/logger.js";

// Managed campaigns joined to their connection, for a tick.
async function listManagedCampaigns(
  pool: pg.Pool,
): Promise<Array<ManagedCampaignRef & { connectionId: string | null }>> {
  const { rows } = await pool.query(
    `SELECT mc.id,
            mc.meta_campaign_id,
            conn.id AS connection_id
     FROM managed_campaigns mc
     JOIN customers c        ON c.id = mc.customer_id
     LEFT JOIN meta_connections conn ON conn.customer_id = mc.customer_id
     WHERE mc.status <> 'unmanaged' AND mc.automation_enabled = true`,
  );
  return rows.map((r) => ({
    id: r.id,
    metaCampaignId: r.meta_campaign_id ?? null,
    connectionId: r.connection_id ?? null,
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
  );
  return async () => {
    const campaigns = await listManagedCampaigns(pool);
    const { current } = rollingPeriods();
    return runIngestionTick({
      campaigns,
      ingestion,
      period: current,
      extraPeriods: [todayPeriod()], // customer dashboard only — see todayPeriod
      logger: consoleLogger,
      connectionService,
    });
  };
}
