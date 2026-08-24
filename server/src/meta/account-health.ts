// AIC-72: is the AD ACCOUNT itself able to spend?
//
// The failure this exists to catch: an account-level billing or policy problem
// — a declined card, an unsettled balance, a risk review, a disabled account.
// Every object-level check stays green. The campaign is ACTIVE, the ad sets are
// ACTIVE, the ads are ACTIVE, delivery-health sees no problem with any of them,
// and nothing is delivering because the ACCOUNT cannot spend. Insights simply
// go quiet, which is indistinguishable from "a bad week" until someone looks at
// the account in Ads Manager.
//
// This is the third variant of the same shape the last two tickets fixed:
// tracking-health (the lead count is wrong), cta-health (the button goes
// nowhere), and now this (the account can't pay). In each, every signal we had
// read healthy while the campaign was worthless.
//
// A config read, not a statistical one — same reasoning as its two siblings:
// exact, needs no spend, no attribution lag, and it fires on a paused campaign.

// Meta's documented account_status values. Only ACTIVE can spend normally;
// GRACE_PERIOD still delivers but is a payment failure already in progress, so
// it is a problem to raise now rather than after delivery stops.
const STATUS: Record<number, string> = {
  1: "ACTIVE",
  2: "DISABLED",
  3: "UNSETTLED",
  7: "PENDING_RISK_REVIEW",
  8: "PENDING_SETTLEMENT",
  9: "IN_GRACE_PERIOD",
  100: "PENDING_CLOSURE",
  101: "CLOSED",
};

// Why Meta disabled it, when it says. Turns "status 2" into something an
// operator can act on without opening Ads Manager to guess.
const DISABLE_REASON: Record<number, string> = {
  0: "none",
  1: "ads integrity policy",
  2: "ads IP review",
  3: "risk payment",
  4: "gray account shut down",
  5: "ads AFC review",
  6: "business integrity RASR",
  7: "permanent close",
  8: "unused reseller account",
  9: "unused account",
};

export interface AdAccountHealth {
  adAccountId: string;
  name?: string | null;
  accountStatus: number | null;
  disableReason: number | null;
  // Absent means no payment method on file at all — the account is ACTIVE and
  // still cannot spend a shekel. This is the state a brand-new customer is in
  // before they add a card, and Meta reports it as status 1.
  hasFundingSource: boolean;
  fundingSourceLabel?: string | null;
}

export interface AccountHealthReader {
  getAdAccountHealth(metaAdAccountId: string): Promise<AdAccountHealth>;
}

// Three-valued, same discipline as its siblings: `unknown` is never a soft
// `ok` — a failed read must not clear a real prior alarm.
export type AccountState = "ok" | "broken" | "unknown";

export interface AccountSummary {
  state: AccountState;
  reason: string | null;
  detail: Record<string, unknown>;
}

export function summarizeAccount(h: AdAccountHealth | null): AccountSummary {
  if (!h || h.accountStatus === null || h.accountStatus === undefined) {
    return { state: "unknown", reason: "could not read the ad account", detail: {} };
  }

  const statusName = STATUS[h.accountStatus] ?? `status ${h.accountStatus}`;
  const reasonName =
    h.disableReason && h.disableReason !== 0
      ? DISABLE_REASON[h.disableReason] ?? `reason ${h.disableReason}`
      : null;

  // An unrecognised status is `unknown`, never `broken`. Meta adds values, and
  // flagging every account on an unfamiliar number would be a false alarm on
  // healthy accounts — the same rule cta-health applies to unmodelled
  // destinations.
  if (!(h.accountStatus in STATUS)) {
    return {
      state: "unknown",
      reason: `unrecognised account_status ${h.accountStatus}`,
      detail: { accountStatus: h.accountStatus },
    };
  }

  if (h.accountStatus !== 1) {
    return {
      state: "broken",
      reason: reasonName
        ? `ad account is ${statusName} (${reasonName})`
        : `ad account is ${statusName}`,
      detail: { accountStatus: h.accountStatus, statusName, disableReason: h.disableReason, reasonName },
    };
  }

  // ACTIVE but no card on file: Meta reports status 1, everything looks fine,
  // and the first delivery attempt fails with "Update payment method".
  if (!h.hasFundingSource) {
    return {
      state: "broken",
      reason: "ad account has no payment method on file",
      detail: { accountStatus: 1, statusName, hasFundingSource: false },
    };
  }

  return {
    state: "ok",
    reason: null,
    detail: { accountStatus: 1, statusName, fundingSource: h.fundingSourceLabel ?? null },
  };
}
