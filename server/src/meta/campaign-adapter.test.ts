// Unit tests for GraphCampaignAdapter's create-writes (AIC-50) — the hard
// rule this ticket exists to enforce: every object the builder creates lands
// PAUSED, never live. Mocks global fetch (no other GraphCampaignAdapter
// method has a unit test today — every prior write was verified via a live
// reversible dogfood test instead; this one gets a unit test too because the
// paused-invariant is safety-critical and cheap to pin down here directly).
import { describe, it, expect, vi, afterEach } from "vitest";
import { GraphCampaignAdapter } from "./campaign-adapter.js";

function fakeFetch(respond: { id: string }) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ""));
    return {
      ok: true,
      status: 200,
      json: async () => respond,
      __body: body, // stashed for assertions below
    } as unknown as Response & { __body: URLSearchParams };
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GraphCampaignAdapter create-writes — always PAUSED", () => {
  it("createCampaign sends status=PAUSED and the campaign fields", async () => {
    const mock = fakeFetch({ id: "meta_camp_1" });
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const id = await adapter.createCampaign({
      adAccountId: "act_123", name: "Test", dailyBudgetAgorot: 4000,
      specialAdCategories: [], bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    });

    expect(id).toBe("meta_camp_1");
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("act_123/campaigns");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("status")).toBe("PAUSED");
    expect(body.get("objective")).toBe("OUTCOME_LEADS");
    expect(body.get("daily_budget")).toBe("4000");
  });

  it("createAdSet sends status=PAUSED and is created on the ad account's edge with campaign_id in the body", async () => {
    const mock = fakeFetch({ id: "meta_adset_1" });
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const id = await adapter.createAdSet({
      adAccountId: "act_123", metaCampaignId: "meta_camp_1", name: "Adset",
      targeting: { ageMin: 18, ageMax: 45, genders: [], countries: ["IL"] },
      pageId: "page_1",
    });

    expect(id).toBe("meta_adset_1");
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("act_123/adsets");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("status")).toBe("PAUSED");
    expect(body.get("campaign_id")).toBe("meta_camp_1");
    expect(JSON.parse(body.get("targeting") ?? "{}")).toMatchObject({ age_min: 18, age_max: 45 });
  });

  it("createAd sends status=PAUSED and is created on the ad account's edge with adset_id + creative in the body", async () => {
    const mock = fakeFetch({ id: "meta_ad_1" });
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    const id = await adapter.createAd({
      adAccountId: "act_123", metaAdSetId: "meta_adset_1", name: "Ad", creativeId: "crea_1",
    });

    expect(id).toBe("meta_ad_1");
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("act_123/ads");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("status")).toBe("PAUSED");
    expect(body.get("adset_id")).toBe("meta_adset_1");
    expect(JSON.parse(body.get("creative") ?? "{}")).toEqual({ creative_id: "crea_1" });
  });

  it("throws with the Meta error body when a create call fails, instead of returning a fabricated id", async () => {
    const mock = vi.fn(async () => ({
      ok: false, status: 400,
      json: async () => ({ error: { message: "Invalid parameter" } }),
    } as unknown as Response));
    vi.stubGlobal("fetch", mock);
    const adapter = new GraphCampaignAdapter("tok");

    await expect(adapter.createCampaign({
      adAccountId: "act_123", name: "Test", dailyBudgetAgorot: 4000,
      specialAdCategories: [], bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    })).rejects.toThrow(/Invalid parameter/);
  });
});
