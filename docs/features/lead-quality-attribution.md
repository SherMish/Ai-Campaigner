# Lead-quality attribution (AIC-133)

**Status:** live. Reads the customer's own lead-quality reviews (AIC-67) and,
where it can honestly do so, judges audiences on **cost per RELEVANT lead**
instead of cost per lead.

**Source of truth:**
- `server/src/services/lead-quality-attribution.ts` — the judgement, pure.
- `server/src/services/lead-quality-source.ts` — the DB half (reviews + windows).
- `server/src/recommendations/rules.ts` → `pauseUnderperformingAudience`.
- `server/src/recommendations/explainer.ts` → `pauseAudience(..., basis)`.

**Lock-in tests:**
- `lead-quality-attribution.test.ts` — attribution, thresholds, zero-relevant.
- `rules.test.ts` → "pause_adset — quality-adjusted comparison (AIC-133)".
- `explainer.test.ts` → "the copy names which basis was used".

---

## The bug this fixes

The engine ranked audiences on CPL, and **cheap leads are very often the wrong
leads**. A broad audience pulls browsers: CPL drops, and the engine scales
exactly the audience the customer is complaining about — while proposing to
pause the narrow audience that actually books work.

Shape of it, from the ticket:

| audience | leads | CPL | relevant | cost per REAL lead |
| --- | --- | --- | --- | --- |
| A (broad) | 24 | ₪22 | 4 | **₪132** |
| B (narrow) | 12 | ₪48 | 10 | **₪58** |

On CPL alone, B looks 2.2× worse and gets paused. On relevant leads, B is the
better audience by a wide margin, and pausing it is the mistake.

## Why there is no apportionment

The obvious design — split each review's relevant/irrelevant counts across the
ad sets that were live, in proportion to their leads — **is worse than useless.**
Proportional splitting gives every ad set the same relevance rate, so cost per
relevant lead becomes CPL × a constant, which **reorders nothing**. It would
change no decision while wearing a quality label, which is the exact failure the
philosophy calls "looks like progress".

So attribution is deliberately strict: a review counts **only when exactly one
ad set produced leads in its window**. Everything else is reported as
`unattributable` and simply doesn't exist for ranking purposes.

## The window

A review covers everything since the previous review — that is what AIC-67's
`leads_delta` already means. The first review's window opens at the campaign's
first recorded data. Windows are day-resolution (reviews carry a timestamp,
snapshots are daily), so a review recorded mid-day attributes that whole day.

Spend is summed over the **same** days (`day <= last review date`). Dividing
reviewed relevant leads by lifetime spend would inflate cost-per-relevant by a
different factor per ad set — silently reordering the comparison this exists to
get right.

Leads and spend come from `insight_snapshot_daily`, never the raw table, which
mixes per-day and rolling rows (migration 030).

## When it is allowed to decide

Both thresholds must hold, per ad set:

- `MIN_QUALITY_REVIEWS = 2` — one review is an anecdote, and a single divergent
  period must not pause an audience.
- `MIN_QUALITY_LEADS = 5` — enough leads behind the rate to mean anything.

Only **usable** verdicts enter the map. An ad set with one review is *absent*
rather than present-with-weak-data, so a consumer cannot act on it by forgetting
to check a flag.

The rule then requires quality on **BOTH** sides of the comparison. Comparing
one audience's quality-adjusted cost against another's raw CPL is comparing two
different units and would produce confident nonsense. With one side missing, the
engine falls back to CPL — and says so.

Zero relevant leads yields `costPerRelevantAgorot: null`, ranked as worse than
any finite cost, rather than letting `Infinity` into arithmetic.

## What the customer sees

The basis travels with the recommendation (`evidence.basis`) and the Hebrew copy
branches on it — "based on your feedback about lead quality" vs "based on lead
volume only — we don't yet have enough feedback on quality". Recommendations
written before this ticket have no `basis` and read as volume-only, which is
what they were.

Copy is framed as **targeting**, never as blame: "this audience brings leads
that fit your business less often", not "your leads are low quality".

## Known limits

- Single-ad-set campaigns produce a usable quality figure but no comparison, so
  nothing changes for them. Correct, but it means most campaigns today are
  unaffected — as of writing, one live campaign has usable quality data and one
  ad set.
- Attribution is all-or-nothing per review. A campaign whose ad sets always run
  concurrently will never accumulate quality data. That is honest silence rather
  than an invented number, but it is a real coverage gap.
- Reviews are self-reported and unverifiable. Cost per relevant lead is only as
  good as the customer's own reading of their leads.
