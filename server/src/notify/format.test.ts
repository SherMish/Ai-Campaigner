import { describe, it, expect } from "vitest";
import { formatAction, formatOps, actionTypeLabel, type ActionEvent, type OpsEvent } from "./format.js";

const REF = new Date("2026-08-23T12:00:00Z");

function action(over: Partial<ActionEvent> = {}): ActionEvent {
  return {
    kind: "action",
    id: "a1",
    occurredAt: REF,
    actionType: "pause_ad",
    what: "מודעה 120250980671840544",
    why: "שינוי ידני על ידי הלקוח",
    targetMetaId: "120250980671840544",
    previousState: { status: "ACTIVE" },
    newState: { status: "PAUSED" },
    approvedBy: "customer",
    humanInvolved: true,
    result: "success",
    businessName: "GelNails",
    campaignName: "GelNails | Leads | WhatsApp",
    isTest: false,
    ...over,
  };
}

describe("ops message formatting (AIC-118)", () => {
  it("names the customer, the object and who did it — the three things an operator needs", () => {
    const text = formatAction(action());
    expect(text).toContain("GelNails");
    expect(text).toContain("120250980671840544");
    expect(text).toContain("the customer");
    expect(text).toContain("ACTIVE → PAUSED");
  });

  it("distinguishes the customer from us from the engine", () => {
    expect(formatAction(action({ approvedBy: "customer", humanInvolved: true }))).toContain("the customer");
    expect(formatAction(action({ approvedBy: "sharon@x.com", humanInvolved: true }))).toContain("us (sharon@x.com)");
    expect(formatAction(action({ approvedBy: null, humanInvolved: false }))).toContain("engine (automatic)");
  });

  it("marks a failed action, and never renders it as a success", () => {
    const text = formatAction(action({ result: "failed" }));
    expect(text).toContain("FAILED");
    expect(text.startsWith("🔴")).toBe(true);
  });

  // The two bugs this week were both "a value that means one thing rendered as
  // a claim about another". previous_state/new_state are free-form JSONB, so a
  // row that recorded no transition must not produce a fabricated one.
  it("says nothing about status when the row records no transition", () => {
    expect(formatAction(action({ previousState: {}, newState: {} }))).not.toContain("status:");
    expect(formatAction(action({ previousState: { status: "ACTIVE" }, newState: { status: "ACTIVE" } })))
      .not.toContain("status:");
  });

  it("survives a row with no campaign, customer or reason rather than printing 'null'", () => {
    const text = formatAction(action({ businessName: null, campaignName: null, why: "", targetMetaId: null }));
    expect(text).not.toContain("null");
    expect(text).toContain("unknown customer");
  });

  // rollback_build is deliberately absent from SUMMARY_HE because the CUSTOMER
  // must not see it (it reads as "we changed your campaign automatically").
  // The ops channel is the one place it genuinely matters.
  it("labels ops-only action types instead of falling through to the raw key", () => {
    expect(actionTypeLabel("rollback_build")).not.toBe("rollback_build");
    expect(actionTypeLabel("pause_ad")).toBe("השהיית מודעה");
  });

  it("falls back to the raw action type rather than inventing a label", () => {
    expect(actionTypeLabel("some_future_action")).toBe("some_future_action");
  });

  it("renders an ops item with its severity", () => {
    const e: OpsEvent = {
      kind: "ops", id: "o1", createdAt: REF, type: "campaign_not_delivering",
      severity: "high", detail: "no ad set is delivering",
      businessName: "GelNails", campaignName: "GelNails | Leads", isTest: false,
    };
    const text = formatOps(e);
    expect(text).toContain("Campaign not delivering");
    expect(text).toContain("high");
    expect(text).toContain("no ad set is delivering");
  });
});
