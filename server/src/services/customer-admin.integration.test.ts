// DB + HTTP integration for customer CRUD (AIC-44). Requires DATABASE_URL.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { signAuthToken } from "../auth/tokens.js";
import { ControlService, PgControlStore } from "../execution/control-service.js";
import {
  createCustomer,
  updateCustomer,
  deactivateCustomer,
  reactivateCustomer,
  deleteCustomer,
} from "./customer-admin.js";
import { listAuditLog } from "./admin-audit.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

const ACTOR = { userId: null, label: "__it_operator" };
const controls = new ControlService(new PgControlStore(pool));

async function seedAdmin(tag: string): Promise<{ id: string; token: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, password_hash, name, is_admin) VALUES ($1,'x','Op',true) RETURNING id`,
    [`__it_crud_${tag}@example.com`],
  );
  return { id: rows[0].id, token: signAuthToken(rows[0].id) };
}

async function seedCampaign(customerId: string, agreedBudgetAgorot = 5000): Promise<string> {
  const conn = await pool.query<{ id: string }>(
    `INSERT INTO meta_connections (customer_id, access_health) VALUES ($1,'ok') RETURNING id`,
    [customerId],
  );
  const acct = await pool.query<{ id: string }>(
    `INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`,
    [conn.rows[0].id, `act_crud_${conn.rows[0].id.slice(0, 8)}`],
  );
  const camp = await pool.query<{ id: string }>(
    `INSERT INTO managed_campaigns (customer_id, ad_account_id, status, agreed_budget_agorot) VALUES ($1,$2,'active',$3) RETURNING id`,
    [customerId, acct.rows[0].id, agreedBudgetAgorot],
  );
  return camp.rows[0].id;
}

d("customer CRUD (DB + HTTP)", () => {
  beforeAll(() => {
    process.env.JWT_SECRET ||= "test-secret-crud-int";
    delete process.env.ADMIN_TOKEN;
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM customers WHERE business_name LIKE '__it_crud_%'`);
    await pool.query(`DELETE FROM app_users WHERE email LIKE '__it_crud_%'`);
    await pool.query(`DELETE FROM admin_audit_log WHERE entity_label LIKE '__it_crud_%'`);
    await pool.end();
  });

  it("creates a customer and logs it", async () => {
    const { id } = await createCustomer(pool, ACTOR, { businessName: "__it_crud_create", category: "beautician" });
    const { rows } = await pool.query(`SELECT * FROM customers WHERE id = $1`, [id]);
    expect(rows[0].business_name).toBe("__it_crud_create");
    expect(rows[0].is_active).toBe(true);

    const entries = await listAuditLog(pool, { entityId: id });
    expect(entries[0].action).toBe("customer.create");
    expect(entries[0].entityLabel).toBe("__it_crud_create");
  });

  it("edits business fields and propagates a budget edit to the managed campaign", async () => {
    const { id } = await createCustomer(pool, ACTOR, { businessName: "__it_crud_edit" });
    const campaignId = await seedCampaign(id, 5000);

    const r = await updateCustomer(pool, ACTOR, id, { category: "fitness", agreedBudgetAgorot: 9000 });
    expect(r.ok).toBe(true);

    const { rows: custRows } = await pool.query(`SELECT category FROM customers WHERE id = $1`, [id]);
    expect(custRows[0].category).toBe("fitness");
    const { rows: campRows } = await pool.query(`SELECT agreed_budget_agorot FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(campRows[0].agreed_budget_agorot).toBe(9000);

    const entries = await listAuditLog(pool, { entityId: id });
    const edit = entries.find((e) => e.action === "customer.edit");
    expect(edit?.detail).toContain("9000");
  });

  it("404s an edit on a customer that doesn't exist", async () => {
    const r = await updateCustomer(pool, ACTOR, "00000000-0000-0000-0000-000000000000", { category: "x" });
    expect(r.ok).toBe(false);
  });

  it("soft-deactivates: reversible, marks the campaign unmanaged, and reactivate leaves the campaign as-is", async () => {
    const { id } = await createCustomer(pool, ACTOR, { businessName: "__it_crud_deactivate" });
    const campaignId = await seedCampaign(id);

    const r1 = await deactivateCustomer(pool, ACTOR, controls, id);
    expect(r1.ok).toBe(true);
    let cust = (await pool.query(`SELECT is_active, deactivated_at FROM customers WHERE id = $1`, [id])).rows[0];
    expect(cust.is_active).toBe(false);
    expect(cust.deactivated_at).not.toBeNull();
    let camp = (await pool.query(`SELECT status FROM managed_campaigns WHERE id = $1`, [campaignId])).rows[0];
    expect(camp.status).toBe("unmanaged");

    // Reversible.
    const r2 = await reactivateCustomer(pool, ACTOR, id);
    expect(r2.ok).toBe(true);
    cust = (await pool.query(`SELECT is_active, deactivated_at FROM customers WHERE id = $1`, [id])).rows[0];
    expect(cust.is_active).toBe(true);
    expect(cust.deactivated_at).toBeNull();
    // Campaign management is NOT auto-resumed — that's a deliberate separate step.
    camp = (await pool.query(`SELECT status FROM managed_campaigns WHERE id = $1`, [campaignId])).rows[0];
    expect(camp.status).toBe("unmanaged");

    const entries = await listAuditLog(pool, { entityId: id });
    expect(entries.map((e) => e.action)).toEqual(
      expect.arrayContaining(["customer.deactivate", "customer.reactivate"]),
    );
  });

  it("rejects hard delete when confirmText doesn't match the business name", async () => {
    const { id } = await createCustomer(pool, ACTOR, { businessName: "__it_crud_delete_guard" });
    const r = await deleteCustomer(pool, ACTOR, id, "wrong name");
    expect(r.ok).toBe(false);
    const still = await pool.query(`SELECT id FROM customers WHERE id = $1`, [id]);
    expect(still.rows).toHaveLength(1);
  });

  it("hard-deletes on a correct confirm-to-type, cascades related rows, and the delete survives in the audit log", async () => {
    const { id } = await createCustomer(pool, ACTOR, { businessName: "__it_crud_delete" });
    const campaignId = await seedCampaign(id);

    const r = await deleteCustomer(pool, ACTOR, id, "__it_crud_delete");
    expect(r.ok).toBe(true);

    const cust = await pool.query(`SELECT id FROM customers WHERE id = $1`, [id]);
    expect(cust.rows).toHaveLength(0);
    const camp = await pool.query(`SELECT id FROM managed_campaigns WHERE id = $1`, [campaignId]);
    expect(camp.rows).toHaveLength(0); // cascaded away

    // The audit row is the one thing that must survive — entity_id has no FK.
    const entries = await listAuditLog(pool, { entityId: id });
    const del = entries.find((e) => e.action === "customer.delete");
    expect(del).toBeTruthy();
    expect(del?.entityLabel).toBe("__it_crud_delete");
    expect((del?.beforeState as { customer?: { business_name?: string } })?.customer?.business_name).toBe("__it_crud_delete");
  });

  it("full HTTP round trip: create → edit → deactivate → reactivate → delete, attributed to the real admin actor", async () => {
    const admin = await seedAdmin("http");
    const app = createApp();
    const auth = `Bearer ${admin.token}`;

    const create = await request(app).post("/api/admin/customers").set("Authorization", auth).send({ businessName: "__it_crud_http" });
    expect(create.status).toBe(201);
    const id = create.body.id as string;

    const edit = await request(app).patch(`/api/admin/customers/${id}`).set("Authorization", auth).send({ offer: "20% off" });
    expect(edit.status).toBe(200);

    const deactivate = await request(app).post(`/api/admin/customers/${id}/deactivate`).set("Authorization", auth).send({});
    expect(deactivate.status).toBe(200);

    const reactivate = await request(app).post(`/api/admin/customers/${id}/reactivate`).set("Authorization", auth).send({});
    expect(reactivate.status).toBe(200);

    const auditRes = await request(app).get(`/api/admin/customers/${id}/audit`).set("Authorization", auth);
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.entries.length).toBeGreaterThanOrEqual(3);
    expect(auditRes.body.entries.every((e: { actorLabel: string }) => e.actorLabel === `__it_crud_http@example.com`)).toBe(true);

    const del = await request(app).delete(`/api/admin/customers/${id}`).set("Authorization", auth).send({ confirmText: "__it_crud_http" });
    expect(del.status).toBe(200);
  });

  it("rejects customer CRUD routes without an admin credential", async () => {
    const app = createApp();
    const res = await request(app).post("/api/admin/customers").send({ businessName: "x" });
    expect(res.status).toBe(401);
  });
});
