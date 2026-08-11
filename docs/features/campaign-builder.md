# Campaign builder (P1 — create campaigns)

**Status:** in progress. AIC-49 (recommended-defaults spec) is **live**.
AIC-50 (Meta create-writes), AIC-51 (creative handling), AIC-52 (guided
builder UI), and AIC-53 (launch gate) are **planned** — this doc's later
sections fill in as each lands.

**Source of truth:**
- Recommended-defaults spec: `shared/src/recommended-defaults.ts`

**Lock-in tests:** `shared/src/recommended-defaults.test.ts`.

---

## Why this is P1, not P0

P0 manages a customer's **existing** campaign (PRD §7) — the engine reasons
over what's already running, but a human (the founder) still walks each
customer through creating that first campaign in Ads Manager by hand, which
is exactly what happened for GelNails. This phase replaces that manual
walk-through with a guided in-product builder — the thing that lets the
product create a customer's *first* campaign itself, not just optimize one
that already exists.

## How it works today

### Recommended-defaults spec (AIC-49)

The single documented source of truth for what the builder recommends at
every step, in `shared/src/recommended-defaults.ts` — consumed by both the
server and the web app (it's in the shared workspace, same as `money.ts`),
so no UI component hardcodes an opinion independently. Every value here is a
**recommendation**: overridable in the builder (AIC-52), never a hard
constraint — except the three P0-fixed choices, which the builder won't even
present as a choice:

| Fixed choice | Value |
| --- | --- |
| Objective | `OUTCOME_LEADS` (`FIXED_OBJECTIVE`) |
| Buying type | `AUCTION` (`FIXED_BUYING_TYPE`) |
| Destination | WhatsApp (`FIXED_DESTINATION`) |

**Structure** (`RECOMMENDED_STRUCTURE`): 1 ad set, 3–5 ads — the AIC-38
single-ad-set ideal, presented here as what it's always been: a
*recommendation*, never an assumption the engine or review may rely on. A
customer can and does run more ad sets (audience splits are normal, not
exceptional — see [DATA_MODEL.md](../DATA_MODEL.md)).

**Placements** (`RECOMMENDED_PLACEMENTS`): Advantage+ (automatic), with the
"narrowing raises cost" rationale carried alongside it.

**Budget** (`RECOMMENDED_BUDGET_AGOROT_PER_DAY`): a ₪30–50/day range, ₪40
recommended, framed honestly as a *starting point to gather data* — not a
guaranteed-exact number (real CPL varies too much by category/creative to
claim precision we don't have).

**Special Ad Category** (`SPECIAL_AD_CATEGORY`, `RECOMMENDED_SPECIAL_AD_CATEGORY`):
Meta's compliance mechanism for campaigns touching credit, employment,
housing, or social issues/elections — restricted targeting is legally
required for these. The recommended default is always `NONE`, and the
builder must ask the question explicitly every time
(`SPECIAL_AD_CATEGORY_QUESTION`) — this is never silently inferred from the
business category. `SPECIAL_AD_CATEGORY_HINT` maps a handful of our known
categories (currently just `real_estate` → `HOUSING`) to a likely category,
but a hint only prompts a more careful honest answer; it never sets the
declaration itself.

**Business-category → audience defaults** (`CATEGORY_AUDIENCE_DEFAULTS`,
`resolveAudienceDefault`): age range, gender, and a local-radius
recommendation per business category (`BUSINESS_CATEGORY` — a small, curated
set of common Israeli-SMB categories, not a taxonomy: beautician, fitness,
tutor, restaurant, home_services, retail, health_wellness,
professional_services, real_estate). `customers.category` (migration 002)
stays free text, set by the operator during manual onboarding (AIC-44) — it
is **not** validated against this list at the DB layer, so
`normalizeBusinessCategory` case/whitespace-normalizes and resolves anything
unrecognized to `other`'s honest broad default rather than guessing or
throwing. Each category default carries a one-line plain-Hebrew rationale.

### Forward reference: first-campaign review (AIC-18/38)

AIC-49 asks this spec to be "referenced by" the first-campaign-review
"rebuild to standard" language ([ops-console.md](ops-console.md)). Today's
review UI is three outcome buttons (approve / changes-requested /
unsupported) with no rendered checklist yet, so there's no concrete UI hook
to wire this into right now — this is a forward reference: once the review
UI grows detailed "rebuild to standard" copy, it should pull rationale
strings from here rather than re-writing them.

### Planned: AIC-50–53

- **AIC-50 — Meta create-writes**: `createCampaign`/`createAdSet`/`createAd`
  on the adapter + `ExecWriter`, always created `PAUSED`, idempotent via the
  AIC-13 outbox pattern, with defined partial-failure reconcile behavior.
- **AIC-51 — Creative handling**: upload image/video or select an existing
  IG/FB post → a Meta ad creative; per-ad copy; recommends 3–5 separate ads.
- **AIC-52 — Guided builder UI**: the step flow implementing "recommended +
  why + expand to change" on every step, reading from this spec.
- **AIC-53 — Launch gate**: PAUSED → first-campaign review → customer
  approval → activate, as an approved write through the safe-execute
  pipeline (AIC-12) — no builder path may activate directly.
