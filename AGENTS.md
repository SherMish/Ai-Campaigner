# AGENTS.md — AI Campaigner

Context for **every** Codex session in this repo. Read it, follow it.

**Where things live: [docs/INDEX.md](docs/INDEX.md)** — the routing table from a
code area to the doc that owns it. Start there before changing anything.

---

## Working rules (non-negotiable)

### Documentation travels with the code
- **Every feature has exactly ONE owning doc** in `docs/features/`, describing how
  it works **today** — not a changelog.
- On **every feature add / change / deletion**, update its owning doc in the
  **same unit of work** as the code. A feature without a doc is not finished.
  Removing a feature means **deleting its doc and its INDEX row**, not leaving it
  to rot.
- `docs/INDEX.md` is the routing table (code area → owning doc). Keep its rows in
  sync as docs are added/renamed/removed.
- `docs/STATE.md` is the dated **changelog** — newest first, one
  `### YYYY-MM-DD — title` block per change, appended, never editing an old line.
  It records *what changed and why*; behaviour is specified in the owning doc.
- Use the **feature-docs** skill (`.Codex/skills/feature-docs`) — it encodes this loop.

### Specs travel with the code too
The docs rule above exists because a stale doc gets **trusted**. A stale *spec*
is worse, because it is what the next session builds against.

- **If your change makes another ticket's acceptance criteria false, correct that
  ticket in the SAME unit of work.** Strike the criterion, say what replaced it,
  and date it. Do not leave the correction to be discovered.
- **Predicting the staleness is not discharging it.** AIC-106 wrote "this
  invalidates AIC-105's launch-gate criterion" and shipped anyway; the false AC
  then survived in the backlog and cost a later session a detour to rediscover.
  Foreseeing the contradiction is precisely when it is cheapest to fix.
- Same for **tests and comments that assert the old behaviour**. A passing test
  that encodes a bug as expected is an artifact that *looks like* verification
  while preserving the wrong thing — the budget-ceiling overwrite survived for
  exactly this reason (`campaign-create.integration.test.ts` asserted the
  overwritten value). When a bug lives on a path tests already cover, check
  whether a test is defending it.

### Two distinctions that keep collapsing — hold them open
- **"Unverified" is not "not done."** Say which one you mean. Reporting an
  unchecked criterion as satisfied is how a spec drifts from production.
- **"Pre-existing" is not "accepted."** A correct diagnosis ("this failure
  predates my change") silently reads as a decision to tolerate it. Name the
  diagnosis and the decision separately; a growing set of tolerated failures is
  how the baseline moves without anyone choosing it.

### Ship discipline
- **Commit** when a unit of work is finished — don't wait to be asked.
- **Never `git push` without explicit user approval.** Commit freely; hold the push.
- **After every approved push, wait for green GitHub CI *and* a successful Railway
  deploy.** A push is not "done" until both are confirmed green. If either fails,
  diagnose and fix before moving on — never leave the tree red.
- Railway does not necessarily auto-deploy on green CI — confirm the deploy landed,
  don't assume it.
- **Tests ship with the change.** Every feature or behaviour change comes with tests.
- **Bug fixes are test-first**: write a test that fails *because of the bug*,
  confirm it fails for the right reason, then fix.

### Data
- The database is **Neon** (serverless Postgres). Schema changes go through the
  **numbered-migration runner** — never hand-edit prod.
- **Develop against a Neon branch, never prod.** The primary branch is production
  data; local work and CI use a dev/preview branch.
- Money/budgets stored as **integers (agorot)**, never floats.
- Authorization lives in the **API layer** (the server holds the Neon connection
  string). Neon exposes no public data API, so there is no PostgREST-style table
  exposure to defend against — but never ship the connection string or any token
  to the client.

### Copy
- All user-facing text (Hebrew) lives in the **strings file** — never hard-code
  Hebrew in a component. (Landing copy lives in the static `landing/`.)

## Never render a blank where a reason exists

Any surface that can show nothing — an empty panel, a zero, a missing
value, a suppressed recommendation, a status badge — MUST render **why**.
The code one layer down almost always knows. The bug is that it never
reaches the screen.

- **"אין נתונים" is not a reason.** "הקמפיין התחיל לרוץ היום" is a reason.
  If you cannot say why, that is a gap in the feature, not a copy problem.
- **Distinguish causes end-to-end.** If two situations have different
  fixes, they get different text — all the way through to the customer.
  Collapsing them into one generic message destroys the only part that
  was actionable.
- **Name who acts next**: us, the customer, or nobody. A customer reading
  a problem they cannot act on is worse than not showing it.
- **Never render a value you don't have.** A blank beside a label asserts
  a fact. If a value is unknown, say it is unknown — and if an action
  depends on it, block the action rather than showing an empty field.
- **When the reason is "we're not sure the data is right", say that too.**
  Never silently degrade a number into looking confident.

This applies to adding, changing, AND removing states. A new variant of
any customer-visible enum ships with its copy in the same change.

### How this is enforced (not a code-review checklist)

A rule nobody can violate beats a rule everyone remembers. Every
customer-visible enum has an **exhaustive** copy map, so a new variant is a
`tsc` failure rather than a blank on someone's screen:

```ts
const HOME_STATE_COPY: Record<HomeState, StateCopy> = { /* … */ };

// and at any switch over one of these enums:
default:
  return assertNever(state); // shared/src/assert-never.ts
```

The maps live in [`web/src/app/state-copy.ts`](web/src/app/state-copy.ts)
(text still comes from `strings.ts` — the maps bind reason → copy, they
don't inline Hebrew). `state-copy.test.ts` additionally asserts every
variant's copy is **non-empty and distinct**: `Record<Enum, T>` catches a
missing key but happily accepts `""` or copy pasted from the case above it,
which is exactly how the three `צריך טיפול` causes would quietly re-collapse
into one message. Do not weaken that test to make a new variant pass.

Enums under the contract today: `HomeState`, `AttentionKind`,
`NoActionReason`. When you add a customer-visible enum, add it here — the
lead/destination type (AIC-87/89) and `measurement_trust` (AIC-94) join this
list when they land as real union types.

---

## The product in one paragraph (keep in mind for every feature)

AI Campaigner manages a small business's Meta advertising **for** them. The customer
never has to understand Ads Manager. We monitor, analyze, and **recommend** — and
**nothing that changes spend or delivery ever happens without the customer's explicit
approval.** Two principles trace through every feature:

1. **Doing nothing is valid.** The engine never manufactures activity. Below the
   evidence threshold the honest output is
   *"אין כרגע מספיק מידע שמצדיק שינוי. נמשיך לעקוב."*
2. **The LLM explains; deterministic logic decides.** No language model ever chooses
   a budget, an ID, a permission, a status, or whether enough data exists.

### The litmus test (apply to every feature and line of copy)
Does this make the customer's campaign **safer** or the recommendation
**clearer / more honest** — without exposing advertising complexity? If neither,
reconsider before building it.

---

## Analytics (AIC-28)

Mixpanel is wired. Read `docs/METRICS.md` before adding tracking; the rules
below are the ones easy to break by accident.

## Where to put a new event

**Server, at the state transition** — `server/src/analytics/mixpanel.ts`
`track()`. Funnel events are emitted from the code path that performs the
transition, *after* the row is written. Never from a click handler, and never
from the browser: an event fired at the intent counts things that did not
happen (PIS-27; the reason AIC-28 says milestones must be reconstructable from
source).

Ask first: does the server already know this happened? It almost always does,
and it knows it truthfully.

**Browser** — `web/src/analytics.ts`, for identity and page views only.

## Rules

- **snake_case, past tense.** `recommendation_approved`, not `Approve Rec`.
- **Never put PII in event properties** — email, phone, WhatsApp number,
  business name, contact name. The scrubber drops them, but relying on it is
  not the same as not sending them. Profile properties (`identifyCustomer`) are
  the only place PII belongs, because profiles can be deleted on request.
- **Never put a customer-owned object id in a page-view route.** Use the route
  pattern; `trackPage` already normalises uuids to `:id`.
- **Pass `isTest`.** Our own rows (Pisga, betas) must not enter the funnel.
  `GenCampaign.isTest` and `resolveCampaignOwner()` carry it.
- **`distinct_id` is the customer id**, never a user id or email.
- Analytics never throws and never blocks a request. Keep it that way.

## Local and CI

No `MIXPANEL_TOKEN` → the client is never constructed and every call is a
silent no-op. Tests never emit.
