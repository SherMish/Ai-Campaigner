import { describe, it, expect } from "vitest";
import { classifyAdState } from "./ad-state.js";

// Found live 2026-08-22: a customer added an ad, got a success confirmation,
// and the dashboard still showed only the old ads. The ad was ACTIVE on Meta
// seconds later — but sitting at effective_status PENDING_REVIEW, a value that
// appeared NOWHERE in this codebase despite being the state EVERY new ad is in
// for its first hours.
describe("classifyAdState", () => {
  it("treats a brand-new ad awaiting Meta review as pending, not missing", () => {
    expect(classifyAdState("PENDING_REVIEW")).toBe("in_review");
    expect(classifyAdState("PENDING_BILLING_INFO")).toBe("in_review");
  });

  it("surfaces a rejected ad rather than letting it vanish", () => {
    // The nastier half: a rejected ad NEVER gains insight data, so under the
    // old data-derived list it would have been invisible forever — reading as
    // "the create silently failed" when in fact Meta refused the content.
    expect(classifyAdState("DISAPPROVED")).toBe("rejected");
    expect(classifyAdState("WITH_ISSUES")).toBe("rejected");
  });

  it("classifies a delivering ad as active", () => {
    expect(classifyAdState("ACTIVE")).toBe("active");
  });

  it("distinguishes paused-by-someone from blocked-by-a-parent", () => {
    // These already have customer-facing copy (statusPausedByYou vs
    // statusBlockedByAdSet/Campaign) — the point is that the parent's pause is
    // NOT the ad's own fault, and the UI already says so differently.
    expect(classifyAdState("PAUSED")).toBe("paused");
    expect(classifyAdState("ADSET_PAUSED")).toBe("blocked_by_parent");
    expect(classifyAdState("CAMPAIGN_PAUSED")).toBe("blocked_by_parent");
  });

  it("treats deleted/archived as gone", () => {
    expect(classifyAdState("DELETED")).toBe("gone");
    expect(classifyAdState("ARCHIVED")).toBe("gone");
  });

  // The set of values Meta can return is not ours to freeze. An unrecognised
  // status must still render as SOMETHING (AIC-98: never a blank where a
  // reason exists) rather than being dropped or guessed into a wrong bucket.
  it("keeps an unknown status visible instead of guessing", () => {
    expect(classifyAdState("SOME_FUTURE_META_STATUS")).toBe("unknown");
    expect(classifyAdState("")).toBe("unknown");
  });
});
