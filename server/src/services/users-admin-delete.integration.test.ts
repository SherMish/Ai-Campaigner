// AIC-127: deleting from the Users view. Irreversible, against a database
// shared with production, so every guard gets a test — and the "business only"
// mode's whole promise (the LOGIN SURVIVES so onboarding can be re-walked) is
// asserted rather than assumed.
import { describe, it, expect, afterAll } from "vitest";
import { pool } from "../db/pool.js";
import { deleteUserRecords } from "./users-admin.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;
const PREFIX = "__it_udel_";

const ACTOR = { userId: null as string | null, label: "test-operator" };

async function seed(tag: string, opts: { withBusiness?: boolean } = {}) {
  const email = `${PREFIX}${tag}@example.com`;
  let customerId: string | null = null;
  if (opts.withBusiness !== false) {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (business_name, is_test) VALUES ($1, true) RETURNING id`,
      [`${PREFIX}${tag}`],
    );
    customerId = cust.rows[0].id;
    const conn = await pool.query<{ id: string }>(
      `INSERT INTO meta_connections (customer_id, access_health) VALUES ($1,'ok') RETURNING id`,
      [customerId],
    );
    const acct = await pool.query<{ id: string }>(
      `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
      [conn.rows[0].id, `act_udel_${conn.rows[0].id.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO managed_campaigns (customer_id, ad_account_id, meta_campaign_id, name, status)
       VALUES ($1,$2,'m_udel','C','active')`,
      [customerId, acct.rows[0].id],
    );
  }
  const u = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, password_hash, customer_id) VALUES ($1,'x',$2) RETURNING id`,
    [email, customerId],
  );
  return { userId: u.rows[0].id, email, customerId };
}

const userExists = async (id: string) =>
  (await pool.query(`SELECT 1 FROM app_users WHERE id = $1`, [id])).rowCount === 1;
const customerExists = async (id: string) =>
  (await pool.query(`SELECT 1 FROM customers WHERE id = $1`, [id])).rowCount === 1;

d("deleteUserRecords (DB)", () => {
  afterAll(async () => {
    await pool.query(`DELETE FROM app_users WHERE email LIKE '${PREFIX}%'`);
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '${PREFIX}%'`);
    await pool.end();
  });

  // The mode that exists for testing: wipe the business, keep the login, so the
  // onboarding wizard can be walked again as the same person.
  it("business mode deletes the business and its connection but KEEPS the login", async () => {
    const { userId, email, customerId } = await seed("biz");
    const r = await deleteUserRecords(pool, ACTOR, userId, "business", email);

    expect(r.ok).toBe(true);
    expect(await customerExists(customerId!)).toBe(false);
    expect(await userExists(userId)).toBe(true);

    // ...and the login is genuinely reusable: customer_id is NULL, which is the
    // exact state a fresh signup is in, so /admin/users offers onboarding again.
    const { rows } = await pool.query(`SELECT customer_id FROM app_users WHERE id = $1`, [userId]);
    expect(rows[0].customer_id).toBeNull();
  });

  it("the cascade really removes the connection and campaign, not just the customer row", async () => {
    const { userId, email, customerId } = await seed("cascade");
    await deleteUserRecords(pool, ACTOR, userId, "business", email);
    for (const table of ["meta_connections", "managed_campaigns"]) {
      const { rowCount } = await pool.query(`SELECT 1 FROM ${table} WHERE customer_id = $1`, [customerId]);
      expect(rowCount, table).toBe(0);
    }
  });

  it("all mode deletes the login too", async () => {
    const { userId, email, customerId } = await seed("all");
    const r = await deleteUserRecords(pool, ACTOR, userId, "all", email);
    expect(r.ok).toBe(true);
    expect(await customerExists(customerId!)).toBe(false);
    expect(await userExists(userId)).toBe(false);
  });

  it("all mode works on a signup that never had a business", async () => {
    const { userId, email } = await seed("nobiz", { withBusiness: false });
    const r = await deleteUserRecords(pool, ACTOR, userId, "all", email);
    expect(r.ok).toBe(true);
    expect(await userExists(userId)).toBe(false);
  });

  // Confirm-to-type is enforced SERVER-side: the client can be bypassed and
  // this is irreversible.
  it("refuses when the typed confirmation is not the email, and deletes nothing", async () => {
    const { userId, email, customerId } = await seed("confirm");
    const r = await deleteUserRecords(pool, ACTOR, userId, "all", "not-the-email");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/confirmation/);
    expect(await userExists(userId)).toBe(true);
    expect(await customerExists(customerId!)).toBe(true);
    void email;
  });

  it("matches the email case-insensitively — the operator retypes, not copy-pastes", async () => {
    const { userId, email } = await seed("case");
    const r = await deleteUserRecords(pool, ACTOR, userId, "all", email.toUpperCase());
    expect(r.ok).toBe(true);
  });

  it("refuses business mode for a user with no business rather than silently succeeding", async () => {
    const { userId, email } = await seed("empty", { withBusiness: false });
    const r = await deleteUserRecords(pool, ACTOR, userId, "business", email);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no business/);
    expect(await userExists(userId)).toBe(true);
  });

  it("refuses to delete your own account — it would end your session mid-action", async () => {
    const { userId, email } = await seed("self", { withBusiness: false });
    const r = await deleteUserRecords(pool, { userId, label: "me" }, userId, "all", email);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/your own account/);
    expect(await userExists(userId)).toBe(true);
  });

  // The console must never be left with zero full_admins: nobody could
  // administer operators again, including undoing this very delete.
  it("refuses to delete the last full_admin", async () => {
    const { userId, email } = await seed("lastadmin", { withBusiness: false });
    await pool.query(`UPDATE app_users SET is_admin = true, admin_role = 'full_admin' WHERE id = $1`, [userId]);

    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app_users WHERE is_admin = true AND admin_role = 'full_admin' AND id <> $1`,
      [userId],
    );
    const r = await deleteUserRecords(pool, ACTOR, userId, "all", email);

    if (rows[0].n === 0) {
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/last full admin/);
      expect(await userExists(userId)).toBe(true);
    } else {
      // Other full_admins exist in this shared DB, so the guard correctly does
      // NOT fire — asserting a refusal here would be asserting the wrong thing.
      expect(r.ok).toBe(true);
    }
  });

  it("writes an audit row that records the Meta objects were left alone", async () => {
    const { userId, email } = await seed("audit");
    await deleteUserRecords(pool, ACTOR, userId, "business", email);
    const { rows } = await pool.query(
      `SELECT action, detail, before_state FROM admin_audit_log WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    expect(rows[0].action).toBe("user.delete_business");
    expect(rows[0].detail).toMatch(/Meta assets were NOT touched/);
    // The snapshot is the only surviving record of what was deleted.
    expect(rows[0].before_state.campaign).toBeTruthy();
    expect(rows[0].before_state.metaCampaignIdLeftOnMeta).toBe("m_udel");
  });
});
