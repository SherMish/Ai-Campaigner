# Lead-event volume — the pixel is alive, but the lead event stopped

**Status:** live. Runs on every generation tick for Pixel-based campaigns.

**Source of truth:** `server/src/meta/event-volume.ts`,
`GraphCampaignAdapter.getPixelEventCounts`,
`server/src/services/event-volume-monitor.ts`,
`server/src/db/migrations/046_event_volume.sql`.

**Lock-in tests:** `server/src/meta/event-volume.test.ts`,
`server/src/recommendations/rules.test.ts` (`lead_event_stopped` precedence).

---

## The gap this closes

[tracking-health](tracking-health.md) compares the campaign's declared lead
definition against its ad sets' Meta configuration. That catches a **wrong or
missing** lead type. It cannot catch a **correctly declared** one whose event
silently stopped firing — a deploy that dropped the pixel call from the
thank-you page, a consent-banner change, a broken form.

Its own doc records this as a known gap, deliberately deferred rather than
papered over. This is that follow-up.

## Why a stats-based signal works here and didn't there

The AIC-88 review rejected a stats-based check because *"the lead event hasn't
fired"* is indistinguishable from *"nobody has converted yet"*. That is true —
and fatal — for a bare zero.

What makes it real is that the signal is **comparative**, and needs both halves:

1. **The pixel is demonstrably alive right now** — other events are firing.
   Rules out "no traffic" and "pixel removed entirely".
2. **The lead event did fire in the earlier window.** Rules out "never worked"
   and "campaign too young".

Only when both hold does a zero mean something *stopped*. Missing either, the
verdict is `unknown` — never `broken`.

## The window length is the whole design

Chosen against real data, not picked. On the live Pisga pixel,
`CompleteRegistration` fired 2/2/8/6 on Aug 18–22 and then zero on the 23rd and
24th while `PageView` kept firing.

- A **2-day** window calls that broken. It is far more likely an ordinary quiet
  stretch.
- **3 complete days** stays quiet, because the 22nd is still inside it.

Three is therefore the default, and the test suite pins that exact sequence —
including an assertion that a 2-day window *would* have cried wolf, so the
reasoning survives someone later "tuning" the constant.

**Today is always excluded.** A partial day under-reads by construction and
would fire this check every morning.

## Verified against the live pixel

The real adapter over 30 days of the real pixel returns `ok`:
`recentLead: 14`, `recentOther: 540`, `priorLead: 11`. The lead event is firing;
no false alarm.

Note the adapter sums per `(day, event)`: `/stats?aggregation=event` returns
buckets **finer than a day** and repeats an event within one. Reading a single
bucket as the day's total would under-report and make a healthy pixel look
stopped.

## What happens when it fires

`managed_campaigns.lead_event_*` is cached; a **high-severity**
`lead_event_stopped` ops item is raised idempotently (reaching Telegram via the
AIC-118 relay); recommendations are suppressed with
`no_rec_reason: lead_event_stopped`.

High severity because leads are still *arriving* — we have simply stopped
counting them, so every number the engine and the customer see is
under-reported, and the engine would read falling leads on a working campaign.

Precedence: `account_cannot_spend` → `delivery_blocked` → `tracking_broken` →
**`lead_event_stopped`** → `cta_broken` → the evidence gates. It sits just below
`tracking_broken` because a misconfigured lead *type* is the more fundamental
error — a stopped event at least means the definition was right.

## Known gaps

- **Only standard Meta events.** The lead action is mapped through
  `standardEventForAction`; a custom conversion has no standard name, resolves
  to `null`, and the check reports `not_applicable`. Guessing there would flag
  every custom-conversion campaign.
- **A drop is not a stop.** It fires only at exactly zero. A lead event that
  fell 90% still reads `ok` — that is AIC-92's territory, not this one.
