import { describe, it, expect } from "vitest";
import { readOauthConfig, buildDialogUrl, oauthEnabled, oauthReturnUrl, OauthNotConfiguredError } from "./oauth-config.js";

const FULL = {
  META_APP_ID: "1762330388097443",
  META_APP_SECRET: "sekrit",
  META_LOGIN_CONFIG_ID: "2135474130384425",
  META_OAUTH_REDIRECT_URI: "https://ads-agent.co.il/api/meta/oauth/callback",
} as NodeJS.ProcessEnv;

describe("oauth-config", () => {
  it("reads a complete configuration", () => {
    expect(readOauthConfig(FULL)).toEqual({
      appId: "1762330388097443",
      appSecret: "sekrit",
      configId: "2135474130384425",
      redirectUri: "https://ads-agent.co.il/api/meta/oauth/callback",
    });
  });

  it("names every missing variable at once, not the first one", () => {
    // Fixing these one deploy at a time is the failure this prevents.
    const e = (() => { try { readOauthConfig({} as NodeJS.ProcessEnv); } catch (x) { return x as Error; } })()!;
    expect(e).toBeInstanceOf(OauthNotConfiguredError);
    for (const k of Object.keys(FULL)) expect(e.message).toContain(k);
  });

  it("refuses a non-https redirect, allowing localhost for dev", () => {
    expect(() => readOauthConfig({ ...FULL, META_OAUTH_REDIRECT_URI: "http://ads-agent.co.il/cb" }))
      .toThrow(/must be https/);
    expect(() => readOauthConfig({ ...FULL, META_OAUTH_REDIRECT_URI: "http://localhost:5185/cb" }))
      .not.toThrow();
  });

  it("builds a dialog url with config_id and no scope parameter", () => {
    // The configuration owns permissions; passing scope too gives two sources
    // of truth that can disagree.
    const url = new URL(buildDialogUrl(readOauthConfig(FULL), "STATE"));
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/v21.0/dialog/oauth");
    expect(url.searchParams.get("config_id")).toBe("2135474130384425");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("STATE");
    expect(url.searchParams.get("scope")).toBeNull();
  });

  it("is off unless explicitly enabled", () => {
    expect(oauthEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(oauthEnabled({ META_OAUTH_ENABLED: "1" } as NodeJS.ProcessEnv)).toBe(false);
    expect(oauthEnabled({ META_OAUTH_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe(true);
  });

  describe("oauthReturnUrl", () => {
    const ENV = { APP_BASE_URL: "https://ads-agent.co.il" } as NodeJS.ProcessEnv;

    it("sends a CONNECTED customer to the dashboard, not back to onboarding", () => {
      // Adoption has already run — their campaigns are in the database. Parking
      // them on "we are reviewing your campaign, nothing to do" is a wall in
      // front of data they can already see.
      expect(oauthReturnUrl("connected", undefined, ENV)).toBe("https://ads-agent.co.il/app");
    });

    it("returns a FAILED or REFUSED customer to onboarding, where the button is", () => {
      // Not /app/onboarding: App.tsx registers /onboarding, and the earlier bug
      // here left a customer in the app shell with no explanation at all.
      expect(oauthReturnUrl("failed", "meta_error", ENV))
        .toBe("https://ads-agent.co.il/onboarding?meta=failed&reason=meta_error");
    });

    it("carries the reason when there is one", () => {
      expect(oauthReturnUrl("refused", "access_denied", ENV))
        .toBe("https://ads-agent.co.il/onboarding?meta=refused&reason=access_denied");
    });

    it("tolerates a trailing slash on the base url", () => {
      expect(oauthReturnUrl("failed", undefined, { APP_BASE_URL: "https://ads-agent.co.il/" } as NodeJS.ProcessEnv))
        .toBe("https://ads-agent.co.il/onboarding?meta=failed");
    });
  });
});
