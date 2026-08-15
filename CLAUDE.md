# CLAUDE.md — AI Campaigner

Context for **every** Claude Code session in this repo. Read it, follow it.

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
- Use the **feature-docs** skill (`.claude/skills/feature-docs`) — it encodes this loop.

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

### Never blank when the reason is known
- **Any surface that can be empty must render a reason. "No data" is not a
  reason.** If the code already knows *why* a panel, card, or row has nothing to
  show — thin evidence, a campaign that just started, a value we don't hold — say
  that, don't render nothing. An empty state the code can't yet explain is fine;
  a silent one it *could* explain is the bug.
- This is a recurring pattern, not a one-off: the no-recommendation reasons
  (AIC-64/85), the measurement-trust composed state (AIC-94), the launch screen's
  destination row (never print a blank value beside a confident label — describe
  it or block, per AIC-89), and the audience/ad detail panel (AIC-95) are four
  independent instances of the same underlying bug. Apply this by default on any
  new surface rather than waiting for the next blank panel to show up in a
  screenshot.

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
