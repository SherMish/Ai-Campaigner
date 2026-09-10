import { describe, it, expect } from "vitest";
import {
  completeOauth, exchangeCode, inspectToken, discoverAssets,
  OauthRefusedError, OauthFaultError, type FetchLike,
} from "./oauth-exchange.js";
import type { OauthConfig } from "./oauth-config.js";

const CONFIG: OauthConfig = {
  appId: "1762330388097443",
  appSecret: "sekrit",
  configId: "2135474130384425",
  redirectUri: "https://ads-agent.co.il/api/meta/oauth/callback",
};

const ALL_SCOPES = [
  "ads_management", "ads_read", "business_management",
  "pages_show_list", "pages_read_engagement", "pages_manage_ads", "instagram_basic",
];

// Routes a URL to a canned body, so each test states only what it cares about.
function fakeFetch(routes: Array<[RegExp, unknown, number?]>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    for (const [re, body, status] of routes) {
      if (re.test(url)) return { ok: (status ?? 200) < 400, status: status ?? 200, json: async () => body };
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  }) as FetchLike & { calls: string[] };
  f.calls = calls;
  return f;
}

const okRoutes = (over: Partial<{ scopes: string[]; ads: string[]; pages: string[] }> = {}) => [
  [/oauth\/access_token/, { access_token: "EAAG-real-token" }] as [RegExp, unknown],
  [/debug_token/, {
    data: {
      is_valid: true, user_id: "77001",
      granular_scopes: (over.scopes ?? ALL_SCOPES).map((s) => ({ scope: s })),
    },
  }] as [RegExp, unknown],
  [/me\/businesses/, { data: [{ id: "467328257419676" }] }] as [RegExp, unknown],
  [/me\/adaccounts/, { data: (over.ads ?? ["act_2181076988590009"]).map((id) => ({ id })) }] as [RegExp, unknown],
  [/me\/accounts/, { data: (over.pages ?? ["100457729476059"]).map((id) => ({ id })) }] as [RegExp, unknown],
  [/instagram_business_account/, { instagram_business_account: { id: "17841400000" } }] as [RegExp, unknown],
];

describe("oauth-exchange", () => {
  describe("exchangeCode", () => {
    it("sends the exact redirect_uri the dialog used", async () => {
      // Meta compares the two as strings; a mismatch is the classic silent failure.
      const f = fakeFetch(okRoutes());
      await exchangeCode(CONFIG, "CODE", f);
      expect(f.calls[0]).toContain(encodeURIComponent(CONFIG.redirectUri));
      expect(f.calls[0]).toContain("code=CODE");
    });

    it("surfaces Meta's own error message", async () => {
      const f = fakeFetch([[/access_token/, { error: { message: "This authorization code has been used.", code: 100 } }, 400]]);
      await expect(exchangeCode(CONFIG, "USED", f)).rejects.toThrow(/has been used/);
    });

    it("treats a 200 with no access_token as a fault", async () => {
      const f = fakeFetch([[/access_token/, { token_type: "bearer" }]]);
      await expect(exchangeCode(CONFIG, "C", f)).rejects.toThrow(OauthFaultError);
    });
  });

  describe("inspectToken", () => {
    it("refuses a token missing a required scope, naming it", async () => {
      // The real case: the customer completes consent but declines an asset, and
      // the token comes back valid and unusable.
      const f = fakeFetch(okRoutes({ scopes: ALL_SCOPES.filter((s) => s !== "ads_management") }));
      await expect(inspectToken(CONFIG, "T", f)).rejects.toThrow(/missing permissions: ads_management/);
    });

    it("does NOT require instagram_basic", async () => {
      const f = fakeFetch(okRoutes({ scopes: ALL_SCOPES.filter((s) => s !== "instagram_basic") }));
      await expect(inspectToken(CONFIG, "T", f)).resolves.toMatchObject({ metaUserId: "77001" });
    });

    it("falls back to flat scopes when granular is absent", async () => {
      const f = fakeFetch([[/debug_token/, { data: { is_valid: true, user_id: "9", scopes: ALL_SCOPES } }]]);
      await expect(inspectToken(CONFIG, "T", f)).resolves.toMatchObject({ metaUserId: "9" });
    });

    it("refuses a token Meta reports as invalid", async () => {
      const f = fakeFetch([[/debug_token/, { data: { is_valid: false, granular_scopes: ALL_SCOPES.map((s) => ({ scope: s })) } }]]);
      await expect(inspectToken(CONFIG, "T", f)).rejects.toThrow(/not valid/);
    });
  });

  describe("discoverAssets", () => {
    it("reads what the token can reach, not what we asked for", async () => {
      const assets = await discoverAssets("T", fakeFetch(okRoutes()));
      expect(assets).toEqual({
        businessIds: ["467328257419676"],
        adAccountIds: ["act_2181076988590009"],
        pageIds: ["100457729476059"],
        instagramIds: ["17841400000"],
      });
    });

    it("survives a Page with no Instagram linked", async () => {
      const routes = okRoutes().filter(([re]) => !/instagram_business_account/.test(re.source));
      routes.push([/instagram_business_account/, { error: { message: "nope", code: 100 } }, 400] as never);
      const assets = await discoverAssets("T", fakeFetch(routes));
      expect(assets.instagramIds).toEqual([]);
      expect(assets.pageIds).toHaveLength(1);
    });

    it("asks Meta one edge at a time", async () => {
      // Four parallel calls on a fresh token is the burst that earns a code-17
      // throttle, which reads to the customer as a failed connection.
      const f = fakeFetch(okRoutes());
      await discoverAssets("T", f);
      const order = f.calls.map((u) => u.replace(/^.*v21\.0\//, "").split("?")[0]);
      expect(order.slice(0, 3)).toEqual(["me/businesses", "me/adaccounts", "me/accounts"]);
    });
  });

  describe("completeOauth", () => {
    it("returns the token, scopes and assets together", async () => {
      const r = await completeOauth(CONFIG, "CODE", fakeFetch(okRoutes()));
      expect(r.accessToken).toBe("EAAG-real-token");
      expect(r.assets.metaUserId).toBe("77001");
      expect(r.assets.adAccountIds).toEqual(["act_2181076988590009"]);
    });

    it("refuses a grant with no ad account — the one asset the product cannot work without", async () => {
      const f = fakeFetch(okRoutes({ ads: [] }));
      await expect(completeOauth(CONFIG, "C", f)).rejects.toThrow(OauthRefusedError);
      await expect(completeOauth(CONFIG, "C", f)).rejects.toThrow(/no ad account/);
    });

    it("refuses a grant with no Page — every creative needs one", async () => {
      const f = fakeFetch(okRoutes({ pages: [] }));
      await expect(completeOauth(CONFIG, "C", f)).rejects.toThrow(/no Facebook Page/);
    });
  });
});
