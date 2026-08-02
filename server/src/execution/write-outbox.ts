import type pg from "pg";

export type WriteKind = "set_daily_budget" | "pause_ad";

export interface OutboxEntry {
  idempotencyKey: string; // deterministic per intended change
  campaignId: string;
  recommendationId: string | null;
  kind: WriteKind;
  payload: Record<string, unknown>;
}

// Applies a single intended change to Meta. Only absolute-set, idempotent ops
// are supported, so re-applying reaches the same end state (safe on retry).
export interface MetaWriter {
  apply(kind: WriteKind, payload: Record<string, unknown>): Promise<void>;
}

export interface DrainSummary {
  drained: number;
  succeeded: number;
  failed: number;
}

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = 60_000;

export class WriteOutbox {
  constructor(private readonly pool: pg.Pool) {}

  // Enqueue an intended change. The UNIQUE idempotency key makes a repeat enqueue
  // a no-op, so proposing/approving the same change twice can't create two writes.
  // Returns true if a new row was inserted, false if it already existed.
  async enqueue(entry: OutboxEntry): Promise<boolean> {
    const { rows } = await this.pool.query(
      `INSERT INTO meta_write_outbox (idempotency_key, campaign_id, recommendation_id, kind, payload)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [entry.idempotencyKey, entry.campaignId, entry.recommendationId, entry.kind, JSON.stringify(entry.payload)],
    );
    return rows.length > 0;
  }

  // Drain up to `limit` eligible rows. FOR UPDATE SKIP LOCKED lets multiple
  // workers drain concurrently without contending. A succeeded row is terminal
  // and never re-run; a failure backs off and retries until MAX_ATTEMPTS.
  async drainOnce(writer: MetaWriter, limit = 10): Promise<DrainSummary> {
    const summary: DrainSummary = { drained: 0, succeeded: 0, failed: 0 };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{
        id: string;
        kind: WriteKind;
        payload: Record<string, unknown>;
        attempts: number;
      }>(
        `SELECT id, kind, payload, attempts
         FROM meta_write_outbox
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY next_attempt_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [limit],
      );
      // Claim them in-progress inside the same tx so a concurrent drain skips them.
      for (const row of rows) {
        await client.query(`UPDATE meta_write_outbox SET status = 'in_progress' WHERE id = $1`, [row.id]);
      }
      await client.query("COMMIT");

      for (const row of rows) {
        summary.drained++;
        try {
          await writer.apply(row.kind, row.payload);
          await this.pool.query(
            `UPDATE meta_write_outbox SET status = 'succeeded', attempts = attempts + 1 WHERE id = $1`,
            [row.id],
          );
          summary.succeeded++;
        } catch (err) {
          const attempts = row.attempts + 1;
          const terminal = attempts >= MAX_ATTEMPTS;
          await this.pool.query(
            `UPDATE meta_write_outbox
             SET status = $2, attempts = $3, last_error = $4,
                 next_attempt_at = now() + ($5 || ' milliseconds')::interval
             WHERE id = $1`,
            [row.id, terminal ? "failed" : "pending", attempts, (err as Error).message, String(BACKOFF_MS * attempts)],
          );
          summary.failed++;
        }
      }
      return summary;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}

// Deterministic idempotency key for a recommendation's intended change.
export function outboxKey(recommendationId: string, kind: WriteKind, targetId: string): string {
  return `${recommendationId}:${kind}:${targetId}`;
}

// Test double that records applied writes and can be told to fail.
export class FakeMetaWriter implements MetaWriter {
  public applied: Array<{ kind: WriteKind; payload: Record<string, unknown> }> = [];
  public failTimes = 0;
  async apply(kind: WriteKind, payload: Record<string, unknown>): Promise<void> {
    if (this.failTimes > 0) {
      this.failTimes--;
      throw new Error("simulated Meta write failure");
    }
    this.applied.push({ kind, payload });
  }
}
