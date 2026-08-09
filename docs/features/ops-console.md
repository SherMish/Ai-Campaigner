# Ops console (internal)

**Status:** in progress — the operator surfaces. AIC-16 (customers view) done;
needs-attention queue (AIC-17), first-campaign review (AIC-18), billing +
lead-quality (AIC-19), customer CRUD + admin audit log (AIC-44), and the full
Meta data explorer (AIC-45) extend this doc.

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
| `/admin/meta` | `AdminMeta.tsx` — full Meta data explorer (see below) | live (AIC-45) |
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

## Customer CRUD + admin audit log (AIC-44)

AIC-16 was read-only. `server/src/services/customer-admin.ts` adds the write
side the operator actually needs for manual onboarding and support:

- **Create** — `createCustomer(pool, actor, fields)`: business info only (no
  subscription/connection/campaign — those are provisioned separately, once a
  customer is onboarded).
- **Edit** — `updateCustomer(...)`: any business field, plus an optional
  `agreedBudgetAgorot` which (when a managed campaign exists) is written
  straight to `managed_campaigns.agreed_budget_agorot` — the SAME column
  `execution/budget.ts` reads live on every safety check, so a budget edit
  propagates to the engine's spend limit immediately, no cache to invalidate.
- **Deactivate / reactivate** (`customers.is_active`, `deactivated_at` —
  migration 016) — the default, reversible path for a churned/paused account.
  Deactivating ties into AIC-14's emergency controls: if a managed campaign
  exists, it's marked `unmanaged`, which already excludes it from
  `listEligibleForGeneration` (stops monitoring/generation) and makes
  `ControlService.assertExecutable` throw (stops execution). Reactivating flips
  `is_active` back but deliberately does **not** auto-resume the campaign —
  resuming ad spend is a separate, explicit operator decision via the
  campaign's own controls.
- **Hard delete** — `deleteCustomer(...)`: the rare, deliberate exception.
  Gated by a server-side confirm-to-type check (`confirmText` must equal the
  business name exactly) — enforced in the service itself, not just the UI, so
  a bypassed client can't skip it. A real `DELETE FROM customers`, which
  cascades to subscriptions/meta_connections/managed_campaigns and everything
  under them (migrations 002–015). **Never touches Meta** — we stop managing
  the customer's assets, we do not delete them. `app_users.customer_id` is
  `ON DELETE SET NULL`, so a deleted customer's login survives, just unlinked.

**Admin audit log** (`admin_audit_log`, migration 016;
`server/src/services/admin-audit.ts`): append-only, distinct from
`action_history` (AIC-15, which logs *Meta* changes) — this logs *console*
actions: who (`actor_user_id` + a snapshotted `actor_label` email, so the
entry reads even if the admin account is later removed), what (`action`, e.g.
`customer.create`/`.edit`/`.deactivate`/`.reactivate`/`.delete`), which entity
(`entity_type`/`entity_id`/`entity_label`), before→after (`before_state`/
`after_state` JSONB), when. `entity_id` is deliberately **not** a foreign key
— a hard-deleted customer's audit trail is the one record that must survive
the delete it's describing; `deleteCustomer` snapshots the full row (+
subscription/connection/campaign) into `before_state` before deleting. AIC-44
ships `logAdminAction`/`listAuditLog` and a per-customer read
(`GET /admin/customers/:id/audit`, rendered as a trail in the customer detail
panel); AIC-47 builds the operator-account management surface and the full
cross-entity filterable audit UI on top of the same table.

Routes: `POST /admin/customers`, `PATCH /admin/customers/:id`,
`POST /admin/customers/:id/deactivate`, `POST /admin/customers/:id/reactivate`,
`DELETE /admin/customers/:id` (body `{ confirmText }`),
`GET /admin/customers/:id/audit`. Web: `AdminCustomers.tsx` — a "+ לקוח חדש"
create form, an inline edit form on the selected customer (reusing the same
field set), deactivate/reactivate + a destructive delete modal with the
confirm-to-type input, a search box + active/deactivated filter over the
roster (client-side, matching the Overview global search's pattern — fine at
current scale), and the full record (business + contact + subscription +
lead-quality + condensed action-history + the audit trail) in the drill-down.

RLS was intentionally not added to `admin_audit_log`/the new `customers`
columns: this is Neon, not Supabase — per the project's Key Decisions, authz
here is API-layer (`requireAdmin`, fail-closed) the same as every other admin
table, not Postgres RLS.

Tests: `customer-admin.integration.test.ts` (create; edit + budget
propagation to `managed_campaigns`; edit on a missing customer 404s;
deactivate marks the campaign unmanaged and is reversible without
auto-resuming it; delete rejects a mismatched confirm text and leaves the row
intact; delete on a correct confirm-to-type cascades the related rows AND
survives in the audit log with a `before_state` snapshot; a full HTTP round
trip create→edit→deactivate→reactivate→audit→delete attributed to a real
admin actor; 401 without an admin credential).

## Full Meta data explorer (AIC-45)

The unrestricted internal deep view — the exact opposite of the customer's
opt-in audience view (AIC-37, which shows a human label and 3 numbers). Where
AIC-37 hides CPM/CTR/CPC/reach/frequency/rankings (PRD §14), this shows all of
them, for every node: campaign → ad set → ad → creative.

`server/src/meta/explorer.ts` (`GraphExplorerReader`, its own small Graph API
client — deliberately not grown onto `GraphCampaignAdapter`, the safe-execute
reader/writer, since this asks for a much wider read-only field set and
carries no write capability) fetches, in parallel: the campaign object
(budget/bid strategy/effective status), all ad sets (targeting, budget, bid
strategy, `issues_info`), all ads (creative, `issues_info`), and Insights at
all three levels with the full field set (`spend, impressions, reach,
frequency, cpm, ctr, cpc, actions, quality_ranking, engagement_rate_ranking,
conversion_rate_ranking`). `server/src/services/campaign-explorer.ts`
`buildCampaignExplorer(pool, campaignId, opts?)` resolves the managed
campaign's `meta_campaign_id`, builds the reader from
`META_SYSTEM_USER_TOKEN` (or takes an injected `ExplorerReader` — how the
tests drive it without a live Meta call), and degrades **honestly** via
`unavailableReason` rather than a 500 or a fabricated tree:
`no_meta_campaign` (not linked yet), `no_token` (Meta not configured — the
same honest-unavailable pattern as `buildCustomerExecutor`), `meta_error`
(a real Graph API failure, with `errorDetail`).

**Fetch-on-demand, not stored.** Every open of `/admin/meta` (or its
"רענון מ-Meta" refresh button) is a fresh live read — nothing is cached at
rest, no new table. This is the deliberate single exception to "never a live
Meta call at render time" (the rule the rest of this doc follows, AIC-7):
that rule protects the surfaces on the normal navigation path (customer app,
fleet overview) from depending on Meta being up; this surface is the raw
diagnostic view, gated behind an explicit operator action, at the scale of
one operator on 1–2 accounts — "fine for few operators," the ticket's own
framing. Read-only: any change still goes through the safe-execute pipeline
(AIC-12), never from here.

**Flexible/dynamic creatives.** A creative can be a fixed single image/video
(`object_story_spec`) or a "flexible"/dynamic one (`asset_feed_spec`, several
images/videos/bodies/titles Meta mixes per impression) — `normalizeCreative`
recognizes the second shape and surfaces it as a labeled asset-count summary
instead of rendering it as a broken/empty creative.

Web: `web/src/admin/AdminMeta.tsx` at `/admin/meta` (nav item now live,
`AdminSidebar.tsx`). A tab picker over customers with a managed campaign
(hidden when there's only one); the selected campaign's full tree — budget/
bid strategy/status header, a dense 12-metric grid at campaign level, then
one card per ad set (targeting, budget, bid strategy, issues in red when
present) each with its ads (creative preview or the flexible-asset summary,
issues, the same 12-metric grid). `AdminCustomers.tsx`'s customer drill-down
links straight in via `?campaign=<id>` ("נתוני Meta המלאים ←").

Route: `GET /admin/campaigns/:id/explorer`. Tests: `explorer.test.ts` (pure
normalizers — metrics/targeting/creative, including the flexible-creative
shape), `campaign-explorer.integration.test.ts` (DB + HTTP: missing campaign,
`no_meta_campaign`, `no_token`, a full tree via an injected fake reader with
one healthy and one errored ad set, `meta_error`, auth).

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
