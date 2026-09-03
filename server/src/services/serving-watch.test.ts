import { describe, it, expect } from "vitest";
import { judgeServing, judgeCampaignSpending, daytimeHoursBetween, israelHour, CAMPAIGN_SILENT_HOURS, SILENT_HOURS, type WatchState } from "./serving-watch.js";

const NOW = new Date("2026-09-02T14:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const state = (o: Partial<WatchState> = {}): WatchState => ({
  firstSeenAt: hoursAgo(48), lastServedAt: hoursAgo(48), alertedAt: null, ...o,
});
const active = (impressions: number) => ({ metaObjectId: "as_1", impressions, active: true });

describe("judgeServing (AIC-178)", () => {
  // AIC-183 changed the UNIT these thresholds are counted in: DAYTIME hours,
  // not wall-clock. These fixtures used to encode wall-clock and were rewritten
  // rather than relaxed — 20 hours spanning a night is 9 hours of evidence, and
  // treating it as 20 is what fired an alert every morning.
  it("alerts on an ACTIVE ad set dark through a full day of business hours", () => {
    // The lived case: ACTIVE all day, zero impressions, Meta reporting no
    // issue and delivery_ok still true. NOW is 17:00 Israel; last served two
    // days earlier, so the daytime hours are well past 12.
    expect(judgeServing(active(0), state({ lastServedAt: hoursAgo(48) }), NOW))
      .toEqual({ kind: "alert", silentHours: 26 });
  });

  it("stays quiet until enough DAYTIME hours have actually passed", () => {
    // 8 wall-clock hours back from 17:00 Israel is 09:00 — 8 daytime hours,
    // under the 12 threshold.
    expect(judgeServing(active(0), state({ lastServedAt: hoursAgo(8) }), NOW).kind).toBe("quiet");
    // A day and a half back clears it.
    expect(judgeServing(active(0), state({ lastServedAt: hoursAgo(36) }), NOW).kind).toBe("alert");
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

// 2026-09-02T11:00:00Z is 14:00 in Israel — inside the daytime window.
const DAY = new Date("2026-09-02T11:00:00Z");
const NIGHT = new Date("2026-09-02T00:30:00Z"); // 03:30 Israel
const ago = (from: Date, h: number) => new Date(from.getTime() - h * 3_600_000);
const cState = (from: Date, h: number, alertedAt: Date | null = null): WatchState =>
  ({ firstSeenAt: ago(from, 100), lastServedAt: ago(from, h), alertedAt });

describe("judgeCampaignSpending (AIC-182)", () => {
  it("alerts after 3h of a live campaign spending nothing", () => {
    // The lived case: a declined card. Meta reported account_status ACTIVE and
    // disable_reason 0 the whole time, so the account-health check built for
    // exactly this never fired.
    expect(judgeCampaignSpending({ impressions: 0, hasActiveAdSet: true }, cState(DAY, 5), DAY))
      .toEqual({ kind: "alert", silentHours: 5 });
  });

  it("uses a much shorter fuse than a single ad set", () => {
    expect(CAMPAIGN_SILENT_HOURS).toBeLessThan(SILENT_HOURS);
    expect(judgeCampaignSpending({ impressions: 0, hasActiveAdSet: true }, cState(DAY, 2), DAY).kind).toBe("quiet");
  });

  it("never pages overnight, when silence is normal", () => {
    // 03:30 Israel. A campaign serving nothing at 3am is not news, and a
    // monitor that wakes someone then is muted before it catches anything real.
    expect(judgeCampaignSpending({ impressions: 0, hasActiveAdSet: true }, cState(NIGHT, 9), NIGHT).kind).toBe("quiet");
  });

  it("says nothing when nothing is supposed to be running", () => {
    // Every ad set paused: silence is the expected outcome, not a fault.
    expect(judgeCampaignSpending({ impressions: 0, hasActiveAdSet: false }, cState(DAY, 40), DAY).kind).toBe("quiet");
  });

  it("reports one dark spell once, and recovers on any impression", () => {
    expect(judgeCampaignSpending({ impressions: 0, hasActiveAdSet: true }, cState(DAY, 9, ago(DAY, 1)), DAY).kind).toBe("quiet");
    expect(judgeCampaignSpending({ impressions: 3, hasActiveAdSet: true }, cState(DAY, 9, ago(DAY, 1)), DAY).kind).toBe("serving");
  });
});

describe("israelHour", () => {
  it("reads the hour in Asia/Jerusalem, not UTC", () => {
    // The whole daytime guard depends on this: 11:00Z is 14:00 in Israel, and
    // judging in UTC would shift the quiet window by 2-3 hours.
    expect(israelHour(new Date("2026-09-02T11:00:00Z"))).toBe(14);
    expect(israelHour(new Date("2026-09-02T00:30:00Z"))).toBe(3);
  });
});

describe("daytimeHoursBetween (AIC-183)", () => {
  it("counts only hours inside the daytime window", () => {
    // 20:00 → 22:00 Israel is 2 countable hours; the window closes at 22.
    const from = new Date("2026-09-02T17:00:00Z"); // 20:00 Israel
    const to = new Date("2026-09-02T20:00:00Z");   // 23:00 Israel
    expect(daytimeHoursBetween(from, to)).toBe(2);
  });

  it("counts a whole night as ZERO", () => {
    // 23:00 → 08:00 Israel. Nine wall-clock hours, none of them evidence.
    const from = new Date("2026-09-02T20:00:00Z"); // 23:00 Israel
    const to = new Date("2026-09-03T05:00:00Z");   // 08:00 Israel
    expect(daytimeHoursBetween(from, to)).toBe(0);
  });

  it("resumes counting when the next day opens", () => {
    // 20:00 Israel → 11:00 Israel next day: 2 hours yesterday evening + 2 this
    // morning (09,10) = 4.
    const from = new Date("2026-09-02T17:00:00Z");
    const to = new Date("2026-09-03T08:00:00Z");
    expect(daytimeHoursBetween(from, to)).toBe(4);
  });
});

describe("the first-morning false positive (AIC-183)", () => {
  // Reproduces the real event, from the watch row: the campaign last served at
  // 2026-09-02 23:20 UTC (02:20 Israel) and the alert fired at 06:20 UTC
  // (09:20 Israel) claiming "7 hours" — every one of them overnight, the
  // moment the daytime window opened.
  const lastServed = new Date("2026-09-02T23:20:00Z");
  const firstThingInTheMorning = new Date("2026-09-03T06:20:00Z");
  const st = (alertedAt: Date | null = null): WatchState =>
    ({ firstSeenAt: new Date("2026-08-01T00:00:00Z"), lastServedAt: lastServed, alertedAt });

  it("does NOT alert at 09:20 for a night of silence", () => {
    expect(judgeCampaignSpending({ impressions: 0, hasActiveAdSet: true }, st(), firstThingInTheMorning).kind)
      .toBe("quiet");
  });

  it("alerts once the campaign has really been dark through business hours", () => {
    // Same last-served, but now 13:00 Israel — 4 daytime hours accumulated.
    const afternoon = new Date("2026-09-03T10:00:00Z");
    expect(judgeCampaignSpending({ impressions: 0, hasActiveAdSet: true }, st(), afternoon))
      .toEqual({ kind: "alert", silentHours: 4 });
  });

  it("holds the same line for a single ad set", () => {
    // Two ad-set alerts fired at 07:20 Israel that morning — outside the
    // window entirely, because the ad-set grain had no window at all.
    const early = new Date("2026-09-03T04:20:00Z"); // 07:20 Israel
    expect(judgeServing({ metaObjectId: "as_1", impressions: 0, active: true }, st(), early).kind)
      .toBe("quiet");
  });
});
