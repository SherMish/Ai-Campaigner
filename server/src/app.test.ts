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
});
