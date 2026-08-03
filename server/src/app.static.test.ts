// Single-origin static hosting (the server serves the built web). Builds a fake
// web/dist in a temp cwd so the behavior is verified without a real web build.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./app.js";

describe("single-origin static hosting", () => {
  const origCwd = process.cwd();
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aic-web-"));
    const dist = path.join(tmp, "web", "dist");
    fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), "<!-- LANDING -->");
    fs.writeFileSync(path.join(dist, "app.html"), "<!-- SPA -->");
    fs.writeFileSync(path.join(dist, "assets", "x.js"), "console.log(1)");
    process.chdir(tmp);
  });

  afterAll(() => {
    process.chdir(origCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("serves the landing at /", async () => {
    const res = await request(createApp()).get("/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("LANDING");
  });

  it("serves built assets directly", async () => {
    const res = await request(createApp()).get("/assets/x.js");
    expect(res.status).toBe(200);
    expect(res.text).toContain("console.log");
  });

  it("falls back to the SPA for client-side routes", async () => {
    const res = await request(createApp()).get("/admin/ops");
    expect(res.status).toBe(200);
    expect(res.text).toContain("SPA");
  });

  it("still serves /health and does NOT swallow it into the SPA", async () => {
    const res = await request(createApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("unknown /api routes still 404 as API, not the SPA", async () => {
    const res = await request(createApp()).get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("SPA");
  });
});
