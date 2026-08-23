# Ops notifications (Telegram)

**Status:** live in code, **dark until configured** — the relay builds to `null`
and the error forwarder no-ops while `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
are unset, which is the case on every dev machine, in CI, and in production
until the variables are added. See *Setup* below.

**Source of truth:**
`server/src/notify/telegram.ts` (transport),
`server/src/notify/format.ts` (message wording, pure),
`server/src/notify/relay.ts` (the poll loop),
`server/src/notify/error-forwarder.ts` (console/exception forwarding),
`server/src/db/migrations/043_notification_outbox.sql`,
wiring in `server/src/index.ts`.

**Lock-in tests:**
`server/src/notify/format.test.ts` (wording, actors, no fabricated transitions),
`server/src/notify/telegram.test.ts` (no-op when unconfigured, dedupe, rate cap,
truncation, channel routing),
`server/src/notify/relay.integration.test.ts` (sent once and only once, ops-only
action types, failures, the max-age cutover guard, the test-account guard).

---

## How it works today

Two independent paths feed one Telegram channel.

**1. The relay — everything that reaches the database.** A scheduler (its own
loop, every `NOTIFY_INTERVAL_MS`, default 60s) polls the two tables that already
record every meaningful event:

| Table | What it gives the channel |
| --- | --- |
| `action_history` | every change to a campaign, ad or ad set — created, paused, resumed, archived, deleted, budget moved — plus every attempt that **failed** (`result = 'failed'`) |
| `ops_queue_items` | operational alerts: connection failure, not delivering, rejected by Meta, account restriction, unusual performance |

**It reads the tables rather than adding notifier calls at each write site.**
Seven places write `action_history` today. Calling a notifier from each would be
seven chances to forget and an eighth the next time someone adds one. Reading
the table covers every action type by construction — including types added
later, and including the ones deliberately **hidden from the customer's own
feed** (`rollback_build`), which are exactly what an operator wants to see.

The relay reuses `SUMMARY_HE` from `services/action-history.ts` for its labels
rather than keeping a parallel map, so a new action type gets a label in both
places at once. It does **not** reuse `condense()` — that function's whole job
is hiding rows from customers.

**2. The error forwarder — everything that doesn't.** `console.error`,
`console.warn`, uncaught exceptions and unhandled rejections go to the alert
channel. Wrapping the console rather than asking hundreds of call sites to also
notify, for the same reason the relay reads tables. Installed before the server
starts listening, so a boot-time crash is reported rather than only landing in
Railway's logs.

### Delivery guarantees, stated honestly

**At most once.** A row is claimed (`notified_at` stamped) *before* the send, and
a send that fails is logged and not retried. Retrying risks replaying a burst
every minute during a Telegram outage, and the underlying data is still in the
database and the ops console. **The channel is a convenience, never the system
of record** — nothing in the product may depend on a message arriving.

**Why a column and not a timestamp watermark.** The obvious design — one
`last_seen_at`, poll for anything newer — silently loses events: a row's
`occurred_at` is set when the INSERT runs, but the row only becomes visible when
its transaction commits, so a row can appear with a timestamp already behind the
watermark and never be seen. Marking rows individually has no such window.

**Concurrency.** Claims use `FOR UPDATE SKIP LOCKED`, so two instances (or an
overlapping tick) never claim the same row — the same discipline as the Meta
write-outbox.

### What is claimed but deliberately not sent

Three cases, all counted as `skipped` rather than silently dropped:

| Case | Why |
| --- | --- |
| Older than `maxAgeMs` (default 1h) | Protects the cutover. Without it, the first tick after the channel is configured replays months of history and the channel is muted within the hour. The migration also backfills every existing row as already-sent for the same reason. |
| A **test account** (`customers.is_test`) | Local dev and CI point at the **same database as production**, so without this a single `vitest run` posts dozens of fixture rows into the live channel. Found exactly that way: the relay's own test claimed 20 rows written by other test files running concurrently. |
| A campaign that can't be resolved to a customer | An event we cannot attribute to a real customer is not one to page anyone about. |

Only the relay's own tests pass `includeTestCustomers: true`.

### Not flooding

An ops channel nobody reads is the same as no channel. So the transport
deduplicates identical messages within 5 minutes (opt-in: errors ask for it,
the relay does not, because two customers doing the same thing are two real
events) and caps the whole sender at 20 messages/minute with a single
"suppressing" notice per window. The relay is additionally bounded to 25 rows
per pass; the rest wait for the next tick a minute later.

### Message shape

```
🟠 השהיית מודעה
customer: GelNails
campaign: GelNails | Leads | WhatsApp
what: מודעה 120250980671840544
status: ACTIVE → PAUSED
object: 120250980671840544
by: the customer
why: שינוי ידני על ידי הלקוח
```

🔴 failed or high severity · 🟠 something was stopped · 🟢 created or started.
`by:` distinguishes **the customer** / **us (operator)** / **engine
(automatic)** — the same two columns the customer-facing `actorOf()` reads,
said in the ops channel's own words.

`status:` appears only when the row actually recorded a transition.
`previous_state`/`new_state` are free-form JSONB, and a fabricated transition is
the same class of bug as AIC-116/AIC-117: a value that means one thing rendered
as a claim about another.

---

## Setup

The code is live but dark until these are set. Steps 1–3 are yours — creating a
bot and reading a chat id can't be automated from here.

1. **Create the bot.** Message [@BotFather](https://t.me/BotFather) → `/newbot`
   → copy the HTTP API token.
2. **Create the channel or group** and add the bot to it as an administrator
   (a channel needs admin rights to post; a group only needs membership).
3. **Get the chat id.** Post any message in it, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read
   `result[].chat.id` — a negative number, e.g. `-1001234567890`.
4. **Set the variables on Railway** (bare values, no quotes — see
   [META_SETUP.md](../META_SETUP.md) for why that matters here):

   | Variable | Required | Meaning |
   | --- | --- | --- |
   | `TELEGRAM_BOT_TOKEN` | yes | the bot's HTTP API token |
   | `TELEGRAM_CHAT_ID` | yes | destination for changes and ops items |
   | `TELEGRAM_ALERT_CHAT_ID` | no | separate destination for errors; falls back to `TELEGRAM_CHAT_ID`, so one channel works |
   | `NOTIFY_INTERVAL_MS` | no | poll interval, default `60000` |

Nothing older than an hour is replayed when it first turns on, so it is safe to
enable at any time.

## Known gaps

- **No per-event-type filtering yet.** Every action type goes to the one
  channel. If the volume proves wrong in practice, the natural next step is a
  severity or type allow-list read from an env var, rather than editing code.
- **Errors are forwarded verbatim**, including stack traces, and are deduped
  only by exact text. A high-cardinality error message (one carrying an id) will
  not dedupe.
- **No delivery receipt.** A failed send is logged and the row stays claimed, so
  a Telegram outage silently costs those messages. Deliberate — see the
  guarantees above — but it means the channel must never be the only place an
  operational fact appears.
