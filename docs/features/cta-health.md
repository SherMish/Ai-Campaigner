# CTA health — does the ad's button actually go anywhere?

**Status:** live. Runs on every generation tick, alongside delivery-health and
tracking-health.

**Source of truth:** `server/src/meta/cta-health.ts` (`summarizeCta`,
`CtaReader`), `GraphCampaignAdapter.getAdCreativeDestinations`,
`server/src/services/cta-monitor.ts` (`recordCampaignCta`),
`server/src/db/migrations/044_cta_health.sql`, wiring in
`server/src/recommendations/generation.ts`.

**Lock-in tests:** `server/src/meta/cta-health.test.ts` (the judgement),
`server/src/services/cta-monitor.integration.test.ts` (persistence + ops
escalation), `server/src/recommendations/rules.test.ts` (`cta_broken`
suppression and its precedence).

---

## The failure it exists to catch

Found live on a real customer. A Click-to-WhatsApp campaign where:

- the ad set was correctly `destination_type: WHATSAPP`,
  `optimization_goal: CONVERSATIONS`, page set, no issues;
- the creatives reported `call_to_action_type: WHATSAPP_MESSAGE`;
- and the creatives' `call_to_action` was **`{"type": "WHATSAPP_MESSAGE"}` with
  no `value`** — no phone number.

Meta **derives** `call_to_action_type` from the ad set, so every surface we had
said the ad was fine. With no number there is nothing for a tap to open, so Meta
rendered a generic dead button. Delivery-health said delivering. Tracking-health
said the lead definition matched. Insights showed real spend. **Every signal was
green while every click was wasted.** The customer found it before we did and
paused both ads.

The gap is specifically **between the ad set's promise and the creative's
payload**, and only a comparison of the two can see it — which is why this is
its own check rather than an extension of an existing one.

## How it judges

For each ad, compare its ad set's `destination_type` against its creative's
`call_to_action.value`:

| Ad set destination | Needs | Broken when |
| --- | --- | --- |
| `WHATSAPP` | `value.whatsapp_number` | absent or blank |
| `WEBSITE` | `value.link` | absent or blank |
| `UNDEFINED` / null | — | never (engagement / on-platform) |
| `MESSENGER`, `INSTAGRAM_DIRECT`, `PHONE_CALL` | — | never — see gaps |

**Archived and deleted ads are excluded** (`classifyAdState(...) === "gone"`) —
the same AIC-65 rule one level down. Without it, replacing a broken ad and
archiving the original would leave the campaign flagged forever, because Meta
still returns the archived ad on the `/ads` edge: the recommended fix would
never clear its own alert. **`PAUSED` is deliberately still judged** — a paused
ad can be resumed at any time, and it is the exact state the live failure was
found in.

`call_to_action{type,value}` is requested explicitly. Reading the scalar
`call_to_action_type` would return `WHATSAPP_MESSAGE` for the broken ad and hide
the bug entirely; only the nested `value` proves a real destination.

Judgement is on the **ad set's promise**, not on whichever field happens to be
populated — a leftover number on a website ad is not a working button.

### Four states, and why none collapses into another

`ok` · `broken` · `unknown` (no ads read / read failed) · `not_applicable` (no
ad set has a click destination).

`unknown` is **not** a soft `ok` — a failed Meta read must never clear a real
prior alarm, so `recordCampaignCta` advances only `cta_checked_at` and never
writes `cta_ok`. `not_applicable` **is** a settled verdict for an engagement
campaign, so it does clear a stale `broken` flag. Same discipline as
[tracking-health.md](tracking-health.md), which introduced it to fix a real bug
in delivery-health's unconditional write.

## What happens when it fires

- `managed_campaigns.cta_ok/cta_reason/cta_detail/cta_checked_at` are cached.
- A **high-severity** `campaign_cta_broken` ops item is raised — high because
  this is not degraded measurement, it is 100% wasted budget. Raised
  **idempotently** ("broken AND no open item"), not on the ok→broken edge: an
  edge-triggered raise loses the alert permanently if `ops.create` throws after
  the flag write lands, which is exactly how migration 042's bug happened.
- The ops item flows to the Telegram channel automatically via the AIC-118
  relay — no extra wiring, since the relay reads `ops_queue_items`.
- **Recommendations are suppressed** with `no_rec_reason: cta_broken`, including
  the AIC-86 "add more ads" advisory — which would otherwise produce *more* ads
  with the same dead button and bury the real fix.
- The customer's dashboard shows an `attention` hero (`attentionKind: "cta"`)
  saying the button has no destination, that budget is being wasted, and that
  **the fix is ours** — they cannot repair a creative we built, so "check your
  settings" would be both useless and untrue.

Precedence in `classifyNoAction`: `delivery_blocked` → `tracking_broken` →
`cta_broken` → the evidence gates. Fixed order, so a campaign with several
problems always names the same one.

## Known gaps

- **`MESSENGER` / `INSTAGRAM_DIRECT` / `PHONE_CALL` are not judged.** They are
  actionable destinations but their payload shapes are not modelled here;
  judging them on the WhatsApp rule would flag every one of them as broken. A
  false alarm on a working ad is worse than a gap that is written down.
- **It does not verify the number is *correct*** — only that one is present. A
  valid-looking wrong number still passes.
- **Two Graph reads per campaign per tick** (ad sets + ads). Meta will not nest
  ad-set fields under `/ads`, so the join has to happen on our side.

## Zero ads is `not_applicable`, not `unknown` (AIC-130)

Found live, and it made this check's own advice a trap. A customer was told
*"the button in your ad leads nowhere"*, deleted both broken ads — the only fix
available to them — and the alarm **froze**. With no ads left, `summarizeCta`
returned `unknown`; `unknown` deliberately never writes the flag (so a failed
read can't wipe a real alarm); so `cta_ok` stayed false forever, still citing
*"2 of 2 ad(s)"* that no longer existed.

An empty list here always means a read that **succeeded** and found nothing
left to judge — a read that actually fails throws before reaching
`summarizeCta`. That is information, not the absence of it, so the answer is
`not_applicable`, which settles and clears.

This is the same lesson as the archived-ad filter one level down: any state the
customer can reach by following our advice must be a state the check can clear.
