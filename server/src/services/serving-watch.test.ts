import { describe, it, expect } from "vitest";
import { judgeServing, SILENT_HOURS, type WatchState } from "./serving-watch.js";

const NOW = new Date("2026-09-02T14:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const state = (o: Partial<WatchState> = {}): WatchState => ({
  firstSeenAt: hoursAgo(48), lastServedAt: hoursAgo(48), alertedAt: null, ...o,
});
const active = (impressions: number) => ({ metaObjectId: "as_1", impressions, active: true });

describe("judgeServing (AIC-178)", () => {
  it("alerts on an ACTIVE ad set silent past the threshold", () => {
    // The lived case: ACTIVE all day, zero impressions, Meta reporting no
    // issue and delivery_ok still true.
    expect(judgeServing(active(0), state({ lastServedAt: hoursAgo(20) }), NOW))
      .toEqual({ kind: "alert", silentHours: 20 });
  });

  it("stays quiet until the threshold is actually crossed", () => {
    expect(judgeServing(active(0), state({ lastServedAt: hoursAgo(SILENT_HOURS - 1) }), NOW).kind).toBe("quiet");
    expect(judgeServing(active(0), state({ lastServedAt: hoursAgo(SILENT_HOURS + 1) }), NOW).kind).toBe("alert");
  });

  it("gives a brand-new ad set its grace from when we first saw it", () => {
    // Never served, but only created an hour ago — review and learning are
    // normal. Judging this against epoch would page an operator about every
    // ad set the moment it is built.
    const fresh = state({ firstSeenAt: hoursAgo(1), lastServedAt: null });
    expect(judgeServing(active(0), fresh, NOW).kind).toBe("quiet");

    const stale = state({ firstSeenAt: hoursAgo(30), lastServedAt: null });
    expect(judgeServing(active(0), stale, NOW).kind).toBe("alert");
  });

  it("never alerts on a paused ad set", () => {
    // Silence is the POINT of pausing. Reporting it would make every
    // deliberate pause look like a fault.
    const paused = { metaObjectId: "as_1", impressions: 0, active: false };
    expect(judgeServing(paused, state({ lastServedAt: hoursAgo(100) }), NOW).kind).toBe("quiet");
  });

  it("reports one dark spell once", () => {
    expect(judgeServing(active(0), state({ lastServedAt: hoursAgo(40), alertedAt: hoursAgo(2) }), NOW).kind).toBe("quiet");
  });

  it("treats any impression as serving, which also clears a standing alert", () => {
    expect(judgeServing(active(1), state({ lastServedAt: hoursAgo(40), alertedAt: hoursAgo(2) }), NOW))
      .toEqual({ kind: "serving" });
  });
});
