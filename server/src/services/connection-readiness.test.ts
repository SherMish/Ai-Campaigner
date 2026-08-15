import { describe, it, expect } from "vitest";
import { classifyConnectionReadiness } from "./connection-readiness.js";

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
});
