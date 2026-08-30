# Metrics definitions

**Status:** live — the lead + CPL definitions every recommendation and every
customer-facing number depend on (AIC-6). Get these right here and the engine is
trustworthy; get them wrong and the whole product's judgment is silently corrupt.

**Source of truth:** `server/src/meta/insights.ts` (extract/compute/normalize),
`server/src/meta/snapshot-store.ts` (storage + period comparison).
**Lock-in tests:** `server/src/meta/insights.test.ts`,
`server/src/meta/ingestion-service.test.ts`,
`server/src/meta/snapshot-store.integration.test.ts`.

---

## Lead (AIC-87: per-campaign, not a global constant)

**The lead definition lives on the campaign, not in code.**
`managed_campaigns.lead_event_types` is an ordered priority list of Insights
`action_type` strings; `extractLeads(actions, priority)` walks it and returns
the **first matching type's summed value — never sums across types** (Meta
often reports the same real conversion under several action-type aliases at
once, so summing would multiply one lead into several).

The **default** — used by every campaign that doesn't set its own — is P0's
original Click-to-WhatsApp shape: the messaging-conversation-started event,
preferring the 7-day-attribution variant when present:

- Preferred: `onsite_conversion.messaging_conversation_started_7d`
- Fallback: `onsite_conversion.messaging_conversation_started`

A **Pixel-conversion campaign** (objective `OUTCOME_LEADS`,
`optimization_goal: OFFSITE_CONVERSIONS`) reports a completely different action
type — e.g. `offsite_conversion.fb_pixel_complete_registration` for a
`COMPLETE_REGISTRATION` custom event. Under the old hardcoded constant this
counted as **zero leads regardless of real performance** (confirmed live: a
real ₪205.06/26-registration campaign ingested as ₪205.06/0 before this fix)
— a working campaign rendered as a catastrophically failing one. Setting that
campaign's `lead_event_types` to its real action type fixes it at the source;
no downstream code (snapshot store, readout, features, rules, outcome
measurement, the whole web layer) needed to change, because all of it already
reasons over an abstract `leads` integer.

**Two independent sites turn raw `actions` into a `leads` count, and both
must read the same per-campaign list** (found while wiring this — a classic
"missed consumer" the same way AIC-70/AIC-75 were):
1. Ingestion (`normalizeRow` in `insights.ts`) — writes `insight_snapshots.leads`,
   which backs the rolling/current window, the range switcher, and the engine's evidence.
2. `GraphCampaignAdapter.getLifetimeTotals` — a live, uncached read backing
   `leads_to_date`/`spend_to_date`, the dashboard's "all time" range, and the
   AIC-67 lead-quality watermark.

**Deliberately not threaded:** the operator explorer (`meta/explorer.ts`)
normalizes an entire ad account's rows in one call across potentially several
campaigns, each with its own definition — threading a single list through it
needs a `Map<metaCampaignId, string[]>` built from `managed_campaigns`, which
is disproportionate for an operator-only diagnostic surface. It stays on the
WhatsApp default; a documented gap, not a silent one. The env-gated `probe.ts`
boot check is account-level (no single campaign's definition applies) and is
explicitly commented as such.

## Cost per lead (CPL)

`CPL = spend / leads`, in **agorot**. When `leads = 0`, CPL is **NULL** — an honest
"no data yet," never a misleading 0 or a divide-by-zero.

## What we store, per grain, per period

At campaign / ad-set / ad / creative grain: `spend_agorot`, `leads`, `cpl_agorot`,
`delivery_status`, plus `impressions` and `link_clicks` kept **internal-only** to
*explain* a recommendation later — never surfaced to the customer (PRD §14). The
full raw row is kept in `raw` JSONB.

### Creative grain

Meta Insights has no native "creative" level. In the standard P0 structure
(1 campaign → 1 ad set → 3–5 ads, each ad = one creative) we **derive** the creative
grain from ad-level rows, labelling by ad name. If a structure ever puts multiple
creatives under one ad, this mapping is revisited.

## Period-over-period

`campaignTotals(campaignId, start, end)` sums campaign-grain rows in a window;
`IngestionService.periodComparison` returns current vs previous (default: the last
complete 7-day window vs the 7 days before it — `rollingPeriods()`).

## Ingestion reliability

The scheduled tick (`runIngestionTick`) processes each managed campaign in
isolation: a Meta error is **caught, logged, and skipped** — a missed pull is
retried next tick, never lost, and never crashes the run. Upserts are **idempotent
per `(campaign, grain, object, period)`**, so a re-run updates in place instead of
duplicating. The scheduler stays **inert until `META_SYSTEM_USER_TOKEN` is set**
(`buildIngestionTick` returns null), so no background job runs against an API it
can't reach.

## Not verified against live yet

The "runs green against Pisga's live campaign, producing real snapshots" criterion
needs a real System User token + a linked campaign (AIC-3 operator steps, AIC-1
access result). The normalization, math, idempotency, and error handling are
covered by unit + DB tests with fixtures; swapping `GraphMetaClient` in with a real
token is the remaining step. Reconciliation vs Ads Manager is tracked in
[features/dogfood-readout.md](features/dogfood-readout.md) (AIC-7).

---

# Analytics — the Mixpanel layer (AIC-28)

Everything above defines what a lead IS. This section is about measuring
whether the PRODUCT works — a separate concern that happens to live in the same
file because both answer "what do we count".

**Status:** funnel wired. The four *operational* metrics AIC-28 also asks for
(human minutes per customer, intervention rate, accounts per operator) are
**not** built — see "Not built yet".

**Source of truth:** `server/src/analytics/mixpanel.ts` (server, the funnel),
`web/src/analytics.ts` (identity + page views). Token: `MIXPANEL_TOKEN` on
Railway, served to the browser through `/api/config`.
**Lock-in tests:** `server/src/analytics/mixpanel.test.ts`.
## The funnel is measured on the SERVER

This is the whole design decision, and it comes from a scar. Pisga's PIS-27:
activation milestones were fired from the UI when a customer *reached a phase*,
so they counted intentions rather than outcomes and over-reported activation
for a month. AIC-28 carries that lesson forward as an explicit requirement —
milestones must reflect real state transitions, reconstructable from source.

So every funnel event is emitted from the code path that performs the
transition, **after** the row is written:

| event | fires where | why there |
| --- | --- | --- |
| `recommendation_generated` | `generation.ts`, after the row exists | not where a rule decides one is warranted |
| `recommendation_approved` | `customer-recommendations.ts`, after `execute()` | carries `execution_outcome` — an approval whose Meta write failed is not the same outcome as one that landed |
| `campaign_launched` | `activate.ts` `markLaunched`, after `launch_approved_at` is set | a customer who clicked approve and hit a Meta failure never reaches here |
| `meta_connection_lost` / `_restored` | `ConnectionService`, on a real health change | `unknown` never reaches it (AIC-150), so a network blip cannot look like a lost connection |
| `page_viewed` | browser (SPA + static) | the one thing the server cannot see |
| `element_clicked` | browser | engagement; label never derived from text |
| `signed_up` / `logged_in` | browser | see "Why signup is a browser event" |

**The value moment is `recommendation_approved`.** Everything upstream exists to
reach it: it is the moment the engine's judgement becomes a real change to a
real campaign, with the customer's consent.

## Three rules the module enforces so call sites cannot get them wrong

**1. Never throws, never blocks.** Analytics failing must never fail a
customer's request. Every call is fire-and-forget inside a catch.

**2. No PII in event properties.** This domain is full of it — customer emails,
contact phones, the WhatsApp number every ad routes to, business names. Event
properties in Mixpanel cannot be selectively deleted; profiles can. So a
pattern-based scrubber drops anything matching
`email|phone|whatsapp|name|address|token|password|secret` and records what it
dropped under `scrubbed_properties`, so the omission is visible rather than
silent. `business_category` and `campaign_objective` are allow-listed
explicitly — they match `/name/` by accident and are legitimate dimensions.

A pattern rather than an allow-list is deliberate: a field added next year that
carries an email is caught without anyone remembering this file exists.

**3. Our own accounts are never counted.** `is_test` already excludes Pisga and
the beta rows from growth stats; analytics honours the same boundary, or our
dogfooding *is* the activation funnel. Threaded explicitly through
`GenCampaign.isTest` and `resolveCampaignOwner` rather than looked up ad hoc.

## Identity

`distinct_id` is the **customer id** — a stable uuid, never an email (emails
change, ids do not). One profile per *business*, which is the subject this
product is actually about: a customer is an account with a campaign, and its
several logins are the same subject. The browser uses the same id, so browser
and server events land on one profile instead of two halves of a funnel that
never join.

`mixpanel.reset()` on logout is not optional. Without it the next person to
sign in on that device inherits the previous customer's `distinct_id` and their
events merge into someone else's profile — a privacy incident, not just bad
data.

## Privacy posture

`ip: false` in the browser init. Customers are Israeli businesses, but the
dashboard is a public URL and we cannot prove no EU resident ever opens it. IP
is the one piece of personal data Mixpanel collects by default and we have no
analytic use for it — dropping it removes the question rather than answering it
with a consent banner nobody wants. If EU customers ever become a real segment,
the answer is `opt_out_tracking_by_default: true` plus a consent gate, not a
retrofit.

The **project token is public by design** — it is embedded in the client bundle
of every site that uses Mixpanel and can only write events, never read them.
Served from `/api/config` rather than baked in at build time so it is set once
as a Railway variable and absent environments simply emit nothing.

## Not built yet (AIC-28 is only half done)

The ticket's four *operational* metrics — human onboarding minutes per
customer, support minutes per customer per month, human intervention rate,
accounts per operator — are **not** instrumented. They are the ones the ticket
calls make-or-break for the unit economics, and none of them can be derived
from product events: they need an operator-entered capture mechanism. The
funnel half shipped first because it needed no new UI.

Also absent: `customer_paid` and `onboarding_completed`. Both are operator
actions in P0 (manual billing, hand-provisioning), so there is no honest code
path to fire them from yet — and inventing one would be exactly the
fireable-phase mistake this design exists to avoid.

## The static surfaces (landing, /guides)

`web/public/analytics.js`, loaded by `landing/index.html` and by every guide.
The guides are generated, so the tag lives in `scripts/build-guides.mjs`'s
shared `head()` — anything hand-added to `web/public/guides` is overwritten on
the next build.

Three things there were found by testing rather than reading, and each would
have shipped silently broken:

**Our own CSP blocked it.** `script-src 'self'` meant Mixpanel's library never
loaded and every call queued forever, with no error. That would have been dead
in production exactly as it was locally. `cdn.mxpnl.com` and the ingestion
hosts are now named explicitly in the CSP — never a wildcard, and pinned by a
test in `security.test.ts`.

**The loader stub picks its URL from the page protocol**, so on http it
requests `http://cdn.mxpnl.com`, which Mixpanel does not serve. We inject the
library over https ourselves so both protocols behave identically.

**The stub and the library are different objects.** When the library loads it
replaces `window.mixpanel` and flushes the stub's queue once. Code holding the
stub afterwards pushes into a queue nobody reads again — the first version did
exactly that, so the page view worked and every click vanished. `send()` now
resolves `window.mixpanel` at call time and never holds a reference.

Payload: Mixpanel's CDN build is 33 KB gzipped; bundling the npm package was
measured at 126 KB (it includes the session recorder). On SEO pages that
difference outweighs the third-party request.

## Why signup is a browser event when the server knows better

Everything else in the funnel fires server-side, so this looks like an
exception. It is not.

At signup there is no customer yet — `customer_id` is NULL until an operator
provisions one — so the server has no funnel identity to attribute it to. The
browser does: the anonymous `distinct_id` that already carries the landing page
and guide visits that led here. Tracking `signed_up` there, **without** calling
`reset()`, is what joins "read a guide" to "became a customer".

`reset()` on **login** is correct for the opposite reason: whoever logs in may
not be whoever used that browser last, and must not inherit their id.

## Click labels never come from element text

In the app, text is customer content — ad headlines, business names, audience
labels. A label is either an explicit `data-track` attribute or a structural
descriptor (`button.btn-primary`, `link:/app/settings`). The cost is that
un-annotated controls report unreadably; the alternative is leaking an ad
headline into an event property that cannot be selectively deleted. Add
`data-track` to the controls worth naming — `hero_launch`, `rec_approve`,
`rec_dismiss`, `creative_context_toggle` already have it.

## Data residency — and why `status: 1` proves nothing

`MIXPANEL_API_HOST` (unset → US). Set it to `https://api-eu.mixpanel.com` or
`https://api-in.mixpanel.com` if the Mixpanel project was created in that
region. The server tracker, the SPA and the static pages all read it, so the
three can never disagree.

**This matters more than it looks, because the failure is invisible.** A
project in the EU region does not ingest on the US host — but the US host still
answers `{"error":null,"status":1}`. Measured while setting this up: **a
deliberately bogus 32-zero token gets exactly the same reply.** `/track` is
fire-and-forget by design; it acknowledges anything well-formed and validates
the token asynchronously.

So a `status: 1` is not evidence that anything landed. The only real
confirmation is seeing the event in Mixpanel's own UI (Events / Live View). If
the project shows "Still listening" while requests are being accepted, the two
candidates in order are:

1. **Region mismatch** — project is EU/India, events are going to US. Fix with
   `MIXPANEL_API_HOST`, no code change.
2. **Wrong project** — the token belongs to a different project than the one
   being watched. Check Project Settings → Access Keys.
