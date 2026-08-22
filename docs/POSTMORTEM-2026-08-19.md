# Postmortem — 2026-08-19: the builder's first real onboarding call

**Status:** reference. Not a spec — nothing here defines behaviour. Behaviour
lives in the owning docs under [features/](features/); this records how a day's
worth of failures were found, what was actually true, and which mistakes are
worth not repeating.

**What happened, in one line:** an operator tried to build a real customer's
first campaign, and hit **eight** separate walls in a row. Every one was real.
Most were ours.

---

## 1. Meta facts we got wrong by reasoning instead of measuring

Each of these was first answered confidently and incorrectly, then settled by a
probe. **The probe is the useful part** — it is repeatable next time.

### Instagram rides on the ADS grant, not on `instagram_*` scopes

Claimed twice, wrongly: first "the token lacks `instagram_basic`", then "the
Meta App has no Instagram use case, so no token can carry it". Both were
reasoned from how Instagram *usually* works. Neither survived contact.

The truth: once the customer grants partner access to the **ad account**, the
Instagram account attached to it is readable with the ads grant alone. The
production System User token contains **no `instagram_*` scope of any kind**
and reads it fine.

```bash
# scoped per ad account — no instagram_* scope needed
curl -s -G -H "Authorization: Bearer $TOKEN" --data-urlencode 'fields=id,username' \
  "https://graph.facebook.com/v21.0/act_<ID>/instagram_accounts"
```

Two accounts returned different results on one token, which is what proved the
edge is genuinely scoped rather than permission-masked.

**Lesson:** the layer that grants access is not always the one you would
predict. `REQUIRED_SCOPES.instagram` had been written from reasoning and was
wrong in the harmful direction — on a *failing* read it blamed layer 3 and told
the operator to rotate a production secret, for what is usually a typo.

### `promote_pages` only lists Pages the account has **already advertised through**

The Page picker took three attempts:

1. `me/accounts` — every Page the System User can manage, **across all
   customers**. It offered one customer's Page while another's ad account was
   selected.
2. `{ad_account}/promote_pages` — correctly scoped, but **empty for every
   brand-new account**, i.e. broken exactly in the create-first-campaign flow it
   was meant to serve.
3. The union of same-business Pages ∪ `promote_pages` — what ships.

### `is_transient` is not trustworthy

Meta rate-limited us on 2026-08-22 with:

```json
{"code": 17, "error_user_title": "Ad Account Has Too Many API Calls",
 "error_user_msg": "…Please wait a bit and try again.", "is_transient": false}
```

A pure rate limit — the textbook transient error, whose own message says to
retry — flagged `is_transient: false`. This matters because `is_transient` was
the candidate signal for "roll back only on terminal failures" and for
AIC-105's transient-vs-real error category. **Do not build either on this flag
alone.**

### An empty array is not always "none"

`{"data":[]}` can mean *no such objects* or *you cannot see them*. The tell is
the contrast: unauthorized reads on these edges return an explicit
`(#100)`/`(#10)` error, so a clean `200` with an empty array is informative.
That distinction was load-bearing more than once and is worth checking rather
than assuming in either direction.

### Pixel stats can be aggregated by URL

```bash
curl -s -G -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'aggregation=url' --data-urlencode 'start_time=...' \
  "https://graph.facebook.com/v21.0/<PIXEL_ID>/stats"
```

Useful, **but it does not prove what you might want it to.** It was used to
infer a campaign's landing page; the user correctly pointed out that a React
SPA firing `PageView` only on initial load records every visit as the entry
URL, so "156 fires, exactly one URL" is a property of the instrumentation, not
evidence about the ads. Pixel data is also not ad-attributed — it includes
organic traffic in the same window.

### `DELETE /{id}` is the same call for a campaign, an ad set and an ad

One adapter method covers all three (`GraphCampaignAdapter.deleteObject`).

---

## 2. Prerequisites Meta enforces that **none of our checks can see**

The onboarding wizard verifies *our* access to the customer's assets. These are
not about our access, so all five steps can pass green and the build still
fails. Both now appear as a warning at step 1.

| Prerequisite | Meta's response |
| --- | --- |
| WhatsApp Business number connected to the **Page** (not merely installed on a phone) | *"Your Page is not linked to a WhatsApp account…"* |
| Active payment method on the ad account | *"Update payment method: Visit the Billing and payment center…"* |
| `targeting_automation.advantage_audience` explicitly `0` or `1` | *"you need to enable or disable the Advantage audience feature"* |

**Both prerequisites fail loudly, and both fail LATE** — at the ad-set create,
after the entire builder wizard has been filled in. Late is the cost, not
silence. (This doc briefly claimed the payment one fails *silently*; that was
asserted without verification and was wrong — see §4.)

---

## 3. Bug patterns in our own code, with instances

These recurred often enough to be worth naming as classes.

### A. A guard that never runs, or measures the wrong thing

- **`assertWithinBudget` had exactly one caller** — the recommendation path.
  Nothing bounded a campaign *create* at all.
- Worse, `campaign-create.ts` **wrote** `agreed_budget_agorot` from the same
  input the ceiling was supposed to constrain. The ceiling authorised itself, in
  both directions: a build *under* the agreed figure silently ratcheted the
  customer's agreement **down**, and every later recommendation was then
  measured against a number nobody agreed to.
- The completeness check (AIC-103) ran at provisioning, but Branch A provisions
  the *connection* with no campaign and the builder creates the campaign
  afterwards — so **the one path that produces new campaigns was the one path
  whose end state was unverified.** Both a missing `website_url` and a missing
  WhatsApp number sailed through.

**Check:** for any invariant, grep its callers. "There is a function for it" is
not "it runs on this path."

### B. A passing test defending the bug

`campaign-create.integration.test.ts` asserted
`agreed_budget_agorot === 4000` after a build — i.e. it encoded the
ceiling-overwrite as *expected behaviour*. That is most of why the bug survived
a covered path. A second test asserted the resume-on-Meta behaviour that
stranded a live campaign.

**Check:** when a bug lives somewhere tests already reach, ask whether a test is
holding it in place. Both were **rewritten to the new contract**, not patched.

### C. A refusal that lies about its cause

Our precondition failures surfaced as **`502 "failed to build campaign"`** —
"Meta is broken" — for problems entirely on our side. On a live call that sends
an operator to inspect Meta instead of filling one field.

Now: `409` with distinct codes, because the fixes differ.

| Condition | Code |
| --- | --- |
| no ceiling ever agreed | `budget_ceiling_missing` |
| proposed above the ceiling | `budget_over_ceiling` |
| required destination field missing | `campaign_config_incomplete` (+ `missingFields`) |
| Meta itself refused | `meta_write_refused` (+ Meta's own title/message) |

The outbox deadlock had the same shape: a row at `status='succeeded'` with
`result=NULL` is resolvable by nothing — `checkSettled` needs a result, the
claim needs `pending` — yet it reported *"create already in progress — retry
shortly"*, **false on both counts**, forever.

### D. Validation at the end instead of at the field

The wizard accepted ₪40/day against an agreed ceiling of ₪20 and refused on the
**final click**, after every remaining step had been filled in. The ceiling was
known from provisioning the whole time.

Same shape as the prerequisites in §2: the information existed long before the
moment of refusal.

### E. A design whose premise expired underneath it

AIC-50 deliberately kept partial creates as **resume points** — defensible
*only* while creates were PAUSED. AIC-106 made them ACTIVE the same day, and
every resume point silently became a **live object in a customer's ad account**.
It then happened for real.

The ticket had asked for rollback all along; the implementation read
"reconcilable" as *resume*. **Nobody rechecked the premise when the other ticket
changed it.**

Now: rollback deletes everything the failed attempt created **and** purges that
build's outbox rows. Skipping the second half is not rollback — the outbox
remembers real Meta ids, so deleting on Meta alone makes the next attempt resume
onto ids that no longer exist.

### F. Stale artifacts that read as verified fact

In one day: three docs, one Linear AC, two tests, and several UI strings all
asserted things that were no longer true — including a review screen that said
*"everything will be created paused, no money spent until you approve"*
directly above a new card saying the opposite.

This is why `CLAUDE.md` now carries: **if your change makes another ticket's
acceptance criteria false, correct that ticket in the same unit of work.**
AIC-106 *predicted* it would invalidate AIC-105's criterion and shipped anyway.
Predicting staleness is not discharging it.

---

## 4. Process failures — mine

Recorded because they cost real time and are repeatable.

- **Asserted "a missing payment method fails silently"** without checking, and
  wrote it into product copy where it read as verified. It fails loudly. Same
  class as §1: reasoned, not measured.
- **Poisoned a real customer's build with my own test runs.** `drainOnce`'s
  SELECT was unscoped (`WHERE status='pending' AND next_attempt_at <= now()`),
  integration tests run against the **shared production database**, and the
  drain swept up a live customer's half-finished build, applied it with a
  *fake* writer, and marked it succeeded with no Meta id. Proven by two rows
  updated **65ms apart**. Creates now never drain — a correctness rule
  regardless of tests, since `apply()` returns void and structurally cannot
  record a created id.
- **Verified deploys by curling the wrong thing.** `ads-agent.co.il/` serves the
  static landing page; it returns `200` even if the SPA is broken. The app is at
  `/app`, `/admin`, …
- **A test that hit the real Meta API**, because it did not stub `fetch` before
  its setup calls.
- **An `else if` that swallowed a block** belonging only to the other branch.
  Typecheck passed; the logic was inverted. Caught by re-reading the diff, not
  by the type system.
- **Reported "pre-existing" as if it were "accepted"** — a correct diagnosis
  that silently reads as a decision to tolerate. Distinct things.

---

## 5. Two distinctions that kept collapsing

Both are now in `CLAUDE.md`, because each collapsed more than once in a day.

- **"Unverified" ≠ "not done."** Reporting an unchecked criterion as satisfied
  is how a spec drifts from production.
- **"Pre-existing" ≠ "accepted."** A growing set of tolerated failures is how a
  baseline moves without anyone choosing it. (AIC-109.)

---

## 6. Still open

- **Integration tests run against the shared production database.** The deeper
  cause of the poisoned row, and of the recurring `__it_*` pollution and timeout
  flakes. AIC-84 (Neon branch isolation) / AIC-109.
- **AIC-105's error-handling section** — only the "Meta API failure" slice is
  built, and only for errors Meta already labels. The symptom-table translation,
  the 409/state-conflict category, transient-vs-real retry UX, and inline
  pre-submit validation are not.
- **Ten `e.message` passthroughs** in the wizard put raw server strings in a
  Hebrew operator UI.
- **Two inert corrupt outbox rows** on already-built campaigns, left rather than
  deleted from production unasked.
- **`REQUIRED_SCOPES.instagram = ["ads_management"]`** is deliberately the
  minimal claim, not proven minimal — isolating it needs variant tokens.
- **Advantage audience is OFF**, which may cost delivery on small budgets. A
  deliberate choice to match what the wizard promises; revisiting it means
  changing the promise **first**, then the flag.
