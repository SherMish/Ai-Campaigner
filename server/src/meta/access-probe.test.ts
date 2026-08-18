import { describe, expect, it, vi } from "vitest";
import { AccessProbe } from "./access-probe.js";

// AIC-101. These drive the probe through each real failure mode from
// META_SETUP.md's table without touching the network, so "which layer is at
// fault" is provable rather than something we find out on a customer call.

const PORTFOLIO = "2491237118040524";
const PAGE = "1216278568228263";
const ACCT = "act_2181076988590009";

const ALL_SCOPES = ["ads_read", "ads_management", "business_management", "pages_show_list", "pages_read_engagement"];
const ADS_ONLY = ["ads_read", "ads_management", "business_management"];

const json = (body: unknown, ok = true) =>
  ({ ok, status: ok ? 200 : 400, json: async () => body }) as unknown as Response;

const SYSTEM_USER = "122103498795426897";

// Routes a fake Graph by URL shape. Each option models one layer's answer.
function fakeGraph(opts: {
  scopes?: string[] | null;
  clientPages?: string[] | null;
  clientAdAccounts?: string[] | null;
  mePages?: string[] | null;
  // AIC-105 follow-up — the ad-account layer-2 signal: assigned_users on the
  // SPECIFIC account, business-scoped. null = the call itself failed
  // (unknown); an array not containing SYSTEM_USER = genuinely not assigned.
  adAccountAssignedUsers?: string[] | null;
  readOk?: boolean;
  readError?: string;
}) {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("debug_token")) {
      return opts.scopes === null ? json({}, false) : json({ data: { scopes: opts.scopes ?? ALL_SCOPES } });
    }
    if (u.includes("client_pages")) {
      return opts.clientPages === null ? json({}, false) : json({ data: (opts.clientPages ?? [PAGE]).map((id) => ({ id })) });
    }
    if (u.includes("client_ad_accounts")) {
      return opts.clientAdAccounts === null ? json({}, false) : json({ data: (opts.clientAdAccounts ?? [ACCT]).map((id) => ({ id })) });
    }
    if (u.includes("me/accounts")) {
      return opts.mePages === null ? json({}, false) : json({ data: (opts.mePages ?? [PAGE]).map((id) => ({ id })) });
    }
    if (u.includes("assigned_users")) {
      return opts.adAccountAssignedUsers === null
        ? json({}, false)
        : json({ data: (opts.adAccountAssignedUsers ?? [SYSTEM_USER]).map((id) => ({ id })) });
    }
    // the direct read
    return opts.readOk === false
      ? json({ error: { message: opts.readError ?? "(#100) Requires pages_read_engagement" } }, false)
      : json({ id: PAGE, name: "פסגה" });
  }) as unknown as typeof fetch;
}

const probe = (fetchImpl: typeof fetch) =>
  new AccessProbe({ token: "tok", businessPortfolioId: PORTFOLIO, systemUserId: SYSTEM_USER, ver: "v21.0", fetchImpl });

describe("AccessProbe (AIC-101)", () => {
  it("everything granted → ok", async () => {
    const r = await probe(fakeGraph({})).probeAsset("page", PAGE);
    expect(r.verdict).toEqual({ ok: true, layer: null, diagnosis: "ok" });
  });

  it("customer never shared the Page → layer 1", async () => {
    const r = await probe(fakeGraph({ clientPages: [], mePages: [], readOk: false })).probeAsset("page", PAGE);
    expect(r.verdict.layer).toBe(1);
    expect(r.verdict.diagnosis).toBe("not_shared");
  });

  it("shared but not assigned to the System User → layer 2", async () => {
    const r = await probe(fakeGraph({ mePages: [], readOk: false })).probeAsset("page", PAGE);
    expect(r.verdict.layer).toBe(2);
    expect(r.verdict.diagnosis).toBe("not_assigned");
  });

  it("shared + assigned, ads-only token → layer 3 (the real 2026-08-12 failure)", async () => {
    const r = await probe(fakeGraph({ scopes: ADS_ONLY, readOk: false })).probeAsset("page", PAGE);
    expect(r.verdict.layer).toBe(3);
    expect(r.verdict.diagnosis).toBe("token_missing_scopes");
  });

  it("surfaces Meta's own error text for the operator's technical detail", async () => {
    const r = await probe(fakeGraph({ readOk: false, readError: "(#100) boom" })).probeAsset("page", PAGE);
    expect(r.detail).toContain("boom");
  });

  it("ad accounts match whether Meta returns act_123 or bare 123", async () => {
    // A false 'not shared' here would send the customer to redo a grant they
    // already did correctly — the id-format mismatch is a real Graph quirk.
    const bare = await probe(fakeGraph({ clientAdAccounts: ["2181076988590009"] })).probeAsset("ad_account", ACCT);
    expect(bare.observations.sharedToPortfolio).toBe(true);
    const prefixed = await probe(fakeGraph({ clientAdAccounts: [ACCT] })).probeAsset("ad_account", ACCT);
    expect(prefixed.observations.sharedToPortfolio).toBe(true);
  });

  // AIC-105 follow-up: ad accounts DO have a real layer-2 signal — Meta just
  // doesn't expose it as a self-scoped "which accounts am I on" edge the way
  // Pages' /me/accounts does. Checked from the object's own side instead:
  // GET {ad_account}/assigned_users?business={portfolio} (live-verified
  // 2026-08-18 against the real act_2181076988590009 account).
  it("ad account genuinely assigned to our System User → ok", async () => {
    const r = await probe(fakeGraph({})).probeAsset("ad_account", ACCT);
    expect(r.observations.assignedToSystemUser).toBe(true);
  });

  it("ad account shared but NOT yet assigned to our System User → layer 2", async () => {
    const r = await probe(fakeGraph({ adAccountAssignedUsers: [], readOk: false })).probeAsset("ad_account", ACCT);
    expect(r.observations.assignedToSystemUser).toBe(false);
    expect(r.verdict.layer).toBe(2);
    expect(r.verdict.diagnosis).toBe("not_assigned");
  });

  it("the assigned_users call itself failing is unknown, never a confident denial", async () => {
    const r = await probe(fakeGraph({ adAccountAssignedUsers: null, readOk: false })).probeAsset("ad_account", ACCT);
    expect(r.observations.assignedToSystemUser).toBeNull();
  });

  it("a network failure is unknown, never a confident denial", async () => {
    const boom = vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const r = await probe(boom).probeAsset("page", PAGE);
    // Every layer unreadable → cannot claim the customer did anything wrong.
    expect(r.observations.sharedToPortfolio).toBeNull();
    expect(r.observations.tokenHasScopes).toBeNull();
    expect(r.verdict.ok).toBe(false);
    expect(r.verdict.diagnosis).toBe("unreadable_unknown_cause");
  });
});
