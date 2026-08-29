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
