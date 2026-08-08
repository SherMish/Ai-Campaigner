// DB + HTTP integration for customer auth (AIC-21). Requires DATABASE_URL with
// migrations applied; self-skips otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { pool } from "../db/pool.js";
import { createApp } from "../app.js";

const HAS_DB = !!process.env.DATABASE_URL;
const d = HAS_DB ? describe : describe.skip;

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-auth-integration";
});

d("customer auth (DB + HTTP)", () => {
  const app = createApp();
  const email = `it_auth_${Date.now()}@studio.co.il`;

  afterAll(async () => {
    await pool.query(`DELETE FROM app_users WHERE lower(email) = lower($1)`, [email]);
    await pool.end();
  });

  it("signs up → returns a token + user (no password hash)", async () => {
    const res = await request(app).post("/api/auth/signup").send({ email, password: "sup3rsecret", name: "IT User" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.email).toBe(email.toLowerCase());
    expect(res.body.user.password_hash).toBeUndefined();
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it("rejects a duplicate email with 409", async () => {
    const res = await request(app).post("/api/auth/signup").send({ email, password: "another1", name: "x" });
    expect(res.status).toBe(409);
  });

  it("rejects a weak password with 400", async () => {
    const res = await request(app).post("/api/auth/signup").send({ email: `weak_${Date.now()}@x.co`, password: "short" });
    expect(res.status).toBe(400);
  });

  it("logs in with the right password, 401s on the wrong one", async () => {
    const ok = await request(app).post("/api/auth/login").send({ email, password: "sup3rsecret" });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();

    const bad = await request(app).post("/api/auth/login").send({ email, password: "nope" });
    expect(bad.status).toBe(401);
  });

  it("/me returns the user with a valid token, 401 without", async () => {
    const login = await request(app).post("/api/auth/login").send({ email, password: "sup3rsecret" });
    const token = login.body.token as string;

    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email.toLowerCase());

    const noAuth = await request(app).get("/api/auth/me");
    expect(noAuth.status).toBe(401);
  });
});
