import type pg from "pg";
import type { OpsQueueType, OpsSeverity, OpsStatus } from "@aic/shared";
import type { Logger } from "./logger.js";

export interface OpsItem {
  id: string;
  createdAt: Date;
  customerId: string | null;
  campaignId: string | null;
  type: OpsQueueType;
  severity: OpsSeverity;
  status: OpsStatus;
  detail: string;
  claimedBy: string | null;
  resolutionNote: string | null;
  // AIC-121: found live — the queue showed severity/type/detail but never
  // WHICH customer or campaign, so several near-identical items (repeated
  // connection-health flaps on one account) were indistinguishable at a
  // glance. Same join shape the notification relay already does for
  // Telegram (AIC-118's campaignNames helper) — kept separate rather than
  // shared, since that one batches many campaign ids and this is a single
  // list query.
  businessName: string | null;
  campaignName: string | null;
}

export interface CreateOpsItem {
  customerId: string | null;
  campaignId?: string | null;
  type: OpsQueueType;
  severity: OpsSeverity;
  detail: string;
}

function rowToItem(r: Record<string, unknown>): OpsItem {
  return {
    id: r.id as string,
    createdAt: r.created_at as Date,
    customerId: (r.customer_id as string) ?? null,
    campaignId: (r.campaign_id as string) ?? null,
    type: r.type as OpsQueueType,
    severity: r.severity as OpsSeverity,
    status: r.status as OpsStatus,
    detail: (r.detail as string) ?? "",
    claimedBy: (r.claimed_by as string) ?? null,
    resolutionNote: (r.resolution_note as string) ?? null,
    // Present only on rows from list()'s joined query; claim()/resolve()'s
    // plain UPDATE...RETURNING never selects these, so they're undefined
    // there — normalized to null either way. Callers of claim/resolve
    // (AdminCustomers.tsx) discard the response and reload the full list
    // anyway, so this never surfaces stale/missing names.
    businessName: (r.business_name as string) ?? null,
    campaignName: (r.campaign_name as string) ?? null,
  };
}

// The needs-attention queue over ops_queue_item (AIC-17). One prioritized worklist
// across all accounts, so one operator can supervise many. High severity first,
// then oldest; resolved items fall away unless explicitly included.
export class OpsQueue {
  constructor(private readonly pool: pg.Pool, private readonly logger?: Logger) {}

  async create(item: CreateOpsItem): Promise<OpsItem> {
    const { rows } = await this.pool.query(
      `INSERT INTO ops_queue_items (customer_id, campaign_id, type, severity, detail)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [item.customerId, item.campaignId ?? null, item.type, item.severity, item.detail],
    );
    // High-severity items are what a human must see fast. Telegram alerting reuses
    // this hook (console for now; the alert sink is a later notifications concern).
    if (item.severity === "high") {
      this.logger?.error(`[ops] HIGH: ${item.type} — ${item.detail}`);
    }
    return rowToItem(rows[0]);
  }

  async list(opts: { includeResolved?: boolean } = {}): Promise<OpsItem[]> {
    const where = opts.includeResolved ? "" : "WHERE oq.status <> 'resolved'";
    // LEFT JOINs (not JOIN): customer_id and campaign_id are both nullable on
    // ops_queue_items — an item can exist with no linked campaign at all
    // (e.g. support_request before a campaign is provisioned).
    const { rows } = await this.pool.query(
      `SELECT oq.*, c.business_name, mc.name AS campaign_name
       FROM ops_queue_items oq
       LEFT JOIN customers c ON c.id = oq.customer_id
       LEFT JOIN managed_campaigns mc ON mc.id = oq.campaign_id
       ${where}
       ORDER BY CASE oq.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                oq.created_at ASC`,
    );
    return rows.map(rowToItem);
  }

  async claim(id: string, operator: string): Promise<OpsItem | null> {
    const { rows } = await this.pool.query(
      `UPDATE ops_queue_items SET status = 'in_progress', claimed_by = $2
       WHERE id = $1 AND status <> 'resolved' RETURNING *`,
      [id, operator],
    );
    return rows[0] ? rowToItem(rows[0]) : null;
  }

  async resolve(id: string, note: string): Promise<OpsItem | null> {
    const { rows } = await this.pool.query(
      `UPDATE ops_queue_items SET status = 'resolved', resolution_note = $2
       WHERE id = $1 RETURNING *`,
      [id, note],
    );
    return rows[0] ? rowToItem(rows[0]) : null;
  }
}
