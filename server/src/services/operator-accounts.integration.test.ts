// DB + HTTP integration for operator accounts management (AIC-47). Requires
// DATABASE_URL; self-skips otherwise.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { signAuthToken } from "../auth/tokens.js";
import { listOperators, addOperator, setOperatorRole, removeOperator } from "./operator-accounts.js";
import { listAuditLog } from "./admin-audit.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;
const ACTOR = { userId: null, label: "__it_operator_actor" };

async function seedUser(tag: string, opts: { isAdmin?: boolean; role?: "full_admin" | "operator" } = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, password_hash, name, is_admin, admin_role) VALUES ($1,'x','U',$2,$3) RETURNING id`,
    [`__it_opacct_${tag}@example.com`, opts.isAdmin ?? false, opts.role ?? "operator"],
  );
  return rows[0].id;
}

d("operator accounts (DB + HTTP)", () => {
  beforeAll(() => { process.env.JWT_SECRET ||= "test-secret-opacct"; delete process.env.ADMIN_TOKEN; });
  afterAll(async () => {
    await pool.query(`DELETE FROM app_users WHERE email LIKE '__it_opacct_%'`);
    await pool.query(`DELETE FROM admin_audit_log WHERE entity_label LIKE '__it_opacct_%'`);
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
      await pool.query(`DELETE FROM customers WHERE business_name LIKE ANY($1::text[])`, [["__it_opacct%", "__it_operator_actor%"]]);
    await pool.end();
  });

  it("adds an existing signed-up user as an operator", async () => {
    const userId = await seedUser("addme");
    const r = await addOperator(pool, ACTOR, `__it_opacct_addme@example.com`, "operator");
    expect(r.ok).toBe(true);

    const ops = await listOperators(pool);
    const row = ops.find((o) => o.id === userId)!;
    expect(row.adminRole).toBe("operator");

    const audit = await listAuditLog(pool, { entityId: userId });
    expect(audit[0].action).toBe("operator.add");
  });

  it("refuses to add someone with no existing account", async () => {
    const r = await addOperator(pool, ACTOR, "nobody-__it_opacct@example.com", "operator");
    expect(r.ok).toBe(false);
  });

  it("refuses to re-add someone who's already an operator", async () => {
    await seedUser("already", { isAdmin: true });
    const r = await addOperator(pool, ACTOR, "__it_opacct_already@example.com", "operator");
    expect(r.ok).toBe(false);
  });

  it("changes an operator's role and logs it", async () => {
    // Need at least one OTHER full_admin so the "last full admin" guard doesn't fire.
    await seedUser("otherfull", { isAdmin: true, role: "full_admin" });
    const userId = await seedUser("promote", { isAdmin: true, role: "operator" });

    const r = await setOperatorRole(pool, ACTOR, userId, "full_admin");
    expect(r.ok).toBe(true);
    const ops = await listOperators(pool);
    expect(ops.find((o) => o.id === userId)?.adminRole).toBe("full_admin");

    const audit = await listAuditLog(pool, { entityId: userId });
    expect(audit[0].action).toBe("operator.role_change");
  });

  it("refuses to demote the last full_admin", async () => {
    const userId = await seedUser("lastfull", { isAdmin: true, role: "full_admin" });
    // No other full_admin exists among __it_opacct_ users at this point in isolation —
    // but other tests may have seeded one; scope the check to a fresh, isolated user
    // by first removing any other full_admins we created in THIS test's own rows.
    await pool.query(`UPDATE app_users SET admin_role = 'operator' WHERE email LIKE '__it_opacct_%' AND id <> $1 AND admin_role = 'full_admin'`, [userId]);
    const r = await setOperatorRole(pool, ACTOR, userId, "operator");
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("last full admin");
  });

  it("removes an operator (revokes access, keeps the login) and logs it", async () => {
    await seedUser("keepfull", { isAdmin: true, role: "full_admin" });
    const userId = await seedUser("removeme", { isAdmin: true, role: "operator" });

    const r = await removeOperator(pool, ACTOR, userId);
    expect(r.ok).toBe(true);

    const { rows } = await pool.query(`SELECT is_admin, admin_role FROM app_users WHERE id = $1`, [userId]);
    expect(rows[0].is_admin).toBe(false);
    expect(rows[0].admin_role).toBe("operator");

    const audit = await listAuditLog(pool, { entityId: userId });
    expect(audit[0].action).toBe("operator.remove");
  });

  it("full HTTP round trip: only a full_admin can manage operators; a plain operator gets 403", async () => {
    const app = createApp();
    const fullAdminId = await seedUser("httpfull", { isAdmin: true, role: "full_admin" });
    const operatorId = await seedUser("httpop", { isAdmin: true, role: "operator" });
    const targetId = await seedUser("httptarget", { isAdmin: false });

    const asFullAdmin = `Bearer ${signAuthToken(fullAdminId)}`;
    const asOperator = `Bearer ${signAuthToken(operatorId)}`;

    // A plain operator can list (transparency)...
    const list = await request(app).get("/api/admin/operators").set("Authorization", asOperator);
    expect(list.status).toBe(200);

    // ...but can't add.
    const deniedAdd = await request(app).post("/api/admin/operators").set("Authorization", asOperator).send({ email: "__it_opacct_httptarget@example.com" });
    expect(deniedAdd.status).toBe(403);

    // A full_admin can.
    const add = await request(app).post("/api/admin/operators").set("Authorization", asFullAdmin).send({ email: "__it_opacct_httptarget@example.com", role: "operator" });
    expect(add.status).toBe(201);

    const role = await request(app).post(`/api/admin/operators/${targetId}/role`).set("Authorization", asFullAdmin).send({ role: "full_admin" });
    expect(role.status).toBe(200);

    const remove = await request(app).delete(`/api/admin/operators/${targetId}`).set("Authorization", asFullAdmin).send({});
    expect(remove.status).toBe(200);
  });

  it("emergency-control use writes an admin_audit_log row", async () => {
    const admin = await seedUser("controls", { isAdmin: true, role: "full_admin" });
    const auth = `Bearer ${signAuthToken(admin)}`;
    const app = createApp();

    const cust = await pool.query<{ id: string }>(`INSERT INTO customers (business_name) VALUES ('__it_opacct_controls_cust') RETURNING id`);
    const conn = await pool.query<{ id: string }>(`INSERT INTO meta_connections (customer_id, access_health) VALUES ($1,'ok') RETURNING id`, [cust.rows[0].id]);
    const acct = await pool.query<{ id: string }>(`INSERT INTO ad_accounts (connection_id, meta_ad_account_id) VALUES ($1,$2) RETURNING id`, [conn.rows[0].id, `act_ctrl_${conn.rows[0].id.slice(0, 8)}`]);
    const camp = await pool.query<{ id: string }>(`INSERT INTO managed_campaigns (customer_id, ad_account_id, status) VALUES ($1,$2,'active') RETURNING id`, [cust.rows[0].id, acct.rows[0].id]);

    const res = await request(app).post(`/api/admin/campaigns/${camp.rows[0].id}/controls`).set("Authorization", auth).send({ action: "disable_automation" });
    expect(res.status).toBe(200);

    const audit = await listAuditLog(pool, { entityId: camp.rows[0].id, entityType: "campaign" });
    expect(audit[0].action).toBe("campaign.control.disable_automation");

    await pool.query(`DELETE FROM customers WHERE id = $1`, [cust.rows[0].id]);
  });

  it("the full audit log is filterable by actor and by entity type", async () => {
    const app = createApp();
    const admin = await seedUser("auditview", { isAdmin: true, role: "full_admin" });
    const auth = `Bearer ${signAuthToken(admin)}`;
    const target = await seedUser("auditviewtarget");
    await addOperator(pool, { userId: admin, label: "tester" }, `__it_opacct_auditviewtarget@example.com`, "operator");

    const byType = await request(app).get("/api/admin/audit?entityType=operator").set("Authorization", auth);
    expect(byType.status).toBe(200);
    expect(byType.body.entries.some((e: { entityId: string }) => e.entityId === target)).toBe(true);

    const byActor = await request(app).get(`/api/admin/audit?actorUserId=${admin}`).set("Authorization", auth);
    expect(byActor.status).toBe(200);
    expect(byActor.body.entries.every((e: { actorUserId: string }) => e.actorUserId === admin)).toBe(true);
  });

  it("rejects the operator-management routes without an admin credential", async () => {
    const res = await request(createApp()).get("/api/admin/operators");
    expect(res.status).toBe(401);
  });
});
