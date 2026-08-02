# Ops console (internal)

**Status:** in progress — the operator surfaces. AIC-16 (customers view) done;
needs-attention queue (AIC-17), first-campaign review (AIC-18), and billing +
lead-quality (AIC-19) extend this doc.

**Source of truth:** services under `server/src/services/` + routes in
`server/src/routes/admin.ts` (all behind `requireAdmin`).

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
