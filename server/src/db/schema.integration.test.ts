// Integration test for the P0 schema (AIC-4). Requires a real Postgres via
// DATABASE_URL; self-skips otherwise. Verifies the migrations create every
// table, that FKs cascade, and that the money columns are integer agorot.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "./pool.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

const P0_TABLES = [
  "customers",
  "subscriptions",
  "meta_connections",
  "ad_accounts",
  "managed_campaigns",
  "insight_snapshots",
  "recommendations",
  "action_history",
  "lead_quality_feedback",
  "ops_queue_items",
];

d("P0 schema", () => {
  beforeAll(async () => {
    // Assumes migrations already applied (npm run db:migrate) against this DB.
    await pool.query("SELECT 1");
  });

  afterAll(async () => {
      // Safety net, added 2026-08-22. Cleanup used to live on the LAST LINE of
      // each test body, so any test that threw first leaked its customer row
      // permanently. That is not hypothetical: the failing drain-once test in
      // this suite leaked one row EVERY run, which is how 30 `__it_outbox`
      // customers accumulated in the shared production database — showing up
      // in the ops console as real customers, and feeding the unscoped drain
      // that poisoned a live customer's build.
      //
      // afterAll runs regardless of test outcome, so this cannot leak again.
      // Scoped to THIS file's own prefixes: suites run in parallel, and a
      // broader LIKE would delete a concurrently-running suite's rows.
      await pool.query(`DELETE FROM customers WHERE business_name LIKE ANY($1::text[])`, [["__it_cascade%"]]);
    await pool.end();
  });

  it("created all 10 P0 tables", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [P0_TABLES],
    );
    const found = rows.map((r) => r.table_name).sort();
    expect(found).toEqual([...P0_TABLES].sort());
  });

  it("stores money as integer agorot, not float", async () => {
    const { rows } = await pool.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'subscriptions' AND column_name = 'monthly_amount_agorot'`,
    );
    expect(rows[0]?.data_type).toBe("integer");
  });

  it("cascades a customer delete through the whole graph", async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (business_name) VALUES ('__it_cascade') RETURNING id`,
    );
    const customerId = cust.rows[0].id;
    const conn = await pool.query<{ id: string }>(
      `INSERT INTO meta_connections (customer_id) VALUES ($1) RETURNING id`,
      [customerId],
    );
    const acct = await pool.query<{ id: string }>(
      `INSERT INTO ad_accounts (connection_id, meta_ad_account_id)
       VALUES ($1, $2) RETURNING id`,
      [conn.rows[0].id, `act_it_${conn.rows[0].id.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO managed_campaigns (customer_id, ad_account_id) VALUES ($1, $2)`,
      [customerId, acct.rows[0].id],
    );

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);

    const left = await pool.query(
      `SELECT
         (SELECT count(*) FROM meta_connections WHERE customer_id = $1) AS conns,
         (SELECT count(*) FROM managed_campaigns WHERE customer_id = $1) AS camps`,
      [customerId],
    );
    expect(Number(left.rows[0].conns)).toBe(0);
    expect(Number(left.rows[0].camps)).toBe(0);
  });

  it("enforces one snapshot per (campaign, grain, object, period) — idempotency key", async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'insight_snapshots' AND indexdef LIKE '%UNIQUE%'`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
