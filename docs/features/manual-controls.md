# Manual object controls (AIC-66)

**Status:** live — direct human pause / resume of an ad or ad set on both the
customer app and the ops console, plus archive / delete for operators only.
Before this, the *only* way an object changed state was an approved engine
recommendation; a management product that can't manually turn an ad off is
missing table stakes.

**Source of truth:**
- Core: `server/src/controls/manual-controls.ts` (`setObjectStatus`, `assertOwnedByCampaign`)
- Types + test double: `server/src/controls/types.ts` (`ControlWriter`, `FakeControlWriter`, `ManualObjectStatus`)
- Meta writes: `server/src/meta/campaign-adapter.ts` (`setAdStatus`, `setAdSetStatus`)
- Customer routes: `server/src/routes/controls.ts` (`/api/app/controls/*`)
- Operator routes: `server/src/routes/admin.ts` (`POST /admin/campaigns/:id/objects/:action`)
- Client: `web/src/api.ts` (`getControlState`, `setObjectPaused`, `adminObjectControl`)
- Screens: `web/src/app/Home.tsx` (`AudienceDetails`), `web/src/admin/AdminMeta.tsx` (`ObjectControls`)

**Lock-in tests:** `server/src/controls/manual-controls.integration.test.ts` (11),
`server/src/routes/controls.integration.test.ts` (12).

---

## The three-actor authorization model

This is the part worth understanding; the rest is plumbing.

| Actor | Action | Authorization |
| --- | --- | --- |
| **Engine** | proposes a change | the customer must approve it (AIC-23 → AIC-12) |
| **Customer** | pause/resume their own object | **self-authorized** — no second gate |
| **Operator** | pause/resume/archive/delete | logged to the admin audit; destructive actions confirm-to-type |

A customer pausing their own ad **is** the authorization. Adding an approval
step there would be incoherent — approval exists because *the engine* proposed
something, and there is no engine here. So the product promise ("nothing
changes without approval") is preserved rather than weakened: engine-proposed →
customer approves; customer-initiated → already authorized.

Resume deserves a note: turning something back **on** starts spending money.
For a customer that's still self-authorization. For an **operator** it's
spending someone else's money — allowed (it's a management product), but
audited, and surfaced in the customer's own history like any other change.

## Why not the SafeExecutor

`SafeExecutor` (AIC-12) is recommendation-bound at every step — it loads a
recommendation, checks `state === "approved"`, keys external-change detection
and read-back verification off `rec.type`/`rec.targetMetaId`, and closes by
transitioning the recommendation's state. Reusing it here would mean inserting
a **fake** `recommendations` row and walking it through `proposed → approved`
purely to satisfy the machinery — inventing an approval that never happened, in
the one part of the system whose value is that its records are true.

Instead this follows the shape AIC-63's `activateOne` established, which is
already per-object and non-recommendation:

```
read current status
  → already at target?  → no-op (no write, no log)
  → write
  → read back and verify
  → log to action_history
```

Same discipline as the launch gate (AIC-53) and additions (AIC-63): validate →
write → verify → log, never silently succeed.

**Idempotency for free.** An absolute-set status write is naturally idempotent,
so checking current status first means a retry after a partial failure never
double-writes or double-logs. No outbox needed (unlike the builder's creates,
which genuinely aren't idempotent).

**A DELETED object that stops being readable counts as applied** — Meta often
stops serving a deleted object entirely, and treating that as a verification
failure would report a successful delete as broken. Every other status must
read back as the value we set, or the action is reported failed and logged as
`result='failed'`.

## Ownership: a client-supplied Meta id is never trusted

`assertOwnedByCampaign` lists the campaign's live children and membership-tests
the supplied id — the same pattern as AIC-63's `POST /additions/ad`. The
campaign itself always comes from the caller's own JWT, never the request body.
This also means an ad id can't be passed where an ad-set id is expected.

## Caller-supplied status — and why it doesn't break the invariants

`setAdStatus` / `setAdSetStatus` are the **only** writes in the adapter that
take a status from the caller. Two deliberate invariants live right next to
them and are unaffected:

- create-writes hardcode `PAUSED` (AIC-50) — nothing can be born spending
- `activateCampaign` / `activateAdSet` / `activateAd` hardcode `ACTIVE`
  (AIC-53/63) — the engine and approval paths cannot pass a status

Manual controls are the first legitimate reason for a caller-supplied status,
because the caller is a human acting on their own object. The adapter says so
in a comment so a future reader doesn't mistake it for erosion of the rule.

## Archive vs delete

Archive (`ARCHIVED`) is recoverable and keeps history; delete (`DELETED`) is
permanent. The UI leads with **archive** and treats delete as the deliberate
harder option. Both are:

- **operator-only** — there is no customer-facing destructive route at all
  (asserted by a test that expects 404 on `/api/app/controls/delete`)
- **confirm-to-type** — the request must echo the object id back, enforced
  **server-side** so a bypassed client changes nothing. Same bar AIC-44 set for
  hard-deleting a customer, which is a strictly larger action.

Gate: `requireAdmin` (the whole admin router) — deliberately not
`requireFullAdmin`, which its own comment reserves for operator-account
management. The existing precedent is that deleting an entire customer needs
`requireAdmin` + confirm-to-type; archiving one ad shouldn't need more.

Once archived/deleted, the object drops out of counts, audience comparison and
needs-attention automatically via AIC-65's `isManaged` filtering — the write
and the read-layer filter are two halves of one behaviour.

## The first action that writes BOTH logs

An operator pausing a real ad is simultaneously a **console action** and a
**Meta campaign change**, which nothing else had been:

- `action_history` — campaign-scoped, customer-visible through `condense()`,
  written inside `setObjectStatus` for customer and operator alike
  (`human_involved = true`, `recommendation_id NULL`)
- `admin_audit_log` — console-scoped, operator actions only, written at the
  route layer

Cross-reference is by campaign id, which both record. Note
`admin_audit_log.entity_id` is a **UUID** column and Meta ids are not UUIDs, so
the audit entity is our campaign with the Meta object id carried in
`entity_label` / `detail`.

New `action_type` values (and their `SUMMARY_HE` entries in
`services/action-history.ts`): `pause_ad`, `pause_ad_set`, `resume_ad`,
`resume_ad_set`, `archive_ad`, `archive_ad_set`, `delete_ad`, `delete_ad_set`.
These are kept distinct from the engine's `pause_creative` even though both end
in a paused ad — the history reads better when "you paused this" and "we
recommended pausing this" don't share a label.

## The headline state catches up immediately, not on the next tick (AIC-71)

Found live the same day AIC-71 shipped: a customer paused their only ad set
and Home kept reading "פעיל" — `managed_campaigns.delivering`
([customer-overview.md](customer-overview.md)) was only ever recomputed on
the hourly engine tick, so a customer's own action left the headline stale
for up to an hour. Both `POST /pause`/`/resume` (customer) and
`POST /campaigns/:id/objects/:action` (operator) now call
`refreshDeliveryNow` (`services/delivery-monitor.ts`) right after a write with
outcome `"changed"` — a real Meta re-read (`getDeliveryHealth`) + persist,
reusing the exact same computation as the engine tick, not a separate code
path. Best-effort: a failure here is logged and swallowed, never surfaced as
if the pause/resume itself had failed — that write already succeeded and was
already verified by `setObjectStatus`.

**The server-side fix alone wasn't enough — found immediately after shipping
it.** The DB updated instantly, but Home still needed a full page reload to
show it: `AudienceDetails`' `onToggle` (`Home.tsx`) refreshed the per-row
`ctl` state (`getControlState()`) but never invalidated the shared overview
cache (`overview-store.ts`) that the headline "מצב" and מודעות פעילות count
actually read from. Fixed by calling `invalidateOverview()` after a
successful toggle — the same pattern AIC-53's launch-approval flow already
uses to leave its own stale state. Lesson: a synchronous backend recompute is
only half the fix when the frontend caches its own read separately.

## Customer surface

`AudienceDetails` on Home (the opt-in AIC-37 details panel) is the only
customer surface with per-ad-set and per-ad rows carrying real Meta ids, so the
controls live there. Copy in `strings.he.app.home.controls`.

**Live status, deliberately.** Opening the panel also calls
`GET /api/app/controls/state` — one live Meta read of ACTIVE/PAUSED per object.
The readout surfaces (`customer-overview`, `campaign-audiences`) stay DB-only by
design, but a *cached* status would render a button that lies about what it
does. One live call behind an explicit user action is the same rule that
justifies the ops explorer's live reads (AIC-45). After any change the state is
re-read rather than assumed.

Pausing an ad set stops every ad under it — the UI says so before the click
rather than letting the customer discover it.

## Operator surface

`AdminMeta.tsx`'s explorer tree already renders per-ad-set and per-ad cards with
ids and the **raw** `effective_status` (not the collapsed active/paused of
`getCampaignState`), so it can tell ARCHIVED from PAUSED and drive the right
button. After any write the tree is re-fetched — the explorer is
fetch-on-demand with nothing cached at rest, so a refresh shows Meta's truth
immediately rather than an optimistic guess.

## Not done here

- **No live dogfood against a real ad yet.** Every test uses a fake writer or a
  mocked `fetch`. Pausing a real customer ad is a consequential live write and
  is gated on explicit human go-ahead, same as the rest of the P1 surface.
- Bulk actions (pause all ads in an ad set in one click) — the per-object
  primitive supports it, no UI asks for it yet.
