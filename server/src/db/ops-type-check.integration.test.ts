// AIC-180 follow-up: the DB CHECK and OPS_QUEUE_TYPE must agree.
//
// Both enumerate the allowed set, and on 2026-09-02 they drifted: migration
// 052 copied the list out of 046 and added one entry, not noticing 047 and 051
// had each added one of their own. The narrowed CHECK failed re-validating
// live `business_profile_incomplete` rows on prod and rolled back the deploy —
// CI was green the whole time, because nothing tested the two against each
// other.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "./pool.js";
import { OPS_QUEUE_TYPE } from "@aic/shared";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d("ops_queue_items type CHECK", () => {
  afterAll(async () => { await pool.end(); });

  it("accepts every OPS_QUEUE_TYPE the code can produce", async () => {
    // One transaction, rolled back: this proves the constraint without leaving
    // a single row behind in a database local runs share with production.
    const client = await pool.connect();
    const rejected: string[] = [];
    try {
      await client.query("BEGIN");
      for (const type of OPS_QUEUE_TYPE) {
        try {
          await client.query("SAVEPOINT t");
          await client.query(
            `INSERT INTO ops_queue_items (type, severity, detail) VALUES ($1, 'low', '__it_type_check')`,
            [type],
          );
          await client.query("RELEASE SAVEPOINT t");
        } catch {
          rejected.push(type);
          await client.query("ROLLBACK TO SAVEPOINT t");
        }
      }
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    // Names them, so the failure says which migration to widen rather than
    // just that something is wrong.
    expect(rejected).toEqual([]);
  });
});
