import type pg from "pg";

export type WriteKind = "set_daily_budget" | "pause_ad" | "create_campaign" | "create_ad_set" | "create_ad" | "create_creative";
export const CREATE_WRITE_KINDS: readonly WriteKind[] = ["create_campaign", "create_ad_set", "create_ad", "create_creative"];

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

// Creates a new Meta object and returns its id — NOT naturally idempotent on
// its own (calling it twice makes two objects), unlike MetaWriter's absolute-
// set ops. applyIdempotent() is what makes it safe to call repeatedly.
export interface CreatingWriter {
  create(kind: WriteKind, payload: Record<string, unknown>): Promise<{ metaId: string }>;
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

  // The builder's create-write path (AIC-50): synchronous, because the caller
  // needs the created object's real Meta id immediately to build the NEXT
  // step's payload (an ad set needs its campaign's real id; an ad needs its
  // ad set's real id) — unlike budget/pause writes, a create can't drain in
  // arbitrary background order. Idempotent by construction: if a row for this
  // key already succeeded (an earlier attempt got this far before a crash, a
  // timeout, or a plain retry), its remembered `result` is returned WITHOUT
  // calling Meta again — this is what makes "the builder died mid-create, or
  // the request retried" safe, and what makes a step's already-created PAUSED
  // object a resume point rather than an orphan to clean up.
  async applyIdempotent(entry: OutboxEntry, writer: CreatingWriter): Promise<string> {
    const settled = await this.checkSettled(entry.idempotencyKey);
    if (settled) return settled;

    await this.enqueue(entry); // no-op if a row (any status) already exists

    // Atomically claim it: only one concurrent caller can flip pending→in_progress
    // (Postgres locks the row for the UPDATE), so a double-submit or a client
    // retry racing an in-flight attempt can never both call Meta's create
    // endpoint — the loser backs off instead of making a second object.
    const claim = await this.pool.query(
      `UPDATE meta_write_outbox SET status = 'in_progress' WHERE idempotency_key = $1 AND status = 'pending' RETURNING id`,
      [entry.idempotencyKey],
    );
    if (claim.rows.length === 0) {
      const settledNow = await this.checkSettled(entry.idempotencyKey);
      if (settledNow) return settledNow;
      throw new Error(`create already in progress for ${entry.idempotencyKey} — retry shortly`);
    }

    try {
      const { metaId } = await writer.create(entry.kind, entry.payload);
      await this.pool.query(
        `UPDATE meta_write_outbox SET status = 'succeeded', result = $2, attempts = attempts + 1 WHERE idempotency_key = $1`,
        [entry.idempotencyKey, JSON.stringify({ metaId })],
      );
      return metaId;
    } catch (err) {
      await this.pool.query(
        `UPDATE meta_write_outbox
         SET status = 'pending', attempts = attempts + 1, last_error = $2,
             next_attempt_at = now() + ($3 || ' milliseconds')::interval
         WHERE idempotency_key = $1`,
        [entry.idempotencyKey, (err as Error).message, String(BACKOFF_MS)],
      );
      throw err;
    }
  }

  private async checkSettled(idempotencyKey: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ status: string; result: { metaId: string } | null }>(
      `SELECT status, result FROM meta_write_outbox WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return rows[0]?.status === "succeeded" && rows[0].result ? rows[0].result.metaId : null;
  }
}

// Deterministic idempotency key for a recommendation's intended change.
export function outboxKey(recommendationId: string, kind: WriteKind, targetId: string): string {
  return `${recommendationId}:${kind}:${targetId}`;
}

// Deterministic idempotency key for a builder create-write (AIC-50) — no
// recommendation is involved, so it's keyed on the LOCAL managed_campaigns
// shell row (created before any Meta object exists) + a client-supplied key
// stable across a resumed/retried submission (e.g. "adset-1", "adset-1-ad-2").
export function builderKey(localCampaignId: string, kind: WriteKind, clientKey: string): string {
  return `${localCampaignId}:${kind}:${clientKey}`;
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
