import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import { signAuthToken, signImpersonationToken, verifyAuthToken } from "./tokens.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { buildRequireAdmin } from "../middleware/admin.js";

const USER = "3f4c1a2b-0000-4000-8000-000000000001";
const ADMIN = "3f4c1a2b-0000-4000-8000-0000000000ad";

// AIC-189. Both guarantees live in middleware, so they are tested through a real
// Express app rather than by calling the functions — a guard that is correct but
// not actually mounted protects nothing.
function app() {
  const a = express();
  a.use(express.json());
  a.get("/read", requireAuth, (req, res) =>
    res.json({ userId: (req as AuthedRequest).userId, imp: (req as AuthedRequest).impersonatedBy ?? null }));
  a.post("/write", requireAuth, (_req, res) => res.json({ wrote: true }));
  a.patch("/patch", requireAuth, (_req, res) => res.json({ wrote: true }));
  a.delete("/gone", requireAuth, (_req, res) => res.json({ wrote: true }));
  // Everyone is an admin here, so the ONLY thing that can deny is the imp claim.
  a.get("/admin", buildRequireAdmin({ isAdminUser: async () => true }), (_req, res) => res.json({ ok: true }));
  return a;
}

describe("impersonation", () => {
  beforeAll(() => { process.env.JWT_SECRET = "z".repeat(48); });

  it("carries who is impersonating, not just that someone is", () => {
    expect(verifyAuthToken(signImpersonationToken(USER, ADMIN))).toEqual({
      userId: USER, impersonatedBy: ADMIN,
    });
    expect(verifyAuthToken(signAuthToken(USER))).toEqual({ userId: USER, impersonatedBy: null });
  });

  it("lets an impersonated session READ as the customer", () => {
    return request(app()).get("/read")
      .set("authorization", `Bearer ${signImpersonationToken(USER, ADMIN)}`)
      .expect(200)
      .expect((r) => expect(r.body).toEqual({ userId: USER, imp: ADMIN }));
  });

  it("refuses EVERY write verb from an impersonated session", async () => {
    // Not hidden in the UI — refused. A write here would spend a real
    // customer's budget and be recorded as their own action.
    const t = `Bearer ${signImpersonationToken(USER, ADMIN)}`;
    for (const [method, path] of [["post", "/write"], ["patch", "/patch"], ["delete", "/gone"]] as const) {
      const res = await (request(app()) as never as Record<string, (p: string) => request.Test>)[method](path)
        .set("authorization", t);
      expect(res.status).toBe(403);
      expect(res.body.reason).toBe("impersonation");
    }
  });

  it("still lets a REAL session write", () => {
    return request(app()).post("/write")
      .set("authorization", `Bearer ${signAuthToken(USER)}`)
      .expect(200);
  });

  it("refuses the admin API to an impersonation token even when the user IS an admin", () => {
    // isAdminUser returns true for everyone in this app, so only the imp claim
    // can deny. Without this, impersonating an admin would hand over the admin
    // API under their identity.
    return request(app()).get("/admin")
      .set("authorization", `Bearer ${signImpersonationToken(ADMIN, ADMIN)}`)
      .expect(403)
      .expect((r) => expect(r.body.reason).toBe("impersonation"));
  });

  it("still admits a real admin session", () => {
    return request(app()).get("/admin")
      .set("authorization", `Bearer ${signAuthToken(ADMIN)}`)
      .expect(200);
  });

  it("expires in 30 minutes, not 30 days", () => {
    const decode = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
    const imp = decode(signImpersonationToken(USER, ADMIN));
    expect(imp.exp - imp.iat).toBe(30 * 60);
    // The real session is deliberately long-lived; only this one is short.
    const real = decode(signAuthToken(USER));
    expect(real.exp - real.iat).toBeGreaterThan(30 * 60);
  });
});
