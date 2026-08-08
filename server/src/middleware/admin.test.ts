import { describe, it, expect, afterEach, vi } from "vitest";
import type { Request, Response } from "express";
import { requireAdmin } from "./admin.js";

const OLD = { ...process.env };
afterEach(() => {
  process.env = { ...OLD };
});

function run(authHeader?: string) {
  const req = {
    header: (h: string) => (h.toLowerCase() === "authorization" ? authHeader : undefined),
  } as unknown as Request;
  let statusCode = 0;
  const res = {
    status(c: number) { statusCode = c; return this; },
    json() { return this; },
  } as unknown as Response;
  const next = vi.fn();
  requireAdmin(req, res, next);
  return { status: () => statusCode, next };
}

describe("requireAdmin", () => {
  it("allows a matching bearer token when ADMIN_TOKEN is set", () => {
    process.env.ADMIN_TOKEN = "s3cret";
    const { next, status } = run("Bearer s3cret");
    expect(next).toHaveBeenCalledOnce();
    expect(status()).toBe(0);
  });

  it("401s a wrong or missing token when ADMIN_TOKEN is set", () => {
    process.env.ADMIN_TOKEN = "s3cret";
    expect(run("Bearer nope").status()).toBe(401);
    expect(run(undefined).status()).toBe(401);
    expect(run("Bearer nope").next).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED in production when ADMIN_TOKEN is unset", () => {
    delete process.env.ADMIN_TOKEN;
    process.env.NODE_ENV = "production";
    const { next, status } = run(undefined);
    expect(next).not.toHaveBeenCalled();
    expect(status()).toBe(503);
  });

  it("allows in non-production when ADMIN_TOKEN is unset (dev convenience)", () => {
    delete process.env.ADMIN_TOKEN;
    process.env.NODE_ENV = "test";
    const { next } = run(undefined);
    expect(next).toHaveBeenCalledOnce();
  });
});
