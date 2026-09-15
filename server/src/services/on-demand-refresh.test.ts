import { describe, it, expect, vi } from "vitest";
import { createRefresher, isRateLimit, type CampaignToRefresh } from "./on-demand-refresh.js";

const T0 = new Date("2026-09-15T20:00:00Z");
const camp = (over: Partial<CampaignToRefresh> = {}): CampaignToRefresh => ({
  campaignId: "c1", metaCampaignId: "m1", adAccountId: "act_1", refreshedAt: null, ...over,
});

function setup(opts: { campaign?: CampaignToRefresh | null; refresh?: () => Promise<void>; now?: () => Date; waitMs?: number } = {}) {
  let clock = opts.now ?? (() => T0);
  const refresh = vi.fn(opts.refresh ?? (async () => {}));
  const marked: Array<[string, Date]> = [];
  const ensure = createRefresher({
    load: async () => (opts.campaign === undefined ? camp() : opts.campaign),
    refresh,
    markRefreshed: async (id, at) => { marked.push([id, at]); },
    isThrottle: isRateLimit,
    now: () => clock(),
    waitMs: opts.waitMs ?? 1000,
  });
  return { ensure, refresh, marked, setClock: (f: () => Date) => { clock = f; } };
}

describe("on-demand refresh", () => {
  it("refreshes a campaign that was never refreshed, and marks it", async () => {
    const { ensure, refresh, marked } = setup();
    expect(await ensure("c1")).toBe("refreshed");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(marked[0][0]).toBe("c1");
  });

  it("makes NO Meta calls when refreshed within 10 minutes", async () => {
    // Otherwise every reload and campaign switch is a burst, and the throttle
    // this replaces comes straight back — triggered by the customer instead.
    const { ensure, refresh } = setup({ campaign: camp({ refreshedAt: new Date(T0.getTime() - 9 * 60_000) }) });
    expect(await ensure("c1")).toBe("fresh");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes again after 10 minutes", async () => {
    const { ensure, refresh } = setup({ campaign: camp({ refreshedAt: new Date(T0.getTime() - 11 * 60_000) }) });
    expect(await ensure("c1")).toBe("refreshed");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shares ONE refresh between concurrent requests for the same campaign", async () => {
    // The dashboard fires overview and audiences at the same moment.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { ensure, refresh } = setup({ refresh: () => gate });
    const a = ensure("c1");
    const b = ensure("c1");
    release();
    expect(await Promise.all([a, b])).toEqual(["refreshed", "refreshed"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("backs off the whole AD ACCOUNT after a rate limit — no calls into the block", async () => {
    let n = 0;
    const { ensure, refresh } = setup({
      refresh: async () => {
        n++;
        throw new Error('insights failed: {"message":"User request limit reached","code":17}');
      },
    });
    expect(await ensure("c1")).toBe("throttled");
    // A different campaign on the SAME account must not call Meta either.
    expect(await ensure("c2")).toBe("throttled");
    expect(n).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not mark a throttled refresh as fresh", async () => {
    const { ensure, marked } = setup({ refresh: async () => { throw Object.assign(new Error("x"), { code: 17 }); } });
    await ensure("c1");
    expect(marked).toEqual([]);
  });

  it("tries again once the back-off has passed", async () => {
    let fail = true;
    const s = setup({ refresh: async () => { if (fail) throw Object.assign(new Error("x"), { code: 17 }); } });
    expect(await s.ensure("c1")).toBe("throttled");
    fail = false;
    s.setClock(() => new Date(T0.getTime() + 16 * 60_000));
    expect(await s.ensure("c1")).toBe("refreshed");
  });

  it("does not hang the page on a slow refresh — returns 'refreshing' and finishes in background", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { ensure, marked } = setup({ refresh: () => gate, waitMs: 20 });
    expect(await ensure("c1")).toBe("refreshing");
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(marked).toHaveLength(1);
  });

  it("is unavailable for a campaign not linked to Meta, without calling anything", async () => {
    const { ensure, refresh } = setup({ campaign: camp({ metaCampaignId: null }) });
    expect(await ensure("c1")).toBe("unavailable");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("reports a non-throttle failure as unavailable and does not back off the account", async () => {
    let calls = 0;
    const { ensure } = setup({ refresh: async () => { calls++; throw new Error("boom"); } });
    expect(await ensure("c1")).toBe("unavailable");
    expect(await ensure("c1")).toBe("unavailable");
    expect(calls).toBe(2);
  });
});

describe("isRateLimit", () => {
  it("recognises both shapes Meta's errors reach us in", () => {
    expect(isRateLimit(Object.assign(new Error("x"), { code: 17 }))).toBe(true);
    expect(isRateLimit(new Error('daily insights ad failed: {"code":17,"message":"x"}'))).toBe(true);
    expect(isRateLimit(new Error("User request limit reached"))).toBe(true);
    expect(isRateLimit(new Error('{"code":100,"message":"bad field"}'))).toBe(false);
    expect(isRateLimit(new Error("fetch failed"))).toBe(false);
  });
});
