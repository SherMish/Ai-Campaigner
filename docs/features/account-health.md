# Ad-account health — can the account spend at all?

**Status:** live. Runs on every generation tick, before the per-campaign checks.

**Source of truth:** `server/src/meta/account-health.ts`,
`GraphCampaignAdapter.getAdAccountHealth`,
`server/src/services/account-monitor.ts`,
`server/src/db/migrations/045_account_health.sql`, wiring in
`server/src/recommendations/generation.ts`.

**Lock-in tests:** `server/src/meta/account-health.test.ts`,
`server/src/recommendations/rules.test.ts` (`account_cannot_spend` precedence).

---

## The failure it catches

An account-level billing or policy problem: a declined card, an unsettled
balance, a risk review, a disabled account — or simply **no payment method at
all**, which Meta still reports as `account_status: 1` (ACTIVE).

Every object-level check stays green. Campaign ACTIVE, ad sets ACTIVE, ads
ACTIVE, delivery-health content, tracking matched, CTA present. Nothing
delivers, because the *account* cannot pay. Insights go quiet, which is
indistinguishable from a bad week until someone opens Ads Manager.

This is the third variant of one shape, after
[tracking-health](tracking-health.md) (the lead count is wrong) and
[cta-health](cta-health.md) (the button goes nowhere): **every signal we had read
healthy while the campaign was worthless.**

## How it judges

| Condition | Verdict |
| --- | --- |
| `account_status: 1` + a funding source | `ok` |
| `account_status: 1`, **no** funding source | `broken` — "no payment method on file" |
| `2` DISABLED · `3` UNSETTLED · `7` PENDING_RISK_REVIEW · `8` PENDING_SETTLEMENT · `100`/`101` closing | `broken`, named, with `disable_reason` when Meta gives one |
| `9` IN_GRACE_PERIOD | `broken` — still delivering, but a payment failure already in progress; raise it while there is time to fix the card |
| unrecognised status | `unknown` — never `broken` |
| read failed | `unknown` |

`funding_source_details` is requested rather than the bare id: an account with
no payment method omits the object entirely (that's the signal), and the display
string — "Mastercard *1459" — is what lets an operator tell the customer *which*
card to fix.

Meta adds status values, so an unfamiliar number is `unknown`, never `broken` —
the same rule cta-health applies to destinations it doesn't model. And `unknown`
never writes `account_ok`, so a failed read cannot clear a real alarm.

## Where it's cached, and why not on the campaign

On **`meta_connections`**, not `managed_campaigns`. The ad account belongs to the
connection, and one account can back several campaigns; caching it per-campaign
would store the same fact N times and let the copies disagree.

The ops item is raised **without a `campaign_id`** for the same reason — attaching
it to one campaign would imply the others are fine, when every campaign on the
account is equally dead.

## Precedence: above delivery, deliberately

`classifyNoAction` checks `account_cannot_spend` **before** `delivery_blocked`.
A disabled or unfunded account is the *cause* of the not-delivering it would
otherwise be reported as. Reporting "delivery blocked" there sends an operator
to inspect ad sets that are perfectly configured, while the real fix is a card
on the account.

Full order: `account_cannot_spend` → `delivery_blocked` → `tracking_broken` →
`cta_broken` → the evidence gates.

## The one reason the customer must act on

Unlike tracking-health and cta-health — where the fix is ours and the copy says
"we're on it" — **this one is the customer's**. They own the ad account and the
card. So the copy says what to do and does not promise we're handling it, which
would be false and would leave them waiting.

## Known gaps

- **Does not distinguish "will stop soon" from "has stopped".** GRACE_PERIOD is
  reported at the same severity as DISABLED. That is deliberate for now — both
  need the same action — but a softer signal for grace period would be fairer.
- **One extra Graph read per campaign per tick.** The verdict is per-account, so
  campaigns sharing an account re-read it. Cheap at current scale; worth
  batching per connection if the book grows.
