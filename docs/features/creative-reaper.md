# Orphaned creatives — the ones that never became ads

**Status:** live. Runs on the hourly engine tick. Deletes only creatives **we**
created, aged past a day, and confirmed referenced by no ad.

**Source of truth:** `server/src/services/creative-reaper.ts`,
`GraphCampaignAdapter.listAdCreativeIdsInUse` / `deleteCreative`,
`server/src/db/migrations/049_created_creatives.sql`, the record call in
`createCreativeIdempotent`, the tick wiring in `server/src/index.ts`.

**Lock-in tests:** `server/src/services/creative-reaper.integration.test.ts`.
`server/src/meta/run-reaper-once.ts` runs the same tick immediately instead of
waiting the hour — identical code path and identical guards, it only changes
*when*.

**Proven live** on 2026-08-25: 21 orphans adopted and reaped on a real ad
account, 0 failures, verified by re-reading the account (0 creatives remaining).

---

## The leak

Building an ad on Meta is two calls:

```
POST act_…/adcreatives   → creative id     the content
POST act_…/ads           → ad id           content + ad set + status
```

The UI makes the creative as soon as that step is filled in, **on purpose**:
Meta validates it there, so the customer gets real errors before committing to
anything. The cost is that anything stopping them before submit — an abandoned
session, a validation failure downstream, a blocked flow — leaves a creative
behind that nothing references.

Found live on a real ad account: **21 orphaned creatives across four separate
days, against zero ads.** Every one from a session that didn't reach submit.
Nothing had ever reaped them because nothing was watching.

They cost nothing — a creative with no ad cannot deliver, spend, or appear in
any report — so this is tidiness, not damage control. It is worth doing because
an unbounded pile of debris in a customer's ad account is the kind of thing that
eventually gets noticed by the customer.

## Three conditions, each ruling out a different disaster

| Condition | Rules out |
| --- | --- |
| **we created it** (`created_creatives` has the id) | deleting a creative the customer made themselves in Ads Manager — theirs, possibly kept for reuse |
| **it is old** (>24h) | deleting one made moments ago by a customer still filling in the form |
| **no ad uses it** (fresh Graph read at reap time) | deleting the content out of a live ad |

All three, or it stays.

**Why a table rather than asking Meta.** An adcreative exposes no
`created_time`, so age is unknowable from the API — and "orphaned" alone is not
a licence to delete, because a creative made seconds ago is also unreferenced.
Age is the only thing separating *abandoned* from *in progress*, and only we can
know it. The table doubles as the safety boundary: the reaper can only ever
touch ids it recorded.

**The in-use check is never inferred from `attached_at`.** Ads can be created
outside our flow, and one attached elsewhere would still read as unattached to
us. `attached_at` is an optimisation that settles the common path immediately;
the Graph read is the authority. If that read fails, the reaper deletes
**nothing** — without it there is no way to tell an orphan from a live creative,
and the failure mode of guessing is destroying a running ad.

## Recorded at the funnel, not the routes

`createCreativeIdempotent` is the single path every creative goes through — the
customer builder, add-content, and the admin builder all call it. Recording in
the three routes instead would leave the leak open the moment a fourth caller
appears, which is exactly how the `isManaged` filter ended up wrong at three
separate call sites (AIC-130).

The record is best-effort: a bookkeeping failure must never fail a creative the
customer has already successfully created on Meta. Missing a row costs one
uncleaned creative — the same state as before this existed.

## Failure handling

A failed delete is left **unmarked**, so a transient Graph error simply retries
next tick. A creative Meta has already removed will answer 400 forever, which is
noisy but harmless — and far better than marking a deletion that never happened.

The tick logs nothing when there are no candidates. On a healthy account that is
every hour, and a log line saying "0 reaped" trains people to skip the logs.

## The back catalogue

Leaks that predate the table have no row and are invisible to the reaper — by
design. `server/src/meta/backfill-orphan-creatives.ts` adopts them: for each ad
account we manage it lists the creatives, lists the ones any ad references, and
records the difference with a backdated `created_at` so the next tick collects
them.

**Ownership is asserted by a human, never derived** — `BACKFILL_IDS` is an
explicit allowlist and nothing outside it is adopted. Without it the script only
reports, which is the form in which it is actually useful: a list for a person
to read and choose from. It never deletes anything itself.

The first version inferred ownership instead, on the reasoning that an account
we manage contains creatives we made. **The dry run listed 54 candidates, of
which 33 were the customer's own** — ad copy from 2022-10, "AI Radar" creatives
from 2025-03, their own 2026-06 campaigns, all predating this product. Applying
it would have queued four years of a real business's advertising history for
irreversible deletion.

The lesson generalises past this script: the reaper is safe *because* it can
only touch ids it recorded, and any tool that reconstructs that set from
inference gives back exactly the safety the boundary was providing.

## Known gaps

- **The real fix would be not creating the creative until submit**, which would
  make the leak impossible rather than cleaning up after it. Not done: the
  current step is what gives the customer per-creative validation from Meta
  before committing, and moving it would either lose that or need the whole
  builder flow restructured.
- **What "deleted" means on Meta.** Verified live on 21 real creatives: after
  the DELETE the account's `adcreatives` edge returns **0**, but a direct query
  by id still returns the object and its name. Same semantics as a deleted ad —
  gone from every listing, still addressable if you already hold the id. So the
  reaper removes creatives from the account's inventory; it does not erase them
  from Meta's storage, and nothing here should be described as if it did.
