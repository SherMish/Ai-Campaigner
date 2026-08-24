import { describe, it, expect } from "vitest";
import { summarizeOvercount, IMPLAUSIBLE_CONVERSION_RATE, MIN_CLICKS_TO_JUDGE } from "./overcount.js";

describe("over-count detection (AIC-92)", () => {
  // The real campaigns on this account convert at 21.1% and 14.6% of link
  // clicks. Neither may ever be flagged — a false positive here suppresses
  // budget increases on a genuinely good campaign.
  it("does NOT flag the real healthy conversion rates this account actually sees", () => {
    expect(summarizeOvercount({ leads: 8, linkClicks: 38 }).state).toBe("ok");   // 21.1%
    expect(summarizeOvercount({ leads: 37, linkClicks: 253 }).state).toBe("ok"); // 14.6%
  });

  it("flags a rate above the plausibility ceiling", () => {
    const s = summarizeOvercount({ leads: 80, linkClicks: 100 });
    expect(s.state).toBe("suspected");
    expect(s.reason).toMatch(/80% of link clicks/);
  });

  it("treats the ceiling itself as acceptable, not suspected", () => {
    const atCeiling = Math.round(100 * IMPLAUSIBLE_CONVERSION_RATE);
    expect(summarizeOvercount({ leads: atCeiling, linkClicks: 100 }).state).toBe("ok");
    expect(summarizeOvercount({ leads: atCeiling + 1, linkClicks: 100 }).state).toBe("suspected");
  });

  // 2 leads on 2 clicks is 100% and means nothing.
  it("refuses to judge below the traffic floor", () => {
    const s = summarizeOvercount({ leads: 2, linkClicks: MIN_CLICKS_TO_JUDGE - 1 });
    expect(s.state).toBe("unknown");
    expect(s.reason).toMatch(/too little traffic/);
  });

  // Signal B is contextual ONLY. Plenty of CAPI setups dedupe correctly, and
  // flagging all of them would be a false alarm on healthy accounts.
  it("never flags on CAPI presence alone, however the sources look", () => {
    for (const sources of [
      { hasBrowserEvents: true, hasServerEvents: true },
      { hasBrowserEvents: true, hasServerEvents: false },
      { hasBrowserEvents: false, hasServerEvents: true },
    ]) {
      expect(summarizeOvercount({ leads: 10, linkClicks: 100, ...sources }).state).toBe("ok");
    }
  });

  // ...but when the rate IS implausible, the source split is what tells an
  // operator where to look first.
  it("names dedup as the likely cause when both event sources are present", () => {
    const s = summarizeOvercount({ leads: 80, linkClicks: 100, hasBrowserEvents: true, hasServerEvents: true });
    expect(s.detail.likelyCause).toMatch(/deduplication failure/);
  });

  it("names page-load firing as the likely cause with a single source", () => {
    const s = summarizeOvercount({ leads: 80, linkClicks: 100, hasBrowserEvents: true, hasServerEvents: false });
    expect(s.detail.likelyCause).toMatch(/page load/);
  });

  it("says nothing about a cause while the rate is fine", () => {
    const s = summarizeOvercount({ leads: 10, linkClicks: 100, hasBrowserEvents: true, hasServerEvents: true });
    expect(s.detail.likelyCause).toBeNull();
  });
});
