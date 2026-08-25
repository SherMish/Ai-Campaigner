import { describe, it, expect } from "vitest";
import {
  attributeLeadQuality, qualityVerdict, MIN_QUALITY_REVIEWS,
  type LeadQualityReview, type WindowLeads,
} from "./lead-quality-attribution.js";

const review = (id: string, leads: number, relevant: number): LeadQualityReview =>
  ({ id, createdAt: new Date(`2026-08-${id.padStart(2, "0")}T00:00:00Z`), leadsDelta: leads, relevantDelta: relevant });

const from = (m: Record<string, WindowLeads[]>) => (r: LeadQualityReview) => m[r.id] ?? [];

describe("attributeLeadQuality (AIC-133)", () => {
  it("attributes a review whose window had exactly one producing audience", () => {
    const res = attributeLeadQuality(
      [review("1", 12, 2)],
      from({ "1": [{ adSetId: "as_a", leads: 12 }] }),
    );
    expect(res.attributed).toBe(1);
    expect(res.byAdSet.get("as_a")).toMatchObject({ reviewedLeads: 12, relevantLeads: 2, reviewCount: 1 });
  });

  it("REFUSES to attribute a window with two producing audiences", () => {
    // The heart of this ticket. The customer answered for the campaign; nothing
    // in that answer says which audience produced the relevant ones.
    const res = attributeLeadQuality(
      [review("1", 18, 7)],
      from({ "1": [{ adSetId: "as_a", leads: 12 }, { adSetId: "as_b", leads: 6 }] }),
    );
    expect(res.attributed).toBe(0);
    expect(res.unattributable).toBe(1);
    expect(res.byAdSet.size).toBe(0);
  });

  it("does NOT apportion proportionally, because that reorders nothing", () => {
    // Splitting relevance by share of volume gives every audience the same
    // relevance rate, so cost-per-relevant-lead becomes CPL times a constant —
    // identical ranking, now wearing a quality label. That is worse than no
    // attribution: the engine makes the same wrong call with a confident
    // justification attached.
    const res = attributeLeadQuality(
      [review("1", 18, 7)],
      from({ "1": [{ adSetId: "as_a", leads: 12 }, { adSetId: "as_b", leads: 6 }] }),
    );
    expect(res.byAdSet.get("as_a")).toBeUndefined();
    expect(res.byAdSet.get("as_b")).toBeUndefined();
  });

  it("ignores audiences that produced nothing in the window", () => {
    // A paused audience is not a second source; it just isn't there.
    const res = attributeLeadQuality(
      [review("1", 9, 4)],
      from({ "1": [{ adSetId: "as_a", leads: 9 }, { adSetId: "as_paused", leads: 0 }] }),
    );
    expect(res.attributed).toBe(1);
    expect(res.byAdSet.get("as_a")?.relevantLeads).toBe(4);
  });

  it("accumulates across several attributable reviews", () => {
    const res = attributeLeadQuality(
      [review("1", 10, 1), review("2", 8, 2)],
      from({ "1": [{ adSetId: "as_a", leads: 10 }], "2": [{ adSetId: "as_a", leads: 8 }] }),
    );
    expect(res.byAdSet.get("as_a")).toMatchObject({ reviewedLeads: 18, relevantLeads: 3, reviewCount: 2 });
  });

  it("counts a window with no snapshot data as unattributable, not as an error", () => {
    const res = attributeLeadQuality([review("1", 5, 1)], from({}));
    expect(res.unattributable).toBe(1);
  });
});

describe("qualityVerdict (AIC-133)", () => {
  const q = (reviews: number, leads: number, relevant: number) =>
    ({ adSetId: "as_a", reviewCount: reviews, reviewedLeads: leads, relevantLeads: relevant });

  it("computes cost per RELEVANT lead", () => {
    // 12 leads for ₪264, 2 relevant → ₪132 each, not the ₪22 CPL the engine
    // currently optimises on.
    const v = qualityVerdict(q(2, 12, 2), 26400);
    expect(v.usable).toBe(true);
    expect(v.costPerRelevantAgorot).toBe(13200);
    expect(v.relevantRate).toBeCloseTo(0.167, 2);
  });

  it("refuses to act on a single review", () => {
    // Customers estimate, forget, and answer while busy. One divergent period
    // is noise, and pausing an audience on it would be worse than doing nothing.
    expect(qualityVerdict(q(1, 20, 1), 40000).usable).toBe(false);
    expect(MIN_QUALITY_REVIEWS).toBeGreaterThan(1);
  });

  it("refuses to act on too few reviewed leads", () => {
    expect(qualityVerdict(q(3, 3, 0), 10000).usable).toBe(false);
  });

  it("reports zero relevant leads as a rate of 0, never as infinite cost", () => {
    // An audience sending nothing but junk is a real and important finding —
    // but it has no finite cost per relevant lead, and letting Infinity into a
    // comparison would make it win or lose by accident.
    const v = qualityVerdict(q(3, 15, 0), 30000);
    expect(v.usable).toBe(true);
    expect(v.relevantRate).toBe(0);
    expect(v.costPerRelevantAgorot).toBeNull();
  });

  it("is unusable when there is no quality data at all", () => {
    expect(qualityVerdict(undefined, 10000).usable).toBe(false);
  });
});
