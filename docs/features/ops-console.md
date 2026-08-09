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

The web console is a **nav shell** (AIC-43) under **`/admin`** —
`web/src/admin/AdminShell.tsx` (a right-side sidebar, reusing the customer app's
shell CSS, AIC-40) + `AdminSidebar.tsx`, wrapping the section routes:

| Route | Screen | Status |
| --- | --- | --- |
| `/admin` | `AdminOverview.tsx` — fleet snapshot + global search | live (AIC-43) |
| `/admin/customers` | `AdminCustomers.tsx` — needs-attention queue + all customers + drill-down (readout + review) | live (carried over from the pre-shell single dashboard) |
| נתוני Meta (Meta explorer) | full internal per-audience/per-ad data | disabled "בקרוב" — AIC-45 |
| המלצות (recommendations oversight) | all recs, all customers | disabled "בקרוב" — AIC-46 |
| מפעילים (operators + audit) | operator accounts + admin action log | disabled "בקרוב" — AIC-47 |

(The old `/admin/ops` + `/admin/readout` routes now redirect to
`/admin/customers`, where that content lives.) `AdminGate.tsx` gates on the
**signed-in user**: it calls `GET /auth/me` and renders only when
`user.isAdmin` — otherwise it prompts to sign in with an admin account. `api()`
sends the customer JWT for `/admin/*` (a break-glass admin token still wins if
one was set). To grant admin: `UPDATE app_users SET is_admin = true WHERE
lower(email) = '…'`.

Tests: `admin.test.ts` (unit — admin JWT allows, non-admin 403, missing 401,
break-glass), `admin-auth.integration.test.ts` (real route, admin vs non-admin vs
no token).

## Fleet overview (AIC-43)

`server/src/services/fleet-overview.ts` `buildFleetOverview(pool)` →
`GET /api/admin/overview`. Two honestly-separated halves:

- **Operational** (campaigns-by-status, delivering vs needs-attention —
  `managed_campaigns.delivery_ok`, AIC-39 — spend/leads for the current rolling
  window, open ops-queue depth): covers **every** managed campaign, including
  internal/dogfood ones — the operator watches those too.
- **Billing/conversion** (via the existing `conversionSummary`, AIC-19):
  excludes test customers, so MRR-adjacent numbers never count an account that
  was never going to pay. At current scale (Pisga dogfood only) this correctly
  renders "no real paying customers yet" rather than a fabricated number.

**Global search**: a text input on the Overview filters the already-fetched
customer list (business name + campaign name) client-side and links to
`/admin/customers?focus=<id>`, which `AdminCustomers` reads on mount to
auto-select and open that customer's drill-down.

Tests: `fleet-overview.integration.test.ts` (aggregation across statuses/
delivery/spend/queue; test-customer exclusion from conversion; auth).

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
