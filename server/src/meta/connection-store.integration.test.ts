// DB integration for PgConnectionStore (AIC-5). Requires DATABASE_URL with the
// migrations applied; self-skips otherwise. Proves the service persists a health
// transition and raises a real ops-queue row end-to-end.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { PgConnectionStore } from "./connection-store.js";
import { FakeMetaClient } from "./client.js";
import { ConnectionService } from "./connection-service.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

d("PgConnectionStore + ConnectionService (DB)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("persists a revocation and raises an ops item", async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (business_name) VALUES ('__it_conn') RETURNING id`,
    );
    const customerId = cust.rows[0].id;
    const conn = await pool.query<{ id: string }>(
      `INSERT INTO meta_connections (customer_id, access_health) VALUES ($1, 'ok') RETURNING id`,
      [customerId],
    );
    const connectionId = conn.rows[0].id;
    await pool.query(
      `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1, $2)`,
      [connectionId, `act_it_${connectionId.slice(0, 8)}`],
    );

    const store = new PgConnectionStore(pool);
    const client = new FakeMetaClient({}, "revoked"); // grant pulled
    const svc = new ConnectionService(store, client);

    const health = await svc.verify(connectionId);
    expect(health).toBe("revoked");

    const persisted = await pool.query<{ access_health: string }>(
      `SELECT access_health FROM meta_connections WHERE id = $1`,
      [connectionId],
    );
    expect(persisted.rows[0].access_health).toBe("revoked");

    const ops = await pool.query<{ count: string }>(
      `SELECT count(*) FROM ops_queue_items
       WHERE customer_id = $1 AND type = 'meta_connection_failure'`,
      [customerId],
    );
    expect(Number(ops.rows[0].count)).toBe(1);

    // assertExecutable must now halt.
    await expect(svc.assertExecutable(connectionId)).rejects.toThrow();

    await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  });
});
