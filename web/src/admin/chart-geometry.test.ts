import { describe, it, expect } from "vitest";
import { splitIntoRuns, niceMax, project, type DayPoint } from "./chart-geometry.js";

const p = (date: string, spendAgorot = 0, leads = 0): DayPoint => ({ date, spendAgorot, leads });

describe("chart geometry (AIC-122)", () => {
  // The important one. Real fleet data has missing days (no ingestion ran),
  // and a missing day is NOT a zero-spend day. Connecting straight through
  // would assert continuity that was never measured.
  it("breaks the line at a missing day instead of drawing through it", () => {
    const runs = splitIntoRuns([p("2026-08-14"), p("2026-08-15"), p("2026-08-18"), p("2026-08-19")]);
    expect(runs).toHaveLength(2);
    expect(runs[0].map((r) => r.date)).toEqual(["2026-08-14", "2026-08-15"]);
    expect(runs[1].map((r) => r.date)).toEqual(["2026-08-18", "2026-08-19"]);
  });

  it("keeps a fully consecutive series as one run", () => {
    const runs = splitIntoRuns([p("2026-08-14"), p("2026-08-15"), p("2026-08-16")]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(3);
  });

  it("handles month boundaries as consecutive, not as a gap", () => {
    const runs = splitIntoRuns([p("2026-07-31"), p("2026-08-01")]);
    expect(runs).toHaveLength(1);
  });

  it("an empty series produces no runs, and a lone point produces one", () => {
    expect(splitIntoRuns([])).toEqual([]);
    expect(splitIntoRuns([p("2026-08-14")])).toHaveLength(1);
  });

  it("niceMax never returns 0 — an all-zero series still gets a real axis", () => {
    expect(niceMax([])).toBe(1);
    expect(niceMax([0, 0, 0])).toBe(1);
  });

  it("niceMax rounds up to a readable step", () => {
    expect(niceMax([3245])).toBe(4000);
    expect(niceMax([2, 3, 4])).toBe(4);
    expect(niceMax([12])).toBe(20);
  });

  const box = { width: 100, height: 60, padLeft: 0, padBottom: 0, padTop: 0 };

  it("projects the max value to the top and zero to the baseline", () => {
    expect(project(0, 0, 2, 10, box).y).toBe(60);   // zero → bottom
    expect(project(0, 10, 2, 10, box).y).toBe(0);   // max  → top
  });

  it("spreads points across the full width, and puts a lone point at the left edge", () => {
    expect(project(0, 0, 3, 10, box).x).toBe(0);
    expect(project(2, 0, 3, 10, box).x).toBe(100);
    // total = 1 would divide by zero; must not produce NaN.
    expect(project(0, 5, 1, 10, box).x).toBe(0);
  });

  it("never divides by a zero max", () => {
    expect(Number.isNaN(project(0, 0, 2, 0, box).y)).toBe(false);
  });
});
