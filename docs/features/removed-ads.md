# Removed ads — the customer's "delete", and Meta's

**Status:** live. The customer can remove a **paused** ad from their own view;
it is restorable. An ad an operator archived or deleted at Meta leaves the same
view, and is not.

**Source of truth:** `server/src/controls/hidden-ads.ts`,
`server/src/services/campaign-audiences.ts`,
`server/src/services/ad-meta-cache.ts` (the tombstone),
`server/src/db/migrations/048_hidden_ads.sql`, the `/hide` `/unhide` routes in
`server/src/routes/controls.ts`, `AudienceDetails` + `RemovedAdRow` in
`web/src/app/Home.tsx`.

**Lock-in tests:** `server/src/services/hidden-ads.integration.test.ts`.

---

## Why this is not Meta's archive

The obvious implementation was to call Meta's archive. It cannot be used. From
Meta's own status guide:

> An `ARCHIVED` object has only two fields you can change: `name` and `status`.
> You can also only change `status` to `DELETED`.

**There is no un-archive** — not in Ads Manager, not through any API, ever. A
customer-facing remove built on it could never offer a restore, which is the
larger half of what this feature is for, and it would hand a non-expert a
permanently irreversible write to their own ad account. (Meta's own UI hides
this: the "delete" button in Ads Manager actually archives.)

So the customer's remove is **ours alone**. The ad stays `PAUSED` on Meta,
untouched, and "removed" is a row in our database. Meta's real
`ARCHIVED`/`DELETED` stay operator-only, in the Meta explorer
(`/admin/meta`) behind `requireAdmin` + confirm-to-type.

## Two ways an ad leaves the view, one bucket, one difference

| Reason | What happened | Restorable |
| --- | --- | --- |
| `by_customer` | removed here; Meta never saw it | **yes** — a DB delete |
| `gone_at_meta` | an operator archived/deleted it at Meta | **no** |

They share one "removed" bucket in the UI because to the customer they are the
same event, and differ in exactly one place: whether a restore button is
offered. Offering one for `gone_at_meta` would be a button that cannot work.

`gone_at_meta` **wins when both apply**, and the order is deliberate: the reason
that decides what the customer can *do* beats the reason that merely explains
how the ad left.

Deliberately not split into archived-vs-deleted. Once Meta stops listing an
object we cannot tell which it was, and inventing the distinction would be
guessing at a fact we don't have.

## The tombstone — how "gone at Meta" became visible at all

An ad archived at Meta used to stay in the customer's panel forever, because the
per-ad rows are built from stored `insight_snapshots`, which outlive the Meta
object and carry a frozen status. `upsertAdMeta` made it worse by **hard-
deleting** the cache row the moment Meta stopped reporting the ad, discarding
the only evidence it was gone — so the row fell back to the stale snapshot
status and rendered as a live ad.

The prune is now a tombstone (`ad_meta.gone_at`). AIC-65's rule — a dead ad must
not stay visible — is preserved by *filtering* rather than by deleting. A bonus
that the hard delete could not offer: an ad that reappears in a later Meta
response simply clears `gone_at`, so a transient API miss or a pagination edge
**self-heals** instead of permanently discarding the row.

## Pause-first, enforced on the server

Remove is offered only on a paused ad, and `hideAd` re-checks it against a
**live** Meta read.

A disabled button is a suggestion; this is the rule. Removing a running ad is
the one genuinely expensive mistake this surface could allow — the ad would be
invisible **and still spending**. A cached status would let exactly that case
through, which is why the check does not use our own cache.

Restore brings the ad back **paused**, because that is simply what it still is
on Meta. Restoring never resumes spending; the customer resumes it explicitly
afterwards. That matches the house invariant that nothing goes live without a
deliberate act (AIC-50/53) and makes restore a genuinely safe button.

## The numbers do not move — and the panel says so

**Nothing about removal touches ingestion or Meta.** Every `insight_snapshots`
row the ad ever produced stays exactly where it was, so every total in the
product is byte-identical before and after: the campaign KPIs, the ad-set rows,
the admin readout, the fleet stats. A pinned test asserts the stored rows are
untouched, because if hiding could reach ingestion, every historical figure in
the product would be rewritable from the UI.

The consequence has to be surfaced rather than swallowed. **An ad set's total
still includes the removed ad**, so its visible creative rows no longer sum to
it. That gap is reported explicitly — `removedCreativesCount`,
`removedSpendAgorot`, `removedLeads`, in the *selected* window so the two
actually reconcile — and rendered under the toggle as
*"ההוצאה והלידים שלהן נספרים בסיכום של הקהל למעלה: ₪X · Y לידים"*.

An unexplained gap in the arithmetic is exactly the kind of thing that makes a
customer stop trusting the numbers, so the rule is: never let the rows silently
fail to add up.

An ad removed before it ever recorded data is listed as removed but contributes
**zero** to those figures — there is no gap to explain, and counting it would
imply money that never existed.

## The operator's view is never filtered

`/admin/meta` and the admin readout show every ad, removed or not, with full
numbers. `perCreative` comes from `store.creativeStats`, a separate method that
never consults `hidden_ads` — pinned by a test, so a future refactor merging the
two read paths has to notice.

A support call that opens with "my ad disappeared" is unanswerable if the
operator's own view disappeared it too. Every hide/restore also writes an
`action_history` row (`hide_ad` / `unhide_ad`), and that row records **our
visibility**, not a Meta status — claiming a status transition would be a lie,
since Meta's status is deliberately unchanged.

## Keying

`hidden_ads` is keyed `(campaign_id, meta_ad_id)`, not on the ad id alone. A
Meta ad id is globally unique in practice, so a bare primary key looks
equivalent — but every read and write here is campaign-scoped, and a key
narrower than that scope silently disagrees with it: one campaign's row blocks
another's insert, and `ON CONFLICT DO NOTHING` reports that collision as
"already hidden" rather than as the anomaly it is. The integration tests, which
reuse ad ids across campaigns, caught this.

## Known gaps

- **The Meta explorer does not badge a customer-removed ad.** An operator can
  see it in the action history but not inline on the row. Worth adding if
  support questions come up.
- **A pre-existing archived ad has no tombstone.** Rows hard-deleted before this
  migration are simply gone from `ad_meta`, so such an ad still renders from its
  snapshots with a stale badge. Only ads archived from now on get the tombstone.
- **Ad sets have no equivalent.** Remove applies to ads only; a customer with a
  dead audience still sees it.
