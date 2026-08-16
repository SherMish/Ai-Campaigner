# State → copy mapping (AIC-98)

**Status:** live — every customer-visible enum binds to its copy through an
exhaustive `Record`, so a new variant without a message is a `tsc` failure
rather than a blank card someone finds in a screenshot. This is the
enforcement half of CLAUDE.md's **"Never render a blank where a reason
exists"**; the rule itself lives there, this doc describes the machinery.

**Source of truth:**
- Copy maps: `web/src/app/state-copy.ts` (`ATTENTION_COPY`, `HOME_STATE_BADGE`,
  `NO_REC_COPY`, `noRecCopy`)
- Exhaustiveness guard: `shared/src/assert-never.ts` (`assertNever`)
- The enums: `web/src/api.ts` (`HomeState`, `AttentionKind`, `NoActionReason`),
  mirroring `server/src/services/customer-overview.ts` and
  `server/src/recommendations/rules.ts`
- Consumer: `web/src/app/Home.tsx` (`hero`, `noRecCard`)

**Lock-in tests:** `web/src/app/state-copy.test.ts` (7). These run in CI via
`npm run test:unit`, which now includes the web workspace (it previously ran
shared + server only — a test nobody runs enforces nothing).

---

## Why a map and not a switch

The same defect shipped on four separate surfaces (AIC-64/85 no-rec reasons,
AIC-89 launch destination, AIC-95 audience panel, AIC-97 מצב badge) and each
was found by a customer in a screenshot. Every one had the same shape: the
code one layer down knew the reason and it never reached the screen.

A `switch` with a `default:` is how that happens quietly. `hero()` and
`noRecCard()` both had one, so a brand-new state fell through to "everything
is fine" — a state that means *something is wrong* rendering as *all good*.
The `Record<Enum, Copy>` removes the fallback: the compiler now lists the
missing variant by name.

## The three layers

1. **`Record<Enum, Copy>`** — a missing key fails `tsc` at the map.
2. **`assertNever` at every switch** — a missing branch fails `tsc` at the
   switch. Verified: adding a `HomeState` variant produces
   `Argument of type '"suspended"' is not assignable to parameter of type 'never'`.
3. **`state-copy.test.ts`** — `Record` accepts a key filled with `""` or
   pasted from the case above it, and the type system cannot see either.
   The test asserts every variant's copy is non-empty and **distinct**.

## Distinctness is on title+body, not badge

Badges are severity labels and legitimately repeat — all three `attention`
causes wear `צריך טיפול`. What must stay distinct is the title+body pair,
because that is what the customer reads and acts on, and the three causes
have *different fixes*: a lost connection is theirs to reconnect; a delivery
problem and broken tracking are ours. Collapsing them destroys the only
actionable part. Two reasons may share a title when their bodies differ
(`stable` and `no_comparable_audiences` both open "אין כרגע משהו שצריך
לעשות") — the body carries the distinction.

**Do not weaken this test to make a new variant pass.** If two variants
genuinely want the same message, they are the same variant.

## Copy still lives in strings.ts

`state-copy.ts` holds the reason → copy **binding**, never the Hebrew itself
(the house rule that all user-facing text lives in `web/src/strings.ts` is
unchanged). The binding is the part that rots silently: `strings.ts` cannot
tell you a key is missing.

## What's covered today

`HomeState`, `AttentionKind`, `NoActionReason`, and, since AIC-100,
`AdDeliveryState` (`web/src/app/delivery-status.ts` — the פירוט panel's
per-ad status pill: delivering / paused by you / blocked by a paused ad set
/ blocked by a paused campaign). Deliberately narrow — this ticket set the
standard rather than retrofitting every surface at once.

`NoActionReason` gained customer copy for `delivery_blocked` and
`tracking_broken` in the same change. Both route the campaign to the
`attention` hero before the no-rec card renders, so neither is reachable
today — but "unreachable" is a routing detail a refactor can change silently,
and the rule is that every reason owns its copy. Their previous behaviour was
the generic "we're watching the campaign" fallback, which for those two was
false: we are not simply watching, something is broken and we know what.

**Joining this contract when they land as real union types:** the
lead/destination type (AIC-87/89, currently a bare `string` in
`shared/src/recommended-defaults.ts`) and `measurement_trust` (AIC-94).
`DeliveryState` (`server/src/meta/delivery-health.ts`) is operator-facing
only and reaches the customer solely via `attentionKind`, which is covered.
