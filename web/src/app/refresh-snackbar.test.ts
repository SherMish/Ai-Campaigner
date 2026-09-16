import { describe, it, expect } from "vitest";
import { snackFor, LINGER_MS } from "./refresh-snackbar";

const base = { loading: false, hasData: true, stalled: false };

describe("snackFor", () => {
  it("says a campaign is loading while its numbers are cleared for a switch", () => {
    expect(snackFor(null, { ...base, loading: true, hasData: false })).toBe("loading_campaign");
  });

  it("shows the refresh while Meta is being read", () => {
    // The live case: every card reads "—" for 15-20 s with nothing explaining it.
    expect(snackFor(null, { ...base, dataRefresh: "refreshing" })).toBe("refreshing");
  });

  it("announces 'updated' only after a refresh the customer watched", () => {
    expect(snackFor("refreshing", { ...base, dataRefresh: "fresh" })).toBe("refreshed");
    expect(snackFor("stalled", { ...base, dataRefresh: "refreshed" })).toBe("refreshed");
  });

  it("says nothing on a load that was already fresh", () => {
    expect(snackFor(null, { ...base, dataRefresh: "fresh" })).toBeNull();
    // Nor after a mere campaign switch that landed on already-fresh data.
    expect(snackFor("loading_campaign", { ...base, dataRefresh: "fresh" })).toBeNull();
  });

  it("names a rate limit rather than spinning", () => {
    expect(snackFor(null, { ...base, dataRefresh: "throttled" })).toBe("throttled");
  });

  it("stops spinning once the store has given up reloading", () => {
    // Otherwise the spinner would run forever over numbers that cannot change
    // until the page is reloaded.
    expect(snackFor("refreshing", { ...base, dataRefresh: "refreshing", stalled: true })).toBe("stalled");
  });

  it("stays silent when a refresh is unavailable", () => {
    expect(snackFor(null, { ...base, dataRefresh: "unavailable" })).toBeNull();
  });

  it("only the in-progress kinds persist; outcomes linger and leave", () => {
    expect(LINGER_MS.refreshing).toBeNull();
    expect(LINGER_MS.loading_campaign).toBeNull();
    for (const k of ["refreshed", "throttled", "stalled"] as const) expect(LINGER_MS[k]).toBeGreaterThan(0);
  });
});
