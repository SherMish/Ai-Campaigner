import { describe, it, expect, afterEach, vi } from "vitest";
import type { Request, Response } from "express";
import { buildRequireAdmin } from "./admin.js";
import { signAuthToken } from "../auth/tokens.js";

// Set before snapshotting OLD so afterEach preserves it (CI has no JWT_SECRET).
process.env.JWT_SECRET ||= "test-secret-admin";
const OLD = { ...process.env };
afterEach(() => {
  process.env = { ...OLD };
});

// isAdminUser resolver: only "admin-1" is an admin.
const guard = buildRequireAdmin({ isAdminUser: async (id) => id === "admin-1" });

async function run(authHeader?: string) {
  const req = {
    header: (h: string) => (h.toLowerCase() === "authorization" ? authHeader : undefined),
  } as unknown as Request;
  let statusCode = 0;
  const res = {
    status(c: number) { statusCode = c; return this; },
    json() { return this; },
  } as unknown as Response;
  const next = vi.fn();
  await guard(req, res, next);
  return { status: () => statusCode, next };
}

describe("requireAdmin (per-user role)", () => {
  it("allows an admin user's JWT", async () => {
    const { next, status } = await run(`Bearer ${signAuthToken("admin-1")}`);
    expect(next).toHaveBeenCalledOnce();
    expect(status()).toBe(0);
  });

  it("403s a valid but non-admin user's JWT", async () => {
    const { next, status } = await run(`Bearer ${signAuthToken("user-2")}`);
    expect(next).not.toHaveBeenCalled();
    expect(status()).toBe(403);
  });

  it("401s a missing or unverifiable token", async () => {
    expect((await run(undefined)).status()).toBe(401);
    expect((await run("Bearer not-a-jwt")).status()).toBe(401);
  });

  it("allows the break-glass ADMIN_TOKEN when set", async () => {
    process.env.ADMIN_TOKEN = "s3cret";
    const { next, status } = await run("Bearer s3cret");
    expect(next).toHaveBeenCalledOnce();
    expect(status()).toBe(0);
  });

  it("still 401s a wrong break-glass token", async () => {
    process.env.ADMIN_TOKEN = "s3cret";
    expect((await run("Bearer nope")).status()).toBe(401);
  });
});
