# Ops console (internal)

**Status:** in progress — the operator surfaces. AIC-16 (customers view) done;
needs-attention queue (AIC-17), first-campaign review (AIC-18), and billing +
lead-quality (AIC-19) extend this doc.

**Source of truth:** services under `server/src/services/` + routes in
`server/src/routes/admin.ts` (all behind `requireAdmin`).

## Auth (per-user role, fail-closed)
Admin is an attribute of the **account**, not a shared secret. `app_users.is_admin`
(migration 012) marks admin accounts; `requireAdmin`
(`server/src/middleware/admin.ts`) accepts a valid customer JWT whose user has
`is_admin = true` and sets `req.userId`. No admin credential → **denied, always**
(403 for a valid non-admin, 401 otherwise) — in every environment, never open by
omission (the PIS-26 lesson). An optional `ADMIN_TOKEN` remains as a break-glass
for machine/curl access (matching `Authorization: Bearer <token>`, constant-time);
it's unset by default, so only admin users get in.

The web console is a **single dashboard** at **`/admin`** (`web/src/admin/AdminDashboard.tsx`)
— the needs-attention queue + all customers, with a per-customer drill-down that
folds in the campaign readout (AIC-7) and the first-campaign review action. (The
old split `/admin/ops` + `/admin/readout` routes now redirect to `/admin`.)
`AdminGate.tsx` gates on the **signed-in user**: it calls `GET /auth/me` and
renders only when `user.isAdmin` — otherwise it prompts to sign in with an admin
account. `api()` sends the customer JWT for `/admin/*` (a break-glass admin token
still wins if one was set). To grant admin:
`UPDATE app_users SET is_admin = true WHERE lower(email) = '…'`.

Tests: `admin.test.ts` (unit — admin JWT allows, non-admin 403, missing 401,
break-glass), `admin-auth.integration.test.ts` (real route, admin vs non-admin vs
no token).

---

## Customers view (AIC-16)

`listCustomers(pool)` returns the operator's list with status-at-a-glance
(subscription status, connection health, campaign status, agreed budget, open-rec
count) assembled from the real tables. `getCustomerDetail(pool, id)` adds the full
business info, contact, next-charge date, the outstanding proposed recommendation,
and open ops-item count. Routes: `GET /api/admin/customers`,
`GET /api/admin/customers/:id`. Reads only; role-gated. Source:
`server/src/services/customers.js`. Tests: `customers.integration.test.ts`.

## Needs-attention queue (AIC-17)

`OpsQueue` is the single prioritized worklist over `ops_queue_item` across all
accounts — high severity first, then oldest; resolved items fall away.
`create` is the canonical entry point (support intake, delivery checks; the
connection-health and execution paths already raise items), logging high-severity
ones for the alert hook (Telegram later). Operators triage: `claim` → in_progress
+ claimed_by; `resolve(note)` → resolved + note. Routes: `GET /api/admin/ops-queue`
(`?all=true` includes resolved), `POST /ops-queue`, `POST /ops-queue/:id/claim`,
`POST /ops-queue/:id/resolve`. Source: `server/src/services/ops-queue.js`. Tests:
`ops-queue.integration.test.ts`.

## First-campaign review (AIC-18)

The mandatory human gate before a campaign becomes managed. `submitReview` records
outcome + reviewer + timestamp + the §11 checklist and moves the campaign's status:
`approved` → `active` (we manage + monitor; no Meta change), `unsupported` →
`unmanaged`, `changes_requested` → **stays `under_review`**. The §11 hard rule is
enforced in code: a `changes_requested` campaign is **not** activated/modified until
`recordCustomerDecision(reviewId, true)` records the customer's explicit approval
(which then flips it to `active`); a decline keeps it `under_review`. Routes:
`GET/POST /api/admin/campaigns/:id/review`, `POST /api/admin/reviews/:id/customer-decision`.
Source: `server/src/services/campaign-review.js`. Tests:
`campaign-review.integration.test.ts` (all three outcomes + no-activation-without-
approval).

**Compatibility criteria (AIC-38).** The supported shape is **1 campaign → N ad
sets → 3–5 creatives** (see [DATA_MODEL.md](../DATA_MODEL.md)). A legitimate
multi-ad-set **audience split** (e.g. the GelNails campaign: two ad sets by age,
same creatives) is `approved` and **managed as-is** — it is *not* a reason for
`changes_requested`/"rebuild to one ad set" or `unsupported`. The single-ad-set
ideal is an onboarding *recommendation*, never a compatibility bar. Reserve
`changes_requested`/`unsupported` for genuinely unmanageable structures: wrong
objective (not leads/WhatsApp), no WhatsApp destination, or an unwieldy sprawl of
overlapping ad sets — not a clean 2–3 audience split.

## Manual billing + weekly lead-quality (AIC-19)

**Billing ledger** (no payment gateway): `updateBilling` edits the subscription
(setup paid + date, status, next charge, monthly amount); `conversionSummary` reads
setup→subscription conversion across real (non-test) customers. **Lead quality**
(PRD §20, campaign-level weekly, no per-lead data): `upsertLeadQuality` (idempotent
per campaign+week), `listLeadQuality`, `leadQualityResponseRate` (answered / active
campaigns for a week). Routes: `PATCH /api/admin/customers/:id/billing`,
`GET /api/admin/billing/conversion`, `GET/POST /api/admin/campaigns/:id/lead-quality`,
`GET /api/admin/lead-quality/response-rate?week=`. Source:
`server/src/services/billing.js`. Tests: `billing.integration.test.ts`.

## Web ops console
The operator surfaces above render in `web/src/admin/OpsConsole.tsx` at
`/admin/ops` (customers list, needs-attention queue with triage, per-customer
detail with the review form + billing + lead-quality).
