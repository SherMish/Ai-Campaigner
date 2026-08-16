import { describe, expect, it } from "vitest";
import { AD_DELIVERY_BADGE, AD_DELIVERY_TONE, deliveryStatus } from "./delivery-status";

// AIC-100. Same discipline as state-copy.test.ts (AIC-98): every resolved
// state gets distinct, non-empty copy, and the resolution itself is a pure
// function so every precedence case is a direct assertion, not something
// only reachable through Home.tsx's render tree.

describe("deliveryStatus (AIC-100)", () => {
  it("all active → delivering", () => {
    expect(deliveryStatus("active", "active", "active")).toBe("delivering");
  });

  it("ad paused, ad set active → paused_by_you (the real bug report's inverse)", () => {
    expect(deliveryStatus("paused", "active", "active")).toBe("paused_by_you");
  });

  it("ad active, ad set paused → blocked_by_adset, never delivering", () => {
    expect(deliveryStatus("active", "paused", "active")).toBe("blocked_by_adset");
  });

  it("ad active, campaign paused → blocked_by_campaign, never delivering", () => {
    expect(deliveryStatus("active", "active", "paused")).toBe("blocked_by_campaign");
  });

  it("the ad's own pause always wins — never phrased as a parent problem", () => {
    expect(deliveryStatus("paused", "paused", "active")).toBe("paused_by_you");
    expect(deliveryStatus("paused", "active", "paused")).toBe("paused_by_you");
    expect(deliveryStatus("paused", "paused", "paused")).toBe("paused_by_you");
  });

  it("campaign outranks ad set when both parents are paused — the fix isn't at the ad set", () => {
    expect(deliveryStatus("active", "paused", "paused")).toBe("blocked_by_campaign");
  });
});

describe("AD_DELIVERY_BADGE / AD_DELIVERY_TONE (AIC-98 discipline)", () => {
  const nonEmpty = (s: string) => typeof s === "string" && s.trim().length > 0;

  it("every state has non-empty badge text", () => {
    for (const [state, label] of Object.entries(AD_DELIVERY_BADGE)) {
      expect(nonEmpty(label), state).toBe(true);
    }
  });

  it("no two states share the same badge text — each names a distinct cause", () => {
    const seen = new Map<string, string>();
    for (const [state, label] of Object.entries(AD_DELIVERY_BADGE)) {
      expect(seen.get(label), `${state} duplicates ${seen.get(label)}`).toBeUndefined();
      seen.set(label, state);
    }
  });

  it("every state has a tone, and 'delivering' is the only ok one", () => {
    for (const [state, tone] of Object.entries(AD_DELIVERY_TONE)) {
      expect(["ok", "warn", "neutral"]).toContain(tone);
      if (state === "delivering") expect(tone).toBe("ok");
      else expect(tone).not.toBe("ok");
    }
  });
});
