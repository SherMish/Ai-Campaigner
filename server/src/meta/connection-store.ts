import type { AccessHealth, OpsQueueType, OpsSeverity } from "@aic/shared";
import type pg from "pg";

// The connection as the service needs to see it.
export interface ConnectionRow {
  id: string;
  customerId: string;
  accessHealth: AccessHealth;
  adAccountMetaId: string | null;
  pageId: string | null;
  instagramId: string | null;
}

export interface OpsItemInput {
  customerId: string | null;
  campaignId?: string | null;
  type: OpsQueueType;
  severity: OpsSeverity;
  detail: string;
}

// Persistence the connection service depends on. Abstracted so the service logic
// is unit-tested against an in-memory fake and runs in prod against Postgres.
export interface ConnectionStore {
  getConnection(id: string): Promise<ConnectionRow | null>;
  updateHealth(
    id: string,
    health: AccessHealth,
    verifiedAt: Date,
  ): Promise<void>;
  touchVerified(id: string, verifiedAt: Date): Promise<void>;
  raiseOpsItem(item: OpsItemInput): Promise<void>;
}

// Postgres-backed store.
export class PgConnectionStore implements ConnectionStore {
  constructor(private readonly pool: pg.Pool) {}

  async getConnection(id: string): Promise<ConnectionRow | null> {
    const { rows } = await this.pool.query(
      `SELECT mc.id, mc.customer_id, mc.access_health, mc.page_id, mc.instagram_id,
              aa.meta_ad_account_id AS ad_account_meta_id
       FROM meta_connections mc
       LEFT JOIN ad_accounts aa ON aa.connection_id = mc.id
       WHERE mc.id = $1
       LIMIT 1`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      customerId: r.customer_id,
      accessHealth: r.access_health,
      adAccountMetaId: r.ad_account_meta_id ?? null,
      pageId: r.page_id ?? null,
      instagramId: r.instagram_id ?? null,
    };
  }

  async updateHealth(
    id: string,
    health: AccessHealth,
    verifiedAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE meta_connections
       SET access_health = $2, last_verified_at = $3
       WHERE id = $1`,
      [id, health, verifiedAt],
    );
  }

  async touchVerified(id: string, verifiedAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE meta_connections SET last_verified_at = $2 WHERE id = $1`,
      [id, verifiedAt],
    );
  }

  async raiseOpsItem(item: OpsItemInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO ops_queue_items (customer_id, campaign_id, type, severity, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        item.customerId,
        item.campaignId ?? null,
        item.type,
        item.severity,
        item.detail,
      ],
    );
  }
}

// In-memory store for unit tests — no DB.
export class InMemoryConnectionStore implements ConnectionStore {
  public opsItems: OpsItemInput[] = [];
  public healthUpdates: Array<{ id: string; health: AccessHealth; at: Date }> = [];
  public verifiedTouches: Array<{ id: string; at: Date }> = [];

  constructor(private readonly connections: Map<string, ConnectionRow>) {}

  async getConnection(id: string): Promise<ConnectionRow | null> {
    return this.connections.get(id) ?? null;
  }
  async updateHealth(id: string, health: AccessHealth, at: Date): Promise<void> {
    const c = this.connections.get(id);
    if (c) c.accessHealth = health;
    this.healthUpdates.push({ id, health, at });
  }
  async touchVerified(id: string, at: Date): Promise<void> {
    this.verifiedTouches.push({ id, at });
  }
  async raiseOpsItem(item: OpsItemInput): Promise<void> {
    this.opsItems.push(item);
  }
}
