import { describe, it, expect } from "vitest";
import { summarizeEventVolume, type EventDayCount } from "./event-volume.js";

const REF = new Date("2026-08-25T09:00:00Z"); // "today" — excluded from judgement
const c = (day: string, event: string, count: number): EventDayCount => ({ day, event, count });

// Recent window = 3 complete days: 22, 23, 24. Prior = the 14 before that.
describe("per-event volume (AIC-91)", () => {
  it("says nothing while the lead event is still arriving", () => {
    const s = summarizeEventVolume({
      leadEvent: "CompleteRegistration", ref: REF,
      counts: [c("2026-08-10", "CompleteRegistration", 5), c("2026-08-23", "CompleteRegistration", 2), c("2026-08-23", "PageView", 90)],
    });
    expect(s.state).toBe("ok");
  });

  // The failure: pixel demonstrably alive, lead event silent, and it used to fire.
  it("flags a lead event that stopped while the pixel kept firing", () => {
    const s = summarizeEventVolume({
      leadEvent: "CompleteRegistration", ref: REF,
      counts: [
        c("2026-08-15", "CompleteRegistration", 8), c("2026-08-16", "CompleteRegistration", 6),
        c("2026-08-22", "PageView", 269), c("2026-08-23", "PageView", 93), c("2026-08-24", "PageView", 24),
      ],
    });
    expect(s.state).toBe("broken");
    expect(s.reason).toMatch(/has stopped/);
    expect(s.detail).toMatchObject({ recentLead: 0, priorLead: 14 });
  });

  // Both halves are required. Neither alone may raise an alarm.
  it("is unknown when nothing at all fires — that's a dead pixel, a different failure", () => {
    const s = summarizeEventVolume({
      leadEvent: "CompleteRegistration", ref: REF,
      counts: [c("2026-08-15", "CompleteRegistration", 8)],
    });
    expect(s.state).toBe("unknown");
    expect(s.reason).toMatch(/no events at all/);
  });

  it("is unknown when the lead event never fired — nothing has 'stopped'", () => {
    const s = summarizeEventVolume({
      leadEvent: "CompleteRegistration", ref: REF,
      counts: [c("2026-08-23", "PageView", 90), c("2026-08-24", "PageView", 24)],
    });
    expect(s.state).toBe("unknown");
    expect(s.reason).toMatch(/nothing to compare/);
  });

  // A WhatsApp campaign has no pixel event. not_applicable, never a silent ok.
  it("is not_applicable for a campaign with no pixel lead event", () => {
    expect(summarizeEventVolume({ leadEvent: null, counts: [], ref: REF }).state).toBe("not_applicable");
  });

  it("is unknown with no pixel data at all", () => {
    expect(summarizeEventVolume({ leadEvent: "CompleteRegistration", counts: [], ref: REF }).state).toBe("unknown");
  });

  // Today is partial and always under-reads; including it would fire this check
  // every morning.
  it("ignores today, so a partial day never triggers it", () => {
    const s = summarizeEventVolume({
      leadEvent: "CompleteRegistration", ref: REF,
      counts: [
        c("2026-08-15", "CompleteRegistration", 8),
        c("2026-08-22", "CompleteRegistration", 3), // inside the recent window
        c("2026-08-25", "PageView", 1), // today — must be ignored entirely
      ],
    });
    expect(s.state).toBe("ok");
    expect(s.detail).toMatchObject({ recentLead: 3 });
  });

  // THE CALIBRATION CASE, from the live Pisga pixel: CompleteRegistration fired
  // 2/2/8/6 on Aug 18-22 then went quiet on the 23rd and 24th. A 2-day window
  // calls that broken; 3 complete days correctly stays quiet, because the 22nd
  // is still inside it. This sequence is why the default is 3.
  it("stays quiet on the real sequence that motivated the window length", () => {
    const counts = [
      c("2026-08-18", "CompleteRegistration", 2), c("2026-08-20", "CompleteRegistration", 2),
      c("2026-08-21", "CompleteRegistration", 8), c("2026-08-22", "CompleteRegistration", 6),
      c("2026-08-23", "PageView", 93), c("2026-08-24", "PageView", 24),
    ];
    expect(summarizeEventVolume({ leadEvent: "CompleteRegistration", counts, ref: REF }).state).toBe("ok");
    // ...and the same data with a 2-day window WOULD have cried wolf.
    expect(summarizeEventVolume({ leadEvent: "CompleteRegistration", counts, ref: REF, recentDays: 2 }).state).toBe("broken");
  });
});
