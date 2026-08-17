import { describe, it, expect } from "vitest";
import { classifyConnectionReadiness, missingConfigFields } from "./connection-readiness.js";

const READY = {
  campaignId: "camp1",
  metaCampaignId: "meta_camp1",
  accessHealth: "ok",
  metaAdAccountId: "act_1",
  pageId: "page_1",
};

// The single source of truth both the customer-facing add-content 409
// (additions/session.ts) and the admin console (customers.ts) now share —
// a real live bug (a customer told "build your first campaign" when the
// actual problem was a missing Page grant) came from these checks being
// duplicated and drifting.
describe("classifyConnectionReadiness", () => {
  it("is null (ready) when every layer is present", () => {
    expect(classifyConnectionReadiness(READY)).toBeNull();
  });

  it("no_campaign when there's no campaign at all", () => {
    expect(classifyConnectionReadiness({ ...READY, campaignId: null })).toBe("no_campaign");
  });

  it("not_launched when a local campaign exists but was never linked to Meta", () => {
    expect(classifyConnectionReadiness({ ...READY, metaCampaignId: null })).toBe("not_launched");
  });

  it("connection_issue when the connection is unhealthy", () => {
    expect(classifyConnectionReadiness({ ...READY, accessHealth: "needs_reconnect" })).toBe("connection_issue");
  });

  it("connection_issue when there's no ad account on file", () => {
    expect(classifyConnectionReadiness({ ...READY, metaAdAccountId: null })).toBe("connection_issue");
  });

  it("missing_page when everything else is fine but the Page is missing (the real production case)", () => {
    expect(classifyConnectionReadiness({ ...READY, pageId: null })).toBe("missing_page");
  });

  it("checks in priority order — no_campaign wins even if other fields are also missing", () => {
    expect(classifyConnectionReadiness({ campaignId: null, metaCampaignId: null, accessHealth: null, metaAdAccountId: null, pageId: null })).toBe(
      "no_campaign",
    );
  });

  // AIC-103: found live — free_beta_signups_leads passed every check above
  // (real, launched, healthy connection, Page present) and still couldn't
  // take a write, because website_url was never set. The customer got a raw
  // 409 at submit time instead of being told at entry.
  describe("incomplete_config (AIC-103)", () => {
    it("is null (ready) for a WhatsApp campaign with its number on file", () => {
      expect(classifyConnectionReadiness({ ...READY, isMessaging: true, whatsappDestination: "+972501234567" })).toBeNull();
    });

    it("incomplete_config for a WhatsApp campaign missing its number", () => {
      expect(classifyConnectionReadiness({ ...READY, isMessaging: true, whatsappDestination: "" })).toBe("incomplete_config");
    });

    it("is null (ready) for a website campaign with url + pixel + lead events on file", () => {
      expect(
        classifyConnectionReadiness({
          ...READY, isMessaging: false, websiteUrl: "https://example.com", trackingPixelId: "px_1",
          leadEventTypes: ["offsite_conversion.fb_pixel_lead"],
        }),
      ).toBeNull();
    });

    it("incomplete_config for a website campaign missing website_url — the real live case", () => {
      expect(
        classifyConnectionReadiness({
          ...READY, isMessaging: false, websiteUrl: null, trackingPixelId: "px_1",
          leadEventTypes: ["offsite_conversion.fb_pixel_lead"],
        }),
      ).toBe("incomplete_config");
    });

    it("never fires when the caller doesn't pass isMessaging — omission means 'not checked', not 'complete'", () => {
      expect(classifyConnectionReadiness(READY)).toBeNull();
    });

    it("missing_page still wins over incomplete_config — earlier checks take priority", () => {
      expect(classifyConnectionReadiness({ ...READY, pageId: null, isMessaging: false, websiteUrl: null })).toBe("missing_page");
    });
  });

  describe("missingConfigFields (AIC-103)", () => {
    it("lists every missing field for a website campaign, not just the first", () => {
      expect(missingConfigFields({ ...READY, isMessaging: false, websiteUrl: null, trackingPixelId: null, leadEventTypes: [] })).toEqual([
        "website_url", "tracking_pixel_id", "lead_event_types",
      ]);
    });

    it("empty when the caller didn't pass isMessaging", () => {
      expect(missingConfigFields(READY)).toEqual([]);
    });
  });
});
