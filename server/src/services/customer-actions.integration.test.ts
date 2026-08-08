// DB integration for the customer connection/budget actions (AIC-21/24).
// Requires DATABASE_URL; self-skips otherwise. The live Meta recheck path
// (ConnectionService.verify) is unit-tested in meta/connection-service.test.ts;
// here we cover the no-token fallback + the budget-request ops item.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { pool } from "../db/pool.js";
import { recheckCustomerConnection, requestBudgetChange } from "./customer-actions.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function seedChain(tag: string, health = "ok") {
  const cust = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test, onboarding_status) VALUES ($1, true, 'ready') RETURNING id`,
    [`__it_act_${tag}`],
  );
  const customerId = cust.rows[0].id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, password_hash, name, customer_id) VALUES ($1,'x','Owner',$2) RETURNING id`,
    [`__it_act_${tag}@example.com`, customerId],
  );
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, system_user_id, access_health) VALUES ($1,'9',$2) RETURNING id`,
    [customerId, health],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_act_${conn.rows[0].id.slice(0, 8)}`],
  );
  await pool.query(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, name, status, agreed_budget_agorot) VALUES ($1,$2,'C','active',800)`,
    [customerId, acct.rows[0].id],
  );
  return { customerId, userId: user.rows[0].id };
}

d("customer actions (DB)", () => {
  beforeAll(() => {
    delete process.env.META_SYSTEM_USER_TOKEN; // exercise the no-live-check fallback
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM app_users WHERE email LIKE '__it_act_%'`);
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_act_%'`);
    await pool.end();
  });

  it("recheck without a token returns the stored health", async () => {
    const { userId } = await seedChain("health", "revoked");
    expect(await recheckCustomerConnection(pool, userId)).toBe("revoked");
  });

  it("recheck returns null when there is no connection", async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (business_name, is_test) VALUES ('__it_act_noconn', true) RETURNING id`,
    );
    const user = await pool.query<{ id: string }>(
      `INSERT INTO app_users (email, password_hash, customer_id) VALUES ('__it_act_noconn@example.com','x',$1) RETURNING id`,
      [cust.rows[0].id],
    );
    expect(await recheckCustomerConnection(pool, user.rows[0].id)).toBeNull();
  });

  it("budget request raises a support_request ops item scoped to the customer", async () => {
    const { customerId, userId } = await seedChain("budget");
    expect(await requestBudgetChange(pool, userId, 1200)).toBe(true);
    const { rows } = await pool.query(
      `SELECT type, severity, detail FROM ops_queue_items WHERE customer_id = $1`,
      [customerId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("support_request");
    expect(rows[0].detail).toContain("1200");
  });
});
