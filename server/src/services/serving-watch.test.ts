import { describe, it, expect } from "vitest";
import { judgeServing, judgeCampaignSpending, israelHour, CAMPAIGN_SILENT_HOURS, SILENT_HOURS, type WatchState } from "./serving-watch.js";

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
