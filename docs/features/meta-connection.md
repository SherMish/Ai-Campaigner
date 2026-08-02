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
rotation) · `needs_reconnect` (unclassified/transient — re-checked next tick).
The mapping lives in `classifyGraphError` so on-read and scheduled checks agree.

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
