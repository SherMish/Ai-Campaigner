# Ops console (internal)

**Status:** done — all five console sections are live. AIC-16 (customers
view), needs-attention queue (AIC-17), first-campaign review (AIC-18), billing
+ lead-quality (AIC-19), customer CRUD + admin audit log (AIC-44), the full
Meta data explorer (AIC-45), recommendations oversight (AIC-46), and operator
accounts + the full audit log (AIC-47).

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

**Role tier (AIC-47).** `app_users.admin_role` (migration 018) is `'full_admin'
| 'operator'`, meaningful only when `is_admin = true`. This is **one deliberate
gate, not a general RBAC system**: every admin route stays gated on
`requireAdmin` alone (both roles have identical console access) EXCEPT
operator-account management itself, which additionally requires
`requireFullAdmin` — "only a full-admin can manage operators" was the concrete
AC; building granular per-action permissions (a true "reviewer" read-only
role) across every mutating route was out of scope. The migration backfills
today's `is_admin = true` accounts to `full_admin`, so nobody loses the
ability to manage operators the moment this ships. Both guards live in
`middleware/admin.ts` (`buildRequireAdmin`/`buildRequireFullAdmin`, unit
tested with a fake resolver — no DB in those tests).

The web console is a **nav shell** (AIC-43) under **`/admin`** —
`web/src/admin/AdminShell.tsx` (a right-side sidebar, reusing the customer app's
shell CSS, AIC-40) + `AdminSidebar.tsx`, wrapping the section routes:

| Route | Screen | Status |
| --- | --- | --- |
| `/admin` | `AdminOverview.tsx` — fleet snapshot + global search | live (AIC-43) |
| `/admin/customers` | `AdminCustomers.tsx` — needs-attention queue + all customers + drill-down (readout + review) | live (carried over from the pre-shell single dashboard) |
| `/admin/users` | `AdminUsers.tsx` — every signed-up login, separate from the customers/business view (see below) | live (2026-08-16) |
| `/admin/meta` | `AdminMeta.tsx` — full Meta data explorer (see below) | live (AIC-45) |
| `/admin/recommendations` | `AdminRecommendations.tsx` — all recs, all customers (see below) | live (AIC-46) |
| `/admin/operators` | `AdminOperators.tsx` — operator accounts + the full admin action log (see below) | live (AIC-47) |

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
open ops-item count, and — when there's no outstanding recommendation —
`noRecReason`/`noRecDetail` (AIC-64): the precise gate/threshold the engine's
last tick blocked on, so the operator can answer "is the agent actually
looking at this account?" precisely, not just "no." Rendered in
`AdminCustomers.tsx`'s drill-down with the exact numbers (e.g. `₪10/יום × 7 =
₪70 < נדרש ₪150`) — see [RULES.md](../RULES.md#why-theres-no-recommendation-aic-64).
Routes: `GET /api/admin/customers`, `GET /api/admin/customers/:id`. Reads
only; role-gated. Source: `server/src/services/customers.js`. Tests:
`customers.integration.test.ts`.

**`connectionReadiness` — the same reason a customer would eventually hit,
surfaced before they do (bug fix, 2026-08-15).** Both rows carry a
`connectionReadiness` field — `no_campaign` / `not_launched` / `missing_page`
/ `connection_issue`, or `null` once the campaign is real, linked, and every
connection layer (health, ad account, Page) is present. This is the EXACT
same classification the customer-facing add-content flow's 409 uses
(`server/src/services/connection-readiness.ts`'s `classifyConnectionReadiness`
— one pure function, two consumers, so the two surfaces can't drift onto
different definitions of "ready"). Found live: a customer's `page_id` had
been silently NULL for weeks — real, active, spending campaign, but nothing
in the admin list distinguished it from a fully healthy one, because
`accessHealth` alone (`ok`/`revoked`/`invalid`/`needs_reconnect`) only
reflects whether the CONNECTION passed its own health check, not whether
every asset it needs (ad account, Page) is actually on file. `AdminCustomers.tsx`
shows a `pill warn` badge with the reason next to the raw `accessHealth`
in both the list row and the detail card, and a fourth filter tab
("בעיית חיבור") narrows the list to exactly these customers — an operator
no longer has to wait for a customer to report it.

## Users view (separate from Customers, 2026-08-16)

A **user** is the login (`app_users`: email, password hash, name) — distinct
from a **customer** (`customers`: the business the Meta connection hangs off).
The two are deliberately decoupled (`app_users.customer_id`, nullable), which
means a real signup with no business linked yet is invisible on the Customers
page above — that page queries `customers`, so it only shows what already has
a business record. This page exists to close that gap: it queries `app_users`
first, so every login gets a row whether or not onboarding has happened yet.

Kept as a **separate page from `/admin/customers`**, not a replacement —
explicit product decision: the two answer different questions ("who signed
up" vs "which businesses are we managing"), and businesses will keep existing
independently of a login (an operator can still hand-create one via "+ לקוח
חדש" for a phone-onboarded customer with no self-serve account).

`listAppUsers(pool)` (`server/src/services/users-admin.ts`) starts from
`app_users`, LEFT JOINs each one out to its business/subscription/connection/
campaign if it has one — the same `connectionReadiness` classification the
Customers view uses (`connection-readiness.ts`), `null` for a user with no
business yet rather than a misleading "ready."

**Clicking a row is the entry point into the AIC-101 onboarding wizard.** If
the user already has a linked business, it navigates straight to
`/admin/onboarding/:customerId`. If not, `ensureCustomerForUser(pool, actor,
userId)` first creates a bare `customers` row (business name defaults to the
user's name, falling back to their email if blank; `contact_email` seeded
from their login email) and links `app_users.customer_id` to it — logged to
`admin_audit_log` as `user.provision_customer` — then navigates into the
wizard on the new id. Idempotent: a user who already has a business (whether
from a prior click or hand-created separately) gets that same id back, never
a second row.

**The onboarding CTA is withheld once a user is already fully connected**
(`offersOnboarding`, `web/src/admin/user-row-status.ts`, unit-tested) — a
real gap in the first version, caught live: with no guard, Pisga and
free_beta test (both fully connected) still showed "start onboarding," and
clicking it would have run `provisionConnection` a second time — INSERTing a
duplicate connection/ad_account/campaign for a customer that already has a
working one (provisioning always inserts, never upserts). The rule mirrors
`connectionReadiness`: `null` (fully ready) withholds the CTA; a business
with no `customerId` yet, or any readiness gap short of fully ready, still
gets it, since those are exactly the cases the wizard exists to finish or
fix. A fully-connected row's action links to `/admin/customers?focus=<id>`
instead — the same jump-to-drilldown pattern the Overview search uses.

**Payment details and trial state are explicitly out of scope for now**
(2026-08-16 product decision) — `subscriptions` still lives on `customers`,
not `app_users`. If billing ever moves to be per-login rather than
per-business, that's a real schema decision (not just a rename), flagged here
for whoever picks it up.

Routes: `GET /admin/users`, `POST /admin/users/:id/customer`. Tests:
`users-admin.integration.test.ts` (a bare user shows null business/connection;
a fully-linked user reflects real connection state; `ensureCustomerForUser`
creates+links once and is idempotent on repeat; falls back to email when the
user has no name; full HTTP round trip including the admin-only gate),
`user-row-status.test.ts` (`offersOnboarding`'s three cases — no business,
fully connected, every readiness gap short of that).

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
  Same shape for `thresholdOverrides` (AIC-77a) → `managed_campaigns.threshold_overrides`,
  read by `resolveThresholds` (see [../RULES.md](../RULES.md#configurable-thresholds-aic-77a))
  — validated against the known threshold keys before any write, all-or-nothing.
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

Each ad's creative also carries `pageId` (from `object_story_spec.page_id`) —
added 2026-08-12 while diagnosing a real bug: `meta_connections.page_id` can
be blank for a hand-provisioned connection (see AIC-68) with no way to
recover the real value short of a live Meta read, since our own DB never had
it. The explorer already reads live per-ad creative data, so this is the one
place in the app that can answer "what Page is this campaign actually
running as" without a new endpoint.

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

## Recommendations oversight (AIC-46)

PRD §23's "Recommendations" surface: every recommendation the engine (AIC-8/9)
has produced, across every customer, with its evidence and full lifecycle
status — the operator's window into whether the engine is trustworthy.

`server/src/services/recommendation-oversight.ts` `listRecommendationsForAdmin
(pool, filter)` joins `recommendations → managed_campaigns → customers` (+ a
lateral join to the latest `action_history` row for that rec, so an executed
rec carries its Meta write's success/failure and a link back, and a
`LEFT JOIN recommendation_outcomes` for its measured AIC-76 outcome — see
below), filterable by state/type/customer, newest-first, capped at 300 (a
triage view, not a report). `GET /admin/recommendations?state=&type=&customerId=`.

**Deliberately read + flag only — no operator-initiated approve/execute.**
The ticket left this "optional, decide in build." The product's whole trust
model is "every spend/delivery change requires customer approval"; a
side-channel execute button for operators would undercut that for a P0
feature the ticket itself marked optional. If a real support case ever needs
an operator to act on a customer's behalf, that should be its own explicit,
audited flow through the safe-execute pipeline (AIC-12) — not bolted onto
this oversight list.

**Flag for review** (`recommendations.flagged_for_review`/`flag_note`/
`flagged_by`/`flagged_at`, migration 017): orthogonal to the AIC-8 state
machine — a flagged rec still runs its normal customer-approval lifecycle
untouched; the flag is the operator's own marker, not a gate. `POST
/admin/recommendations/:id/flag` (body `{ note }`) / `.../unflag`, both
logged to `admin_audit_log` (`recommendation.flag`/`.unflag`, AIC-44's table —
`entity_type: 'recommendation'`).

**Failed recs** surface via the state filter (`state=failed`) — consistent
with the needs-attention queue below: a failure is never hidden.

**`add_creatives_for_comparison` (AIC-86)** — the first advisory-only
recommendation type — renders through the exact same generic evidence table
with zero special-case code, but its evidence is richer on purpose: it
carries both `comparableCreativeCount` and `comparableAdsetCount` /
`dormantAdsetIds` together, so an operator sees the full structurally-un-
optimizable picture even though the customer only ever sees the
creative-focused message. See
[RULES.md](../RULES.md#comparability--the-add_creatives_for_comparison-advisory-aic-8586).

Web: `web/src/admin/AdminRecommendations.tsx` at `/admin/recommendations` (nav
item now live). A fleet-wide **outcome-by-type summary card** at the top
(AIC-76, see below); a state/type/customer filter row; a table of matches; a
drill-down per rec showing current→proposed budget, max spend impact,
rationale, approval/execution status, the raw evidence as a key→value table
(whatever shape the rule that fired put there — never reformatted/guessed),
a link into the customer's action-history (`/admin/customers?focus=<id>`,
AIC-44's drill-down, which already renders condensed action-history) when the
rec was actually executed, a **measured-outcome block** for any executed rec
(AIC-76, see below), and the flag/unflag control.

Tests: `recommendation-oversight.integration.test.ts` (list + join
correctness, state/type/customer filters, action-history linkage, failed recs
surfaced, a measured outcome and its exact window dates, a confounded
outcome's detail, `getOutcomeAggregate`'s per-type counts, flag/unflag +
audit logging, 404 on a missing rec, full HTTP round trip with a real admin
actor, auth).

**Outcome measurement (AIC-76).** Did an executed recommendation actually
help? Full design in [outcome-measurement.md](outcome-measurement.md) — this
page only covers the two UI surfaces it adds here. The per-rec block shows
the verdict, before/after CPL, the raw delta, the exact measured window, and
(when confounded) what else changed and when — reading
`AdminRecRow.outcome`, `null` until the after-window closes. The aggregate
card (`GET /admin/recommendations/outcomes-summary`) is its **own** query,
grouping every executed recommendation by type and verdict — deliberately
not a client-side rollup over the 300-row-capped list above, which would
silently undercount past 300 rows. Both are correlation-only by construction
and copy — see the doc for why.

**Note:** GelNails hasn't produced a real recommendation yet (thin data / the
one ad set that's excluded from evidence by AIC-39's delivery-health check) —
verified with realistic seeded-then-cleaned-up data on prod instead of real
engine output. Re-verify with real recs once the engine actually proposes one.

## Meta connection onboarding wizard (AIC-101 + AIC-68)

Replaces the "hand-written SQL against prod" gap [META_SETUP.md](../META_SETUP.md)
used to flag — the exact path that let a blank `page_id` ship unnoticed for
months. `/admin/onboarding/:id` (`web/src/admin/AdminOnboarding.tsx`), linked
from a customer's detail card ("אשף חיבור Meta"). **Internal only** — admin-gated,
never customer-facing; the operator runs it live on the onboarding call while
the customer is in their own Meta Business Settings.

**All five steps render on one screen, not a strict wizard.** A small step
indicator persists which step the call is on (`POST .../onboarding/step`,
`customer_onboarding.current_step`) so closing the tab mid-call doesn't lose
the operator's place, but nothing is hidden behind "next" — an operator on a
live call doesn't want to click through screens mid-conversation.

**Step 1 (customer grants partner access) reuses `strings.he.app.connect.steps`
verbatim** — the exact same script and Business-Portfolio-ID copybox the
customer-facing Connect screen renders — rather than a third hand-copy of the
instructions (the wizard/runbook/Connect screen would otherwise drift, which
is exactly the class of bug the AIC-98 distinct-copy discipline exists to
prevent). The portfolio ID itself comes from the unauthenticated
`GET /api/config` (`server/src/config/meta-identity.ts`), so it's never
hardcoded in the frontend a second time.

**Every check step is a live Graph API call, never just instructions.**
`server/src/meta/access-layers.ts` (`classifyAccess`) is the pure three-layer
classifier this doc's [access model](../META_SETUP.md#the-three-layers-of-access-all-three-must-be-satisfied)
describes as code: `directReadOk` (ground truth) short-circuits to `ok`;
otherwise layer 1 (`sharedToPortfolio`) is reported before a simultaneously-
failing layer 3, because sending an operator to regenerate a production token
while the customer hasn't even shared the asset yet wastes an expensive,
disruptive action for nothing. Six diagnoses (`ok` / `not_shared` /
`not_assigned` / `token_missing_scopes` / `unreadable_unknown_cause` /
`unknown`), each with distinct Hebrew title+body in
`web/src/admin/onboarding-copy.ts` — three of them (`not_shared`/
`not_assigned`/`token_missing_scopes`) look identical from the Business
Settings UI, which is the entire premise of the ticket, so a distinctness
test (`onboarding-copy.test.ts`) guards against ever collapsing them back
into one message. `server/src/meta/access-probe.ts` (`AccessProbe`) does the
actual Graph reads (`client_pages`/`client_ad_accounts` for layer 1,
`me/accounts` for layer 2 — Pages only, ad accounts have no equivalent edge —
`debug_token` for layer 3, plus a direct object read as ground truth),
normalizing ad-account ids with/without the `act_` prefix since Meta returns
them inconsistently across edges. A network failure is treated as unknown,
never rendered as a confident denial. `POST .../onboarding/check` (asset +
Page, step 1) and `POST .../onboarding/token-check` (step 3) persist results
into `customer_onboarding.checks` (JSONB, merged per-key so checking one
asset never clobbers another's stored result).

**Step 4 provisioning (AIC-68) is where AIC-69's ordering rule is enforced in
code, not just documented.** `server/src/services/customer-onboarding.ts`
`provisionConnection` writes the `meta_connections` / `ad_accounts` /
`managed_campaigns` trio in one transaction, and **refuses to write a
`page_id` unless a passed `AccessVerdict` for that exact Page is `ok`** —
`POST .../onboarding/provision` never trusts a verdict the client sends up
from an earlier check; it re-probes the Page live, immediately before the
write, every time. A `page_id` the backend can't read flips the whole
connection's health to `revoked` (worst-health-wins across all granted
assets), which drops the campaign out of `listEligibleForGeneration` and
silently stops the recommendation engine — strictly worse than not setting
`page_id` at all, so the refusal is a hard 409 (with the diagnosis on the
body, rendered as a known reason in the UI, not a generic failure) rather
than a soft warning. `lead_event_types` defaults to the WhatsApp pair (AIC-87)
when left blank, so a plain WhatsApp-lead campaign needs no extra input.

**Step 5 finalize runs the real `ConnectionService.verify()`** — the exact
check the recommendation engine's own tick relies on — and only marks
`customer_onboarding.completed_at` on a genuine `ok`, never on an assumption
that provisioning succeeding implies the connection is healthy.

Routes (all under `requireAdmin`, `server/src/routes/admin.ts`):
`GET .../onboarding`, `POST .../onboarding/step`, `POST .../onboarding/check`,
`POST .../onboarding/token-check`, `POST .../onboarding/provision`,
`POST .../onboarding/finalize`. Source: `server/src/meta/access-layers.ts`,
`server/src/meta/access-probe.ts`, `server/src/services/customer-onboarding.ts`.
Tests: `access-layers.test.ts` (10, every diagnosis + the layer-1-before-
layer-3 ordering + ground-truth-overrides-edges), `access-probe.test.ts` (8,
mocked Graph responses for every layer/detail/id-format/network-failure case),
`customer-onboarding.integration.test.ts` (13, resumability, per-check merge,
the three page_id-gate refusal cases, atomic no-partial-write on refusal,
lead-type defaulting, the connected-campaign-has-no-`create_campaign`-row
regression), `onboarding.integration.test.ts` (15, full HTTP round trip
including the specific scenario this doc calls out above — a Page that passed
an earlier check is re-verified, and fails, at provision time). Live-verified
against real Meta and the real DB (2026-08-16): a known-good real Page and ad
account both return `ok`; a bogus Page id returns a clean `not_shared`; the
full onboarding-open → customer-basics → check → token-check round trip
returns real data end to end for `test@test.com`'s connection.

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

**One subtlety for builder-created campaigns (AIC-53).** For a campaign that
already exists on Meta (a partner-managed existing campaign), `status='active'`
means "we manage it and it's live." For a *builder-created* campaign it means
"reviewed and managed" but the campaign is still PAUSED on Meta — going live is
a separate customer launch approval (the AIC-53 launch gate,
[campaign-builder.md](campaign-builder.md)), tracked by
`managed_campaigns.launch_approved_at`. So `submitReview(approved)` moving a
campaign to `active` is necessary but not sufficient for a builder campaign to
spend; the launch gate is what actually flips it ACTIVE.

**"Rebuild to standard" language** (once the review UI grows past its current
three outcome buttons) should pull its rationale from
[campaign-builder.md](campaign-builder.md)'s recommended-defaults spec
(AIC-49) rather than re-writing it — no concrete UI hook exists yet.

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

## Operator accounts + the full admin action log (AIC-47)

Two governance pieces, one page: **who can access the console**, and **what
they've done in it**.

**Operator accounts** (`server/src/services/operator-accounts.ts`):
`listOperators` (any admin — transparency), `addOperator` / `setOperatorRole` /
`removeOperator` (`requireFullAdmin` only). Adding is a **promotion of an
existing signed-up account** — P0 has no invite-by-email flow (no email sender
yet, same limitation as password reset, AIC-33), so the person must already
have a login; `addOperator` sets `is_admin = true` on their `app_users` row.
Removing sets `is_admin = false` and resets the role — the account/login
itself is never deleted (same convention as a hard-deleted customer's linked
`app_user` surviving, AIC-44). Both role-demotion and removal refuse to touch
the **last remaining `full_admin`** — live-verified: attempting to demote the
sole full_admin correctly fails and the UI reverts to the real server state.
Routes: `GET/POST /api/admin/operators`, `POST /api/admin/operators/:id/role`,
`DELETE /api/admin/operators/:id`.

**The full admin audit log** is the same `admin_audit_log` table AIC-44 built
(migration 016) — AIC-47 adds no new table, only the read/filter surface on
top, plus new writers: `operator.add` / `.role_change` / `.remove` (this
ticket), and `campaign.control.<action>` for emergency-control use
(`POST /campaigns/:id/controls` — disable/enable automation, freeze/unfreeze
execution, mark unmanaged, pause management), which was silently unlogged
before this ticket even though the AIC-47 spec explicitly lists it as one of
the actions this log must capture — closed as part of this work, best-effort
(a logging failure never turns a successful control into a reported error).
`listAuditLog` (`admin-audit.ts`) gained an `entityType` filter alongside the
existing `entityId`/`actorUserId` ones, so "by customer" can mean the whole
entity class or one specific id. `GET /api/admin/audit?actorUserId=&entityType=&entityId=`.

**No current cross-link to `action_history`** (Meta campaign changes, AIC-15):
the one case that would populate both logs — an operator-initiated
recommendation execute — was deliberately not built (AIC-46). If that ever
changes, that's where the cross-link belongs.

**RLS**: intentionally not added to `admin_audit_log` or `app_users.admin_role`
— same Neon architecture decision as AIC-44 (API-layer authz via
`requireAdmin`/`requireFullAdmin`, not Postgres RLS).

Web: `web/src/admin/AdminOperators.tsx` at `/admin/operators` (nav item now
live). Two sections: the operator roster (role dropdown + remove, both
disabled — not hidden — for a non-full_admin, so the UI stays honest about
what exists even when you can't act on it) with an add-operator form below it
for full_admins; and the full audit log with actor/entity-type filters.

Tests: `middleware/admin.test.ts` (unit — `requireFullAdmin`: full_admin
allowed, plain operator 403, no userId 403), `operator-accounts.integration.
test.ts` (add/promote/remove + audit logging, the last-full-admin guard on
both demotion and removal, a full HTTP round trip proving only full_admin can
manage operators, emergency-control use now writes an audit row, the full log
filters by actor and entity type, auth). Live-verified end to end against
prod Neon (add → promote → remove a real test operator, the last-full-admin
guard correctly blocking a demotion, a real reversible emergency-control
round trip on Pisga's own campaign logging both actions truthfully) — cleaned
up afterward.
