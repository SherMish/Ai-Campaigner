// DB + HTTP integration for per-user admin auth (AIC ops console). Requires
// DATABASE_URL; self-skips otherwise. Verifies the real requireAdmin (bound to
// the Pg user store) against a live admin route: only an is_admin app_user's JWT
// gets in.
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";
import { signAuthToken } from "../auth/tokens.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

async function seedUser(tag: string, isAdmin: boolean): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO app_users (email, password_hash, name, is_admin) VALUES ($1,'x','U',$2) RETURNING id`,
    [`__it_admin_${tag}@example.com`, isAdmin],
  );
  return rows[0].id;
}

d("per-user admin auth (DB + HTTP)", () => {
  beforeAll(() => {
    process.env.JWT_SECRET ||= "test-secret-admin-int-padding-to-32-chars-minimum";
    delete process.env.ADMIN_TOKEN; // pure user-based, no break-glass
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM app_users WHERE email LIKE '__it_admin_%'`);
    await pool.end();
  });

  it("lets an admin user's JWT reach an admin route", async () => {
    const adminId = await seedUser("yes", true);
    const res = await request(createApp())
      .get("/api/admin/customers")
      .set("Authorization", `Bearer ${signAuthToken(adminId)}`);
    expect(res.status).toBe(200);
  });

  it("403s a valid non-admin user's JWT", async () => {
    const userId = await seedUser("no", false);
    const res = await request(createApp())
      .get("/api/admin/customers")
      .set("Authorization", `Bearer ${signAuthToken(userId)}`);
    expect(res.status).toBe(403);
  });

  it("401s with no token", async () => {
    const res = await request(createApp()).get("/api/admin/customers");
    expect(res.status).toBe(401);
  });
});
