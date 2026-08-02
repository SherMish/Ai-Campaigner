import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { RecommendationState } from "@aic/shared";
import type { RecommendationRecord, RecommendationDraft } from "./types.js";

export interface ActionHistoryEntry {
  campaignId: string;
  recommendationId: string | null;
  what: string;
  actionType: string;
  targetMetaId: string | null;
  previousState: Record<string, unknown>;
  newState: Record<string, unknown>;
  why: string;
  approvedBy: string | null;
  humanInvolved: boolean;
  result: "success" | "failed";
}

export interface RecommendationStore {
  create(draft: RecommendationDraft, expiresAt: Date | null): Promise<RecommendationRecord>;
  getById(id: string): Promise<RecommendationRecord | null>;
  listProposed(campaignId: string): Promise<RecommendationRecord[]>;
  // Optimistic state change: only succeeds if the row is still in `from`.
  // Returns the updated record, or null if the guard failed (concurrent change).
  setState(
    id: string,
    from: RecommendationState,
    to: RecommendationState,
    patch?: Partial<
      Pick<RecommendationRecord, "approvedBy" | "approvedAt" | "executedAt">
    >,
  ): Promise<RecommendationRecord | null>;
  writeActionHistory(entry: ActionHistoryEntry): Promise<void>;
}

// ── Postgres ────────────────────────────────────────────────────────────────
function rowToRecord(r: Record<string, unknown>): RecommendationRecord {
  return {
    id: r.id as string,
    campaignId: r.campaign_id as string,
    type: r.type as RecommendationRecord["type"],
    state: r.state as RecommendationState,
    targetMetaId: (r.target_meta_id as string) ?? null,
    evidence: (r.evidence as Record<string, unknown>) ?? {},
    currentBudgetAgorot: r.current_budget_agorot as number | null,
    proposedBudgetAgorot: r.proposed_budget_agorot as number | null,
    maxSpendImpactAgorot: r.max_spend_impact_agorot as number | null,
    rationale: (r.rationale as string) ?? "",
    expiresAt: (r.expires_at as Date) ?? null,
    approvedBy: (r.approved_by as string) ?? null,
    approvedAt: (r.approved_at as Date) ?? null,
    executedAt: (r.executed_at as Date) ?? null,
  };
}

export class PgRecommendationStore implements RecommendationStore {
  constructor(private readonly pool: pg.Pool) {}

  async create(draft: RecommendationDraft, expiresAt: Date | null): Promise<RecommendationRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO recommendations
         (campaign_id, type, state, target_meta_id, evidence,
          current_budget_agorot, proposed_budget_agorot, max_spend_impact_agorot,
          rationale, expires_at)
       VALUES ($1,$2,'proposed',$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        draft.campaignId,
        draft.type,
        draft.targetMetaId,
        JSON.stringify(draft.evidence),
        draft.currentBudgetAgorot,
        draft.proposedBudgetAgorot,
        draft.maxSpendImpactAgorot,
        draft.rationale,
        expiresAt,
      ],
    );
    return rowToRecord(rows[0]);
  }

  async getById(id: string): Promise<RecommendationRecord | null> {
    const { rows } = await this.pool.query(`SELECT * FROM recommendations WHERE id = $1`, [id]);
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  async listProposed(campaignId: string): Promise<RecommendationRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM recommendations WHERE campaign_id = $1 AND state = 'proposed'`,
      [campaignId],
    );
    return rows.map(rowToRecord);
  }

  async setState(
    id: string,
    from: RecommendationState,
    to: RecommendationState,
    patch: Partial<Pick<RecommendationRecord, "approvedBy" | "approvedAt" | "executedAt">> = {},
  ): Promise<RecommendationRecord | null> {
    const { rows } = await this.pool.query(
      `UPDATE recommendations
       SET state = $3,
           approved_by = COALESCE($4, approved_by),
           approved_at = COALESCE($5, approved_at),
           executed_at = COALESCE($6, executed_at)
       WHERE id = $1 AND state = $2
       RETURNING *`,
      [id, from, to, patch.approvedBy ?? null, patch.approvedAt ?? null, patch.executedAt ?? null],
    );
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  async writeActionHistory(e: ActionHistoryEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO action_history
         (campaign_id, recommendation_id, what, action_type, target_meta_id,
          previous_state, new_state, why, approved_by, human_involved, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        e.campaignId,
        e.recommendationId,
        e.what,
        e.actionType,
        e.targetMetaId,
        JSON.stringify(e.previousState),
        JSON.stringify(e.newState),
        e.why,
        e.approvedBy,
        e.humanInvolved,
        e.result,
      ],
    );
  }
}

// ── In-memory (tests) ────────────────────────────────────────────────────────
export class InMemoryRecommendationStore implements RecommendationStore {
  public records = new Map<string, RecommendationRecord>();
  public actionHistory: ActionHistoryEntry[] = [];

  async create(draft: RecommendationDraft, expiresAt: Date | null): Promise<RecommendationRecord> {
    const rec: RecommendationRecord = {
      id: randomUUID(),
      campaignId: draft.campaignId,
      type: draft.type,
      state: "proposed",
      targetMetaId: draft.targetMetaId,
      evidence: draft.evidence,
      currentBudgetAgorot: draft.currentBudgetAgorot,
      proposedBudgetAgorot: draft.proposedBudgetAgorot,
      maxSpendImpactAgorot: draft.maxSpendImpactAgorot,
      rationale: draft.rationale,
      expiresAt,
      approvedBy: null,
      approvedAt: null,
      executedAt: null,
    };
    this.records.set(rec.id, rec);
    return { ...rec };
  }

  async getById(id: string): Promise<RecommendationRecord | null> {
    const r = this.records.get(id);
    return r ? { ...r } : null;
  }

  async listProposed(campaignId: string): Promise<RecommendationRecord[]> {
    return [...this.records.values()].filter(
      (r) => r.campaignId === campaignId && r.state === "proposed",
    );
  }

  async setState(
    id: string,
    from: RecommendationState,
    to: RecommendationState,
    patch: Partial<Pick<RecommendationRecord, "approvedBy" | "approvedAt" | "executedAt">> = {},
  ): Promise<RecommendationRecord | null> {
    const r = this.records.get(id);
    if (!r || r.state !== from) return null;
    r.state = to;
    if (patch.approvedBy !== undefined) r.approvedBy = patch.approvedBy;
    if (patch.approvedAt !== undefined) r.approvedAt = patch.approvedAt;
    if (patch.executedAt !== undefined) r.executedAt = patch.executedAt;
    return { ...r };
  }

  async writeActionHistory(e: ActionHistoryEntry): Promise<void> {
    this.actionHistory.push(e);
  }
}
