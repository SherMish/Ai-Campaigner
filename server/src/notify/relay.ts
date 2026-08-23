// Ops notification relay (AIC-118). Polls the two tables that already record
// everything worth knowing about — action_history (every change to a campaign,
// ad or ad set, plus every failed attempt) and ops_queue_items (operational
// alerts) — and pushes the new rows to Telegram.
//
// READ-THE-TABLES, don't add call sites. Seven places write action_history
// today. Calling a notifier from each would be seven chances to forget, and an
// eighth the next time someone adds one. Reading the table means every action
// type is covered by construction, including the ones deliberately hidden from
// the customer's own feed (rollback_build) which are exactly what an operator
// wants to see.
//
// Delivery is at-most-once by design: a row is CLAIMED (notified_at stamped)
// before the send, and a send that fails is logged and not retried. The
// alternative — retrying — risks replaying a burst every tick during a Telegram
// outage, and the underlying data is still in the DB and the ops console. The
// channel is a convenience, never the system of record.
import type pg from "pg";
import { sendTelegram, telegramConfigured } from "./telegram.js";
import { formatEvent, type ActionEvent, type OpsEvent, type NotifiableEvent } from "./format.js";
import type { Logger } from "../services/logger.js";

export interface RelaySummary {
  claimed: number;
  sent: number;
  skipped: number; // claimed but deliberately not sent (too old, or a test account)
  failed: number;
}

// Anything older than this is marked as seen WITHOUT being sent. Two cases it
// exists for: the first tick after the channel is configured (months of rows
// sitting unnotified), and a long outage or restart. Nobody wants to be paged
// about what happened last Tuesday, and a channel that opens with 400 messages
// is a channel that gets muted.
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

// Bounded per tick so one busy period can't turn into a single enormous batch.
const BATCH = 25;

export function buildNotificationRelay(
  pool: pg.Pool,
  log?: Logger,
  opts: { maxAgeMs?: number; includeTestCustomers?: boolean } = {},
): (() => Promise<RelaySummary>) | null {
  // Not configured → no relay at all, rather than a relay that claims rows and
  // drops them. Otherwise turning the channel on later would show nothing,
  // because everything since deploy would already be marked as sent.
  if (!telegramConfigured("ops")) return null;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  // Test accounts are claimed but never sent. This is not a test convenience —
  // local dev and CI point at the SAME database as production (see
  // docs/INDEX.md), so without it a single `vitest run` posts dozens of
  // fixture rows into the live ops channel. Found exactly that way: the relay's
  // own integration test claimed 20 rows written by other test files running
  // concurrently. Only the relay's own tests opt in.
  const includeTest = opts.includeTestCustomers === true;

  return async () => {
    const summary: RelaySummary = { claimed: 0, sent: 0, skipped: 0, failed: 0 };
    const events = [...(await claimActions(pool)), ...(await claimOpsItems(pool))];
    summary.claimed = events.length;
    if (events.length === 0) return summary;

    // Oldest first: the channel should read in the order things happened.
    events.sort((a, b) => at(a).getTime() - at(b).getTime());

    const cutoff = Date.now() - maxAgeMs;
    for (const e of events) {
      if (!includeTest && e.isTest) {
        summary.skipped++;
        continue;
      }
      if (at(e).getTime() < cutoff) {
        summary.skipped++;
        continue;
      }
      const outcome = await sendTelegram(formatEvent(e));
      if (outcome === "sent") summary.sent++;
      else {
        summary.failed++;
        log?.error(`[notify] relay could not send ${e.kind} ${e.id} — ${outcome}`);
      }
    }
    return summary;
  };
}

function at(e: NotifiableEvent): Date {
  return e.kind === "action" ? e.occurredAt : e.createdAt;
}

// Claim-then-read in one statement. FOR UPDATE SKIP LOCKED keeps two instances
// (or an overlapping tick) from claiming the same rows — the same discipline
// the Meta write-outbox already uses.
async function claimActions(pool: pg.Pool): Promise<ActionEvent[]> {
  const { rows } = await pool.query(
    `WITH claimed AS (
       SELECT id FROM action_history
       WHERE notified_at IS NULL
       ORDER BY occurred_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE action_history ah
     SET notified_at = now()
     FROM claimed
     WHERE ah.id = claimed.id
     RETURNING ah.id, ah.occurred_at, ah.action_type, ah.what, ah.why,
               ah.target_meta_id, ah.previous_state, ah.new_state,
               ah.approved_by, ah.human_involved, ah.result, ah.campaign_id`,
    [BATCH],
  );
  if (rows.length === 0) return [];

  // Names in a second query rather than a JOIN in the UPDATE: keeping the
  // claiming statement as narrow as possible means it locks only what it must.
  const names = await campaignNames(pool, rows.map((r) => r.campaign_id as string));
  return rows.map((r) => ({
    kind: "action" as const,
    id: r.id as string,
    occurredAt: r.occurred_at as Date,
    actionType: r.action_type as string,
    what: (r.what as string) ?? "",
    why: (r.why as string) ?? "",
    targetMetaId: (r.target_meta_id as string) ?? null,
    previousState: (r.previous_state as Record<string, unknown>) ?? {},
    newState: (r.new_state as Record<string, unknown>) ?? {},
    approvedBy: (r.approved_by as string) ?? null,
    humanInvolved: r.human_involved === true,
    result: r.result as "success" | "failed",
    businessName: names.get(r.campaign_id as string)?.businessName ?? null,
    campaignName: names.get(r.campaign_id as string)?.campaignName ?? null,
    // Unknown campaign → treat as a test row and stay silent. An event we
    // cannot attribute to a real customer is not one to page anyone about.
    isTest: names.get(r.campaign_id as string)?.isTest ?? true,
  }));
}

async function claimOpsItems(pool: pg.Pool): Promise<OpsEvent[]> {
  const { rows } = await pool.query(
    `WITH claimed AS (
       SELECT id FROM ops_queue_items
       WHERE notified_at IS NULL
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE ops_queue_items oq
     SET notified_at = now()
     FROM claimed
     WHERE oq.id = claimed.id
     RETURNING oq.id, oq.created_at, oq.type, oq.severity, oq.detail, oq.campaign_id,
               (SELECT business_name FROM customers c WHERE c.id = oq.customer_id) AS business_name`,
    [BATCH],
  );
  if (rows.length === 0) return [];

  const names = await campaignNames(
    pool,
    rows.map((r) => r.campaign_id as string | null).filter((v): v is string => !!v),
  );
  return rows.map((r) => ({
    kind: "ops" as const,
    id: r.id as string,
    createdAt: r.created_at as Date,
    type: r.type as string,
    severity: r.severity as "low" | "medium" | "high",
    detail: (r.detail as string) ?? "",
    // ops_queue_items carries customer_id directly; fall back to the campaign's
    // owner when only the campaign is set.
    businessName:
      (r.business_name as string) ??
      (r.campaign_id ? names.get(r.campaign_id as string)?.businessName ?? null : null),
    campaignName: r.campaign_id ? names.get(r.campaign_id as string)?.campaignName ?? null : null,
    isTest:
      r.is_test === true ||
      (r.is_test === null && r.campaign_id ? names.get(r.campaign_id as string)?.isTest ?? true : false),
  }));
}

async function campaignNames(
  pool: pg.Pool,
  campaignIds: string[],
): Promise<Map<string, { businessName: string | null; campaignName: string | null; isTest: boolean }>> {
  const ids = [...new Set(campaignIds)];
  if (ids.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT mc.id, mc.name AS campaign_name, c.business_name, c.is_test
     FROM managed_campaigns mc
     JOIN customers c ON c.id = mc.customer_id
     WHERE mc.id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(
    rows.map((r) => [
      r.id as string,
      {
        businessName: (r.business_name as string) ?? null,
        campaignName: (r.campaign_name as string) ?? null,
        isTest: r.is_test === true,
      },
    ]),
  );
}
