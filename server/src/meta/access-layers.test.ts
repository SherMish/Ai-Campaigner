import { describe, expect, it } from "vitest";
import {
  classifyAccess,
  hasRequiredScopes,
  type AccessObservations,
} from "./access-layers.js";

// AIC-101. Every case here is a row of META_SETUP.md's troubleshooting table.
// The point of the table — and of this module — is that these failures are
// indistinguishable from the Business Settings UI, so each one has to be
// provably distinguishable HERE, where the operator's diagnosis comes from.

const obs = (o: Partial<AccessObservations>): AccessObservations => ({
  sharedToPortfolio: null,
  assignedToSystemUser: null,
  tokenHasScopes: null,
  directReadOk: null,
  ...o,
});

describe("classifyAccess (AIC-101 — the three layers)", () => {
  it("a successful direct read is ok, whatever the individual layer signals say", () => {
    // Ground truth beats the edges: this is the same read the connection
    // health check makes, so if it passes, persisting the id is safe.
    expect(classifyAccess(obs({ directReadOk: true }))).toEqual({
      ok: true, layer: null, diagnosis: "ok",
    });
    // Even with a layer edge reporting nothing — Meta's client_* edges are
    // occasionally inconsistent; we trust the call we actually make.
    expect(
      classifyAccess(obs({ sharedToPortfolio: false, directReadOk: true })).ok,
    ).toBe(true);
  });

  it("client_pages empty → layer 1, the customer hasn't shared it", () => {
    const v = classifyAccess(obs({ sharedToPortfolio: false, directReadOk: false }));
    expect(v).toEqual({ ok: false, layer: 1, diagnosis: "not_shared" });
  });

  it("shared but not assigned to the System User → layer 2", () => {
    const v = classifyAccess(obs({
      sharedToPortfolio: true, assignedToSystemUser: false, directReadOk: false,
    }));
    expect(v).toEqual({ ok: false, layer: 2, diagnosis: "not_assigned" });
  });

  it("shared + assigned but the token lacks the scopes → layer 3", () => {
    const v = classifyAccess(obs({
      sharedToPortfolio: true, assignedToSystemUser: true,
      tokenHasScopes: false, directReadOk: false,
    }));
    expect(v).toEqual({ ok: false, layer: 3, diagnosis: "token_missing_scopes" });
  });

  it("layer 1 outranks a simultaneously-unscoped token", () => {
    // Both are broken. Reporting layer 3 first would send the operator to
    // rotate a production secret while the customer still hasn't shared the
    // asset — expensive, and it wouldn't fix anything.
    const v = classifyAccess(obs({
      sharedToPortfolio: false, tokenHasScopes: false, directReadOk: false,
    }));
    expect(v.layer).toBe(1);
  });

  it("all three layers pass and it STILL won't read → says so, never invents a cause", () => {
    const v = classifyAccess(obs({
      sharedToPortfolio: true, assignedToSystemUser: true,
      tokenHasScopes: true, directReadOk: false,
    }));
    expect(v).toEqual({ ok: false, layer: null, diagnosis: "unreadable_unknown_cause" });
  });

  it("nothing observed yet is 'unknown' — not a pass, not a diagnosed failure", () => {
    const v = classifyAccess(obs({}));
    expect(v).toEqual({ ok: false, layer: null, diagnosis: "unknown" });
    // The distinction that matters: unknown must never render as ok.
    expect(v.ok).toBe(false);
  });
});

describe("hasRequiredScopes", () => {
  it("Page reads need BOTH pages_show_list and pages_read_engagement", () => {
    // The real 2026-08-12 failure: an ads-only token. /me/accounts returns
    // nothing without pages_show_list, and the direct Page read 100s without
    // pages_read_engagement.
    expect(hasRequiredScopes("page", ["ads_read", "ads_management"])).toBe(false);
    expect(hasRequiredScopes("page", ["pages_show_list"])).toBe(false);
    expect(hasRequiredScopes("page", ["pages_show_list", "pages_read_engagement"])).toBe(true);
  });

  it("ad accounts need ads_read + ads_management", () => {
    expect(hasRequiredScopes("ad_account", ["ads_read"])).toBe(false);
    expect(hasRequiredScopes("ad_account", ["ads_read", "ads_management"])).toBe(true);
  });

  it("extra scopes are fine", () => {
    expect(hasRequiredScopes("ad_account", ["ads_read", "ads_management", "pages_show_list"])).toBe(true);
  });

  // Verified live 2026-08-19, against the real production System User token.
  // An IG Business account shared with us as an AD-ACCOUNT asset reads fine
  // on an ads/business-scoped token: `17841447360487819` (ads_agent_il) both
  // listed under act_1573023157816786/instagram_accounts AND direct-read
  // 200 OK, with NO instagram_* scope on the token. The earlier
  // `instagram_basic` requirement was reasoned, never measured, and it was
  // wrong. It matters because an unreadable id then blames layer 3 and sends
  // the operator to rotate a production secret — see the case below.
  it("Instagram reads ride on the ads/business grant, NOT instagram_basic", () => {
    const productionScopes = [
      "ads_management",
      "ads_read",
      "business_management",
      "catalog_management",
      "pages_manage_ads",
      "pages_read_engagement",
      "pages_show_list",
      "public_profile",
      "threads_business_basic",
    ];
    expect(hasRequiredScopes("instagram", productionScopes)).toBe(true);
  });
});

describe("classifyAccess — Instagram diagnosis (AIC-108 follow-up)", () => {
  // The bug: with `instagram_basic` wrongly required, a TYPO'd or not-yet-
  // shared IG id produced `token_missing_scopes`, i.e. "regenerate the System
  // User token and rotate the secret". This module's own header warns against
  // exactly that: sending an operator to rotate a production secret for
  // something that was never broken. A token that can demonstrably read
  // Instagram must never be blamed.
  const scopedToken = {
    sharedToPortfolio: null,
    assignedToSystemUser: null,
    tokenHasScopes: true,
    directReadOk: false,
  };

  it("does NOT blame the token when the read fails but the token is scoped", () => {
    const v = classifyAccess(scopedToken);
    expect(v.ok).toBe(false);
    expect(v.diagnosis).not.toBe("token_missing_scopes");
    expect(v.diagnosis).toBe("unreadable_unknown_cause");
  });

  it("still passes a readable Instagram account", () => {
    expect(classifyAccess({ ...scopedToken, directReadOk: true })).toEqual({
      ok: true,
      layer: null,
      diagnosis: "ok",
    });
  });
});
