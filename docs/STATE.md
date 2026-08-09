# docs/STATE.md — dated changelog

Newest first. One `### YYYY-MM-DD — <title>` block per change: **what changed and
why**. Append a block; never edit an existing line. Behaviour is specified in the
owning doc under [features/](features/), not here.

## Changelog

### 2026-08-09 — Operator accounts + full admin audit log (AIC-47)
The last ops-console-v2 ticket — all five admin sections are now live. New
`app_users.admin_role` (`full_admin`|`operator`, migration 018, backfilled
from today's `is_admin` accounts) is the one deliberate role gate: every
admin route still runs on `requireAdmin` alone, except operator-account
management itself, which additionally requires `requireFullAdmin` — a
general per-route RBAC overhaul was explicitly out of scope, only the
concrete "only a full-admin can manage operators" AC. `services/
operator-accounts.ts` add/promote/remove an operator (promotion of an
existing signed-up account only — no invite-by-email, same P0 gap as
password reset); both role-demotion and removal refuse to touch the last
remaining full_admin. Removing revokes console access without deleting the
login. The full filterable audit log reuses AIC-44's `admin_audit_log` table
(no new table) — `listAuditLog` gained an `entityType` filter; new writers
`operator.add/.role_change/.remove` and `campaign.control.<action>` (closed a
real gap: emergency-control use was silently unlogged before this, despite
being explicitly listed in the AIC-47 spec). Web: `AdminOperators.tsx` at
`/admin/operators` (nav item now live — the console's last "בקרוב" row is
gone). Live-verified end to end on prod Neon: added/promoted/removed a real
test operator, the last-full-admin guard correctly blocked a demotion, and a
real reversible emergency-control round trip on Pisga's campaign logged both
actions truthfully — cleaned up afterward. Tests: `middleware/admin.test.ts`
(requireFullAdmin), `operator-accounts.integration.test.ts` (10 tests). Also
removed a stale doc section (`ops-console.md`'s "Web ops console") that still
referenced the pre-shell `OpsConsole.tsx`/`/admin/ops`, deleted back in
AIC-43 but left undocumented as gone.

### 2026-08-09 — Recommendations oversight (AIC-46)
PRD §23's cross-account recommendations surface: every rec the engine has
produced, any customer, filterable by state/type/customer, with its evidence
and full lifecycle status. `services/recommendation-oversight.ts`
`listRecommendationsForAdmin` joins recommendations→campaigns→customers +
the latest linked `action_history` row (outcome + a link back). Deliberately
**read + flag only** — no operator-initiated approve/execute: the product's
core trust model is customer-approval-gated spend changes, and a side-channel
execute button for operators would undercut that for a feature the ticket
itself marked optional. New `flagged_for_review`/`flag_note` on
`recommendations` (migration 017) lets an operator flag a rec for review,
orthogonal to the AIC-8 state machine — logged to `admin_audit_log` (AIC-44's
table, `entity_type: 'recommendation'`). Failed recs surface via the state
filter, consistent with the needs-attention queue. Web: `AdminRecommendations.
tsx` at `/admin/recommendations` (nav item now live). Verified with realistic
seeded-then-cleaned-up data on prod — GelNails hasn't produced a real
recommendation yet (thin data / the delivery-health exclusion), so this is
honestly not yet re-verifiable against real engine output. Tests:
`recommendation-oversight.integration.test.ts`. Doc: `ops-console.md`.

### 2026-08-09 — Full Meta data explorer (AIC-45)
The operator's unrestricted deep view — the exact opposite of the customer's
opt-in audience view (AIC-37): every node (campaign→ad-set→ad→creative) with
every metric Meta gives us, including the ones hidden from customers per PRD
§14 (CPM/CTR/CPC/reach/frequency/quality-engagement-conversion rankings),
targeting, budgets + bid strategy, and delivery issues. New
`server/src/meta/explorer.ts` (`GraphExplorerReader`, its own small read-only
Graph client) + `services/campaign-explorer.ts` fetch live from Meta on every
open/refresh — no new storage table, honest degradation via
`unavailableReason` (`no_meta_campaign`/`no_token`/`meta_error`) instead of a
500 or a fabricated tree. This is the one deliberate exception to "never a
live Meta call at render time" (AIC-7's rule protects the normal navigation
path; this is a gated, explicit operator action). Recognizes flexible/dynamic
creatives (`asset_feed_spec`) instead of rendering them as broken. Web:
`AdminMeta.tsx` at `/admin/meta` (nav item now live); `AdminCustomers.tsx`
links straight in via `?campaign=<id>`. Tests: `explorer.test.ts` (pure
normalizers incl. the flexible-creative shape),
`campaign-explorer.integration.test.ts` (DB+HTTP, injected fake reader).
Doc: `ops-console.md`.

### 2026-08-09 — Customer CRUD + admin audit log (AIC-44)
The operator's actual daily onboarding/support tool: `AdminCustomers.tsx`
gains create ("+ לקוח חדש"), an inline edit form (business fields; budget
edits write straight to `managed_campaigns.agreed_budget_agorot`, which the
engine's safety check already reads live), deactivate/reactivate (reversible;
deactivating marks the managed campaign `unmanaged` — stops both generation
and execution via the existing AIC-14 controls, without touching Meta), and a
gated hard-delete (confirm-to-type, enforced server-side too, cascades the
customer's rows, never touches Meta assets). New `customers.is_active`/
`deactivated_at` + append-only `admin_audit_log` (migration 016;
`services/admin-audit.ts` + `services/customer-admin.ts`) — every write is
logged (who/what/entity/before→after), with `entity_id` deliberately not a
foreign key so a hard-deleted customer's own delete is still legible in its
audit trail. Search + active/deactivated filter over the roster; the
drill-down now shows the full record (business+contact+subscription) plus
lead-quality and condensed action-history via existing endpoints, plus the new
per-customer audit trail. QA'd live end-to-end against prod Neon (create →
edit → deactivate → reactivate → delete, confirm-to-type rejected then
accepted, audit trail survived the cascade) then cleaned up. Tests:
`customer-admin.integration.test.ts`. Doc: `ops-console.md`.

### 2026-08-09 — Admin console nav shell + fleet overview (AIC-43)
The admin console gets a proper multi-section frame — the base the rest of
ops-console-v2 (AIC-44…47) hangs off. New `AdminShell.tsx` (right-side sidebar,
reusing the customer app's shell CSS) + `AdminSidebar.tsx`: **סקירה כללית**
(Overview, `/admin`) and **לקוחות** (Customers, `/admin/customers`, the
pre-shell single dashboard's queue+customers+drill-down content, moved and
restyled to the `.dash`/`.card`/`op-table` system) are live; **נתוני Meta** /
**המלצות** / **מפעילים** show as disabled "בקרוב" rows until AIC-45/46/47 land.
New `GET /api/admin/overview` (`services/fleet-overview.ts`): campaigns-by-status,
delivering-vs-needs-attention (AIC-39 `delivery_ok`), spend/leads for the
managed fleet (all campaigns, incl. dogfood), open ops-queue depth, and
billing/conversion (excludes test customers — honest "no real customers yet" at
current scale). A client-side global search (business name + campaign name)
jumps to `/admin/customers?focus=<id>`, which auto-selects that customer's
drill-down. `CustomerListRow`/`CustomerDetail` gained `campaignName`. Old
`/admin/ops`+`/admin/readout` now redirect to `/admin/customers`. QA'd live:
real GelNails delivery-problem queue item, real fleet numbers, search→jump-to
end-to-end. Tests: `fleet-overview.integration.test.ts`. Doc: `ops-console.md`.

### 2026-08-09 — Design-system roll-out + shared overview fetch + a11y pass (AIC-42)
Recommendations (list + detail) and Settings now use the same tighter type +
lifted cards as the dashboard (`.dash`/`.dash-title`) — one visual system across
`/app*`. New `web/src/app/overview-store.ts`: a single `useSyncExternalStore`
cache for `GET /api/app/overview`, consumed by the sidebar, Home, and Settings —
confirmed via the Performance API that a page load now fires exactly **one**
overview request (was up to 3, one per component). A11y: the account menu opens
with focus on its first item, ↑/↓ cycle entries, Escape closes and returns focus
to the trigger; the mobile drawer closes on Escape; visible `:focus-visible`
rings on nav items/gear/FAB/menu entries; `aria-current="page"` on the active nav
item (via React Router's `NavLink`). Verified live: all three keyboard behaviors
tested end-to-end in the browser. Doc: `customer-app.md`.

### 2026-08-09 — Opt-in per-audience/per-creative details view (AIC-37)
Progressive disclosure for the multi-ad-set campaigns AIC-38 established as
normal: Home stays the 4-number roll-up by default; a collapsed **"הצג פירוט"**
expander reveals the per-audience breakdown, each expandable to its own
per-creative rows. New `GET /api/app/audiences`
(`server/src/services/campaign-audiences.ts`, ownership-scoped, DB-only). Audience
labels are derived from what actually differs between a campaign's ad sets — age
→ gender → geo, else the ad set's own name — never "ad set N"
(`server/src/meta/audience-label.ts`, `deriveAudienceLabels`). Labels are fetched
+ cached (`ad_set_meta`, migration 015) by the engine tick (alongside delivery
health) and threaded into `pause_underperforming_audience`'s evidence, so the
explainer now names the audience by its human dimension instead of generic
phrasing. Home's active-creative count is de-duplicated by creative name (the
same design under two ad sets is one "creative," not two). QA'd live on GelNails:
opened the details, saw "18–35" / "35–45" with the Almond creative under each.
Deferred: instrumenting the toggle as a product signal (needs AIC-28, which
doesn't exist yet). Docs: `RULES.md`, `customer-app.md`.

### 2026-08-09 — Dashboard two-column layout (AIC-41)
Restructured Home (`/app`) into a Pisga-style **rail + main** dashboard: left rail
= the campaign at-a-glance card; main = hero (status) + KPI row + recommendation
nudge + weekly feedback + activity. The status hero no longer spans full width.
Tighter type (smaller title/hero/KPI) and lifted cards (soft shadow) via a new
`.dash*` scope in `ui.css`; collapses to one column ≤1024px. Same `getOverview`
data — no backend change. (Known follow-up for AIC-42: overview is fetched twice —
Sidebar + Home — worth deduping via context.) Doc: customer-app.md.

### 2026-08-09 — App shell: right-side sidebar nav (AIC-40)
Replaced the signed-in app's top header with a Pisga-style **right-side sidebar
shell** in AdPilot's palette (ink sidebar, orange accent). New `AppShell.tsx`
(React Router layout route) + `Sidebar.tsx`; `/app*` nested under it in `App.tsx`;
per-screen `AppHeader` dropped from Home/Recommendations/Settings. Sidebar =
brand → nav sections (ראשי / המלצות+badge / הגדרות) → user card (real name/email +
account menu with logout). Off-canvas drawer + right-side FAB below 860px. Shell
CSS = `.ap-*` in `ui.css`; icons via `lucide-react`. Chrome only — no backend/data
changes. First of the 3-part /app redesign (AIC-40/41/42). Doc: customer-app.md.

### 2026-08-09 — Admin routing + entry-screen redirects (UX)
Single admin dashboard: `/admin` now renders one `AdminDashboard` (queue +
customers + a per-customer drill-down that folds in the campaign readout);
the old `/admin/ops` and `/admin/readout` routes redirect to `/admin`
(`OpsConsole.tsx`/`Readout.tsx` removed). Fixed bare `/admin` bouncing to `/login`.
Authenticated visitors on `/login` `/signup` `/register` `/forgot` `/reset` now
redirect to the dashboard (`/app`); `/onboarding` self-redirects to `/app` once
`onboarding_status = ready`.

### 2026-08-09 — Ad-set delivery-health detection; audience rule now live (AIC-39)
Detects not-delivering / disapproved ad sets (invisible in Insights) via a
separate `effective_status` + `issues_info` read. New `meta/delivery-health.ts`
(normalize/summarize) + adapter `getDeliveryHealth`; `services/delivery-monitor.ts`
persists `managed_campaigns.delivery_ok`/`delivery_reason` (migration 014) and
raises a `campaign_not_delivering` ops item on the ok→not-ok transition (deduped),
recovering on heal. Wired into the engine tick: errored ad sets are recorded and
**excluded** from the rules' evidence (ad sets + their creatives) — which lets
**AIC-36's `pause_underperforming_audience` go live** (re-inserted into `RULES`).
Customer surface: `overview.attentionKind = "delivery"` → Home shows a distinct
plain-Hebrew "needs attention" message; campaign `status` stays `active` so the
engine keeps optimizing the healthy ad sets. New owning doc
`features/delivery-health.md`. Tests: delivery-health, delivery-monitor, generation
exclusion, overview delivery-attention. 122 unit + 45 integration green.

### 2026-08-09 — Audience-aware rules + pauseAdSet write (AIC-36)
The rules now reason at the audience (ad-set) grain. **Creative fix (live):**
`pause_weak_creative` compares creatives WITHIN an ad set (grouped by
`parent_meta_id`), so the same creative under two audiences is never pitted
against itself. **Audience rule (implemented, NOT live):**
`pause_underperforming_audience` proposes pausing the worse ad set when its CPL is
≥2× the best over a stricter evidence gate; held out of the live `RULES` array
until AIC-39 can exclude errored/not-delivering ad sets (else it would recommend
pausing an errored audience). **New execution capability:** `pause_adset` rec type
(migration 013 widens the type CHECK) + `ExecWriter.pauseAdSet` + adapter
`pauseAdSet`/`setAdSetStatus`; the executor does external-change + read-back verify
on the ad set's status. `getCampaignState` now returns `adSetStatuses`. Snapshot
store gained `adsetStats` + `adSetId` on creatives. Budget rules stay
campaign-level (CBO). Docs: `RULES.md`. Tests: `rules.adset.test.ts`,
`safe-executor.test.ts` (pause_adset happy + external-change).

### 2026-08-09 — Managed shape = 1 campaign → N ad sets (AIC-38)
Definition/anchor for the multi-ad-set arc the GelNails dogfood surfaced (a real
campaign with 2 ad sets split by age). Codified the supported shape — **1 campaign
→ N ad sets → 3–5 creatives** — in `DATA_MODEL.md`; the single-ad-set ideal is an
onboarding *recommendation*, not a system/engine/review assumption. First-campaign
review criteria (`ops-console.md` + a `campaign-review.ts` comment): a legitimate
multi-ad-set **audience split** is `approved`/managed-as-is, never
`changes_requested`/"rebuild" or `unsupported` — those are reserved for genuinely
unmanageable structures. Docs + comment only; no behavior change. Anchors AIC-36
(audience-aware engine) and AIC-37 (surfacing).

### 2026-08-09 — Per-user admin role for the ops console
Admin access is now an attribute of the account, not a shared token. New
`app_users.is_admin` (migration 012); `requireAdmin` accepts a valid customer JWT
whose user is admin (403 for a valid non-admin, 401 otherwise — fail-closed in
every environment; the old "open in non-prod" convenience is gone). `ADMIN_TOKEN`
stays as an optional break-glass. `GET /auth/me` now returns `isAdmin`; the web
`AdminGate` renders the console only for a signed-in admin account and `api()`
sends the user's JWT for `/admin/*`. sharon.mishayev@gmail.com set as the sole
admin. Owning doc: `features/ops-console.md`. Tests: `admin.test.ts` (rewritten),
`admin-auth.integration.test.ts`.

### 2026-08-09 — Scheduled recommendation evaluator — closes the engine loop (AIC-9)
The rules engine was built + tested but nothing invoked it at runtime — the
scheduler only ran ingestion, so no recommendation was ever produced. Added
`server/src/recommendations/generation.ts`: `listEligibleForGeneration` (active +
automation-on + linked + healthy-connection campaigns) and `runGenerationTick`
(reads each campaign's live daily budget, then runs the canonical
`refreshRecommendations` staleness tick to create/expire `proposed` recs).
`buildGenerationTick` is inert without a Meta token. Wired into `index.ts` to run
**after** ingestion in the same "engine" tick. Also fixed `startScheduler` to run
one tick immediately on boot (was waiting a full hour after each deploy). It only
proposes — nothing executes without a customer approval. Owning doc updated
(`features/recommendation-engine.md`). Tests: `generation.test.ts`,
`generation.integration.test.ts`. Sharon's customer was also repointed from the
mis-seeded beta to the real **GelNails | Leads | WhatsApp | 2026-08** campaign
(meta 120249004871310352, ₪10/day) so the loop dogfoods on live data.

### 2026-08-08 — Onboarding/Connect + Settings actions wired — AIC-21/24
Onboarding now renders the real `onboarding_status` (→ card + stepper) and the
signed-in name; Connect shows the real connection state and "check connection"
calls `POST /api/app/connection/recheck` (live per-asset verify with a Meta
token, else the stored health). Settings gained three real actions: budget-change
request (`POST /api/app/budget-request` → ops item, `server/src/services/customer-actions.ts`),
check-connection (shared recheck), and change-password
(`POST /api/auth/change-password` — verifies the current password, then
`updatePassword`; new `findByIdWithHash`/`updatePassword` on the user store). The
header self-fetches the name once (`getMe`) so every screen shows it. Deferred to
tickets: the campaign-review screen (AIC-32, schema-vs-design mismatch) and the
real connect config — business-portfolio ID + WhatsApp/booking links (AIC-33).
Tests: `customer-actions.integration.test.ts`, change-password cases in
`auth-service.test.ts`.

### 2026-08-08 — Recommendation approve/dismiss wired over the pipeline — AIC-23
The customer recommendation surface is live: `GET /api/app/recommendations`
(+ `/:id`), `POST …/approve`, `POST …/dismiss` (`server/src/services/customer-recommendations.ts`),
all JWT-scoped to the caller's campaign. Approve transitions proposed → approved
and hands off to the AIC-12 `SafeExecutor` (no execution logic re-implemented);
outcomes map to plain-Hebrew customer messages, and a missing Meta token yields a
503 with the rec untouched. `Recommendations.tsx` list + detail render the
deterministic `explain()` text, exact current→proposed budget, and max spend
impact; the dev type-switcher is gone. `overview.pendingRecommendations` drives
the Home badge + nudge. The app header now fetches the signed-in name once
(`getMe`) so every screen shows it (loader, never the mock). New owning doc
`features/customer-recommendations.md`; lock-in test
`customer-recommendations.integration.test.ts`.

### 2026-08-08 — Home + Settings wired to live customer data — AIC-22/24
New JWT-scoped `GET /api/app/overview` (+ `POST /api/app/lead-quality`) assembles
the caller's account → customer → connection → campaign → subscription, the
snapshot-based readout, and condensed action history — reading only the caller's
own rows. `Home.tsx` and `Settings.tsx` now render from it (real KPIs, deltas,
budget, Meta connection, billing, activity); the Home dev state-switcher is gone
and the headline `homeState` is derived server-side. Honest empty states
(`collecting`, `—`, "nothing changed yet") instead of sample numbers. New owning
doc `features/customer-overview.md`. First real customer (sharon.mishayev@…, the
Pisga dogfood account) now loads end-to-end.

### 2026-08-08 — Customer auth backend wired (email+password + JWT) — AIC-21
Built the auth backend: `app_users` table (migration 011, case-insensitive unique
email), bcrypt passwords, our own JWT sessions (`JWT_SECRET`), `/api/auth/signup|
login|me` + `requireAuth`. Wired the frontend auth screens to the real endpoints
(store JWT, redirect), added `AuthGate` on signed-in routes + logout. Google
sign-in stays deferred (AIC-30); forgot/reset still frontend-only. Verified: 4 unit
+ 5 DB/HTTP integration tests; a real `app_users` row is created end-to-end. Owning
doc: `features/customer-auth.md`.

### 2026-08-08 — AIC-1 spike PASS (live) + admin API auth + Railway live
Live-verified the whole partner-access model on Pisga's real account: a read-only
probe + a no-op budget write routed through the full AIC-12 safe-execute pipeline
both PASSED under **Standard Access** — reads and writes on a partner-owned ad
account work without Advanced Access. AIC-1 Done; AIC-12/13 live-verified; AIC-25
descoped to a scale concern. Added `GraphCampaignAdapter` (real MetaReader/
ExecWriter) + gated probe/write-test tools. Closed the admin-API hole: `requireAdmin`
now **fails closed in production** when `ADMIN_TOKEN` is unset and requires a bearer
otherwise; web console gated via `AdminGate`. Also fixed two Railway deploy blockers
(NODE_ENV skipping devDeps → `NPM_CONFIG_PRODUCTION=false`; cwd-relative web/dist →
`resolveWebDist`); the app is **live** at aicserver-production.up.railway.app serving
landing + SPA + API with Neon migrations applied.

### 2026-08-04 — Customer app screens (frontend, AdPilot design) — AIC-21/22/23/24
Built every customer-facing screen as frontend on mock data, from the AdPilot
Product Phase 1/2 design directions: auth (signup/login/forgot/reset), checkout,
onboarding (6 states + stepper), connect-Meta (4 outcomes), first-campaign review,
home dashboard (5 states + weekly lead-quality + activity), recommendations list +
detail (3 types × approve/dismiss/executed), settings & support. Added the AdPilot
design system (`web/src/ui.css`), shared components (`web/src/app/components.tsx`),
centralized copy (`strings.he.app`), and full routing (`App.tsx`). No backend yet —
screens navigate/switch via in-component state; wiring lands per ticket. Verified:
typecheck + build green; login/home/onboarding render faithfully. Owning doc:
`features/customer-app.md`. Open decision: the design's self-serve **checkout**
diverges from P0 manual billing — tracked separately.

### 2026-08-04 — Landing page (AdPilot design) — AIC-20
Replaced the placeholder `landing/index.html` with the full AdPilot marketing page
from the provided design directions: fluid responsive RTL Hebrew, brand palette
(orange/cream/ink/green/indigo) + Rubik/IBM Plex Mono, and all sections — hero
collage, dark ₪299-vs-₪1,200 comparison, how-it-works, dashboard mock, creative +
lead-quality + support, pricing, 8-question FAQ (native accordion), final CTA,
footer. CSS-only mockups (no external images). Verified: builds into
`web/dist/index.html`, renders at desktop + 375px with no horizontal overflow.
Contact CTAs + brand alignment (AdPilot vs AI Campaigner) flagged as open.

### 2026-08-03 — Ops console: manual billing + weekly lead-quality — AIC-19
Added the manual billing ledger (`updateBilling` + `conversionSummary` for
setup→subscription conversion, no payment gateway) and weekly campaign-level
lead-quality capture (`upsertLeadQuality` idempotent per campaign+week,
`listLeadQuality`, `leadQualityResponseRate`), routes under `/api/admin/*`.
Verified: 2 DB integration tests (billing + conversion; lead-quality upsert +
response rate).

### 2026-08-03 — Ops console: first-campaign review — AIC-18
Added the review workflow (`campaign_reviews` table): `submitReview` records
outcome + reviewer + timestamp + §11 checklist and moves status (approved →
active, unsupported → unmanaged, changes_requested → stays under_review). The §11
hard rule is enforced — a changes_requested campaign is not activated until
`recordCustomerDecision(true)` records explicit customer approval. Routes under
`/api/admin/campaigns/:id/review` + `/reviews/:id/customer-decision`. Verified: 4
DB integration tests (all outcomes + no-activation-without-approval).

### 2026-08-03 — Ops console: needs-attention queue — AIC-17
Added `OpsQueue` over `ops_queue_item`: one prioritized worklist across all
accounts (high severity first, then oldest; resolved fall away), a canonical
`create` (high-sev logged for the alert hook), and triage (`claim` → in_progress +
claimed_by; `resolve(note)`). Routes under `GET/POST /api/admin/ops-queue`.
Verified: DB integration (severity sort, claim, resolve).

### 2026-08-03 — Ops console: customers view — AIC-16
Added `listCustomers` / `getCustomerDetail` assembling each account's info +
subscription + connection health + campaign + agreed budget + outstanding
recommendation + open ops-item count from the real tables, at
`GET /api/admin/customers[/:id]`. Migration 010 adds ops-queue triage columns +
the `campaign_reviews` table for the rest of P0.4. Verified: DB + HTTP integration.

### 2026-08-03 — Action history surface — AIC-15
Added the per-campaign audit surface reading only from `action_history`:
`listCampaignActionHistory` / `listCustomerActionHistory` (newest-first, full PRD
§23 fields, automated-vs-human), and `condense()` — a jargon-free plain-Hebrew
projection for customer reuse. Exposed at `GET /api/admin/campaigns/:id/history`
(`?condensed=true`). Verified: DB + HTTP integration test. Completes P0.3.

### 2026-08-03 — Emergency controls + failure handling — AIC-14
Added per-account kill-switches (disable/enable automation, freeze/unfreeze
execution, mark unmanaged, pause management) as immediate DB flags (migration 009
adds `execution_frozen`), exposed at `POST /api/admin/campaigns/:id/controls`.
`ControlService.assertExecutable` is the control gate the SafeExecutor already
calls — flipping any switch halts execution on the next attempt (rec stays
approved). Failure handling (ops item + plain-Hebrew customer message + failed
action_history, never a silent success) is enforced in the AIC-12 pipeline.
Verified: 6 tests (gate per flag; kill-switch halts a batch mid-way). Telegram
alerting + ops-console surfacing land with P0.4.

### 2026-08-03 — Safe-execute pipeline — AIC-12
Added `SafeExecutor.execute`: the ordered pipeline for executing an approved
recommendation — relevance → access-health hold → emergency-control hold → claim
executing → external-change detection (cancel, never overwrite) → budget-safety
block → execute → read-back verify (mismatch = failure) → log to action_history.
Access-lost and automation-stop are holds (rec stays approved); external-change,
over-budget, write-fail, and verify-mismatch are failures with an ops item + a
plain-Hebrew customer message. A failed execution never looks succeeded.
replace_creative escalates to ops as a human task. Verified: 10 scenario tests.

### 2026-08-03 — Budget safety + idempotent write outbox — AIC-13
Added `assertWithinBudget` (agreed budget is a hard ceiling; ≤0 or over-ceiling
rejected; null/non-budget passes) and `meta_write_outbox` (migration 008): a
durable queue with a unique idempotency key per intended change (repeat enqueue =
no-op), `FOR UPDATE SKIP LOCKED` draining, backoff/retry to MAX_ATTEMPTS, and
terminal succeeded rows. Only absolute-set idempotent ops (set_daily_budget,
pause_ad) are enqueued, so a lost-response retry re-applies to the same end state.
Verified: 4 budget unit tests + 3 DB integration tests (enqueue idempotency,
exactly-once drain, backoff-then-succeed).

### 2026-08-03 — LLM explainer (plain-Hebrew, never decides) — AIC-10
Added the explainer: `explain(rec)` renders each recommendation type + a weekly
status as plain business Hebrew from a centralized copy table, injecting figures
from the structured record by code (deterministic fallback, always works).
`explainWithLlm` optionally rephrases but accepts the model's text only if every
figure survives verbatim and no Ads Manager jargon appears — the "LLM explains,
never decides" boundary, enforced structurally. Documented in `docs/RULES.md`.
Verified: 10 tests (number-fidelity, jargon-absence, fallback, rejection of a
number-changing or jargon-introducing rephrase). P0.2 recommendation engine
complete.

### 2026-08-03 — Recommendation staleness + expiry — AIC-11
Added `refreshRecommendations` as the canonical eval tick: a proposed rec is valid
iff the same gated rules still produce an equivalent rec from current evidence;
otherwise it's expired (and replaced when a different action is now warranted). An
expired rec is un-approvable by construction (AIC-8 state machine). "Material
divergence" is defined as rules-no-longer-yield-it. Verified: 4 tests
(evidence-holds → stays; diverged → expires; expired → un-approvable; replaced).

### 2026-08-03 — Deterministic recommendation rules v1 — AIC-9
Added the rules engine: `evaluateCampaign` runs five rule types
(pause_weak_creative, replace_creative, decrease_budget, increase_budget,
no_action) over per-campaign evidence, gated by named minimum-evidence thresholds
(`RULE_THRESHOLDS`) — below the gate it emits `no_action`, never a forced change.
Zero LLM involvement; output fully structured. `rule-evaluator.ts` assembles
evidence from `insight_snapshot`, persists an acting draft as `proposed` (deduped;
`no_action` not stored). Thresholds + priority documented in `docs/RULES.md`.
Verified: 14 rule fixture tests (fires when it should, does NOT on thin evidence) +
3 evaluator tests.

### 2026-08-03 — Recommendation state machine — AIC-8
Added the recommendation lifecycle as an explicit state machine
(`proposed→approved→executing→executed|failed`, plus `dismissed`/`expired`),
illegal transitions rejected before any write. `RecommendationService` wraps every
transition with the state-machine check + an optimistic store guard
(`StaleRecommendationError` on a lost race); `completeExecution` writes the PRD §23
audit row to `action_history`. `no_action` is a first-class type. pg + in-memory
stores. Verified: 9 unit + 1 DB integration test.

### 2026-08-03 — Dogfood readout (admin) — AIC-7
Added the internal readout: `buildCampaignReadout` (status + current/previous
7-day totals + per-creative rows + period deltas, read only from
`insight_snapshot`), the `/api/admin` routes behind a `requireAdmin` guard, and
the `/admin/readout` React screen (Hebrew, RTL; `formatShekel`, NULL CPL → "—").
Verified: deltaPct unit test + DB/HTTP integration test, and rendered end-to-end
against seeded Pisga snapshots on a local Postgres (status active, ₪734 spend
+8%, 18 leads +20%, CPL ₪40.78 −10%, 3-creative table). Reconciliation vs Ads
Manager gated on real ingestion.

### 2026-08-03 — Insights ingestion → insight_snapshot — AIC-6
Added the ingestion pipeline: `getInsights` on the Meta client (4 grains, creative
derived from ad rows), pure metric functions (`extractLeads` — 7d-preferred, never
double-counted; `computeCpl` — NULL at 0 leads; `normalizeRow` — spend→agorot), the
snapshot store (idempotent upsert per (campaign, grain, object, period) + period
totals), and `runIngestionTick` (per-campaign isolation: a Meta error is caught,
logged, retried next tick, never crashes the run). Wired an inert-until-token
scheduler into `index.ts`. Lead/CPL documented in `docs/METRICS.md`. Verified: 12
new unit tests + 2 DB integration tests (idempotency, period totals). Live against
Pisga gated on a real System User token + linked campaign.

### 2026-08-03 — Meta connection + access-loss detection — AIC-5
Added the Meta client abstraction (`GraphMetaClient` + `FakeMetaClient`), a Graph
error → access-health classifier, the connection store (pg + in-memory), and
`ConnectionService`: verify folds per-asset access into one health, persists
transitions, and raises a single `meta_connection_failure` ops item on loss.
`assertExecutable` throws `AccessHaltedError` unless health is `ok` — the P0.3
execution-halt safety rule. Customer-facing reconnect copy added to `strings.ts`
(plain Hebrew, no Meta jargon; `connectionMessage()` maps every non-ok state to
one prompt). Verified: 8 service + 3 classifier unit tests, and a DB integration
test proving persistence + ops item + halt end-to-end. Live-against-Pisga is
gated on a real System User token (AIC-3 operator steps) and AIC-1.

### 2026-08-03 — Meta setup runbook — AIC-3
Added `docs/META_SETUP.md`: the one-time Meta-side configuration (Business
Portfolio, app, System User + token scopes, partner-asset assignment, token
storage/rotation posture) in the accurate access framing (partner access +
System User, subject to Meta's required Marketing API tier; no customer OAuth in
P0). Added `META_*` env placeholders to `server/.env.example`. The operator steps
(mint token, assign Pisga's ad account) are executed in Meta's UI by a person and
are checklisted in the doc; the app only consumes the resulting token + asset IDs.

### 2026-08-03 — Core data model: 10 P0 entities — AIC-4
Added migrations `002`–`007` creating the ten P0 tables (customers,
subscriptions, meta_connections, ad_accounts, managed_campaigns,
insight_snapshots, recommendations, action_history, lead_quality_feedback,
ops_queue_items) with FKs, indexes, and CHECK-enum columns mirrored in
`shared/src/domain.ts`. Money is integer agorot; `action_history` is append-only;
the snapshot idempotency key is `(campaign, grain, object, period)`. Added the
Pisga dogfood seed (idempotent) and a DB integration test (self-skips without
`DATABASE_URL`). RLS deliberately not adopted (Neon has no PostgREST surface;
rationale in DATA_MODEL.md). Verified against a local Postgres: 7 migrations
apply, seed idempotent, 4/4 integration tests green.

### 2026-08-03 — Stack scaffold (server / web / shared) — AIC-2
Scaffolded the monorepo from Pisga's proven stack: npm workspaces
(`shared` / `server` / `web`), TypeScript throughout, Neon Postgres via a
numbered-migration runner (`001_init.sql` creates the `_migrations` ledger only;
the P0 entities land in AIC-4), an Express API with a root `/health` for Railway
and an `/api` mount point, a Vite + React SPA with the static landing served at
root, the `strings.ts` copy file, `railway.json`, and a GitHub `ci` workflow
(typecheck + build + unit tests). `shared/money.ts` enforces integer-agorot money.
Verified locally: typecheck, build, and 5/5 unit tests green. No DB/e2e in CI yet
(waiting on a Neon dev-branch `DATABASE_URL`).

### 2026-08-02 — Repo bootstrap: governance layer
Created the standalone AI Campaigner repo with its operating rules
([CLAUDE.md](../CLAUDE.md)), the `feature-docs` skill, and the docs system
(INDEX routing table + this changelog + the feature-doc template). Establishes the
docs-travel-with-code and ship discipline before any feature work, so every later
change inherits it. Stack scaffold (server/web/CI/Railway/Neon) lands separately.
