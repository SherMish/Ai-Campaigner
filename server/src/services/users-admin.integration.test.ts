// DB integration for the admin user list (AIC-189 follow-up).
//
// The bug is a JOIN fan-out, which no unit test can see: `listAppUsers` LEFT
// JOINs managed_campaigns, so a customer with nine campaigns appeared as nine
// users and the header counted twelve where there were four. It only became
// visible once OAuth adoption started giving one customer many campaigns.
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { listAppUsers } from "./users-admin.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

const MADE: { users: string[]; customers: string[] } = { users: [], customers: [] };

async function seedUserWithCampaigns(label: string, campaigns: number) {
  const { rows: c } = await pool.query<{ id: string }>(
    `INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`,
    [`__it_ual_${label}`],
  );
  MADE.customers.push(c[0].id);
  const { rows: u } = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, password_hash, name, customer_id) VALUES ($1,'x',$2,$3) RETURNING id`,
    [`__it_ual_${label}@example.test`, `__it_ual_${label}`, c[0].id],
  );
  MADE.users.push(u[0].id);

  const { rows: conn } = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, business_portfolio_id, system_user_id, access_health)
     VALUES ($1,'','','ok') RETURNING id`,
    [c[0].id],
  );
  const { rows: acct } = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id, name, currency, timezone)
     VALUES ($1,'act_it','','ILS','Asia/Jerusalem') RETURNING id`,
    [conn[0].id],
  );
  for (let i = 0; i < campaigns; i++) {
    await pool.query(
      `INSERT INTO managed_campaigns (customer_id, ad_account_id, name, meta_campaign_id)
       VALUES ($1,$2,$3,$4)`,
      [c[0].id, acct[0].id, `__it_ual_${label}_${i}`, `12024${Math.floor(Math.random() * 1e13)}`],
    );
  }
  return { userId: u[0].id, customerId: c[0].id };
}

d("listAppUsers (DB)", () => {
  afterAll(async () => {
    if (MADE.customers.length) {
      await pool.query(`DELETE FROM managed_campaigns WHERE customer_id = ANY($1)`, [MADE.customers]);
      await pool.query(
        `DELETE FROM ad_accounts WHERE connection_id IN (SELECT id FROM meta_connections WHERE customer_id = ANY($1))`,
        [MADE.customers],
      );
      await pool.query(`DELETE FROM meta_connections WHERE customer_id = ANY($1)`, [MADE.customers]);
      await pool.query(`DELETE FROM app_users WHERE id = ANY($1)`, [MADE.users]);
      await pool.query(`DELETE FROM customers WHERE id = ANY($1)`, [MADE.customers]);
    }
    await pool.end();
  });

  it("returns each user EXACTLY once, however many campaigns they have", async () => {
    // The reported symptom: 4 users rendered as 12 rows, one per campaign.
    const nine = await seedUserWithCampaigns("nine", 9);
    await seedUserWithCampaigns("one", 1);
    await seedUserWithCampaigns("none", 0);

    const rows = await listAppUsers(pool);
    const mine = rows.filter((r) => r.email.startsWith("__it_ual_"));

    expect(mine).toHaveLength(3);
    expect(mine.filter((r) => r.id === nine.userId)).toHaveLength(1);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it("reports how many campaigns a user has, instead of showing one of nine as the whole truth", async () => {
    const rows = await listAppUsers(pool);
    const byName = (n: string) => rows.find((r) => r.email === `__it_ual_${n}@example.test`)!;
    expect(byName("nine").campaignCount).toBe(9);
    expect(byName("one").campaignCount).toBe(1);
    expect(byName("none").campaignCount).toBe(0);
  });
});
