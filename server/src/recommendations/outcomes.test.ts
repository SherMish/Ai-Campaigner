import { describe, it, expect } from "vitest";
import {
  measurementWindows,
  isDueForMeasurement,
  outcomeFeatures,
  outcomeDelta,
  classifyOutcome,
  isMeasurableType,
  hasConfound,
  type OutcomeFeatures,
} from "./outcomes.js";
import { RULE_THRESHOLDS as T, resolveThresholds, resolveCooldownClasses } from "./rules.js";
import type { DailyPoint } from "../meta/snapshot-store.js";

const EXECUTED_AT = new Date("2026-08-10T14:30:00.000Z"); // mid-day on purpose

function feat(over: Partial<OutcomeFeatures> = {}): OutcomeFeatures {
  return { spendAgorot: 70000, leads: 20, cplAgorot: 3500, daysActive: 7, ...over };
}

describe("measurementWindows", () => {
  it("puts N complete days on each side of the execution day", () => {
    const { before, after } = measurementWindows(EXECUTED_AT, 7);
    expect(before).toEqual({ start: "2026-08-03", end: "2026-08-09" });
    expect(after).toEqual({ start: "2026-08-11", end: "2026-08-17" });
  });

  it("EXCLUDES the execution day from both windows — it's a blend of both states", () => {
    const { before, after } = measurementWindows(EXECUTED_AT, 7);
    expect(before.end).toBe("2026-08-09"); // day before
    expect(after.start).toBe("2026-08-11"); // day after
    expect(before.end < "2026-08-10").toBe(true);
    expect(after.start > "2026-08-10").toBe(true);
  });

  it("ignores the time of day — a 23:59 execution gets the same windows as a 00:01 one", () => {
    const early = measurementWindows(new Date("2026-08-10T00:01:00.000Z"), 7);
    const late = measurementWindows(new Date("2026-08-10T23:59:00.000Z"), 7);
    expect(early).toEqual(late);
  });

  it("respects a shorter window", () => {
    const { before, after } = measurementWindows(EXECUTED_AT, 3);
    expect(before).toEqual({ start: "2026-08-07", end: "2026-08-09" });
    expect(after).toEqual({ start: "2026-08-11", end: "2026-08-13" });
  });
});

describe("isDueForMeasurement", () => {
  it("is not due while the after-window is still running", () => {
    // after-window ends 2026-08-17; on the 17th its last day isn't complete yet.
    expect(isDueForMeasurement(EXECUTED_AT, 7, new Date("2026-08-17T23:00:00Z"))).toBe(false);
  });

  it("becomes due the day after the after-window closes", () => {
    expect(isDueForMeasurement(EXECUTED_AT, 7, new Date("2026-08-18T00:30:00Z"))).toBe(true);
  });

  it("a shorter per-account window becomes due sooner", () => {
    // 3-day window: after-window ends 2026-08-13, so due on the 14th.
    expect(isDueForMeasurement(EXECUTED_AT, 3, new Date("2026-08-14T00:30:00Z"))).toBe(true);
    expect(isDueForMeasurement(EXECUTED_AT, 7, new Date("2026-08-14T00:30:00Z"))).toBe(false);
  });
});

// The load-bearing property of this whole design. If someone later splits
// COOLDOWN_DAYS into two keys, this test fails rather than the two silently
// drifting into an incoherent config (measure at 7, cool down at 3 → the
// engine re-recommends against an outcome that's still provisional).
describe("THE INVARIANT: measurable exactly when the class may be acted on again", () => {
  it("a recommendation becomes due for measurement the same day its cooldown expires", () => {
    const thresholds = resolveThresholds(null, 7000);
    const executedAt = new Date("2026-08-10T14:30:00.000Z");

    // Walk day by day; the first day it's measurable must be the first day
    // its class is no longer cooling down.
    let firstMeasurableDay: string | null = null;
    let firstUncooledDay: string | null = null;
    for (let d = 0; d <= 20; d++) {
      const now = new Date(executedAt.getTime() + d * 24 * 60 * 60 * 1000);
      const due = isDueForMeasurement(executedAt, thresholds.COOLDOWN_DAYS, now);
      const cooling = resolveCooldownClasses(
        { pause_creative: executedAt },
        thresholds.COOLDOWN_DAYS,
        now,
      ).has("creative");
      if (due && firstMeasurableDay === null) firstMeasurableDay = now.toISOString().slice(0, 10);
      if (!cooling && firstUncooledDay === null) firstUncooledDay = now.toISOString().slice(0, 10);
    }
    expect(firstMeasurableDay).not.toBeNull();
    expect(firstMeasurableDay).toBe(firstUncooledDay);
  });
});

describe("outcomeFeatures / outcomeDelta", () => {
  const daily = (days: number): DailyPoint[] =>
    Array.from({ length: days }, (_, i) => ({ date: `2026-08-0${i + 1}`, spendAgorot: 1000, leads: 2 }));

  it("computes null-honest CPL via the feature layer — zero leads is null, not 0", () => {
    const f = outcomeFeatures({ spendAgorot: 50000, leads: 0, cplAgorot: null }, daily(5));
    expect(f.cplAgorot).toBeNull();
    expect(f.daysActive).toBe(5);
  });

  it("delta is null when there is no baseline to compare against", () => {
    const before = feat({ spendAgorot: 0, leads: 0, cplAgorot: null });
    const after = feat();
    const d = outcomeDelta(before, after);
    expect(d.cplPct).toBeNull(); // before CPL null
    expect(d.leadsPct).toBeNull(); // before leads 0
    expect(d.spendPct).toBeNull(); // before spend 0
  });

  it("a CPL drop is a negative percentage (down is better)", () => {
    const d = outcomeDelta(feat({ cplAgorot: 4000 }), feat({ cplAgorot: 3000 }));
    expect(d.cplPct).toBe(-25);
  });
});

describe("classifyOutcome", () => {
  const base = { type: "pause_creative" as const, confound: null };

  it("improved when CPL fell by at least the materiality band", () => {
    const before = feat({ cplAgorot: 4000 });
    const after = feat({ cplAgorot: 3000 }); // -25%
    expect(classifyOutcome({ ...base, before, after, delta: outcomeDelta(before, after) })).toBe("improved");
  });

  it("degraded when CPL rose by at least the band", () => {
    const before = feat({ cplAgorot: 3000 });
    const after = feat({ cplAgorot: 4000 }); // +33%
    expect(classifyOutcome({ ...base, before, after, delta: outcomeDelta(before, after) })).toBe("degraded");
  });

  it("neutral inside the band — but the raw delta is still carried, never discarded", () => {
    const before = feat({ cplAgorot: 4000 });
    const after = feat({ cplAgorot: 3560 }); // -11%: real, but under the 25% bar
    const delta = outcomeDelta(before, after);
    expect(classifyOutcome({ ...base, before, after, delta })).toBe("neutral");
    expect(delta.cplPct).toBe(-11); // the bucket is a view; this is the data
  });

  it("insufficient_data when either side has no computable CPL", () => {
    const before = feat({ leads: 0, cplAgorot: null });
    const after = feat();
    expect(classifyOutcome({ ...base, before, after, delta: outcomeDelta(before, after) })).toBe("insufficient_data");
  });

  it("insufficient_data when the after-window has too few days with data", () => {
    const before = feat();
    const after = feat({ daysActive: T.MIN_DAYS_DATA - 1 });
    expect(classifyOutcome({ ...base, before, after, delta: outcomeDelta(before, after) })).toBe("insufficient_data");
  });

  it("confounded when another change landed in the window — even if CPL clearly improved", () => {
    const before = feat({ cplAgorot: 4000 });
    const after = feat({ cplAgorot: 2000 }); // -50%, would be `improved`
    const v = classifyOutcome({
      ...base,
      before,
      after,
      delta: outcomeDelta(before, after),
      confound: { otherActions: [{ actionType: "pause_ad_set", occurredAt: "2026-08-12T10:00:00Z", humanInvolved: true }] },
    });
    expect(v).toBe("confounded"); // can compute, can't attribute
  });

  it("a zero-spend day is a confound (delivery interruption)", () => {
    const before = feat({ cplAgorot: 4000 });
    const after = feat({ cplAgorot: 2000 });
    const v = classifyOutcome({
      ...base,
      before,
      after,
      delta: outcomeDelta(before, after),
      confound: { zeroSpendDays: ["2026-08-13"] },
    });
    expect(v).toBe("confounded");
  });

  it("insufficient_data OUTRANKS confounded — not having the data is the more basic fact", () => {
    const before = feat({ leads: 0, cplAgorot: null });
    const after = feat();
    const v = classifyOutcome({
      ...base,
      before,
      after,
      delta: outcomeDelta(before, after),
      confound: { zeroSpendDays: ["2026-08-13"] },
    });
    expect(v).toBe("insufficient_data");
  });

  it("replace_creative is not_measurable — it makes no Meta write, so there is no event to measure from", () => {
    const before = feat({ cplAgorot: 4000 });
    const after = feat({ cplAgorot: 2000 }); // would otherwise be a clear `improved`
    const v = classifyOutcome({ type: "replace_creative", before, after, delta: outcomeDelta(before, after), confound: null });
    expect(v).toBe("not_measurable");
  });

  it("a per-account threshold override moves the materiality band", () => {
    const before = feat({ cplAgorot: 4000 });
    const after = feat({ cplAgorot: 3560 }); // -11%
    const loose = resolveThresholds({ BUDGET_CPL_RISE_PCT: 0.1 }, 7000); // 10% band
    expect(classifyOutcome({ ...base, before, after, delta: outcomeDelta(before, after), thresholds: loose })).toBe("improved");
  });
});

describe("isMeasurableType / hasConfound", () => {
  it("every acting type that writes to Meta is measurable", () => {
    expect(isMeasurableType("pause_creative")).toBe(true);
    expect(isMeasurableType("pause_adset")).toBe(true);
    expect(isMeasurableType("increase_budget")).toBe(true);
    expect(isMeasurableType("decrease_budget")).toBe(true);
  });

  it("replace_creative (no Meta write) and no_action are not", () => {
    expect(isMeasurableType("replace_creative")).toBe(false);
    expect(isMeasurableType("no_action")).toBe(false);
  });

  it("an empty confound object is not a confound", () => {
    expect(hasConfound(null)).toBe(false);
    expect(hasConfound(undefined)).toBe(false);
    expect(hasConfound({})).toBe(false);
    expect(hasConfound({ otherActions: [], zeroSpendDays: [] })).toBe(false);
  });
});
