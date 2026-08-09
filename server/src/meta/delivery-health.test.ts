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
