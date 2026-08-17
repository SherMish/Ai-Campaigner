// DB + HTTP integration for the admin Users view (2026-08-16) — separate from
// the Customers (business) view: every login gets a row here, whether or not
// a business is linked yet. Requires DATABASE_URL.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { listAppUsers, ensureCustomerForUser } from "./users-admin.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

const ADMIN = "Bearer test-admin";
const ACTOR = { userId: null, label: "test" };

async function makeUser(email: string, name = "", customerId: string | null = null) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, password_hash, name, customer_id) VALUES ($1,'x',$2,$3) RETURNING id`,
    [email, name, customerId],
  );
  return rows[0].id;
}

async function cleanupUser(userId: string) {
  const { rows } = await pool.query<{ customer_id: string | null }>(`SELECT customer_id FROM app_users WHERE id = $1`, [userId]);
  await pool.query(`DELETE FROM app_users WHERE id = $1`, [userId]);
  if (rows[0]?.customer_id) await pool.query(`DELETE FROM customers WHERE id = $1`, [rows[0].customer_id]);
}

d("admin users view (DB + HTTP)", () => {
  beforeAll(() => { process.env.ADMIN_TOKEN = "test-admin"; });
  afterAll(async () => { await pool.end(); });

  it("a user with no linked business shows up with a null business/connection", async () => {
    const userId = await makeUser("__it_users_admin_bare@example.com", "Bare User");
    try {
      const list = await listAppUsers(pool);
      const row = list.find((r) => r.id === userId)!;
      expect(row).toBeDefined();
      expect(row.customerId).toBeNull();
      expect(row.businessName).toBeNull();
      expect(row.accessHealth).toBeNull();
      expect(row.campaignStatus).toBeNull();
      expect(row.connectionReadiness).toBeNull();
    } finally {
      await cleanupUser(userId);
    }
  });

  it("a user linked to a fully-ready business reflects the real connection state", async () => {
    const cust = await pool.query<{ id: string }>(
      `INSERT INTO customers (business_name, onboarding_status) VALUES ('__it_users_admin_biz','ready') RETURNING id`,
    );
    const customerId = cust.rows[0].id;
    const conn = await pool.query<{ id: string }>(
      `INSERT INTO meta_connections (customer_id, access_health, page_id) VALUES ($1,'ok','page_ua_1') RETURNING id`,
      [customerId],
    );
    const acct = await pool.query<{ id: string }>(
      `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
      [conn.rows[0].id, `act_ua_${conn.rows[0].id.slice(0, 8)}`],
    );
    // A real whatsapp_destination — otherwise AIC-103's completeness check
    // would flag this "fully ready" fixture as incomplete_config.
    await pool.query(
      `INSERT INTO managed_campaigns (customer_id, ad_account_id, status, meta_campaign_id, whatsapp_destination) VALUES ($1,$2,'active','meta_camp_ua','972500000000')`,
      [customerId, acct.rows[0].id],
    );
    const userId = await makeUser("__it_users_admin_linked@example.com", "Linked User", customerId);
    try {
      const list = await listAppUsers(pool);
      const row = list.find((r) => r.id === userId)!;
      expect(row.customerId).toBe(customerId);
      expect(row.businessName).toBe("__it_users_admin_biz");
      expect(row.accessHealth).toBe("ok");
      expect(row.campaignStatus).toBe("active");
      expect(row.connectionReadiness).toBeNull(); // fully ready
    } finally {
      await cleanupUser(userId);
    }
  });

  it("ensureCustomerForUser creates and links a bare business on first call, and is idempotent after", async () => {
    const userId = await makeUser("__it_users_admin_ensure@example.com", "Ensure User");
    try {
      const first = await ensureCustomerForUser(pool, ACTOR, userId);
      expect(first.created).toBe(true);
      expect(first.customerId).toBeTruthy();

      const biz = await pool.query<{ business_name: string; contact_email: string }>(
        `SELECT business_name, contact_email FROM customers WHERE id = $1`,
        [first.customerId],
      );
      expect(biz.rows[0].business_name).toBe("Ensure User");
      expect(biz.rows[0].contact_email).toBe("__it_users_admin_ensure@example.com");

      const linked = await pool.query<{ customer_id: string }>(`SELECT customer_id FROM app_users WHERE id = $1`, [userId]);
      expect(linked.rows[0].customer_id).toBe(first.customerId);

      // Second call must NOT create a second customer row.
      const second = await ensureCustomerForUser(pool, ACTOR, userId);
      expect(second.created).toBe(false);
      expect(second.customerId).toBe(first.customerId);

      const count = await pool.query<{ count: string }>(`SELECT count(*) FROM customers WHERE contact_email = $1`, ["__it_users_admin_ensure@example.com"]);
      expect(Number(count.rows[0].count)).toBe(1);
    } finally {
      await cleanupUser(userId);
    }
  });

  it("falls back to the email when the user has no name", async () => {
    const userId = await makeUser("__it_users_admin_noname@example.com", "");
    try {
      const r = await ensureCustomerForUser(pool, ACTOR, userId);
      const biz = await pool.query<{ business_name: string }>(`SELECT business_name FROM customers WHERE id = $1`, [r.customerId]);
      expect(biz.rows[0].business_name).toBe("__it_users_admin_noname@example.com");
    } finally {
      await cleanupUser(userId);
    }
  });

  it("HTTP: GET /admin/users lists real users; POST .../customer provisions and is admin-only", async () => {
    const userId = await makeUser("__it_users_admin_http@example.com", "HTTP User");
    try {
      const app = createApp();

      const unauthed = await request(app).get("/api/admin/users");
      expect(unauthed.status).toBe(401);

      const list = await request(app).get("/api/admin/users").set("Authorization", ADMIN);
      expect(list.status).toBe(200);
      expect(list.body.users.some((u: { id: string }) => u.id === userId)).toBe(true);

      const provision = await request(app).post(`/api/admin/users/${userId}/customer`).set("Authorization", ADMIN).send({});
      expect(provision.status).toBe(200);
      expect(provision.body.created).toBe(true);
      const customerId = provision.body.customerId;

      // Idempotent over HTTP too.
      const again = await request(app).post(`/api/admin/users/${userId}/customer`).set("Authorization", ADMIN).send({});
      expect(again.body.customerId).toBe(customerId);
      expect(again.body.created).toBe(false);
    } finally {
      await cleanupUser(userId);
    }
  });
});
