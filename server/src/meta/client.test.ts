import { describe, it, expect } from "vitest";
import { GraphMetaClient } from "./client.js";

// Real bug found while verifying AIC-95 live: the customer's per-audience/
// per-ad detail panel was rebuilt to follow the day/week/month/allTime range
// switcher via disjoint-daily insight_snapshot_daily rows at adset/creative
// grain (server/src/services/campaign-audiences.ts). But getDailyInsights —
// the ONLY thing that ever writes disjoint-daily rows — pulled campaign grain
// only ("asking for ad-set/ad grain per day would multiply the row count for
// no gain", true before AIC-95, false after). Confirmed live: real
// insight_snapshot_daily has campaign-grain rows going back weeks, but ZERO
// adset/creative-grain rows for any real customer — the panel would show
// "no_data_yet" forever, never real data, for every real account. This test
// locks in that getDailyInsights must pull all three levels, same as the
// rolling-window getInsights already does, deriving a creative row from each
// ad row the same way.
describe("GraphMetaClient.getDailyInsights — must cover adset/ad/creative grain, not campaign only", () => {
  function dayRow(dateStart: string, overrides: Record<string, unknown> = {}) {
    return {
      date_start: dateStart,
      date_stop: dateStart,
      spend: "10.00",
      campaign_id: "c1",
      ...overrides,
    };
  }

  it("pulls campaign, adset, and ad levels — each with time_increment=1 — and derives a creative row per ad row", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      let data: Record<string, unknown>[] = [];
      if (url.includes("level=campaign")) {
        data = [dayRow("2026-08-10")];
      } else if (url.includes("level=adset")) {
        data = [dayRow("2026-08-10", { adset_id: "as1" })];
      } else if (url.includes("level=ad")) {
        data = [dayRow("2026-08-10", { adset_id: "as1", ad_id: "ad1", ad_name: "Ad One" })];
      }
      return { ok: true, status: 200, json: async () => ({ data }) };
    };

    const client = new GraphMetaClient("token", "v21.0", fetchImpl);
    const rows = await client.getDailyInsights("c1", { start: "2026-08-10", end: "2026-08-10" });

    // All three levels were actually requested, each as a disjoint-daily pull.
    expect(calls.some((u) => u.includes("level=campaign") && u.includes("time_increment=1"))).toBe(true);
    expect(calls.some((u) => u.includes("level=adset") && u.includes("time_increment=1"))).toBe(true);
    expect(calls.some((u) => u.includes("level=ad") && u.includes("time_increment=1"))).toBe(true);

    const grains = rows.map((r) => r.row.grain).sort();
    expect(grains).toEqual(["ad", "adset", "campaign", "creative"]);
    // Every row is tagged with the date it belongs to.
    expect(rows.every((r) => r.date === "2026-08-10")).toBe(true);
    // The creative row mirrors the ad row it was derived from.
    const adRow = rows.find((r) => r.row.grain === "ad")!;
    const creativeRow = rows.find((r) => r.row.grain === "creative")!;
    expect(creativeRow.row.objectId).toBe(adRow.row.objectId);
    expect(creativeRow.row.name).toBe("Ad One");
  });
});
