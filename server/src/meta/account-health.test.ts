import { describe, it, expect } from "vitest";
import { summarizeAccount, type AdAccountHealth } from "./account-health.js";

function acct(over: Partial<AdAccountHealth> = {}): AdAccountHealth {
  return {
    adAccountId: "act_1", name: "Test", accountStatus: 1, disableReason: 0,
    hasFundingSource: true, fundingSourceLabel: "Mastercard *1459",
    ...over,
  };
}

describe("ad-account health (AIC-72)", () => {
  it("a normal active account with a card is ok", () => {
    expect(summarizeAccount(acct()).state).toBe("ok");
  });

  // The case the ticket is named for: ads look ACTIVE, every object-level check
  // is green, and the account cannot spend.
  it("flags a DISABLED account and names Meta's reason", () => {
    const s = summarizeAccount(acct({ accountStatus: 2, disableReason: 3 }));
    expect(s.state).toBe("broken");
    expect(s.reason).toMatch(/DISABLED/);
    expect(s.reason).toMatch(/risk payment/);
  });

  it("flags every non-active billing state", () => {
    for (const [status, name] of [[3, "UNSETTLED"], [7, "PENDING_RISK_REVIEW"], [8, "PENDING_SETTLEMENT"], [100, "PENDING_CLOSURE"], [101, "CLOSED"]] as const) {
      const s = summarizeAccount(acct({ accountStatus: status }));
      expect(s.state, name).toBe("broken");
      expect(s.reason, name).toMatch(new RegExp(name));
    }
  });

  // Grace period still delivers — which is exactly why it must be raised NOW,
  // while there is time to fix the card, rather than after delivery stops.
  it("flags IN_GRACE_PERIOD even though ads are still running", () => {
    const s = summarizeAccount(acct({ accountStatus: 9 }));
    expect(s.state).toBe("broken");
    expect(s.reason).toMatch(/IN_GRACE_PERIOD/);
  });

  // Meta reports status 1 for an account with no card at all. Everything reads
  // healthy and the first delivery attempt fails with "Update payment method" —
  // the exact failure a real customer hit during onboarding.
  it("flags an ACTIVE account that has no payment method on file", () => {
    const s = summarizeAccount(acct({ hasFundingSource: false }));
    expect(s.state).toBe("broken");
    expect(s.reason).toMatch(/no payment method/);
  });

  // unknown is never a soft ok — a failed read must not clear a real alarm.
  it("reports unknown when the account could not be read", () => {
    expect(summarizeAccount(null).state).toBe("unknown");
    expect(summarizeAccount(acct({ accountStatus: null })).state).toBe("unknown");
  });

  // Meta adds status values. Flagging every account on an unfamiliar number
  // would be a false alarm on healthy accounts — same rule cta-health applies
  // to destinations it does not model.
  it("treats an unrecognised status as unknown, never broken", () => {
    const s = summarizeAccount(acct({ accountStatus: 42 }));
    expect(s.state).toBe("unknown");
    expect(s.reason).toMatch(/unrecognised/);
  });

  it("carries the funding source into detail so an operator can see which card", () => {
    expect(summarizeAccount(acct()).detail.fundingSource).toBe("Mastercard *1459");
  });
});
