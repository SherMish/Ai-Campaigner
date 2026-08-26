# Creative context (AIC-78)

**Status:** live. Assembled per customer and shown on the create-ad screen; a
copy of it goes to the ops Telegram channel when a customer opens that screen.

**Source of truth:**
- `server/src/services/creative-context.ts` — assembly + the operator's summary.
- `server/src/services/creative-angle.ts` — which angle a piece of copy takes.
- `server/src/routes/additions.ts` → `GET /app/additions/creative-context`.
- `web/src/app/AddContent.tsx` → `CreativeContextPanel`.
- Business fields: migration 050 (`customers`), captured by AIC-138.

**Lock-in tests:**
- `creative-angle.test.ts` — including the Hebrew substring collisions below.
- `creative-context.test.ts` — the angle picture and the Telegram summary.

---

## What it is

Everything an ad writer — a person today, a generator later — needs to write
copy about **this** business rather than generic marketing filler:

| part | where it comes from |
| --- | --- |
| who it is for (audience, service area, main service) | `customers` columns |
| business facts (offer, differentiators, objections, price, constraints) | `customers` columns, captured in the wizard (AIC-138) |
| whether those facts are worth anything | `summarizeProfile` (AIC-132) |
| the copy that already ran | live Meta read, one per ad, capped at 8 |
| the angle each ad took | classified from that copy |
| what each ad achieved | `insight_snapshots` at ad grain |
| lead quality per ad | AIC-133, where it attributes cleanly |
| market/competitor context | `market: null` — the slot AIC-81/82 will fill |

## Assembled, not stored

The obvious build is a `creative_context` table. It would be wrong. The
business facts are already columns on `customers`, and the ticket asks for the
creative history to be **derived from our own data, not re-entered by hand** — a
table would be a second copy of both, able to disagree with them from the day it
shipped.

The one genuinely new thing is the ANGLE each ad takes, and even that is read
out of the copy at request time rather than written down at launch. That costs a
live Meta read and buys two things a stored tag could not have: it works for ads
created before this existed, and for ads an operator built by hand in Ads
Manager.

## The angle classifier, and why it says "I don't know"

Rules, not an LLM. An LLM would classify more copy — and would also produce a
confident label for an ad that takes no clear angle at all. A tested-angles list
is only useful if it is TRUE, so `classifyAngle` returns `null` the moment the
copy doesn't commit, and the context reports `unclassifiedAds` alongside the
list. Without that number, "we tried price" reads as "we tried everything except
price".

Seven angles: price, speed, experience, trust, outcome, objection, local.
Matching is occurrence-weighted with the headline counted twice — the headline
is the ad's actual claim; the body can wander.

### Hebrew substring collisions

Hebrew glues prefixes (ו/ב/ל/ה/מ/ש/כ) onto words and has no capitalisation, so a
plain substring search finds words inside unrelated words. Both of these were
found by running the classifier over **real live ads**, not imagined:

| term | matched inside | meaning |
| --- | --- | --- |
| `מבצע` (a sale) | `ומבצע שינויים` | *performs* changes |
| `שנות` (years) | `לשנות` | *to change* |

Two defences: a `COLLISIONS` list stripped before counting, and terms chosen to
be unambiguous (bare `שנות` was replaced by the phrase `שנות ניסיון`). The
collisions list is meant to grow from observed failures, never from imagination.

The same live run showed the opposite failure: "עדיין משלמים אלפי שקלים?" is a
price angle in every sense and matched nothing, because the vocabulary lacked
the words Israeli small businesses actually use for cost — משלמים, לשלם, שקלים,
ריטיינר.

## Attempted is not the same as tested

The first version reported `angles: price` for an account whose four ads had
spent **₪1, ₪16, ₪3 and ₪6 between them**, with zero leads. Zero leads at ₪26 is
the *expected* outcome at that spend, not a result — and an angle recorded as
tried-and-failed would be excluded from future proposals **permanently**, on no
evidence at all.

So every angle carries the spend behind it and one of two states:

| state | meaning |
| --- | --- |
| `tested` | the ads carrying it cleared `MIN_CREATIVE_SPEND_AGOROT` (₪150) |
| `attempted` | they did not — we do **not** know whether it works |

The threshold is inherited, not invented: it is the same bar the engine already
requires before it will judge a single creative. Spend is summed **across** the
ads carrying an angle — three ads at ₪60 each is a real test of the angle even
though no single ad clears the bar alone.

`singleAngle` is unaffected by any of this: "every ad you have run argues price"
is a statement about VARIETY and is true whatever they spent. What changes is
whether we may also imply it did not work. The untested wording says both facts:
*every ad argues price, and none of them has had enough budget to know.*

### The window that spend is measured over

Not `store.creativeStats`. That method looks lifetime-ish and in fact returns
each ad's most recent **7-day rolling** row — the right answer for "how is this
ad doing now", the wrong one for "has this angle ever had a fair test". Using it
judged an angle on one week of a campaign's life, and hid a lead: switching to
the summed per-day rows moved the same account from ₪26/0 leads to ₪48/1 lead.

Totals are summed over `insight_snapshot_daily` (never the raw table, which
mixes per-day with overlapping rolling rows — migration 030). Those rows are
retained for `DAILY_LOOKBACK_DAYS` (45), so this is "the last 45 days", not all
time. An older campaign's earliest spend goes uncounted, which can only make the
evidence bar harder to clear, never easier.

## What the screen says

The panel sits at the top of the create-ad screen, above the form. Its headline
is the thing most worth knowing:

> **כל המודעות שרצו עד היום מדברות על מחיר / מבצע. זווית אחרת היא ההזדמנות הכי
> גדולה שיש כאן.**

`singleAngle` is set only when at least two classified ads all take the same
angle. Four ads arguing price are not four tests — they are one test run four
times, and this was true on **two of the three real accounts** the first time it
ran. Framed as an opening rather than a telling-off: the person reading it is
about to write the next ad.

## The Telegram copy

Sent to the ops channel when a customer opens the create-ad screen, because that
is the moment a human can still help. Throttled to one message per customer per
30 minutes, in memory — the screen is opened, abandoned and reopened while
someone writes an ad, and a dozen identical messages would train the channel to
be ignored. A redeploy resetting the throttle costs one extra message, which is
not worth a table.

It is sent **after** the response and inside a `catch`: a notification must never
delay or fail the screen.

Fields are truncated to 160 characters **in the message only**, on a word
boundary — Telegram caps at ~4k and eight full fields would blow it. The API
response, the on-screen panel and anything a generator reads carry the complete
text. Cutting mid-word made a field read as corrupted data, which is why the cut
looks for a nearby space.

## Ownership

Ad ids come from our own `ad_meta` rows for the caller's own campaign, resolved
from the JWT — never from the request. There is no id here for a client to
tamper with, which is what makes this route safe without an extra ownership
assertion.

## Known limits

- **Capped at 8 ads.** One live Meta read each, on a page load. The newest ads
  are the ones worth learning from. `adsRead < adsTotal` is reported so a
  partial read never looks like a customer who ran fewer ads than they did.
- **The angle list is a floor, not a census.** See `unclassifiedAds`.
- **Angles are not tagged at launch.** The ticket describes appending an angle
  when a creative goes live. Reading it back from the copy achieves the same
  list without a capture UI, and works retroactively — but it means an ad whose
  angle is clear to its author and unclear to the rules is counted as unread.
- **No consumer beyond this screen and the ops channel yet.** The copy engine
  (AIC-79) and market-gap analysis (AIC-82) don't exist; the builder's
  recommended defaults (AIC-49) do, and are not wired to this.
