# Meta connection & access-loss detection

**Status:** live (code) — the backend representation of "we can manage this
customer's account," with continuous detection of access loss (AIC-5). The
live-against-Pisga row and true revocation-in-Meta test are gated on a real
System User token (see [META_SETUP.md](../META_SETUP.md)) and AIC-1.

**Source of truth:**
- Client + fake: `server/src/meta/client.ts` (`GraphMetaClient`, `FakeMetaClient`)
- Error classification: `server/src/meta/errors.ts`
- Persistence: `server/src/meta/connection-store.ts` (`PgConnectionStore`, `InMemoryConnectionStore`)
- Service: `server/src/meta/connection-service.ts` (`ConnectionService`, `assertExecutable`, `AccessHaltedError`)
- Customer copy: `web/src/strings.ts` (`connection`, `connectionMessage()`)

**Lock-in tests:** `server/src/meta/errors.test.ts`,
`server/src/meta/connection-service.test.ts` (unit),
`server/src/meta/connection-store.integration.test.ts` (DB, self-skips without
`DATABASE_URL`).

---

## How it works today

**Access model.** The customer grants our Business partner access to their assets
(ad account, + Page/IG for creatives); we assign them to our System User; the
backend operates them with the System User token via the Bearer header (never in
the URL). No customer OAuth in P0.

**Verifying access.** `ConnectionService.verify(connectionId)` checks each granted
asset through the `MetaClient`, folds the per-asset results into one health with
`worstHealth` (ok only if *every* asset is ok; the most specific reason wins), and:
- **unchanged** → refreshes `last_verified_at`, no ops item;
- **changed to a loss** → persists the new `access_health`, and raises **one**
  `meta_connection_failure` ops-queue item (high severity) with an internal detail
  string. Re-running while still lost does not duplicate the item.

**Health values.** `ok` · `revoked` (asset grant removed/downgraded — permission
error codes) · `invalid` (token dead/expired — Graph code 190; fix is token
rotation) · `needs_reconnect` (an access failure Meta *did* answer, but that we
cannot classify further). The mapping lives in `classifyGraphError` so on-read
and scheduled checks agree.

### "I could not ask" is not "the answer is no" (AIC-150)

A fifth outcome, `unknown`, exists in the code and **never** in the database.
It is returned when we did not get an answer about access at all:

| situation | outcome |
| --- | --- |
| transport failure (`fetch failed`, DNS, timeout) | `unknown` |
| Meta 5xx | `unknown` — Meta being broken says nothing about our grant |
| rate limited (429, codes 4/17/32/613) | `unknown` — we asked too often, that is all |
| any other 4xx | `needs_reconnect` |
| code 190 / permission codes | `invalid` / `revoked` |

`ConnectionService.verify` folds only the checks that answered. If any check is
`unknown` and no definite check is worse than `ok`, **nothing is written** — not
the health, and not `last_verified_at`, which would claim a verification that
never happened. The previous answer stands and we re-ask next tick. A definite
non-ok still wins immediately: knowing the Page grant is gone is knowledge,
whatever happened to the other call.

**Why this matters more here than in the other health checks.** `needs_reconnect`
is not a log level — it routes `deriveHomeState` to `attention`, so the customer
sees "איבדנו גישה לחשבון Meta" and a reconnect CTA, it raises a high-severity
alert, and it halts execution. A single `fetch failed` did all three to a real
customer on 2026-08-27.

**The mirror bug, caught by the compiler.** Adding `unknown` to the type
immediately failed `worstHealth`, revealing that an unrecognised value scored
*below* `ok` — so an unreachable ad account would have quietly cleared a real
prior revocation. A false all-clear is the same bug pointing the other way, and
only the type surfaced it.

**Known gap.** A blip is now silent, which is right; sustained failure should
not be. Alerting after N consecutive unverifiable ticks needs a counter and is
deliberately not built.

**Execution halt (safety rule, P0.3).** `assertExecutable(connectionId)` throws
`AccessHaltedError` unless persisted health is `ok`. The execute pipeline calls it
before any spend/delivery change, so access loss stops writes immediately. It
reads persisted health (cheap), not a live call.

**Customer-facing.** The server exposes only the `access_health` value; the client
maps every non-`ok` state to the same plain-Hebrew reconnect prompt via
`connectionMessage()` — no Meta jargon ("revoked"/"OAuth") ever reaches the
customer.

## Not done here (gated on credentials)
- Establishing Pisga's connection as the first real row, and testing a real
  revocation in Meta, need a live System User token + assigned assets (AIC-3
  operator steps) and the AIC-1 access-tier result. The code path is exercised by
  the fake client + DB integration test; swapping in `GraphMetaClient` with a real
  token is the remaining step.
- The scheduled health check is wired by the ingestion scheduler (AIC-6); this
  ticket provides the on-read `verify()` it calls.

---

## Customer-facing OAuth (AIC-186)

**Status:** built, shipped behind `META_OAUTH_ENABLED`. The manual partner-share
path above is unchanged and remains the only one that works for a customer
without a role on our Meta app — see "What is still blocked" below.

**Source of truth:**
- Dialog + env: `server/src/meta/oauth-config.ts`
- State: `server/src/meta/oauth-state.ts`
- Token at rest: `server/src/meta/token-crypto.ts`
- Meta calls: `server/src/meta/oauth-exchange.ts`
- Persistence: `server/src/meta/oauth-store.ts`
- Routes: `server/src/routes/meta-oauth.ts`
- Customer copy: `web/src/strings.ts` (`onboarding.oauth*`), `web/src/app/Onboarding.tsx`

**Lock-in tests:** `oauth-config.test.ts`, `oauth-state.test.ts`,
`oauth-exchange.test.ts`, `token-crypto.test.ts`,
`oauth-store.integration.test.ts` (DB, self-skips without `DATABASE_URL`).

### The flow

```
customer (signed in)
  → POST /api/meta/oauth/start          authed; returns a URL, does not redirect
  → facebook.com/v21.0/dialog/oauth     config_id 2135474130384425
  → GET  /api/meta/oauth/callback       unauthed; identity comes from `state`
  → /app/onboarding?meta=connected
```

### Why `state` carries identity

Our session is a JWT in an `Authorization` header. **A browser sends no
`Authorization` header on a top-level navigation**, so neither the redirect out
nor Meta's redirect back can be authenticated the usual way. The customer's
identity therefore has to travel inside `state`, which makes that parameter
load-bearing in a way the usual "CSRF nonce" framing does not cover. It resists
three separate attacks, by three separate mechanisms:

| attack | defence |
| --- | --- |
| forge a state for another user | HMAC-SHA256 over `(nonce, userId)`, domain-separated from session tokens |
| replay a captured callback URL | the nonce is spent by a single `UPDATE … WHERE spent_at IS NULL AND expires_at > now()` |
| redeem an abandoned consent later | 15-minute TTL, enforced in the same predicate |

The spend is one statement on purpose. `SELECT`-then-`UPDATE` is the same code
with a race in it, and the race is "two concurrent callbacks both succeed" —
covered by a test that fires both at once and asserts exactly one wins.

Missing, already-spent and expired all return the **same** message. Telling them
apart tells an attacker which nonces are real.

### Token type, and why not a user token

The configuration issues a **System User access token**: it does not expire. A
user access token lasts 60 days and dies on a password change, which for a
product whose ingestion runs at 03:00 means every customer silently stops being
managed twice a year.

Tokens are stored **AES-256-GCM encrypted** under `META_TOKEN_ENC_KEY`
(`token-crypto.ts`). GCM rather than CBC because it authenticates: a tampered
ciphertext fails to decrypt instead of decrypting to garbage we would then send
to Meta as a Bearer credential. The key is checked at `/start`, not at the
callback — discovering we cannot store a token *after* the customer has granted
access means throwing away a real consent.

### What a grant must contain

`completeOauth` verifies before persisting anything:

- `debug_token` reports the token valid, and carries all six required scopes
  (`ads_management`, `ads_read`, `business_management`, `pages_show_list`,
  `pages_read_engagement`, `pages_manage_ads`). `instagram_basic` is **wanted,
  never required** — many customers have no Instagram business account.
- at least one ad account, and at least one Page.

A customer can complete Meta's dialog having declined an asset, and the token
comes back perfectly valid and unusable. Checking here means the failure is
reported at connect time, naming what is missing, instead of surfacing as a
permission error during a 3am tick.

### Adoption: every campaign, none automated

Discovery reads **every** campaign on the granted ad account into
`managed_campaigns`, so the AIC-186 switcher shows the customer their whole
account rather than one campaign an operator picked.

Every adopted campaign is written with **`automation_enabled = false`**, and the
column defaults to `true`, so it is set explicitly on every insert.

This is the live-account safety boundary in schema form. Reading a customer's
existing campaigns is **observation**; letting the engine change them is an
**action they have not asked for**. The two must never be the same act. Turning
automation on stays a deliberate, per-campaign decision.

The whole landing — connection, ad account, every campaign — is one
transaction. A connection carrying three of a customer's five campaigns is worse
than no connection, because the switcher would silently omit their work.

### Which step a new user lands on

A user who has just registered has **no customer row at all** — signup writes
`app_users` with `customer_id = NULL`, and `/overview` returns `customer: null`.

`Onboarding.tsx` used to read `customer?.onboardingStatus ?? ""` and fall back to
step "A", so a newly registered user was shown **"מתחילים בשיחת היכרות"** — book
an intro call — and the connect button was unreachable. That is the flow
backwards: connecting is what *creates* the customer, so it cannot require one to
already exist.

`onboarding-step.ts` now answers this, and `null` means **connect**. An
unrecognised *status* still falls back to "A": that is a real customer whose
state we cannot read, and guessing "connect" for someone who may already be
connected is a worse wrong answer than the neutral first step.

### Where a connected customer lands

**The dashboard, not the review step.** Adoption runs before the redirect, so by
the time the customer comes back their campaigns are already in the database.
`campaign_under_review` exists for the operator-provisioned flow, where a human
genuinely inspects the campaign first; nobody reviews a self-serve OAuth
connection, so leaving them there parks them behind a gate that never opens,
reading "there is nothing to do" in front of data they can already see.

So `saveOauthConnection` writes `onboarding_status = 'ready'` and
`oauthReturnUrl("connected")` returns `/app`. The two failure outcomes still go
to `/onboarding`, because that is where the connect button is.

### The customer row

Signup creates an `app_user` with `customer_id = NULL`; a `customers` row has
always been an operator's job. Connecting is the moment the customer becomes
real, so the callback creates one if none exists — otherwise "connect right
after registering" has nothing to attach to. The lookup is `FOR UPDATE` so a
double-submitted callback cannot create two customers for one user.

`business_name` is `NOT NULL` and the business profile has not been collected
yet, so the ad account's own name is used and the customer corrects it at the
profile step.

### Environment

| variable | meaning |
| --- | --- |
| `META_OAUTH_ENABLED` | `"true"` to serve the routes at all. Anything else → 404. |
| `META_LOGIN_CONFIG_ID` | Business Login configuration (`2135474130384425`). |
| `META_OAUTH_REDIRECT_URI` | Must match Meta's whitelist **byte for byte** — Meta compares it as a string between the dialog and the exchange. |
| `META_TOKEN_ENC_KEY` | 32 bytes, base64 (`openssl rand -base64 32`). |
| `APP_BASE_URL` | Where the callback redirects the customer afterwards. |

`META_APP_ID` and `META_APP_SECRET` already exist for the probe.

### What is still blocked (Meta side, not code)

As of 2026-09-10 the app has `business_verification_passes: false` and
`privileges: []` — Advanced Access to nothing, never submitted for review. Until
Business Verification and App Review clear, **this flow works only for people
holding a role on the app** (admin/developer/tester). That is why the flag
exists and why the manual path stays.

### Whose credential (AIC-187)

Every Graph call in the product resolves its credential through
`server/src/meta/token-resolver.ts`, never from the environment directly:

| connection | credential |
| --- | --- |
| `connected_via = 'manual'` | the shared System User token (`META_SYSTEM_USER_TOKEN`) |
| `connected_via = 'oauth'` | that customer's own token, decrypted |
| no connection row | the shared token — every customer who predates OAuth |

Four entry points, by what the caller happens to hold: `tokenForCustomer`,
`tokenForCampaign`, `tokenForUser`, `tokenForAdAccount`. Answering this in one
place is the point — a site that forgot to ask would fall back to the shared
token and **mostly work**, succeeding for manual customers and failing only for
OAuth ones.

**A failure to decrypt returns null, never a fallback.** Falling back would run
an OAuth customer's account on *our* credential: either a permission error, or —
if we happen to hold partner access as well — a success that hides a broken key.

**The ticks resolve per campaign, inside the loop.** Both the ingestion tick and
the generation tick used to build one client and reuse it for every campaign.
With per-customer tokens that is the worst available bug, because it mostly
works: correct for whichever customer came first, silently wrong for the rest.
`runIngestionTick` therefore takes `ingestionFor`/`connectionServiceFor`
factories rather than instances, and `buildGenerationTick` runs the generation
once per campaign (safe because it holds no cross-campaign state).

Verifying access is the sharpest case: checking an OAuth customer's assets with
our token reports what we cannot see as **revoked** — a false access-loss alarm
that halts execution on a connection that is fine.

**What deliberately keeps the shared token:** the operator scripts that act on
*our own* account (`probe.ts`, `write-test.ts`, `adset-write-test.ts`,
`backfill-orphan-creatives.ts`, `find-campaign.ts`), and `/builder/geo` — Meta's
`/search` is a global reference endpoint that reads nothing belonging to anyone,
so resolving a customer would put a database read on every keystroke of a
location picker.

### Known gaps

- **The wizard's access probe has no OAuth answer.** `probeOrNull` asks about
  membership of OUR business portfolio and OUR System User — questions that only
  exist for a partner-shared connection. For an OAuth customer the three-layer
  check is not wrong, it is inapplicable, and the wizard does not yet say so.
- **The first ad account and Page win.** A customer who grants four ad accounts
  gets the first one. `granted_*` records all of them so a picker can be added
  without re-consent, but no picker exists yet.
- **No revocation webhook.** Access loss is still discovered by
  `ConnectionService.verify` on a tick, not pushed by Meta.
