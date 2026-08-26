import { describe, it, expect } from "vitest";
import { computeRangeDeltas, deltaPct } from "./readout.js";

describe("deltaPct", () => {
  it("computes rounded percent change", () => {
    expect(deltaPct(120, 100)).toBe(20);
    expect(deltaPct(80, 100)).toBe(-20);
  });
  it("is null with no baseline (avoids a fake +100%)", () => {
    expect(deltaPct(50, 0)).toBeNull();
  });
});

// Found live on test@test.com, 2026-08-26: the dashboard's ▲/▼ line never
// changed with the range switcher. Every tab showed the SAME comparison —
// "▲20% מהתקופה הקודמת" — because the delta was computed once, over the
// engine's fixed 7-complete-day window, and rendered under whichever number
// the selected range produced.
//
// Two separate lies came out of that:
//   * on היום, with no rows at all, the cards read "—" with "▲20% מהתקופה
//     הקודמת" underneath: a confident comparison for a window we measured
//     nothing in;
//   * on חודש, a 30-day total sat above a week-over-week movement.
//
// This is the "does this number tell the truth, or just look like progress"
// test, failed on the most-looked-at line of the product.
describe("computeRangeDeltas — the ▲/▼ line belongs to the SELECTED window", () => {
  // 14 complete days, every one with data: 100 agorot and 1 lead per day for
  // the older week, then 200 and 2 for the recent week.
  const daily = Array.from({ length: 14 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 7, 12 + i)).toISOString().slice(0, 10); // 08-12 … 08-25
    const recent = i >= 7;
    return { date, spendAgorot: recent ? 200 : 100, leads: recent ? 2 : 1, cplAgorot: 100 };
  });
  const ref = new Date("2026-08-25T12:00:00Z");
  const coveredFrom = "2026-07-12"; // 45-day lookback, well before the data

  it("week compares the trailing 7 days against the 7 before them", () => {
    const d = computeRangeDeltas(daily, ref, coveredFrom);
    expect(d.week).toEqual({ spendPct: 100, leadsPct: 100, cplPct: 0 });
  });

  it("day has NO comparison — today is still filling up", () => {
    // Today against a complete yesterday always reads as a fall, which is an
    // artefact of the clock rather than anything the campaign did.
    expect(computeRangeDeltas(daily, ref, coveredFrom).day).toBeNull();
  });

  it("month has NO comparison when the previous 30 days aren't fully covered", () => {
    // The per-day rows reach back 45 days; the month-before-last month needs
    // 60. Comparing 30 days against the 15 we happen to have would invent a
    // collapse that never happened.
    expect(computeRangeDeltas(daily, ref, coveredFrom).month).toBeNull();
  });

  it("month DOES compare when 60 days of data exist", () => {
    const long = Array.from({ length: 60 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 5, 27 + i)).toISOString().slice(0, 10);
      const recent = i >= 30;
      return { date, spendAgorot: recent ? 200 : 100, leads: recent ? 2 : 1, cplAgorot: 100 };
    });
    const d = computeRangeDeltas(long, ref, "2026-06-01");
    expect(d.month?.spendPct).toBe(100);
  });

  it("all-time has no previous period by definition", () => {
    expect(computeRangeDeltas(daily, ref, coveredFrom).allTime).toBeNull();
  });

  it("a previous window that starts before the campaign had data is not compared", () => {
    // Half a week of real data against half a week of nonexistence would
    // report a doubling that is really just the campaign starting.
    const d = computeRangeDeltas(daily, ref, "2026-08-16");
    expect(d.week).toBeNull();
  });
});
