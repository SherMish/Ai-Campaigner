# Profile quality gate — do we know enough to advertise this business?

**Status:** live. Runs on the hourly engine tick, before generation.

**Source of truth:** `server/src/services/profile-quality.ts` (the judgement),
`server/src/services/profile-monitor.ts` (persist + ops item),
`server/src/db/migrations/051_profile_quality.sql`, the `profile_incomplete`
branch in `classifyNoAction`, and `web/src/admin/profile-badge.ts` for the
wizard badge.

**Lock-in tests:** `server/src/services/profile-quality.test.ts`,
`web/src/admin/profile-badge.test.ts`, the `profile_incomplete` cases in
`rules.test.ts`.

---

## The question nothing else asks

Six health checks ask whether a campaign's **numbers** can be trusted. This one
asks whether **our own homework** is done — and it is the only check that reads
no Meta data at all, because the missing information was never Meta's to give.

Measured when it shipped: three of five customers had every business field
blank, including the only one spending money.

## Why it comes before anything that generates

**The failure is invisible in the output.** Hand a copy generator
*"12 שנות ניסיון, מלווים עד החתימה"* and it writes something specific. Hand it
nothing and it writes *"שירות מקצועי ואמין, צרו קשר עוד היום"* — equally
fluent, equally confident, worthless. You cannot tell from the ad which input it
had, so every downstream feature degrades silently while still producing
polished-looking work.

Build the generator first and you evaluate it on output it never had the inputs
to produce well.

## Presence is not the check

`geo_area = "Israel"` is technically an answer, passes any is-it-filled test,
and for geo targeting produces exactly the country-wide spend that wastes the
budget. So the gate is about **specificity**.

| State | Meaning |
| --- | --- |
| `broken` | no offer, or no differentiators — the ad could only compete on price, the worst competition a small business can pick |
| `thin` | filled but uninformative: country-only geo, a two-word offer, a category with no service, an audience of "כולם" |
| `ok` | enough to write from |

**Rules only, deliberately.** They catch the blatant cases for nothing. A real
specificity judgement needs an LLM pass at capture time, and that is a separate
decision rather than a hidden dependency of this one. Where the rules cannot
tell, they answer `ok`: a false alarm nags an operator about a profile that is
actually fine, and that erodes the signal faster than a missed one.

One consequence worth stating: *"כל הארץ (שירות מרחוק, בלי תלות במיקום)"* is
**not** flagged, while *"ישראל"* is. Same fact, but the first says it on
purpose — and nagging someone who already explained themselves is how a check
gets ignored.

## `profile_incomplete`, and where it sits

The engine can now say *"I have nothing to propose because nobody told me what
this business sells."* That is **not** `collecting` — "still gathering data" is
false, and it sends an operator to watch a dashboard when the fix is a
five-minute phone call.

Its precedence is the design:

```
account_cannot_spend → delivery_blocked → tracking_broken
  → lead_event_stopped → cta_broken → profile_incomplete → collecting → …
```

**Below** everything that costs money right now — a dead button wastes 100% of
spend every hour, a thin profile costs nothing today. **Above** every
evidence gate, because those all mean "wait for more data from Meta", which is
the wrong instruction here.

Only `broken` suppresses. `thin` is a nudge; withholding every recommendation
from a paying customer over a missing price range would be absurd.

## Operator-first

The **badge in the onboarding wizard** is the part that earns its keep at five
customers: it updates live as the operator types, and names the missing fields
rather than scoring the profile — *"70% complete"* tells nobody what to ask
next, *"חסר: הצעה, במה שונים ממתחרים"* does, while the customer is still on the
phone.

That badge is a deliberate **second implementation** of the rules, client-side.
The server's verdict remains the one of record — it drives suppression, the ops
item and the no-rec reason, and is computed from what was actually stored. The
badge is a live hint about text that has not been saved yet. Both are pure
functions, tested on both sides, and if they disagree the server wins by
construction because nothing downstream reads the badge.

The ops item is **medium**: nothing is on fire and no money is being wasted, but
every copy feature is blocked on it, so it must not sit at the bottom either.
Only `broken` raises one — an item per imperfect profile would bury the queue.

**It never halts a campaign.** Like over-count detection, it informs and
suppresses.

## Known gaps

- **`thin` is a judgement call**, and the rules only catch blatant cases. A
  two-word offer is caught; a plausible-but-generic paragraph is not.
- **Customer-facing copy exists but is deliberately gentle**, and the specific
  missing fields are never shown to the customer — only to the operator.
- **The badge can drift from the server.** Mitigated by tests mirroring the same
  cases, not by sharing code: the shared-module version would have to live in
  `shared/`, which is a bigger change than this ticket warranted.
