import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";

describe("server smoke", () => {
  it("GET /health returns ok", async () => {
    const res = await request(createApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe("ai-campaigner");
  });

  it("unknown /api route 404s (router mounted, no handler yet)", async () => {
    const res = await request(createApp()).get("/api/does-not-exist");
    expect(res.status).toBe(404);
  });

  // AIC-101/AIC-99: unauthenticated on purpose — Connect.tsx/AddContent.tsx
  // need it before/without a customer session, and it's a public identifier
  // we already print in front of customers, not a secret.
  it("GET /api/config returns the Business Portfolio ID with no auth", async () => {
    const res = await request(createApp()).get("/api/config");
    expect(res.status).toBe(200);
    expect(res.body.businessPortfolioId).toMatch(/^\d+$/);
  });
});
