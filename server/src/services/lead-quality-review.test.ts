import { describe, it, expect, vi } from "vitest";
import { mondayOf, recordLeadQualityReview, LeadQualityValidationError } from "./lead-quality-review.js";
import type pg from "pg";

describe("mondayOf", () => {
  it("a Wednesday maps to that week's Monday", () => {
    expect(mondayOf(new Date("2026-08-12T10:00:00Z"))).toBe("2026-08-10");
  });

  it("a Monday maps to itself", () => {
    expect(mondayOf(new Date("2026-08-10T23:00:00Z"))).toBe("2026-08-10");
  });

  it("a Sunday maps to the Monday that started that week", () => {
    expect(mondayOf(new Date("2026-08-16T05:00:00Z"))).toBe("2026-08-10");
  });
});

// AIC-67: recordLeadQualityReview's validation runs BEFORE any DB write —
// these pin that invalid input never reaches an INSERT (double-counting and
// nonsense data are rejected at the same layer, not left to a DB constraint).
describe("recordLeadQualityReview — validation (never writes on invalid input)", () => {
  function fakePool() {
    return { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as pg.Pool;
  }

  it("rejects leadsDelta <= 0 — 'nothing to review' is not a valid review", async () => {
    const pool = fakePool();
    await expect(recordLeadQualityReview(pool, "camp_1", { leadsDelta: 0, relevantDelta: 0 }))
      .rejects.toThrow(LeadQualityValidationError);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects relevantDelta > leadsDelta", async () => {
    const pool = fakePool();
    await expect(recordLeadQualityReview(pool, "camp_1", { leadsDelta: 3, relevantDelta: 9 }))
      .rejects.toThrow(LeadQualityValidationError);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("rejects a negative relevantDelta", async () => {
    const pool = fakePool();
    await expect(recordLeadQualityReview(pool, "camp_1", { leadsDelta: 3, relevantDelta: -1 }))
      .rejects.toThrow(LeadQualityValidationError);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("accepts relevantDelta === leadsDelta (all relevant) and writes once", async () => {
    const pool = fakePool();
    await recordLeadQualityReview(pool, "camp_1", { leadsDelta: 4, relevantDelta: 4 });
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual(["camp_1", 4, 4]);
  });

  it("accepts relevantDelta === 0 (none relevant)", async () => {
    const pool = fakePool();
    await recordLeadQualityReview(pool, "camp_1", { leadsDelta: 4, relevantDelta: 0 });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
