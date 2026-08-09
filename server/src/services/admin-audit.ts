import type pg from "pg";

// Append-only log of consequential actions taken IN the console — distinct from
// action_history (AIC-15), which logs Meta campaign changes. This logs operator
// actions on our own records: who, what, which entity, before→after, when.
// AIC-44 is the first writer (customer CRUD); AIC-47 adds the filterable UI +
// operator-account actions on top of this same table.

export interface Actor {
  userId: string | null;   // null only for the break-glass token path (no human)
  label: string;           // snapshot (usually the actor's email) so the log
                            // reads even if the app_user row is later deleted
}

export interface AuditEntry {
  id: string;
  createdAt: string;
  actorUserId: string | null;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string;
  beforeState: unknown;
  afterState: unknown;
  detail: string;
}

export interface AuditLogInput {
  actorUserId: string | null;
  actorLabel: string;
  action: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string;
  beforeState?: unknown;
  afterState?: unknown;
  detail?: string;
}

export async function logAdminAction(pool: pg.Pool, entry: AuditLogInput): Promise<void> {
  await pool.query(
    `INSERT INTO admin_audit_log
       (actor_user_id, actor_label, action, entity_type, entity_id, entity_label, before_state, after_state, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      entry.actorUserId,
      entry.actorLabel,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.entityLabel,
      entry.beforeState === undefined ? null : JSON.stringify(entry.beforeState),
      entry.afterState === undefined ? null : JSON.stringify(entry.afterState),
      entry.detail ?? "",
    ],
  );
}

export interface AuditFilter {
  entityId?: string;
  actorUserId?: string;
}

// AIC-44 needs enough of a read path to prove "delete is logged" and to show a
// per-customer trail; AIC-47 builds the full cross-entity filterable console.
export async function listAuditLog(pool: pg.Pool, filter: AuditFilter = {}): Promise<AuditEntry[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.entityId) { params.push(filter.entityId); clauses.push(`entity_id = $${params.length}`); }
  if (filter.actorUserId) { params.push(filter.actorUserId); clauses.push(`actor_user_id = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const { rows } = await pool.query(
    `SELECT * FROM admin_audit_log ${where} ORDER BY created_at DESC LIMIT 200`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    createdAt: new Date(r.created_at).toISOString(),
    actorUserId: r.actor_user_id,
    actorLabel: r.actor_label,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    entityLabel: r.entity_label,
    beforeState: r.before_state,
    afterState: r.after_state,
    detail: r.detail,
  }));
}
