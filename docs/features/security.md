# Security posture

**Status:** live. Audited end-to-end on 2026-08-25 (ad-hoc, no ticket).

**Source of truth:** `server/src/middleware/security.ts` (headers + rate
limits), `server/src/middleware/auth.ts` + `admin.ts` (authn/authz),
`server/src/auth/tokens.ts` + `passwords.ts`, `server/src/db/pool.ts` (TLS).

**Lock-in tests:** `server/src/routes/tenant-isolation.integration.test.ts` —
the guarantee below, written as real cross-tenant HTTP requests;
`server/src/middleware/security.test.ts`.

---

## The guarantee

> Customer A can never, by intent or by API bug, touch customer B's ads, and no
> customer can change anyone's budget — including their own.

**How it is enforced, everywhere, without exception:** a customer route never
takes the acting customer from the request. It resolves it from the JWT
(`resolveCampaignId` / `resolveBuilderContext` / `resolveAdditionContext`) and
then treats every client-supplied identifier as hostile until proven to belong
to that customer:

| Identifier from the client | Proven by |
| --- | --- |
| Meta ad / ad-set id | `assertOwnedByCampaign` — lists the caller's own campaign's children and membership-tests |
| `localCampaignId` | `ownsLocalCampaign` — `WHERE id = $1 AND customer_id = $2` |
| recommendation id | fetched, then `rec.campaignId !== campaignId` → 404 |
| pending addition id | scoped to the caller's campaign |

The isolation test is deliberately built on a Meta mock where **every write
succeeds**, so nothing but our own refusal can stop a cross-tenant write. An
earlier version of that mock returned the victim's ad for *every* campaign id —
which made the ad genuinely the attacker's as far as the ownership check could
tell, and turned five correct refusals into apparent 200s. A permissive mock
does not prove isolation; it manufactures ownership.

**Budget.** There is no customer-facing budget write anywhere. `/budget-request`
records a request for an operator to action. Budget changes come from the admin
console or the engine's safe-execute pipeline, never from a customer request.

## What was wrong, and is now fixed

**TLS to the database was unauthenticated.** The pool passed
`rejectUnauthorized: false`, under a comment claiming it made us "accept the
provider's chain-trusted certs" — the exact opposite of what the flag does. It
disables verification entirely: any server presenting any certificate was
trusted, so a man-in-the-middle on the path to the database could read and
rewrite every query — every customer's ads, budgets and password hashes.
Verified against the real production instance before changing it: full
verification connects fine, because Neon serves a normal publicly trusted
certificate. There was never a reason to disable it.

`sslmode` is now stripped from the URL rather than left to
pg-connection-string, which both silences its deprecation warning and removes a
real hazard: `require` currently means verify-full and is scheduled to **weaken**
to libpq semantics in pg v9. A security posture that changes on a dependency
bump is not one to inherit.

**No rate limiting on authentication.** Unlimited password attempts are two
problems: an attacker can grind credentials, and each attempt costs *us* a
bcrypt-12 hash, making login a CPU-exhaustion vector against the server.
Fixed-window, per-IP, per-route: login 10/15min, signup 5/hour, change-password
10/15min. Per-IP matters — a shared bucket would turn one brute-force attempt
into a denial of service against every other customer.

`trust proxy` is set to **1**, not `true`. Railway forwards the client IP, so
without it every request in the world shares one bucket; with `true`, Express
trusts a client-supplied header chain and an attacker spoofs a fresh IP per
request and bypasses the limiter entirely.

**No security headers.** Now: CSP, `X-Frame-Options: DENY`, `nosniff`,
`Referrer-Policy`, `Permissions-Policy`, and HSTS **only over TLS** (setting it
on a local http response pins localhost to https in the developer's browser for
six months). `'unsafe-inline'` is present for **style only** — the app styles
through React `style={{…}}` props, which CSP3 treats as inline styles — and a
test asserts it never leaks into `script-src`, where it would stop the CSP being
an XSS control at all.

**JWT.** The algorithm is pinned on both sides. jsonwebtoken v9 already refuses
`alg: none`, so this is not the classic bypass — it is that a verifier which
accepts whatever the token claims to be has no business being a security
boundary, and pinning makes that independent of library defaults. The secret is
also length-checked (≥32): a short HMAC secret can be brute-forced offline from
a single captured token, and every session in the product is one signature.
Production's secret was confirmed to satisfy this **before** shipping the check,
by signing a token for a nonexistent user id and observing `/me` answer 404
(valid signature, unknown user) rather than 401 — parity without authenticating
as any real person.

## Checked and found sound

- **SQL injection** — every query is parameterised; no string interpolation into
  SQL anywhere in `server/src`.
- **Admin authorisation** — `adminRouter` and `adminBuilderRouter` each apply
  `requireAdmin` at router level. Fail-closed: no credential, no access, in any
  environment. Admin is a per-user role, not a shared secret; the optional
  break-glass `ADMIN_TOKEN` is unset by default and compared with
  `timingSafeEqual`.
- **XSS sinks** — no `dangerouslySetInnerHTML`, `innerHTML` or `eval` in the web
  app; React escapes by default.
- **Password storage** — bcrypt, 12 rounds.
- **Error leakage** — raw exception messages reach the client only on admin
  routes. Customer routes return fixed strings.
- **Upload** — memory storage with a byte limit.
- **CORS** — defaults to localhost, and the SPA is same-origin, so no
  cross-origin browser access is granted in production.

## Second pass — what the first pass did not look at

The first pass covered authn/authz, tenant isolation, transport and injection.
It did **not** look at dependencies, timing side channels, or resource limits.
Doing that turned up:

**User enumeration by timing (fixed).** `login` returned immediately on an
unknown email and paid ~100ms of bcrypt on a known one, so response time
answered *"does this address have an account here?"* to anyone willing to time
it — worth money to a competitor and a ready-made target list for phishing. The
miss path now hashes against a fixed dummy digest so both branches cost the
same. The code's own comment had described this fix as *"would be ideal… kept
simple for P0"*, which is how a known gap becomes a permanent one.

**Two moderate dependency advisories (assessed, not exploitable here).**
`react-router` 6.30.6 carries an open-redirect via backslash in `<Link>` /
`useNavigate`, and arbitrary constructor injection in SSR hydration. Neither is
reachable in this app: every navigation target is a literal path prefix plus an
id from our own database — there is no user-controlled destination anywhere —
and the app is client-only, so the hydration path does not exist. `npm audit
fix` cannot resolve them without the v7 major, so this is scheduled work rather
than an incident. **Worth re-checking whenever a user-supplied redirect is
added**, which is exactly what would make the first one live.

## Known gaps

- **Rate limits are per-instance and in memory.** Correct for one Railway
  instance; the moment this scales horizontally the limits multiply by the
  instance count and must move to a shared store.
- **Sessions cannot be revoked.** A 30-day JWT stays valid after a password
  change or a role change. A deleted user is stopped by the lookups that follow,
  but an *admin demoted* mid-session keeps admin until their token expires.
  Fixing it properly means a token version or a session table.
- **No CSRF tokens** — not currently exploitable, because auth is a `Bearer`
  header rather than a cookie, so a cross-site form cannot carry the session.
  This stops being true the day auth moves to cookies.
- **No audit trail on reads.** Writes are logged (`action_history`,
  `admin_audit_log`); an operator reading a customer's data leaves no trace.
- **Signup confirms whether an email is registered.** Unavoidable while signup
  reports "email already registered"; the alternative (always claim success and
  send a mail) needs an email pipeline this product does not have.
- **Uploads buffer up to 200 MB in memory** (`multer.memoryStorage`). A handful
  of concurrent large uploads is a memory-exhaustion vector against a single
  instance. Disk or streaming storage would remove it.
- **React Router 6 → 7** to clear the two advisories above.
- **Dependency scanning is not automated.** `npm audit` had never been run
  before this pass; nothing in CI would report a new advisory.
