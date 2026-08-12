import { describe, it, expect } from "vitest";
import { normalizeAdSet, summarize, isProblem } from "./delivery-health.js";

describe("normalizeAdSet (AIC-39)", () => {
  it("ACTIVE with no issues → delivering", () => {
    expect(normalizeAdSet({ id: "a", effective_status: "ACTIVE" }).state).toBe("delivering");
  });

  it("ACTIVE but with issues_info → not_delivering (the GelNails case)", () => {
    const h = normalizeAdSet({ id: "a", effective_status: "ACTIVE", issues_info: [{ error_summary: "Ad set not delivering" }] });
    expect(h.state).toBe("not_delivering");
    expect(h.reason).toBe("Ad set not delivering");
  });

  it("DISAPPROVED → disapproved", () => {
    expect(normalizeAdSet({ id: "a", effective_status: "DISAPPROVED" }).state).toBe("disapproved");
  });

  it("PAUSED → paused (intentional, not a problem)", () => {
    const h = normalizeAdSet({ id: "a", effective_status: "PAUSED" });
    expect(h.state).toBe("paused");
    expect(isProblem(h)).toBe(false);
  });

  it("DELETED with leftover issues_info → still paused, never flagged (AIC-65)", () => {
    // Real GelNails shape: a deleted ad set can carry stale issues_info from
    // before it was deleted. Deleted must win — "gone is gone."
    const h = normalizeAdSet({ id: "a", effective_status: "DELETED", issues_info: [{ error_summary: "Page Is Unpublished For Ad" }] });
    expect(h.state).toBe("paused");
    expect(h.reason).toBeNull();
    expect(isProblem(h)).toBe(false);
  });

  it("ARCHIVED with leftover issues_info → still paused, never flagged (AIC-65)", () => {
    const h = normalizeAdSet({ id: "a", effective_status: "ARCHIVED", issues_info: [{ error_message: "Creative rejected" }] });
    expect(h.state).toBe("paused");
    expect(isProblem(h)).toBe(false);
  });
});

describe("summarize", () => {
  it("ok when everything delivers or is intentionally paused", () => {
    const s = summarize([
      normalizeAdSet({ id: "a", effective_status: "ACTIVE" }),
      normalizeAdSet({ id: "b", effective_status: "PAUSED" }),
    ]);
    expect(s.ok).toBe(true);
    expect(s.problemAdSetIds).toEqual([]);
  });

  it("not ok + lists the problem ad sets + a reason", () => {
    const s = summarize([
      normalizeAdSet({ id: "a", effective_status: "ACTIVE" }),
      normalizeAdSet({ id: "b", effective_status: "ACTIVE", issues_info: [{ error_message: "Creative rejected" }] }),
    ]);
    expect(s.ok).toBe(false);
    expect(s.problemAdSetIds).toEqual(["b"]);
    expect(s.reason).toBe("Creative rejected");
  });
});

// AIC-71: `delivering` is a different question than `ok` — a fully, correctly
// paused campaign is `ok: true` (nothing broken) but `delivering: false`
// (nothing showing). normalizeAdSet never sets deliveringAdCount itself (it
// has no ad-level knowledge — that's the adapter's ad rollup, tested in
// campaign-adapter.test.ts), so these construct AdSetHealth directly.
describe("summarize — delivering (AIC-71)", () => {
  it("ad set is ACTIVE but every ad under it is paused → not delivering, still ok", () => {
    const s = summarize([{ adSetId: "a", name: null, state: "delivering", reason: null, deliveringAdCount: 0 }]);
    expect(s.ok).toBe(true); // not a problem — nobody's ads are erroring
    expect(s.delivering).toBe(false);
    expect(s.deliveringAdCount).toBe(0);
  });

  it("at least one delivering ad under a delivering ad set → delivering, counted", () => {
    const s = summarize([
      { adSetId: "a", name: null, state: "delivering", reason: null, deliveringAdCount: 2 },
      { adSetId: "b", name: null, state: "paused", reason: null, deliveringAdCount: 0 },
    ]);
    expect(s.delivering).toBe(true);
    expect(s.deliveringAdCount).toBe(2);
  });

  it("an ad set whose own state leaked to paused (e.g. CAMPAIGN_PAUSED) never counts its ads", () => {
    // Real shape: an ad row can still read ACTIVE while its parent ad set's
    // effective_status reports CAMPAIGN_PAUSED — the ad set's OWN state must
    // gate whether its ads count, not the raw per-ad number.
    const s = summarize([{ adSetId: "a", name: null, state: "paused", reason: null, deliveringAdCount: 3 }]);
    expect(s.delivering).toBe(false);
    expect(s.deliveringAdCount).toBe(0);
  });

  it("everything paused → nothing delivering, all-empty campaign never falsely counts", () => {
    const s = summarize([]);
    expect(s.delivering).toBe(false);
    expect(s.deliveringAdCount).toBe(0);
  });
});
