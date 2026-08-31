# docs/STATE.md — dated changelog

Newest first. One `### YYYY-MM-DD — <title>` block per change: **what changed and
why**. Append a block; never edit an existing line. Behaviour is specified in the
owning doc under [features/](features/), not here.

## Changelog

### 2026-08-31 — AIC-158: the dashboard called an unbuilt campaign "live"

Found on a real customer. The wizard's connect-only branch writes a shell
campaign and hands off to the builder; that build was abandoned, so
`meta_campaign_id` was NULL and nothing existed on Meta. `deriveHomeState`
never asked, so the row fell through every branch to `collecting` and the
customer read "הקמפיין פעיל ואנחנו ממשיכים לעקוב" with ₪15 ביום and פניות 0 —
which beside a live badge reads as "my ads run and nobody calls". New
`unbuilt` HomeState (badge, hero, tooltip, CTA to the builder), the rail card's
budget and leads render "—" when there is no campaign to describe, and the
admin wizard's step 5 stops saying "האשף הושלם" for a healthy connection with
no campaign behind it. add-content had this right all along via
`classifyConnectionReadiness`. The overview fixtures were setting no
`meta_campaign_id` at all, so every homeState assertion in that file had been
made against a shell row — the tests were defending the bug; they now seed a
linked campaign and the two that care about absence clear it explicitly.

---

### 2026-08-31 — AIC-157: campaigns can finally target a place

Every ad set we had ever created targeted all of Israel — not by choice, but
because no screen offered one and all three write paths defaulted to
`countries: ["IL"]`. The audience step disclosed it honestly, which made it a
known limitation rather than a hidden bug, and did not make it any cheaper for
a local business on ₪15/day. There is now a city/region picker on the shared
`AudienceFields` — so the customer builder, the admin builder and add-content
all get it — backed by Meta's own `search?type=adgeolocation`, localized
server-side through the same map the dashboard's audience labels use. The
critical rule, locked in by tests at both the unit and adapter level: chosen
cities REPLACE `countries` inside `geo_locations`, never accompany it, because
Meta unions those fields and sending both would target the cities plus the
whole country while looking correct everywhere but the bill. Nothing existing
is retargeted.

---

### 2026-08-31 — AIC-155: the builder's ad preview showed our CRM name, not the Page

Reported from the existing-post step: the preview header read "Liam Aboros"
with a grey initial, while the connected Page was `am nails`. `AddContent` had
always fed the shared `AdPreview` from the real Page; `Builder` fed it
`customers.business_name` and no picture at all. New `GET {builder}/page` on
both builder routers, degrading to nulls so a decorative read can never break
the step. Filed AIC-156 for the related, larger gap found while diagnosing it:
a connected `instagram_id` is stored and health-checked and then never used —
no IG posts in the picker, and no `instagram_actor_id` on any Meta write.

---

### 2026-08-30 — AIC-154: one naming convention for what we create on Meta

There was none — six call sites built names inline. Every self-serve campaign
was literally named "Ads Agent" (`strings.he.appName`); ad sets were
`${campaign} — קהל 1` with a hardcoded 1; ad indices were counted per drafting
session, so add-content dropped a second `מודעה 1` into an ad set that already
had one. `server/src/meta/naming.ts` is now the only place any of the three is
built: `Ads Agent · וואטסאפ · 2026-08`, the audience label itself for ad sets
(sharing `composeAudienceLabel` with the dashboard so the two cannot drift),
and `מודעה n` continuing from the ad set's live names on Meta. Create-time
only — nothing existing is renamed, and adopted campaigns keep the customer's
own names.

---

### 2026-08-30 — wizard: "צור קמפיין חדש" was disabled with no reason given

Reported live: Page picked, budget filled, button dead and the screen silent.
The blocker was an Instagram account selected but never checked. Its disabled
expression listed four conditions, `startNewCampaign` re-checked the same four
in its own order, and the render explained two of them — and a disabled button
cannot reach the guard that knows, so nothing could say why. `newCampaignBlocker()`
is now the single ordered list all three read, and the reason is always printed.

---

### 2026-08-30 — wizard: the new-campaign toggle rendered twice, in the wrong column

The escape hatch shipped earlier today was pasted twice and both copies sat as
direct children of step 4's `auto-fit` grid, so each took its own column: the
same link appeared under the ad-account field and again under the Facebook-page
field, belonging visually to neither. It now lives inside the campaign field,
directly under its select, once. Also suppressed "לא נמצאו קמפיינים בחשבון
הפרסום הזה" in the forced-new case, where it contradicted the populated select
above it. The behaviour it describes was undocumented; the owning section in
[features/ops-console.md](features/ops-console.md) now covers both the scoping
and the toggle.

---

### 2026-08-30 — wizard: step 4 scoped to the verified ad account, and a way to build a new campaign

Two operator-reported gaps. (1) Step 4 listed EVERY ad account the System User
can reach — another customer's included — guarded only by a "בשימוש גם עבור X"
note, on the step that writes the connection everything else is built on. It now
offers only the account verified for that customer, and says why; if that
account is missing from the fetched list it falls back to the full list rather
than leaving a required field that cannot be filled. (2) An account with
campaigns made adopting one the only reachable path, though the builder always
supported creating another and Meta never objected. Adopting stays the default,
with an explicit escape hatch both ways.

Also fixes a test that leaked rows into production: the mass-assignment guard in
customer-profile renames the attacker's own row to "hacked" (correct — they
renamed themselves), which no longer matched the `LIKE '__it_prof_%'` cleanup,
so every run left an orphan behind, seeded `is_test = false` and therefore
counted as a real customer. Two such rows were deleted from production. Cleanup
is now by id, fixtures are `is_test = true`, and the sibling isTest test was
inverted to send `false` — the dangerous direction, and the only one that can
still fail once fixtures are seeded true.

### 2026-08-30 — Instagram was invisible in the wizard even when correctly connected

The IG picker asked only `{ad_account}/instagram_accounts`. That link is real
but empty for accounts connected the way Meta connects them today, so an
operator who had done everything right saw an empty dropdown and no reason why.
It now also reads `{page}?fields=instagram_business_account` for the account's
Pages and unions the two — verified live: the ad-account edge stayed `[]` while
the Page edge returned `@liam_handstylist`, so the old code would still have
shown nothing. Needs no Page token and no `instagram_*` scope. The empty-state
copy now names the real checks in order, including that Business Settings →
Connected assets is NOT sufficient — the exact trap this took an hour to find.
Also fixes the integration tests broken by the `usedByCustomer` change, whose
fixtures turned out to be REAL production ids and so collided with live data.
Owning docs: [docs/META_SETUP.md](META_SETUP.md),
[docs/features/ops-console.md](features/ops-console.md).

### 2026-08-30 — onboarding wizard: say when a Page is already taken, and why one is missing

Two gaps found while onboarding a second customer onto an ad account another
customer already uses. (1) The Page/IG pickers said nothing when an option was
already connected elsewhere — the old reasoning was that the columns are not
unique so there is "no conflict", which is true of the database and useless to
the operator. Both pickers now annotate the option and raise a bold red warning
on the selected one, naming the other customer; never blocked, because the
constraint really does not exist. (2) A Page the operator expected was missing
with no explanation, looking identical to "this account has one Page". A Page
appears only if the System User has a role on it AND it belongs to the ad
account's Business; the picker now states both and points at Business Settings.
Owning doc: [docs/features/ops-console.md](features/ops-console.md).

### 2026-08-30 — the app's WhatsApp link was a placeholder on every screen

`components.tsx` exported `WA = "https://wa.me/972500000000"` behind a TODO — a
fictional number — and 13 "talk to us" links across onboarding, connect,
checkout, recommendations, settings, review, add-content and auth all read it.
For a product whose onboarding and support are deliberately human, that is the
support channel itself being broken, and silently: a wa.me link to an unused
number opens WhatsApp and goes nowhere. Now the landing page's real number
(972526964069), with a test that fails if it becomes a placeholder again or
drifts from the landing page's copy — the landing is static HTML and cannot
import the constant, so the duplication can only be held together by a check.

### 2026-08-30 — Campaign troubleshooting and Meta Pixel guides (AIC-153)

The Hebrew guides section gained two practical search-focused articles for the
questions that appear after a campaign launches: why an active campaign has no
leads, and how to prove a Meta Pixel is measuring the real completion event.
The diagnosis starts with delivery, routing and measurement before suggesting
creative or audience changes, while the Pixel guide distinguishes a loaded
PageView from one successful lead event and covers duplicate events without
promising perfect attribution. Both guides include primary Meta sources,
cross-links, FAQ schema, honest product CTAs and original 1200x630 artwork.
Owning doc: [docs/features/guides-blog.md](features/guides-blog.md).

### 2026-08-30 — Checklist hook becomes a save-post tag (AIC-152)

The checklist carousel's first slide now presents `שמרו את הפוסט` in a compact
sharp-corner tag with a bookmark icon. It reads as the familiar Instagram save
action instead of another rounded CTA, while the other hook formats remain
unchanged. Owning doc:
[docs/features/content-studio.md](features/content-studio.md).

### 2026-08-29 — AIC-28 (part): Mixpanel wired, funnel measured server-side

The customer funnel is instrumented, and the design decision is where it fires:
every event is emitted from the code path that performs the real state
transition, after the row is written — never from a click. That is PIS-27's
lesson, which AIC-28 carries as an explicit requirement. The value moment is
`recommendation_approved`, and it carries `execution_outcome`, so an approval
whose Meta write failed is not counted as one that worked. PII is dropped by a
pattern-based scrubber rather than by call-site discipline, `is_test` keeps our
own accounts out of the funnel, and `ip: false` removes the only personal data
Mixpanel collects by default. HALF THE TICKET REMAINS: the four operational
metrics (human minutes per customer, intervention rate, accounts per operator)
need an operator-entered capture mechanism and are not built. Owning doc:
[docs/METRICS.md](METRICS.md).

### 2026-08-30 — Checklist warning slide loses its false button (AIC-151)

The checklist carousel's fifth slide no longer renders the fixed orange
`עצרו ובדקו` pill. It looked interactive and competed with the warning without
adding information. The warning copy and final free-start CTA remain unchanged.
Owning doc: [docs/features/content-studio.md](features/content-studio.md).

### 2026-08-27 — AIC-150: a network blip told a customer we lost their Meta account

Live on אבשלום's account: `access 'ok' → 'needs_reconnect' (network error
verifying ad_account: fetch failed)`. A transport error says nothing about
access — only that we could not ask — but `needs_reconnect` is customer-facing:
it puts "איבדנו גישה לחשבון Meta" and a reconnect CTA on the dashboard, raises a
high-severity alert, and halts execution. Every other health check in the engine
already separates `broken` from `unknown`; this was the one that didn't, and the
one that shouts. Transport failures, Meta 5xx and rate limits are now `unknown`,
which writes nothing and re-asks next tick, while a definite revocation still
alarms on the first look. Adding the type immediately exposed the mirror bug —
an unknown scored below `ok` in `worstHealth`, so it would have silently cleared
a REAL prior revocation. Owning doc:
[docs/features/meta-connection.md](features/meta-connection.md).

### 2026-08-27 — Landing acquisition moves to WhatsApp (AIC-149)

All six public acquisition links now open a conversation with the real Ads
Agent WhatsApp number instead of composing an email. Fit-check, joining and
general-contact actions carry short matching Hebrew messages and open in a new
tab, while login and legal navigation remain unchanged. Owning doc:
[docs/features/landing.md](features/landing.md).

### 2026-08-27 — Diverse rotating hero creatives (AIC-148)

The landing hero phone now rotates through four fictional local businesses -
nails, Pilates, dog grooming and a ceramics workshop - instead of presenting one
static example. The set includes women and men, keeps all messages and action
labels in accessible HTML, and uses a relevant CTA for each business. The
platform/destination chips, example label and one-time setup fee were removed.
Reduced-motion visitors see a stable first creative, and the optimized carousel
assets total under 1 MB rather than loading the multi-megabyte sources. Owning
doc: [docs/features/landing.md](features/landing.md).

### 2026-08-27 — Hebrew Meta lead-campaign setup guide (AIC-147)

The guides section gained a complete Hebrew tutorial for small businesses
setting up a Meta lead campaign for WhatsApp or a website. It explains the
campaign, ad-set and ad decisions, operational prerequisites, measurement,
budget reasoning, creative checks and post-launch verification without copying
unsupported learning thresholds or universal budget formulas. The article uses
primary Meta references, original 1200x630 title artwork, SEO metadata, FAQ
schema and a product CTA that makes no performance promise. Owning doc:
[docs/features/guides-blog.md](features/guides-blog.md).

The same evidence pass corrected the existing budget guide: fixed 3-5x budget
rules, exact learning durations and automatic-reset claims were replaced with
unit economics, an explicit test budget and decisions based on actual spend,
relevant leads and the business's capacity to respond.

### 2026-08-27 — Honest landing-page positioning (AIC-146)

The landing no longer sells an unproven recommendation engine as full campaign
management. It now leads with the operational value Ads Agent can deliver today:
guided setup, delivery/measurement monitoring, a simple Hebrew dashboard and
human support. Fabricated recommendation, WhatsApp, result and stepper UI was
removed; pricing moved to one dedicated section after the value story. A clearly
labelled fictional local-service creative now occupies the hero phone. The
customer dashboard screenshot considered for product proof was not published
without explicit approval, and no fake dashboard replaced it. SEO copy now
targets the supported Facebook/Instagram lead-campaign intent without promising
growth or lower CPL. Owning doc:
[docs/features/landing.md](features/landing.md).

### 2026-08-26 — 50-post Instagram idea bank (AIC-142)

Organic marketing no longer starts from a blank topic list. A new editorial
backlog contains 50 concise Hebrew post ideas for Ads Agent's Israeli small-
business ICP, distributed across the three Content Studio formats and the real
problems the product handles. The ideas deliberately stop before full copy so
claims and examples can be researched when each post is produced. Owning file:
[docs/marketing/instagram-post-ideas.md](marketing/instagram-post-ideas.md).

### 2026-08-26 — Compact CTA and aligned checklist geometry (AIC-142)

The final CTA no longer occupies a generic 466px pill. Its width follows the
actual action copy and includes a left-pointing arrow inside the button. On
check and numbered slides, the badge, title, body and footnote now share the
same right edge instead of stepping left by 56px. Focused geometry tests and a
browser render lock the corrected compositions. Owning doc:
[docs/features/content-studio.md](features/content-studio.md).

### 2026-08-26 — AIC-143 (second pass): most of the time, no hero at all

The first pass kept a card for every state and improved its sentence. Wrong
lever: a full-size card is a claim on the customer's attention, and "nothing
should change right now" has no such claim to make. The lead countdown was the
clearest symptom — it made the product sound like a counter, promised that four
more leads would produce an answer (which may be false), and explained the
engine instead of helping the customer. `HERO_TONE` now classifies every reason
as problem / action / quiet; quiet renders one line — "אין כרגע שינוי שמצדיק
פעולה · הקמפיין פעיל ואנחנו ממשיכים לעקוב" — with the evidence behind an ⓘ.

### 2026-08-26 — AIC-143: the hero describes instead of judging

A slot that must contain a sentence fills with reassurance when there is nothing
true to say — which is how a campaign with ₪49 and one lead got told it was
fine. The hero now states the gap and then the threshold WITH its number
("נצטרך בערך ₪150 על כל מודעה"), returning null rather than inventing one where
no numeric gate exists. A facts line was built first and removed on sight: it
restated the KPI cards directly below it, which already lead with the facts. The no-reason fallback, previously the most assertive
copy in the product and backed by nothing, now just says the campaign is
running. Two rules added to CLAUDE.md: never render a verdict where evidence
does not exist, and create the Linear ticket before the commit so the id in the
message is one Linear actually assigned. Owning doc:
[docs/features/customer-overview.md](features/customer-overview.md).

### 2026-08-26 — AIC-145: the "collecting" hero now says what it is waiting for

"עוד קצת פעילות ונוכל להמליץ בביטחון" can sit unchanged for three weeks while
the customer has no idea whether anything is moving — and the engine had already
recorded exactly which evidence gate was unmet and by how much. The hero now
names the gate furthest from being met with real numbers ("עוד 4 פניות ונדע מה
לשנות · יש 1 מתוך 5"). Rendering it caught a contradiction it inherited: the
stored count says 0 while the KPI beside it shows 1, because the lead arrived
today and the engine evaluates complete days — so the copy now takes the
customer-visible count whenever it is higher. Owning doc:
[docs/features/customer-overview.md](features/customer-overview.md).

### 2026-08-26 — AIC-144: "add 3–4 ads" was advice the budget couldn't pay for

Spotted from the other side of a conversation about when to kill an ad: the
product tells every customer to run 3–4 ads regardless of budget, while the
engine refuses to judge a creative below ₪150 of spend. On the live ₪20/day
account those four ads get ₪5/day each and reach that bar in a month apiece — a
structure the product could never form an opinion about. `affordableAdCount`
now derives the number from the budget and the account's own spend bar, clamped
to [2, 4], and the copy states the count and the wait ("2 ads, about 15 days")
instead of a flat range. Also removed the complete-days note from the hero
entirely, at the user's call — a caveat that needs re-explaining twice is not
earning its place. Owning doc: [docs/RULES.md](RULES.md).

### 2026-08-26 — Stronger carousel CTA and cleaner RTL hierarchy (AIC-142)

All final slides now end with the direct `התחילו בחינם` action instead of a
descriptive brand phrase. Small top-right eyebrow labels were removed from every
slide layout so they no longer compete with the main message, and checklist
number badges moved to the right to match the Hebrew reading direction. Tests
cover every layout and browser rendering confirmed the final compositions.
Owning doc: [docs/features/content-studio.md](features/content-studio.md).

### 2026-08-26 — Checklist count and hook-label alignment (AIC-142)

The checklist carousel no longer promises four checks while its opening artwork
shows only three. It now contains exactly three checks from the opening headline
and numbered tiles through the editable fields, JSON contract and rendered slide
sequence. Hook-label copy is also centered vertically from the pill geometry
instead of relying on a top offset. Tests and browser rendering lock both fixes.
Owning doc: [docs/features/content-studio.md](features/content-studio.md).

### 2026-08-26 — One-paste JSON authoring in Content Studio (AIC-142)

Operators no longer have to copy a prepared post into every carousel field by
hand. Each of the three formats now exposes a copyable JSON contract; one pasted
object identifies its template and fills every text field in the correct slide.
The import is atomic and refuses malformed JSON, unsupported templates, missing
required content, non-text values, unknown/misspelled keys and text that would
overflow. Browser verification confirmed automatic myth-to-checklist switching
and that a rejected import leaves the previous draft untouched. Owning doc:
[docs/features/content-studio.md](features/content-studio.md).

### 2026-08-26 — Content Studio symbol and label alignment (AIC-142)

Screenshot review exposed four remaining visual defects in the useful-signal
carousel: its question motif crossed the footer, the `ידעתם?` pill was wider
than its content, the metric slide repeated `לפנייה`, and the action check used
top-aligned rather than truly centered geometry. The renderer now centers both
symbols from their containing shapes, keeps the question circle above the
footer, sizes hook labels from measured text and removes the redundant metric
unit. Focused geometry and slide-model tests lock the correction. Owning doc:
[docs/features/content-studio.md](features/content-studio.md).

### 2026-08-26 — Carousel visual hierarchy and readability correction (AIC-142)

The three Content Studio formats no longer share one interchangeable opening
slide. Myth, signal and checklist now have distinct compositions and color
hierarchies, while the small top-right hook eyebrow was removed so it cannot
compete with the headline. Screenshot review also exposed two geometry defects:
checklist numbers were drawn 54px away from the badge center, and dark CTA copy
could cross a dark decorative circle and disappear. Both are now locked by
renderer tests; the CTA also drops its redundant second image logo. Owning doc:
[docs/features/content-studio.md](features/content-studio.md).

### 2026-08-26 — Three reusable Instagram carousel systems (AIC-142)

Ads Agent's organic content no longer starts from a blank design. The internal
Content Studio turns structured Hebrew copy and optional images into one of
three editorial formats — myth correction, useful signal, or practical
checklist — each with a bold hook, legible content sequence and gentle branded
CTA. The 1080×1350 preview is the exact canvas used for PNG export, so a design
cannot look correct in the editor and change on download. Per-field limits
block export before text clips; image uploads are local, replaceable and
center-cropped without stretching. Sample posts speak to the Israeli
small-business ICP and demonstrate useful judgment before mentioning the
product. Owning doc: [docs/features/content-studio.md](features/content-studio.md).

### 2026-08-26 — AIC-78: the angle classifier was reading the body, not the claim

Review of the second live digest caught the tagging wrong on the one ad that
matters. "אל תהיו חמורים. יש דרך אחרת לנהל קמפיין." was filed as `price` because
its BODY mentions paying a freelancer thousands — but that is the setup being
argued against; the claim is a provocation plus an alternative. It is also the
only ad on that account that produced a lead (₪6), so the single data point
would have taught the wrong lesson. Fixed by adding a `contrarian` angle and by
making the headline decisive — the body now only votes when the headline commits
to nothing. Verdicts also carry `clear`/`weak` confidence, where weak means
another angle nearly tied rather than merely thin. Ads are named by their copy
everywhere, because printing the internal name made a readable ad look
unreadable. Owning doc:
[docs/features/creative-context.md](features/creative-context.md).

### 2026-08-26 — AIC-78 follow-up: an angle nobody funded was being called "tried"

Review of the first live Telegram digest caught a real bug. The Ads Agent
account's four ads had spent ₪26 between them with zero leads, and the context
reported "angles tried: price" — which would have excluded price from future
proposals permanently, on no evidence. Zero leads at ₪26 is the expected outcome
at that spend, not a result. Angles now carry their spend and are `tested` only
once they clear the engine's own creative-spend bar (₪150); below it they are
`attempted`, and every surface says so. Two smaller fixes from the same review:
the audience/area/service fields were missing from the context entirely, and the
Telegram truncation now cuts on a word boundary. Fixing this also exposed that
the spend was being read from `creativeStats`, which returns a 7-day rolling row
rather than a total — the same account reads ₪48 and one lead once summed over
the per-day rows. Owning doc:
[docs/features/creative-context.md](features/creative-context.md).

### 2026-08-26 — AIC-78: the creative context, shown where an ad is written

A per-customer assembly of the business facts (AIC-138), how good they are
(AIC-132), the copy that already ran, the ANGLE each ad took, what each achieved,
and lead quality per ad (AIC-133) — surfaced on the create-ad screen and sent to
the ops Telegram channel when a customer opens it. Assembled rather than stored:
a `creative_context` table would be a second copy of facts that already live on
`customers` and in the snapshots. The headline it produces is `singleAngle` —
"every ad you have run argues price" — which was true on two of the three real
accounts. The angle classifier is rules-based and returns null rather than
guessing; running it over live ads caught two Hebrew substring collisions
(`מבצע` inside `ומבצע שינויים`, `שנות` inside `לשנות`) and a price vocabulary
that missed the words Israelis actually use for cost. Owning doc:
[docs/features/creative-context.md](features/creative-context.md).

### 2026-08-26 — AIC-141: the ▲/▼ line ignored the range switcher

Found while dogfooding test@test.com: the KPI numbers followed the day/week/
month switcher but the movement underneath them didn't — it was one figure over
the engine's fixed 7-complete-day window, rendered under whichever range was
selected. On היום that meant "—" for the number with "▲20% מהתקופה הקודמת"
below it; on חודש, a month's total above a week's movement. The comparison is
now computed over the selected window and is **null** where an honest one isn't
available (today is partial; all-time has no before; a 30-day comparison needs
60 days and the per-day rows only reach back 45). Where it's missing for a
reason, the UI says why. Owning doc:
[docs/features/customer-overview.md](features/customer-overview.md).

### 2026-08-26 — AIC-133: audiences judged on relevant leads, not cheap ones

`pause_adset` ranked audiences on CPL, and cheap leads are very often the wrong
leads — a broad audience pulls browsers, CPL drops, and the engine proposed
pausing the narrow audience that actually books work. Where the customer's own
lead-quality reviews (AIC-67) give usable data for BOTH sides of a comparison,
the ranking is now cost per RELEVANT lead; otherwise it falls back to CPL and
the copy says so out loud. Attribution is deliberately strict — a review counts
only when exactly one ad set produced leads in its window — because the obvious
proportional split gives every ad set the same relevance rate and therefore
reorders nothing while looking like quality. Applies at both grains —
`pause_adset` and `pause_creative` — since the attribution is keyed on an object
id and doesn't care what the object is. Owning doc:
[docs/features/lead-quality-attribution.md](features/lead-quality-attribution.md).

### 2026-08-25 — Know when we don't know enough about the business (AIC-132)
Six health checks ask whether a campaign's numbers can be trusted. This one asks
whether OUR homework is done, and it is the only one that reads no Meta data at
all. Measured when it shipped: three of five customers had every business field
blank, including the only one spending money.

It matters because the failure is invisible in the output — a copy generator
handed nothing writes something equally fluent and completely worthless, so
every downstream feature degrades silently while still looking polished.

Presence is not the check: `geo_area = "Israel"` passes any is-it-filled test and
produces exactly the country-wide spend that wastes the budget. `broken` = no
offer or no differentiators (the ad could only compete on price). `thin` =
filled but uninformative. Rules only — an LLM specificity pass is a separate
decision, not a hidden dependency — and where the rules can't tell they answer
`ok`, because a false alarm erodes the signal faster than a missed one.

New `profile_incomplete` no-rec reason, placed BELOW everything that costs money
now (a dead button wastes 100% of spend hourly; a thin profile costs nothing
today) and ABOVE every evidence gate, because those all mean "wait for Meta" and
that is the wrong instruction when the missing data is ours. Only `broken`
suppresses; `thin` is a nudge.

The wizard badge is the part that earns its keep at five customers: live as the
operator types, naming the missing fields rather than scoring the profile —
"70% complete" tells nobody what to ask next. It is a deliberate second
implementation of the rules, client-side; the server's verdict stays the one of
record and nothing downstream reads the badge.

### 2026-08-25 — Ticket-id mapping for nine commits with wrong ids
Nine commits dated 2026-08-25 carry ticket ids that belong to **different**
tickets. The work had no ticket at all; the ids were invented while writing the
commit message, and Linear had meanwhile assigned those numbers to real,
unrelated tickets. History was not rewritten — the commits are pushed and
deployed, and rewriting master to fix a reference costs more than the confusion
it removes. Code comments and docs have been corrected; this note exists so the
commit messages stay discoverable rather than silently misleading.

| Commit message says | Actually is | The real ticket with that id |
| --- | --- | --- |
| `aic-132` — a8048ce, f10c344, 4b9d86a, 6a122dc | **AIC-136** add-content / ad-preview fixes | AIC-132 = profile quality gate |
| `aic-132` — a6eb500 | **AIC-137** additions attribution + stale delivery state | AIC-132 = profile quality gate |
| `aic-134` — 638afc5, 9db4bbf, 8f31b5a | **AIC-138** business profile capture | AIC-134 = unit economics |
| `aic-135` — 43b6144 | **AIC-139** ad-details modal | AIC-135 = funnel diagnosis |

The root cause is the one AIC-129 already names: **writing an id into a commit
before Linear has assigned it.** The rule going forward is create the ticket
first, read the id back, then reference it — and flip the status in the commit
that closes it.

### 2026-08-25 — Click an ad to see its full creative (AIC-139)
Clicking an ad in הצג פירוט opens its image, headline, primary text, button and
destination — the row's own title is the affordance, since the row already
carries pause and remove. One live Meta read per ad, on open: the panel already
makes two on open and pulling every ad's copy into them would pay for text
nobody asked to see. Ownership-checked, or it would be a read oracle for any ad
the system user can reach — another business's copy, image and destination
phone number.

**Read-only, and that is Meta's constraint rather than a shortcut.** Meta's own
reference lists `name` and `status` as the ONLY editable fields on a creative:
copy and image are frozen at creation, and the docs do not sanction swapping an
ad's creative afterwards either. The modal says so and points at the flow that
works — a new ad with the updated content, old one paused. An edit control would
either silently rebuild the ad (costing its learning and sending it back to
review) or fail against Meta after the customer had done the work.

Two bugs caught by rendering it: an uncapped image pushed the copy and both
buttons past the fold (1030px of content in a 720px viewport), and the button
showed the raw enum WHATSAPP_MESSAGE — the same raw-Meta-names problem AIC-73
fixed in the panel itself.

### 2026-08-25 — The business profile is editable by the customer too (AIC-138)
The same fields the ops console collects, now on /app/settings, populated from
the database. The customer is the authority on their own business and the first
to know when a differentiator or a price changes; the note above the form says
the copy is written from these answers, so it reads as what it is rather than a
contact form.

Same component as the admin form (`showIsTest={false}`), but NOT the same write
path. `updateCustomer` also accepts isTest, onboardingStatus,
agreedBudgetAgorot and rule-threshold overrides — reusing it behind a customer
route, even with those fields unrendered, would have let a customer POST
`isTest: true` and vanish from every billing figure, or retune the engine on
their own account. THE UI IS NOT THE BOUNDARY: `saveCustomerProfile` has an
explicit column whitelist and resolves the customer by joining from the caller's
user row, so no body key can redirect the write. Pinned by tests that post
isTest, onboardingStatus, thresholdOverrides and four id-shaped keys and assert
none of them lands.

Rendered and exercised as a customer before shipping: 14 fields, no internal
test flag, two edits saved and read back out of the database.

### 2026-08-25 — An "i" on every onboarding field, and five fields an AI actually needs (AIC-138)
Hints on every field, because how these are filled in decides their worth:
"שיפוצים" and "שיפוצי מטבחים בדירות ישנות בגוש דן" are the same field and
produce completely different copy. Each hint says what to write and gives an
example — an operator reads it live, on a call.

Five new fields, the first slice of AIC-78's creative context: differentiators
and objections (both named in that ticket as exactly what a founder tells you in
the first five minutes and had nowhere to live), plus price range, "what not to
say", and what happens after a lead. Each passed one test — would a copy
generator write MATERIALLY different copy with this? — and anything that failed
it was left out, because the wizard runs during a live call. "מה אסור להגיד" is
a safety rail rather than flavour: a generator with no constraints invents a
guarantee, and the liability lands on the customer.

TWO BUGS CAUGHT BY RENDERING IT, neither of which any test would have found.
The field components were defined INSIDE BusinessFields, so React remounted
every input on every keystroke and focus jumped to <body> after one character —
the form would have been unusable. And onChange rebuilt from the `form` prop, so
two edits in one tick lost one (reachable via browser autofill, which fills
name/phone/email together) — the same stale-closure fix BuilderCreatives needed
the same morning, reintroduced hours later in a new component.

### 2026-08-25 — The onboarding wizard opens with the business profile (AIC-138)
The wizard started at "שלב 1 — הלקוח משתף גישה", with the business profile
(category, main service, area, audience, offer, contact) living only on the
customer card — a separate screen. Backwards, because everything after it
depends on it: the builder's recommended defaults key off the category (AIC-49)
and the ad copy is written from the offer and the audience. Collecting it last
meant guessing on the call or leaving the wizard mid-flow.

Now the first card, seeded from the server — `GET /admin/customers/:id` already
returned all of it and the wizard just declared a narrower type. Seeding is not
only convenience: a blank form invites retyping what we know, and a blank field
saved over a real value is silent data loss on a live call.

Rendered and exercised in a browser before shipping, not just typechecked: card
order verified as profile → steps 1–5, a field edited, saved, and the new value
confirmed in the database, with no console errors. That is the practice the four
visual bugs earlier today were missing.

### 2026-08-25 — Security audit (ad-hoc, no ticket)
Full pass over authn/authz, tenant isolation, transport, and the usual attack
classes. Details in [features/security.md](features/security.md).

**Tenant isolation was already sound** and is now pinned by 14 cross-tenant
tests that send real authenticated requests from customer A carrying customer
B's identifiers. Every customer route resolves the acting customer from the JWT
and membership-tests any client-supplied id. No customer-facing budget write
exists at all.

**Three real defects, now fixed.** (1) TLS to the database was UNAUTHENTICATED —
`rejectUnauthorized: false`, under a comment claiming the opposite — so a
man-in-the-middle could read and rewrite every query. Verified against
production that full verification works before changing it. (2) No rate limiting
on authentication: credential grinding, and a bcrypt-12 CPU-exhaustion vector.
(3) No security headers at all: no CSP, no clickjacking protection, no HSTS.

Also: JWT algorithm pinned, JWT secret length-checked (production's was verified
to satisfy it BEFORE shipping the check, via a signature-parity probe that
authenticates as nobody), and `sslmode` stripped from the DB URL — it emitted a
deprecation warning and is scheduled to silently WEAKEN in pg v9.

The isolation test's first Meta mock answered yes to every id, which made the
victim's ad genuinely the attacker's as far as the ownership check could tell,
and turned five correct refusals into apparent 200s. A permissive mock does not
prove isolation; it manufactures ownership.

### 2026-08-25 — The dead submit button, and a preview that shows the real Page (AIC-136)
**"Created ad without choosing ad set. Didn't get an error. Was the ad created
or not?"** — reported live. It was not. The ad set radio was unticked, so the
button was disabled, and nothing said so while a green "התוכן מוכן ✓" sat
directly above it. Yesterday's fix covered "no ad sets exist" and left the
commoner case — ad sets exist, none picked — as the same silent dead end.

A single ad set is now selected automatically (with one option there is no
decision to make), and the button states what is missing. AIC-98's rule applies
to disabled controls too: a greyed button with no explanation IS a blank.

**The preview header shows the real Page name and profile photo.** It read
"העסק שלך" with a letter in a circle — a placeholder standing exactly where the
most recognisable thing about the ad belongs. The System User token cannot read
a Page's public fields ("(#10) requires 'pages_read_engagement' or Page Public
Metadata Access", verified live), but `me/accounts` returns a per-Page token
AND the name, so the name is free and only the picture needs a second call.
Best-effort: a failure falls back to the placeholder rather than breaking the
screen.

### 2026-08-25 — The reaper could not see archived ads (AIC-131 fix)
Found by the question "were the ads I deleted really deleted?". They were —
both `status: DELETED`, terminal — but checking exposed a defect in the reaper
shipped an hour earlier.

Its in-use check read `/ads` with Meta's DEFAULT filtering, which **excludes
archived ads**, while the comment directly above it claimed "includes ads of
every status on purpose: a PAUSED or ARCHIVED ad still holds its creative". The
comment asserted a safety property the code did not deliver — the worst kind of
wrong comment, because it invites the next reader to trust it.

Measured live: 8 ads by default, **18 with ARCHIVED requested**. Ten archived
ads were invisible, and every one of their creatives read as orphaned. On the
account we did NOT touch, ten of the thirty-three "orphans" were the content of
live archived ads. Fixing the query drops that account's orphan count from 33
to 23.

`DELETED` cannot be included at all — Meta refuses the request outright
(subcode 1815001) — so a creative whose only ad is deleted will always read as
orphaned. Deliberate and acceptable, since a DELETED ad is terminal, but
documented as a limit rather than left as an assumption.

### 2026-08-25 — First live reap: 21 orphaned creatives deleted (AIC-131)
Ran end to end on a real ad account, on the customer's explicit instruction.
21 adopted through the allowlist, 21 deleted, 0 failures, account re-read
afterwards showing 0 creatives remaining. First proof that `deleteCreative`
works against live Meta at all — until now it was covered only by a test double.

**Only 4 of the 21 were provably ours.** The outbox holds `create_creative` rows
for exactly four (23 and 25 Aug), each with the resulting creative id in its
`result`. The other 17 have no outbox row and no audit row, and the campaign has
existed unbroken since 18 Aug so nothing cascaded their records away. They were
deleted on the customer's explicit "terminate all of them" after that limit was
stated plainly — not on our own judgement that they looked like ours.

That matters as a precedent: the naming convention is NOT evidence of
authorship. A generated "מודעה 1" and a hand-typed one are indistinguishable,
and reading one as the other is what the backfill's first version did across an
entire account.

**What "deleted" means on Meta**, verified rather than assumed: afterwards the
account's `adcreatives` edge returns 0, but a direct query by id still returns
the object and its name — the same semantics as a deleted ad. Removed from the
inventory, not erased from storage.

The 33 orphans on the OTHER ad account were deliberately left alone: they are
demonstrably the customer's own work (ad copy from 2022-10, creatives from
2025-03, campaigns from 2026-06), and a scope named "all of them" in a
conversation about one account is not authority over a second.

### 2026-08-25 — Reap the ad creatives that never became ads (AIC-131)
Building an ad is two Meta calls — POST /adcreatives, then POST /ads. The UI
makes the creative as soon as that step is filled in, deliberately, because Meta
validates it there and the customer gets real errors before committing. The cost
is that anything stopping them before submit leaves a creative behind that
nothing references. Found live while answering "where are they?": **21 orphans
on one ad account across four days, against zero ads.**

Three conditions, each ruling out a different disaster: we created it (a row in
`created_creatives` — a creative the customer made in Ads Manager is theirs and
may be kept for reuse); it is older than a day (one made moments ago is a
customer mid-form, not litter); and no ad references it, re-read from Meta at
reap time. The in-use read is never inferred from our own `attached_at`, because
ads can be created outside our flow — and if that read fails the reaper deletes
NOTHING, since without it an orphan is indistinguishable from a live creative.

A table rather than asking Meta, because an adcreative exposes no `created_time`
— age is unknowable from the API and is the only thing separating abandoned from
in-progress. It doubles as the safety boundary: the reaper can only touch ids it
recorded.

Recorded in `createCreativeIdempotent`, the single funnel all three creative
callers share, rather than in the routes — recording per-route would reopen the
leak the moment a fourth caller appears, which is exactly how the `isManaged`
filter ended up wrong at three call sites in AIC-130.

Leaks predating the table are invisible to the reaper by design; a one-off
(`backfill-orphan-creatives.ts`) can adopt them so the next tick collects them,
and never deletes anything itself.

**Its first version inferred ownership and was wrong.** It adopted every orphan
in every managed account, reasoning that an account we manage contains creatives
we made. The dry run listed 54, of which 33 were the customer's OWN — ad copy
from 2022-10, "AI Radar" creatives from 2025-03, their own 2026-06 campaigns,
all predating this product. Applying it would have queued four years of a real
business's advertising history for irreversible deletion. Ownership is now
asserted by a human via an explicit `BACKFILL_IDS` allowlist; without one the
script only reports. The reaper is safe because it can only touch ids it
recorded, and reconstructing that set by inference hands back exactly the safety
the boundary was providing.

Not done, and the better fix: don't create the creative until submit, which
would make the leak impossible. It would cost the per-creative Meta validation
the customer currently gets before committing, or require restructuring the
whole builder flow.

### 2026-08-25 — The audience row has to survive its last ad (AIC-130 round 2)
Found live an hour after the AIC-130 fixes shipped. The tombstones were being
written correctly and the customer still saw no removed ads — because the whole
AUDIENCE ROW had vanished.

`upsertAdSetMeta` was fed only `isManaged` ad sets, and an ad set whose last ad
was deleted is not "managed". campaign-audiences iterates that cache, so
deleting an ad set's final ad erased the entire audience from הצג פירוט, taking
its ₪16.90 of spend history and both removed ads with it — while that same money
kept counting in the campaign totals directly above it.

The same `isManaged` conflation as the picker bug, at a third call site. The
cache and the engine want DIFFERENT sets: the engine excludes an empty ad set
because it has no evidence to contribute, and that is right; the cache drives
what the customer SEES, and whether an ad set currently has ads must not decide
whether the customer may see where their money went. Cache now takes
`existsOnMeta`, engine keeps `isManaged`. The audience badge follows — with
every ad removed it reads "לא מתפרסם · אין מודעה פעילה" instead of "מפרסם".

Also answered from the same investigation: the two ads the customer believed
they had created never existed. `pending_additions` was empty and Meta reported
zero ads — the submit button was disabled the whole time, so the green
"המודעה נוצרה" ticks were only creatives being prepared. That copy is now
"התוכן מוכן" (shipped in the previous commit).

The new engine test was verified to FAIL against the unfixed code before being
kept — the read-path test written first passed either way, because it seeds the
cache directly and never exercises what writes it.

### 2026-08-25 — Six live bugs from the first hour of dogfooding the removed-ads work (AIC-130)
**The blocker.** A customer deleted both ads from a live ACTIVE ad set, and the
add-an-ad screen then said "לא נמצאו קבוצות מודעות בקמפיין". The picker filtered
on `isManaged`, which is false for an ad set with ZERO ADS — AIC-65's
"never-published draft" heuristic. The one screen that could put an ad back
refused to list the only place it could go: the campaign was unrecoverable
through the UI while being perfectly healthy on Meta. `isManaged` now splits
into `isManaged` (has something to show) and `existsOnMeta` (is a real object);
the picker and the `POST /ad` guard both use the latter, in step, or the picker
would offer an ad set that submit rejects.

**The CTA alarm could never clear.** Told "the button in your ad leads nowhere",
the customer deleted both broken ads — the only fix available — and the alarm
froze: no ads left, so `summarizeCta` returned `unknown`, and `unknown` never
writes the flag, so `cta_ok` stayed false forever citing "2 of 2 ad(s)" that no
longer existed. Following our own advice made the warning permanent. An empty
list means a read that SUCCEEDED and found nothing to judge, so it is now
`not_applicable`, which settles and clears.

**The tombstone had no back catalogue.** Ads deleted before migration 048 were
hard-deleted from `ad_meta`, so they kept rendering as live rows off their
frozen snapshot status. `upsertAdMeta` now inserts tombstones for creatives with
snapshot history missing from Meta's current list — at ingestion, where `ads` is
proof, not in the read path, where "no cache row" is a guess that would hide
every ad on a campaign whose cache hasn't been built.

**"₪0" where we meant "we don't know".** No rows for today rendered "₪0 · 0
פניות" above a panel saying "אין נתונים לתקופה שנבחרה". `rangeHasData` now
travels with `ranges`; the cards show "—".

**An audience badged מפרסם with both its ads מושהה על ידך.** Same false-green as
AIC-100/71, one level up: the badge read only the ad set's own switch.

**"המודעה נוצרה" when no ad existed.** The badge fires when the Meta CREATIVE is
made. On a campaign with no selectable ad set that meant two green "the ad was
created" ticks, a greyed-out submit, and nothing on Meta or in the history — now
"התוכן מוכן", and the creative builder is hidden entirely when there is no ad
set, instead of letting the work happen and then greying out the button.

Also, both requested while testing: the file input is now a real dropzone
(drag-and-drop, immediate thumbnail) instead of the browser's English "Choose
File" chrome, and the creative step shows an ad preview — a deliberate sketch,
since Meta reformats per placement — chiefly so it is visible that the headline
is the small line UNDER the picture and the primary text the big one above it.

Two bugs were caught by the tests rather than by review: a `$1` used as both a
uuid and an untyped SELECT item, which would have thrown on every ingestion
tick, and an existing test that asserted the exact behaviour the blocker fix had
to reverse.

### 2026-08-25 — The customer can remove an ad; Meta's archive could not be used (AIC-128)
Meta's archive was the obvious mechanism and is unusable: "An ARCHIVED object
has only two fields you can change: name and status. You can also only change
status to DELETED." **There is no un-archive, through any API** — so a
customer-facing remove built on it could never offer the restore that is most of
the point, and would hand a non-expert an irreversible write to their own ad
account. (Ads Manager hides this: its "delete" button actually archives.)

So the customer's remove is ours alone — a row in `hidden_ads`, with the ad left
`PAUSED` and untouched on Meta. Offered only on a paused ad, **enforced
server-side against a live Meta read**, because a running ad removed from view
would be invisible AND still spending. Restore brings it back paused, which is
simply what it still is.

The same question from the other side: an ad an operator archived/deleted at
Meta used to stay in `הצג פירוט` forever, since the per-ad rows come from stored
snapshots that outlive the Meta object. Worse, `upsertAdMeta` HARD-DELETED the
cache row the moment Meta stopped reporting it, throwing away the only evidence
it was gone. The prune is now a tombstone (`ad_meta.gone_at`) — AIC-65's rule
enforced by filtering rather than deleting — which also makes a transient Meta
miss self-healing, something the hard delete could not do.

Both land in one "removed" bucket behind a toggle in the panel, differing in
exactly one place: `by_customer` gets a restore button, `gone_at_meta` gets an
explanation. `gone_at_meta` wins when both apply — the reason that decides what
the customer can DO beats the one that explains how the ad left.

**No number moves.** Ingestion is untouched, so campaign KPIs, ad-set rows, the
admin readout and fleet stats are byte-identical (pinned by tests). The
consequence is surfaced rather than swallowed: the ad set's total still includes
the removed ad, so the panel reports removedSpend/removedLeads in the selected
window and says the money is counted above. Rows that silently fail to add up
are how a customer stops trusting the numbers.

The operator's view is never filtered — `perCreative` comes from a separate
read that never consults `hidden_ads`, pinned by a test, because "my ad
disappeared" is unanswerable if it disappeared for the operator too.

Keyed (campaign_id, meta_ad_id) rather than on the ad id alone: every read here
is campaign-scoped, and a narrower key reported a cross-campaign collision as
"already hidden". The integration tests caught it.

### 2026-08-25 — Over-count detection: the failure that makes the engine spend MORE (AIC-92)
Every other measurement check assumes under-counting — fewer leads than really
happened, a cautious engine, bounded damage. Over-counting compounds: inflated
leads → CPL looks excellent → recommend more budget → more money against
conversions that never happened → CPL still looks excellent.

Two signals, deliberately unequal. **A (decisive):** `leads ÷ link_clicks` above
50% with ≥20 clicks, computed from the daily view we already store — no extra
Graph call. The ceiling is wide on purpose: the real campaigns here convert at
21.1% and 14.6%, so 50% is 2.4× the highest healthy rate, and both real rates are
pinned in tests so tightening it has to consciously break them. **B (contextual
only):** browser AND server events on one pixel, which is where dedup failures
happen — fetched only when the rate is already implausible, and used to name the
likely cause. It never raises an alarm alone, because plenty of CAPI setups
dedupe correctly.

**The guardrail is surgical, not blanket**, and that is the ticket's point:
`increaseBudget` returns null while an over-count is suspected, but a DECREASE
and a creative pause still fire. A decrease on suspect numbers is safe; only
spending more is not. Under-counting makes the engine cautious (acceptable),
over-counting makes it spend (unacceptable) — so fail toward not spending, not
toward doing nothing. Consequently this state has no `no_rec_reason`, unlike its
four siblings.

Operator-first: it implicitly says "your numbers are too good to be true", which
needs verifying before it is said aloud, so it raises an ops item and blocks
increases while showing the customer nothing.

### 2026-08-24 — Lead-event volume: the pixel is alive but the lead event stopped (AIC-91)
The gap tracking-health explicitly deferred. That check catches a WRONG or
MISSING lead type; it cannot catch a correctly declared one whose event silently
stopped — a deploy that dropped the pixel call, a consent-banner change, a broken
form.

AIC-88's review rejected a stats-based signal because "the lead event hasn't
fired" is indistinguishable from "nobody converted yet". True for a bare zero.
What makes it real is that it is comparative and needs BOTH halves: the pixel is
demonstrably alive right now (other events firing), AND the lead event did fire
in the earlier window. Missing either, the verdict is `unknown`, never `broken`.

The window length is the whole design, and was chosen against real data rather
than picked: on the live pixel, CompleteRegistration fired 2/2/8/6 on Aug 18–22
then went quiet on the 23rd and 24th while PageView kept firing. A 2-day window
calls that broken; 3 complete days stays quiet. The test pins that exact
sequence AND asserts a 2-day window would have cried wolf, so the reasoning
survives someone later tuning the constant. Today is always excluded — a partial
day under-reads by construction.

Verified with the real adapter over 30 days of the real pixel: `ok`, with
recentLead 14 and recentOther 540. The adapter sums per (day, event) because
`/stats?aggregation=event` returns buckets finer than a day and repeats an event
within one — reading one bucket as a day's total would make a healthy pixel look
stopped.

### 2026-08-24 — Ad-account health: the account that cannot pay (AIC-72)
The third variant of one shape, after tracking-health and cta-health: every
signal green while the campaign is worthless. Here it is the ACCOUNT — a
declined card, an unsettled balance, a risk review, a disabled account, or no
payment method at all (which Meta still reports as `account_status: 1`). Campaign
ACTIVE, ad sets ACTIVE, ads ACTIVE, delivery-health content — and nothing
delivers, with Insights simply going quiet.

Cached on `meta_connections`, not `managed_campaigns`: the account belongs to the
connection and backs N campaigns, so a per-campaign cache would store one fact
N times and let the copies disagree. The ops item carries no `campaign_id` for
the same reason — naming one campaign would imply the others are fine.

Ranked ABOVE `delivery_blocked` in `classifyNoAction`, deliberately: an unfunded
account is the CAUSE of the not-delivering it would otherwise be reported as, and
"delivery blocked" would send an operator to inspect ad sets that are perfectly
configured.

It is also the one no-rec reason whose fix is genuinely the CUSTOMER's — they own
the account and the card — so its copy says what to do rather than "we're on it",
which would be false and would leave them waiting.

Verified with the real adapter against both live ad accounts: `act_1573023157816786`
→ ACTIVE, Mastercard *1459 → `ok`; `act_2181076988590009` → ACTIVE, VISA *5347 →
`ok`. (Worth noting אבשלום's account now has a card — the payment-method gap from
onboarding is closed.)

### 2026-08-24 — CI now runs the integration tests, against its own database (AIC-84, AIC-109)
CI ran `test:unit` with no `DATABASE_URL`, so every DB integration test
self-skipped: **542 of 930 tests ran and 388 did not** — 45 whole files,
including every check that guards a live customer (delivery, tracking and CTA
health, the safe-execute outbox, the notification relay). "CI is green" meant
under 60% of the suite.

It could not simply be given the production `DATABASE_URL`, because the tests
WRITE. That is not hypothetical: sharing one database with production leaked
`__it_*` customers into the real ops console, and let one file's rows be claimed
by another file's code mid-run.

**Correction, same day:** the first attempt at this shipped a database and
nothing else, and CI still ran 540 of 930 tests. The `DATABASE_URL` self-skip was
only the second layer. The real gate is that `server/vitest.config.ts`
**excludes** `**/*.integration.test.ts` outright, and they run from their own
config via a `test:integration` script CI never invoked. Providing the database
was necessary and not sufficient; CI now runs that script too.

**And they could not simply be switched on.** Run in parallel against a fresh
database, `customer-recommendations.integration.test.ts` fails — and passes
alone. Every one of these files talks to the same database, so parallel
execution lets one file's rows land inside another's query and a cleanup DELETE
race a concurrent INSERT. `fileParallelism: false` makes them sequential, which
is correctness rather than a performance concession. This is also the mechanism
behind several failures written off this week as "known pre-existing".

A `postgres:16` service container fixes both halves at once — empty at the start
of every run, unreachable from production by construction, no secrets, dies with
the job. `pool.ts` already skipped SSL for localhost, so nothing else changed.
Migrations run before the tests, which also means **a migration that fails to
apply to an empty database now fails CI** — i.e. production being rebuildable
from scratch is continuously verified rather than assumed.

**The two "known pre-existing failures" were never broken tests.** Against a
fresh isolated database, run sequentially, the integration suite is **390/390
across 46 files** and the unit suite is green. `customer-overview`'s
lead-quality test and `operator-accounts`' last-full-admin test fail only
because of contention and residue in the shared production database — every
report of them in this changelog as "known pre-existing" was describing an
artifact of the test environment, not a defect.

Also cleaned: the last leaked production row, `__it_verify_dash@example.com`.
Worth recording that it was previously described as a test *admin*; it was
`is_admin: false` with `admin_role` merely at its column default, so it never had
console access — an orphaned login, not an privileged account.

### 2026-08-24 — CTA health: catching an ad whose button goes nowhere (AIC-128)
Reported live: a customer's Click-to-WhatsApp ads were running without a WhatsApp
button, and they paused both themselves.

**Diagnosis.** The ad set was correctly `destination_type: WHATSAPP`, and the
creatives reported `call_to_action_type: WHATSAPP_MESSAGE` — but their
`call_to_action` was `{type}` with **no `value`**, so no phone number. Meta
DERIVES that type from the ad set, which is why every surface said the ads were
fine. Delivery-health: delivering. Tracking-health: lead definition matched.
Insights: real spend. Every signal green, every click wasted.

The cause was timing, and narrow: AIC-115 (which attaches the number) began
deploying at 11:51:20 UTC and went live at 11:58:47; the two ads were created at
11:54:56 and 11:54:59 — **3m48s inside that window**, by the old code. A probe
with the current payload on their own post confirmed Meta persists
`value.whatsapp_number`, so a rebuild fixes them; the probe creative was deleted.

**The real gap was that nothing could see it.** The new check compares each ad
set's promised `destination_type` against its creative's actual
`call_to_action.value` — the one comparison that spots the difference. It
requests `call_to_action{type,value}` explicitly, because the scalar
`call_to_action_type` reads healthy on the broken ad and would hide the bug.

Four-valued like tracking-health (`unknown` never overwrites a real verdict,
`not_applicable` does clear a stale one), ops item raised idempotently at high
severity — this is 100% wasted budget, not degraded measurement — which reaches
Telegram through the AIC-118 relay with no extra wiring. Recommendations are
suppressed with `no_rec_reason: cta_broken`, including the "add more ads"
advisory, which would otherwise produce more ads with the same dead button. The
customer's dashboard says the button has no destination and that the fix is
ours, because they cannot repair a creative we built.

Deliberately not judged: MESSENGER/INSTAGRAM_DIRECT/PHONE_CALL, whose payload
shapes aren't modelled — flagging them on the WhatsApp rule would call every
working one broken. Written down in the doc rather than guessed at.

The `no_rec_reason` CHECK is widened in the SAME migration as the reason it
enables (044) — migration 042 exists because tracking_broken was wired through
the code without that, so every cache write raised a constraint violation, was
swallowed by the try/catch, and the dashboard could never say why. Not repeated.

### 2026-08-24 — Reset/delete a signup from the Users view (AIC-127)
Requested for testing: a bin on every `/admin/users` row, opening a red confirm
modal with two irreversible choices — delete the **business only** (the login
survives and can be taken through the onboarding wizard again, which is the
point) or the **signup too**.

`business` mode needed no new deletion logic: `app_users.customer_id` is
`ON DELETE SET NULL` (migration 011), so deleting the customer leaves the login
in exactly the state a fresh signup is in. `all` mode adds the `app_users` row,
in the same transaction — a half-applied `all` would leave a login pointing at a
deleted business, the very state this clears.

**Neither touches Meta**, and the modal says so in its loudest element rather
than its red chrome: a live campaign keeps running and spending afterwards. An
operator who deletes a business and assumes the spend stopped is the actual
hazard. The audit snapshot records `metaCampaignIdLeftOnMeta` so a later reader
knows which objects were left running.

Confirm-to-type is the **email** (this view's row identity; a user may have no
business at all), verified server-side as well as in the UI. Three refusals,
all tested: your own account, the last `full_admin` (mirroring
`removeOperator`), and `business` mode on a user with no business — refused
rather than silently succeeding, with the radio disabled and the reason shown so
the modal never opens on an option the server would reject.

Verified through the real HTTP endpoint on a throwaway row: wrong confirm text
400s and deletes nothing; business mode leaves the login with `customer_id`
NULL and cascades the connection and campaign; the no-business refusal fires;
`all` mode removes the login. Fixture cleaned up, and no existing account was
touched.

### 2026-08-24 — The guides section: static, SEO-first, Markdown-authored (AIC-126)
A blog at `/guides`, linked from the homepage nav and footer, with the sticky
quick-jump sidebar from the requested reference design.

**Static HTML, not React — the decisive call.** `app.ts` serves the SPA shell for
every non-API route, so a React blog would hand crawlers an empty document with
the SPA's generic title and no article text until JS runs. For a surface whose
whole purpose is organic search, the content has to be IN the HTML. Each guide is
now a real file with its own title, description, canonical, OG/Twitter and
JSON-LD — the same pattern the landing, privacy and terms pages already use.

Authoring is one Markdown file in `content/guides/`; five required frontmatter
fields (missing any FAILS the build, because a guide with no description ships an
empty meta tag), and optional `seoTitle`, `slug`, `image`, `keywords`, `faq`.
`faq` emits FAQPage schema — the expandable Q&A block in Google results — and
only when the post genuinely has questions. Length limits are warnings, never
failures: a good title three characters over beats a bad one that fits.

**Two routing details cost real crawl traffic, and both were got wrong before
they were got right.** `extensions: ["html"]` makes `/guides/<slug>` serve the
file rather than falling through to the SPA. And `GET /guides` had to become an
explicit route: serve-static resolves it against the `guides/` DIRECTORY and
never reaches the extensions fallback — with the default redirect it 301s to
`/guides/` (canonical never equals the URL served), and with `redirect: false` it
fell through to the SPA, which is what the first iteration shipped. A probe
showed `/guides` returning 782 bytes of `<div id="root">`; the integration test
now asserts the response is NOT the SPA shell, which is the only way that
regression is visible — it looks fine in a browser.

The TOC ids are stamped on the RENDERED headings and read back out of the same
HTML, so a sidebar link can never point at an id the body lacks, and repeated
headings are deduped (a duplicate id silently sends the second link to the
first section).

### 2026-08-24 — Login/signup are one centered column, and a mock dashboard is gone (AIC-125)
Requested: centre the auth pages and drop the marketing column. `AuthLayout`
(signup/login/forgot/reset) was a `1fr 1fr` grid whose right half was a dark
aside with a **fake dashboard — 18 leads, ₪41 CPL, ₪734 spend** — drawn in the
product's real dashboard styling, on the page where someone decides whether to
trust the product's numbers. It went with the column, as did `.aside`,
`.mini-dash`, `.step-line`, the now-dead `≤860px` override that existed only to
collapse the grid, and the three strings that fed it.

The aside was already hidden below 860px, so the centered single column was
already shipping on mobile — this makes it the only layout rather than a new
one.

Centered with flex, not `display: grid; place-items: center`. The grid form
looked right and is subtly wrong: `justify-items: center` stops the item
stretching, so the track sizes to max-content and the child's `width: 100%`
resolves against a content-sized track instead of the viewport. Flex keeps the
container full-width, so `width: 100%` + `max-width` behaves.

Verified by screenshot on all four screens at desktop and at 375px, including
the tallest form (signup) on the smallest viewport — nothing clipped, no
sideways scroll. Worth noting how that verification went: an in-page
`getBoundingClientRect` pass reported a 214px collapsed track, `left: -238px`
and a horizontal scrollbar, which read as a real overflow bug. It was an
artifact — the JS eval context reported `clientWidth: 0`, and in a zero-width
viewport any centered grid collapses that way. Screenshots at real viewport
sizes are the reliable signal for layout here; a measurement is only as good as
the viewport it was taken in.

### 2026-08-24 — A grid of zeros with no explanation, and a "paying customers" card counting non-payers (AIC-123, AIC-124)
Two reports, one shape: a number that was correct, rendered so it read as a
claim about something else — the same failure as AIC-116/117.

**AIC-124 — "why all 0s?" on /admin/meta.** A campaign whose two ads were
created that morning showed ₪0 and 0 across every field. Correct: the explorer's
window is `rollingPeriods().current`, the 7 complete days ending yesterday
(2026-08-16 – 08-22), and the ads did not exist on any of them. Meanwhile the
campaign had genuinely spent ₪10.62 that day. Nothing on the page said what the
window was or why today was excluded, so the grid read as a dead campaign. The
page now carries a permanent four-point data note: the window and today's
deliberate exclusion, that a new campaign therefore reads all-zero (which means
"not measured here", not "nothing happened"), that Meta revises conversion
figures retroactively, and that the read is live and unstored. Styled info, not
warning — nothing is wrong.

Worth recording because it nearly produced a wrong answer: the raw
`period_start` values read as `2026-08-22T21:00:00Z` and were about to be
reported as spend landing on the 22nd. They are `DATE` columns rendered through
UTC+3; cast to text they are `2026-08-23`. Same column, two different-looking
answers — check the cast before reasoning about a date.

**AIC-123 — the billing card counted non-payers as paying.** `/admin`'s card was
headed "לקוחות משלמים" while its first row showed `conversion.customers`, the
count of NON-TEST customers whether or not any had paid. Two real customers with
zero payments rendered as a paying-customers card headlining 2. Every number was
true; the heading was the lie. The old empty state fired only at
`customers === 0`, so "nobody is paying" was admitted only when there were no
customers at all — never in the ordinary early-stage case. Now a pure
`billingState()` with three states (`no_real_customers` / `none_paying` /
`converting`), the card retitled "המרה לתשלום", and the missing state says so
outright. `none_paying` deliberately checks both `setupPaid` and `subscribed`,
so a subscription without a recorded setup payment still counts as revenue.

### 2026-08-23 — /admin gets four analytics blocks (AIC-122)
Requested: a statistics-rich `/admin`. Picked from a 10-option shortlist:
fleet spend/leads trend, automation rate, queue health, fleet health — the four
whose data was already being written, so none needed new instrumentation.

**The one real hazard was the trend query.** Migration 030 established a hard
rule — *any SUM over time reads `insight_snapshot_daily`, never
`insight_snapshots`* — because the table mixes disjoint per-day rows with
overlapping rolling-window rows, and summing across both double-counts. That
bug had already shipped twice (a real lead read as 3; the engine reading 2× its
own evidence). The trend is exactly such a query, so it reads the view, with a
regression test that inserts both row kinds for one date and asserts the trend
moves by only the per-day amount.

That test also had to be rewritten once: it first asserted an absolute value and
read 4245 instead of 1000, because a fleet-wide aggregate over the shared
production database legitimately includes real data. It now asserts the delta
its own rows cause — the same shared-database lesson as AIC-118's relay tests.

Charts are inline SVG, no charting dependency, geometry in a tested pure module.
Two stacked charts rather than one dual-axis chart (two y-scales can manufacture
any correlation), and a day with no ingested row breaks the line rather than
being drawn through — missing data is not zero spend. Status colors carry a
visible count and label in every case, which the palette validator requires
here: amber measures 2.68:1 against white (below the 3:1 floor) and green↔amber
ΔE 6.6 under protanopia.

Verified in the browser against real production data: 8 polylines across the two
charts (the gap-splitting working — not one continuous line each), automation
15% (7 of 47 actions), queue 9 high / 1 medium, fleet health 3/3 on both
delivery and tracking, and the hover crosshair reading "15.08 · ₪34.66" against
the 3466 agorot actually recorded for that date.

### 2026-08-23 — The needs-attention queue is now grouped, dated and filterable (AIC-121)
Reported live from a real 11-item queue: a plain table, every row showing raw
severity + raw type + the full Meta error text unconditionally — no date/time,
no indication of which customer or campaign. All 11 items looked identical at
a glance; a real `support_request` from a different customer was buried among
10 repeated connection-health flaps on one already-known-dead account
(Pisga's archived connection).

**Server**: `OpsQueue.list()` now LEFT JOINs `business_name`/campaign `name`
into every item — genuinely absent before, not just unrendered. `createdAt`
was already flowing to the client (the service always selected it) but the
frontend's `OpsItem` type didn't declare it, so it silently went unused the
whole time.

**Admin UI**: grouped by type (exhaustive Hebrew label map — `Record<OpsQueueType,
string>`, so a type added to the shared enum without a label is now a compile
error), each row collapsed to date/time + severity + business + campaign + a
one-line preview, full detail on click. Severity and type filters operate
client-side over the already-loaded backlog; the type filter only offers types
actually present. The filter/group logic is `filterAndGroup`/`presentTypes`
(`web/src/admin/ops-queue-view.ts`), a pure function extracted for the same
reason as `onboarding-step4.ts` — no component-test tooling here, so a pure
function is the only way to unit-test a UI decision at all.

Verified in the browser against the real 11-item queue: grouped into "כשל
בחיבור ל-Meta (10)" / "פנייה מהלקוח (1)"; expand/collapse confirmed on one row
without affecting the rest; the severity filter correctly showed the empty-
match state (all 11 are `high`); the type filter correctly isolated the one
real customer request, previously invisible in the noise.

### 2026-08-23 — No horizontal padding against the sidebar, on every page in the product (AIC-120)
Reported as a screenshot: a red warning box on /admin/onboarding touching the
sidebar with no gap. My first attempt only added `className="wrap page dash"`
to that one component — matching its siblings — and changed NOTHING visually,
which is what actually surfaced the real bug: measuring the computed style
showed `paddingRight: 0px` on every admin page already using those classes,
not just the one I'd just touched.

Root cause: `.page`/`.dash` (`ui.css`) exist only for VERTICAL rhythm, but both
declared it with the `padding` SHORTHAND (`padding: 40px 0 90px`), which sets
all four sides at once — so their `0` for left/right silently overrode `.wrap`'s
`padding: 0 24px` (the class that is actually supposed to own horizontal
spacing), at equal specificity, by source order. `.dash` (line 369) comes after
`.wrap` (line 36) in the stylesheet, so it always won.

This was every page combining the classes, not an admin-only bug: the entire
customer app (Home, Builder, AddContent, Settings, Recommendations, Connect,
Checkout, Onboarding, Review) and the entire admin console. It read as fine
almost everywhere because most content sits inside a `.card`, whose own
padding/border/shadow reads as a gap even with none from the page itself —
confirmed by screenshotting `/admin/customers` (a table, looked "close but
fine") right after `/admin/onboarding` (a full-bleed red box, unmistakably
wrong) with the identical `paddingRight: 0px` on both. It took a colored box
with nothing to hide behind to make a product-wide bug visible on one screen.

Fixed by switching `.page`/`.dash` to `padding-block`, which only ever touches
top/bottom and structurally cannot collide with `.wrap`'s horizontal value
again — not a one-off shorthand reorder, which would just relocate the next
collision. Verified via computed style AND screenshot on an admin page (table),
the reported page (warning box), and a customer page (`/app`) — all three now
resolve `paddingRight: 24px`.

### 2026-08-23 — Step 4 showed the wrong form to a customer with no connection (AIC-119)
Reported from the wizard for a customer with **no Meta connection and no
campaign**: it asked for שם הקמפיין, תקציב יומי שסוכם and מספר וואטסאפ, and
offered "יצירת הרשומות". Those fields belong to the *adopt an existing Meta
campaign* branch. For a customer we are going to build a campaign FOR, the
builder collects the name and WhatsApp number — provisioning only needs the
agreed ceiling.

The branch was a boolean: `!loading && !error && !!adAccountId &&
campaigns?.length === 0` selected the build-new form, and the adopt form
rendered on its plain negation. That negation is true **before an ad account is
picked at all**, so the adopt form was the default for a customer with nothing
to adopt, behind a button that could only fail. Same class as the step-4 fix
two days earlier: a form that cannot succeed, inviting an operator to fill it in
mid-call.

Now a pure `step4Branch()` returning `pick_account | loading | error |
new_campaign | adopt_existing`, with all four render sites naming their branch
positively — no negations left in the file. A failed load is its own state
rather than collapsing into "no campaigns", which would offer to build a second
campaign for an account that already has one. Extracted as a module because the
repo has no component-test tooling, so a pure function is the only way to lock
this in; 6 tests.

Verified in the browser on the reported customer (both branches): with no
account picked, all four fields are gone and a "pick an account first" line
shows; selecting an account that has a campaign brings the adopt form back with
the real campaign in the picker.

### 2026-08-23 — Ops notifications: a Telegram channel for changes, failures and errors (AIC-118)
**Live.** Bot `@ads_agent_il_bot` posts to the "Ads Agent Updates" channel;
Railway logs `notify started (every 60000ms)` on boot. Built dark first, then
configured and verified end-to-end the same day — both paths, against the real
channel: three relayed events (a customer pausing an ad, a failed create, a
high-severity ops item) and the error forwarder (an error, a warning, and a
duplicate error correctly suppressed). The verification used a throwaway
customer rather than a real one, so no real customer's audit trail gained an
event that never happened — the exact class of bug fixed earlier today — and the
same run confirmed the default path would have skipped those rows (2 claimed,
0 sent) because they belong to a test account. Fixture deleted afterwards.

**Two paths, one channel.** A relay polls `action_history` and
`ops_queue_items` every minute — every campaign/ad/ad-set change, every failed
attempt, every ops alert — and an error forwarder wraps `console.error`/`warn`
plus uncaught exceptions for everything that never reaches the database.

**It reads the tables instead of adding notifier calls.** Seven places write
`action_history` today; calling a notifier from each would be seven chances to
forget and an eighth next time. Reading covers every action type by
construction, including ones added later and including `rollback_build`, which
`condense()` deliberately hides from the CUSTOMER's feed and which an operator
most wants to see. Labels come from the existing `SUMMARY_HE` map rather than a
parallel copy — the copy is exactly the artifact that goes stale.

**A column, not a timestamp watermark** (migration 043). A watermark loses
events: `occurred_at` is stamped at INSERT but the row is only visible at
COMMIT, so a row can surface already behind the watermark and never be seen.
Per-row `notified_at` has no such window. The migration backfills every existing
row as sent, and the relay skips anything older than an hour — otherwise turning
the channel on replays months of history and it gets muted the same day.

**The test suite found a production hazard.** The relay's own integration test
failed claiming 20 rows written by other test files running concurrently — and
since local, CI and production share one database, that is not a test artifact:
a single `vitest run` would have posted fixture rows into the live channel. The
relay now claims but never sends rows belonging to `is_test` customers, and its
tests are scoped to their own rows and drain the way production does rather than
asserting on global counts.

Delivery is at-most-once and says so: a failed send is logged, not retried, so a
Telegram outage costs those messages. The channel is a convenience, never the
system of record.

### 2026-08-23 — "רצה מודעה אחת בלבד" — told to a customer with two ads running (AIC-117)
Reported by the customer immediately after AIC-116 made their campaign visible:
*"wrong status. we have 2 ads running"*. The AIC-86 advisory fired and its copy
claimed one ad was running.

The rule counts COMPARABLE creatives — ones with enough measured data to judge
against each other. On a campaign built hours earlier that is 0, and 0 < 2, so
it fired. Its own comment defends skipping the evidence gates on the grounds
that *"there is only one creative" is a COUNT, and no amount of additional data
makes a count more true* — the argument is right, but the code was counting
creatives WITH DATA, which is a different number entirely. Two ads running, zero
comparable.

`deliveringAdCount` is the honest count, delivery-health computes it in the same
tick from real ad/ad-set status, and it already said 2 — the rules were simply
never given it. `CampaignEvidence.liveCreativeCount` now carries it, and the
advisory fires only on **positive evidence of exactly one ad** — not at `>= 2`,
and not at `0` either (a paused campaign with five ads reports zero delivering,
identical to one with none).

The first version of this fix got that wrong and a live tick caught it within
minutes: it treated a missing count as zero, delivery-health was rate-limited
(Meta code 17), and the rule fired again on the very customer it was written
for. Absence of evidence is not evidence of one ad. Where the count is genuinely
unavailable the rule falls back to the original evidence-based case (exactly one
creative WITH data) and otherwise stays silent.

The copy was a second, separate defect. "כרגע רצה מודעה אחת בלבד" was
unconditional — it would have been false at a live count of 0 as well as 2. It
is now conditional on the count actually being 1; otherwise the sentence makes
no claim about how many ads run, while staying just as actionable. Rows written
before this carry no live count and keep the phrasing they were generated with.

Both defects are the same shape as AIC-116's: a number that means one thing
being rendered as a statement about another.

**Verified live, on the degraded path** — which is the one that actually bit. A
real tick evaluated the campaign (`evaluated: 1`) while delivery-health was
still rate-limited, so the live count was unavailable, and the rule stayed
silent (`created: 0`). The previous commit created a false recommendation under
exactly those conditions. The customer's existing recommendations are expired,
so they see nothing.

Not yet verified live: the `>= 2` path itself, which needs delivery-health to
succeed and is covered by unit tests only. The hourly production tick will
exercise it once the rate limit clears.

### 2026-08-23 — A live campaign was invisible to the engine and to its own customer (AIC-116)
The customer's dashboard showed `מודעות —` and "not enough data for an audience
breakdown" for a campaign that was live on Meta and spending. Three causes, one
root, all three fixed here.

**1. The campaign never left `under_review`.** `startBuilderCampaign` creates
the shell row with that status, and the only thing that clears it is the AIC-18
first-campaign review — which exists to judge campaigns we did *not* build ("is
this imported structure manageable at all?"). Nobody reviews our own output, so
nobody submits one, so the status never moved. `listEligibleForGeneration`
filters on `status = 'active'`, and that tick is the only writer of `ad_meta`
and `ad_set_meta`, so the campaign got no recommendations and both caches stayed
empty. This is the same AIC-106 leftover as `launch_approved_at` one field over:
"building never activates" was true when written, and stopped being true when
creation became the launch. The build's final UPDATE now sets `status='active'`.
Ingestion was never affected (it gates on `status <> 'unmanaged'`) — only
generation. Imported campaigns still start `under_review` and still need the
review.

**2. The audience panel was built from performance, not from ad sets.** Even
with the caches filled, the panel starts from `adsetRangeStats` — insight rows —
which quietly made it a list of ad sets that *have data*. A campaign built
minutes ago has none, so there was no row for the 2026-08-22 data-less-ad merge
to attach to, and it collapsed to `no_data_yet`. The spine is now the
`ad_set_meta` cache with stats attached where they exist. An ad set with data
outside the window is still excluded, so `no_data_in_range` keeps its meaning.

**3. The data-less-ad merge excluded the commonest case.** It was gated on an
ad's *status* (`PENDING_REVIEW`/`DISAPPROVED` — the states that "explain"
missing data) and so skipped an `ACTIVE` ad created minutes ago that Meta simply
hasn't reported on yet. The gate is now the data: no rows in any period → merged
with `hasData:false`. `hasNoDataYet` had no callers left and was deleted.

**Also fixed, spotted in the same panel:** the connection card rendered the ad
account as `—` directly above a technical line printing its `act_…` id.
`ad_accounts.name` defaults to `''` and the admin wizard never sent one, though
`provisionConnection` has accepted `adAccountName` all along — no caller in
`web/` passed it. Display falls back to the id (`adAccountLabel`), and the
wizard now sends the name and currency its picker already had.

**Verified on the real customer, not just in tests:** one real generation tick
took `evaluated` from 1 to 2, wrote both ads (`ACTIVE`) and the ad set to the
caches, set `delivering_ad_count = 2`, and `buildCampaignAudiences` for their
user id now returns the audience "18–45 · ישראל" with both ads at
`hasData:false`. Their stranded row was repaired in place; a scan found it was
the only one.

**Four stale test artifacts fixed rather than worked around** — two assertions
of `under_review` commented "building never activates", and two test titles
claiming "all PAUSED", all true when written and quietly false since AIC-106.
The 2026-08-22 tests all seeded an ad set that already had data, which is
exactly why cause 2 survived a green suite; the new test seeds none.

### 2026-08-23 — The customer's activity feed showed campaigns that no longer exist
Seen on a real customer's dashboard after their first successful build. Two
separate falsehoods, both from this session's own work.

**Rollback was reported as an automatic campaign change.** `rollback_build` has
no `SUMMARY_HE` entry, so it fell through to the generic fallback and rendered
as *"שינוי בקמפיין · בוצע אוטומטית"* — telling a customer we automatically
changed their campaign, when what happened was cleanup of something that never
became real. It is internal bookkeeping and is now filtered out entirely.

**Four "campaign created" entries for one campaign.** Three failed builds each
logged a creation before being rolled back or cleaned up by hand. `condense`
now drops:

- rows a `rollback_build` explicitly names in its `deleted` list, and
- `create_campaign` rows whose `target_meta_id` is not the campaign's current
  one — a precise DB-only signal, since there is one managed campaign per
  customer, and it also covers cleanups that predate rollback and therefore
  have no `rollback_build` row naming them.

Both filters are deliberately narrow: only rows provably describing something
that no longer exists are hidden, so a genuine action always survives.

Measured on the real campaign: **25 raw rows → 4 shown** — created, one
audience, two ads. Which is what actually happened.

The principle, stated because it keeps recurring: the customer's feed is a
record of what happened to *their campaign*, not of our retries.

### 2026-08-23 — Step 4 no longer offers to create records that already exist
Reported live, straight after the first successful end-to-end build: the
operator was returned to the wizard and asked whether "יצירת הרשומות" and
"אימות והשלמה" still needed clicking.

**"יצירת הרשומות" would have failed.** The builder had already written every
record — `meta_campaign_id`, name, agreed budget, WhatsApp destination,
`launch_approved_at`. Provisioning again INSERTs into `managed_campaigns`,
which is `UNIQUE (customer_id)` and — unlike the shell-row insert — has **no
`ON CONFLICT`**. The only possible outcome was an opaque constraint violation.
The wizard was inviting an operator into an error, mid-call.

Step 4 now shows "הרשומות כבר קיימות — אין מה ליצור" **in place of the entire
form** once a campaign is linked — not just in place of the button. The first
pass hid only the submit and left the whole form rendered: destination radio,
four pickers, name, budget, WhatsApp number. A form that cannot do anything is
not neutral — it invites an operator to fill it in mid-call and then fails.

Regression-checked in the browser against an unprovisioned customer (`Pisga`):
the full form and the provisioning button still render there.

**Getting the signal right took two passes, and the first was wrong.**
`metaCampaignId` is not on the customer DTO at all, so the initial guard
silently never fired — caught by checking in the browser rather than trusting
the typecheck. `campaignId` alone is also wrong: a builder shell row has one
too, which is precisely the state this must distinguish. The correct signal is
`connectionReadiness !== "not_launched"`, since `classifyConnectionReadiness`
returns exactly that when `meta_campaign_id` is null.

**"אימות והשלמה" is not required** — documented rather than left to be asked
again. Nothing gates on `customer_onboarding.completed_at`; it is read in one
place to render a pill. What finalize buys is a last end-to-end
`ConnectionService.verify()`, worth running before ending a call.

Verified in the browser against the real customer: provision button gone,
message shown, finalize still available.

### 2026-08-23 — The builder's success screen now speaks to the operator who built it
Reported live: after an operator launched a customer's campaign they saw
"הקמפיין עלה לאוויר… אפשר לעקוב אחרי התוצאות מהדף הראשי" and a button reading
"למעבר לדף הראשי", then asked whether step 5's finish button still needed
clicking and how to get back there.

Two separate problems, one visible:

**The routing was already right.** `AdminBuilder` passes
`onExit={() => nav('/admin/onboarding/:id')}`, so the button does return to the
wizard. But the copy was customer framing shown to an operator — "go to the main
page" — which gave no hint of that. A screen that does the right thing while
describing something else is indistinguishable from one that does the wrong
thing.

**And the answer to their actual question was undocumented.** Step 5's
"אימות והשלמה" is **not required**: nothing gates on
`customer_onboarding.completed_at` — it is written by `finalize` and read in
exactly one place, to render a pill. The campaign is live either way. What
finalize does buy is a final end-to-end `ConnectionService.verify()`, which is
worth running before leaving a call.

The success screen now branches on `customerId`: operators get a button naming
where it goes ("חזרה לאשף — לאימות הסופי") and copy stating that the final check
is worth doing but not load-bearing. Customer copy is unchanged.

### 2026-08-23 — Existing-post creatives now carry the campaign's CTA (AIC-115)
A real build failed at the last step: *"The ad's creative is incompatible with
the objective of the campaign the ad belongs to."*

`createCreativeFromExistingPost` sent only `object_story_id`, so a creative built
from a plain photo post had no CTA and could not serve a click-to-WhatsApp
objective.

**My first diagnosis was wrong and the user caught it.** I concluded a WhatsApp
campaign simply cannot use an existing post, and filed a ticket to *filter* the
picker. Asked "whatsapp campaign cant use existing post?", I probed the real ad
account instead of reasoning: Meta accepts `call_to_action` alongside
`object_story_id`, and it persists (`call_to_action_type: WHATSAPP_MESSAGE` read
back; probe creative deleted). The post never needed its own CTA — we needed to
attach one.

The misleading artifact was a code comment: *"Meta reuses whatever CTA/link the
original Page post already has."* True of what happens when you send nothing,
read as a limit on what Meta accepts. Filtering the picker would have hidden
usable options behind a restriction that does not exist.

Fixed at the adapter, with the destination threaded from all three call sites.
Engagement sends no CTA (no `ctaType` by design — the interaction is on the post).
The additions path is **best-effort**: a blocked destination falls back to
post-as-is rather than refusing, because `free_beta_signups_leads` (website
campaign, no `website_url`, posts that are link shares) currently works that way
and must keep working.

857 server tests pass; the 2 failures are the known pre-existing pair.

### 2026-08-22 — Removed the dead wizard step indicator, and three claims that were false
All from one user question ("aint it wrong status") and one instruction ("these
do nothing, remove them"). Every item is the same shape: state or copy that was
true once and quietly stopped being true.

**The step indicator is gone.** Its five buttons called `goToStep(n)`, which
only wrote `current_step` — the sections never hid or scrolled, so clicking did
nothing visible. `current_step` turned out to be **write-only**: carried through
the DTO, never read to decide anything, with the indicator as its sole consumer.
It was also actively harmful — it is what made the wizard announce "step 3 of 5"
for `free_beta test`, a customer whose connection is healthy and whose campaign
has been live for a week. Indicator, `goToStep`, the post-provision `goToStep(5)`
write and the orphaned `stepOf` string all removed. The column and its route are
left in place but are now unwritten; worth a follow-up to drop them.

**`resumedNote` reworded.** It said "ממשיכים מהשלב האחרון שנשמר" — there is no
saved step any more. Now states what is actually true and useful on a call: this
customer has been worked on before, and the per-step checks show what is
verified.

**`not_launched` was false in both halves.** It read "קמפיין קיים, לא מקושר
ל-Meta" ("a campaign exists, not linked to Meta"). Traced every writer of
`managed_campaigns`: a row with `meta_campaign_id = NULL` can ONLY be the
builder's shell row, because provisioning an existing campaign always supplies
the Meta id. So this reason can never mean "a real campaign that isn't linked" —
**the state the copy described does not exist.** It only ever means an
unfinished build. Relabelled accordingly.

**And its customer-facing copy still instructed a deleted step.** It said
"אשרו את ההפעלה בדף הבית" — approve the launch on the home page — a step AIC-106
removed earlier the same day. A fourth AIC-106 leftover, missed when the gate
came out. Rewritten, and its CTA now points at the builder (resume the build)
rather than home (nothing to do there).

Verified in the browser: indicator gone, all five sections still render, the
prerequisites warning intact.

### 2026-08-22 — The add-content blocker message named nothing and claimed work nobody was doing
User report: "completely useless, actions-less message". It was worse than
useless — it was **false**.

The old copy: *"יש לנו עוד כמה פרטים להשלים בקמפיין הזה… **אנחנו כבר על זה — אין
צורך לעשות כלום**."*

Checked against the real campaign. Exactly **one** field was missing —
`website_url` — it had been missing for weeks, and **nobody was "on it"**,
because the answer has to come from a person. For a landing-page URL that
person is the **customer**. Telling them there was nothing to do is precisely
what kept it stuck.

The client already received `missingConfigFields` and discarded the list for a
generic sentence. Now it:
- names the missing field in the customer's language ("כתובת הדף באתר שאליו
  המודעה מפנה"), never the column name;
- asks **whoever can actually answer** — a URL or WhatsApp number is the
  customer's to give, a Pixel id or lead-event definition is ours — instead of
  one blanket "we're handling it";
- keeps the genuinely useful part: adding an ad from an existing post still
  works.

Verified in the browser against the real blocked campaign, not just
typechecked.

**The pattern, again:** copy that was reassuring instead of true. "Nothing for
you to do" is the most expensive sentence in the product when it is wrong — it
converts a one-message fix into weeks of silence.

### 2026-08-22 — Engine docs corrected against the code; cooling_down no longer claims "stable"
Found while mapping the recommendation engine end to end. One was a live code
inconsistency, the rest were docs asserting things the code does not do.

**`cooling_down` claimed the campaign was stable.** `explainer.ts`'s `no_action`
switch had no case for it, so it fell to `default: stable()` — "הקמפיין יציב" —
while the web surface said "עוקבים אחרי השינוי האחרון" for the same state. Two
copy sources contradicting each other.

Root cause was weaker than a missing case: `rec.evidence` is a loose
`Record<string, unknown>`, so the switch was **never type-protected**. It now
narrows to `NoActionReason` and ends in a `never` exhaustiveness guard —
verified by temporarily adding a reason and confirming `tsc` fails. The web side
already had this discipline (`Record<NoActionReason, NoRecCopy>`); the server
did not, which is precisely how this slipped.

**`RULES.md`'s numbered rule list omitted `pause_adset`.** It jumped from
`replace_creative` to the budget rules; in `RULES` the audience rule sits at
index 2, between them. The prose elsewhere had the order right — the list did
not, and reading only the list would mis-order the engine. Also added: rule 0
(`add_creatives_for_comparison`, the one rule that fires below the evidence
gate) and AIC-107's engagement refusal on `increase_budget`, which was
implemented but undocumented.

**`recommendation-engine.md` described a 2-step tick.** It runs three —
ingest → generate → **measure outcomes**. Its `GenerationSummary` was also
listed with four fields; it has six.

**`expires_at` documented as inert.** The column exists and `generation.ts`
unconditionally writes `null`; nothing reads it. Expiry is staleness only. Said
plainly so nobody builds on a TTL that does not exist.

**`DORMANT_SHARE_THRESHOLD` flagged as non-overridable** — a private module
constant, not one of the 14 `RULE_THRESHOLDS` keys, in a document that
elsewhere says every threshold resolves per campaign.

### 2026-08-22 — Two truth bugs found while mapping the recommendation engine
**1. The activity feed credited us for the customer's own actions.** User
report: every entry read "בוצע על ידינו" ("done by us") — including ad sets the
CUSTOMER had paused from their own dashboard.

The data was never wrong: those rows carry `human_involved = true` and
`approved_by = 'customer'`. The projection collapsed three actors (engine / the
customer / us) into one boolean, and the UI read `automated: false` as "us".
`actorOf()` now returns `automated | customer | us`, and the feed says
"בוצע על ידך" when the customer did it. A NULL approver with a human involved
attributes to "us" — never to the customer, which is the direction that would
lie.

**2. `tracking_broken` could never be cached — the CHECK constraint rejected
it.** AIC-88 added the reason and wired it end to end (classifier, customer
copy, ops label), but `managed_campaigns.no_rec_reason`'s CHECK was last
widened in migration 035 and never gained the value. `recordNoRecReason`'s
write is wrapped in a swallowing try/catch, so every attempt raised a
constraint violation, was logged, and the column stayed stale — a campaign with
broken tracking has never been able to say so on the dashboard.

`docs/RULES.md` warns about exactly this silent-failure class. It had already
happened. Verified against the live DB before and after: the constraint held 8
values without `tracking_broken`; migration 042 widens it, and writing the
value now succeeds.

### 2026-08-22 — The ad list shows ads that exist, not only ads that have data
User report: added an ad from an existing post, got a success confirmation, and
the dashboard still showed only 2 ads. Nothing had failed — the ad was ACTIVE on
Meta within seconds (`120249289037720352`, `PENDING_REVIEW`).

Cause: the per-ad list is built from `insight_snapshots` — ads with MEASURED
data. A new ad has none, so it could not appear. The list was showing "ads that
have data" while the customer read it as "my ads". `PENDING_REVIEW` — the state
every new ad passes through — appeared **nowhere** in the codebase.

Worse, waiting would not have fixed the other half: a `DISAPPROVED` ad never
gains insight data at all, so it would have stayed invisible forever, reading as
"the create silently failed".

Fixed: `ad_meta` cache (migration 041) + `classifyAdState` + a merge in
`campaign-audiences` for states that EXPLAIN missing data, refreshed in-request
after an add (not just on the hourly tick — the AIC-71 shape). `hasData` is
carried separately so the UI shows "awaiting review" rather than "₪0 · 0 leads",
which would claim zero *results* for an ad that never had the chance.

Tests proven to catch the bug: temporarily disabling the merge fails them, then
passes with it restored.

**Also recorded** (postmortem §1): Meta flagged a pure rate-limit error as
`is_transient: false` while its own message said to retry. That flag was the
candidate signal for transient-vs-terminal rollback and for AIC-105's fourth
error category — it is not trustworthy on its own.

848/850 server + 27 web tests pass; the 2 failures are the known pre-existing
pair.

### 2026-08-19 — Postmortem written: the builder's first real onboarding call
[POSTMORTEM-2026-08-19.md](POSTMORTEM-2026-08-19.md), linked from INDEX.

An operator hit **eight** separate walls trying to build one real customer's
first campaign. Every one was real; most were ours. The doc is organised by what
a future session needs rather than chronologically:

1. **Meta facts we got wrong by reasoning instead of measuring** — each with the
   repeatable probe that settled it (Instagram riding the ads grant,
   `promote_pages` only listing already-advertised Pages, empty-array vs
   permission-masked, pixel URL aggregation and why it proves less than it
   looks).
2. **Prerequisites Meta enforces that no check of ours can see** — Page↔WhatsApp
   link, payment method, `advantage_audience`. All fail loudly; all fail LATE.
3. **Bug patterns in our code, as named classes** — a guard that never runs; a
   passing test defending the bug; a refusal that lies about its cause;
   validation at the end instead of at the field; a design whose premise expired
   underneath it; stale artifacts reading as verified fact.
4. **Process failures, mine** — including poisoning a real customer's build with
   my own test runs, and asserting a Meta behaviour I had not measured.
5. The two distinctions that kept collapsing (unverified ≠ not done;
   pre-existing ≠ accepted).
6. What is still open.

### 2026-08-19 — Correction: a missing payment method fails LOUDLY, not silently
The entry below claimed a missing payment method fails silently — campaign
accepted, ACTIVE, never delivering. **That was wrong, and asserted without
verifying.** The operator hit Meta's real error the same day:

    Update payment method: Visit the Billing and payment center
    to add a valid payment method.

Corrected in the wizard copy and in
[ops-console.md](features/ops-console.md). Both prerequisites fail loudly and
both fail LATE — at the ad-set create, after the entire builder wizard has been
filled in. Late is the real cost; silence was never the problem.

Worth recording as the same failure mode this session kept finding elsewhere: a
confident claim about external behaviour, reasoned rather than measured, then
written into product copy where it reads as verified fact.

**Also confirmed by this report:** the `GraphWriteError` surfacing shipped in
`b7d2677` is working in production — the operator saw Meta's own
`error_user_msg` verbatim instead of "failed to build campaign".

### 2026-08-19 — Onboarding wizard warns about the two prerequisites it cannot check
Both bit a real onboarding call today, so step 1 now opens with a bordered
warning covering them.

- **WhatsApp Business number connected to the Facebook PAGE** — not just
  installed on a phone. Meta refuses the ad set create without it, and refuses
  at the very END, after the whole builder wizard has been filled in.
- **An active payment method on the ad account** — this one fails SILENTLY:
  Meta accepts the campaign, it reads ACTIVE, and never delivers. Nothing in
  the product distinguishes that from a slow start, which makes it the more
  expensive of the two.

Placed at step 1, not near the build: that is the only moment the customer is
on the call with their own Meta screen open, and the only point either is cheap
to fix. Styled as a warning rather than a note — an operator scanning a script
skips a grey paragraph. The copy states plainly that neither is auto-verified,
rather than letting the wizard's five green checks imply otherwise.

Verified in the browser, not just typechecked: renders above the numbered
steps, 2px warning border, both items present.

### 2026-08-19 — Ad set creates now send advantage_audience (Meta requires it explicitly)
Found live mid-build, after the WhatsApp Page link was fixed: Meta refuses an
ad set create unless `targeting.targeting_automation.advantage_audience` is an
explicit `0` or `1`. We were sending neither.

Set to **0**, as a stated product opinion (`ADVANTAGE_AUDIENCE_ENABLED`) rather
than a magic number. The wizard tells the customer the campaign targets a
specific age range and gender, and the review step lists them back; Advantage
audience lets Meta deliver outside that, which would make both untrue.

Trade-off recorded in the owning doc rather than hidden: Advantage audience
often improves delivery on small budgets, so this may cost performance.
Revisiting is legitimate — but change the customer-facing promise first, then
the flag.

### 2026-08-19 — Root cause found: the outbox drain was poisoning real customers' builds
The unresolvable outbox row that blocked a real customer's campaign was not a
mystery after all, and the cause was our own test runs.

**Diagnosed by timestamp.** A real customer's pending `create_creative` row
(owner: `free_beta test`) and a test's `pause_ad` row (owner: `__it_outbox`)
were updated **65ms apart** — the same drain batch. `drainOnce`'s SELECT was
unscoped (`WHERE status = 'pending' AND next_attempt_at <= now()`), so an
integration-test drain running against the SHARED production database picked up
a live customer's half-finished build, applied it with a FAKE writer, and
marked it `succeeded`. `writer.apply()` returns void, so no Meta id was ever
recorded — producing `succeeded` + `result=NULL`, which nothing can resolve.

That is exactly the row that made the builder report a false *"create already
in progress — retry shortly"* forever.

**Fixed: the drain never sees a create.** `kind NOT LIKE 'create\_%'` is now
part of the SELECT. This is a correctness rule independent of the test bleed —
creates are synchronous-only by design (the caller needs the new id immediately
to build the next step's payload), and a drain structurally cannot return one.
Locked in by a test that enqueues a pending create, drains, and asserts the row
is untouched.

**Not fixed here, and the deeper fault:** integration tests run against the
shared production database, so any unscoped query in a test can reach real
customer rows. That is AIC-84 (Neon branch isolation) / AIC-109.

**Cleaned up:** 3 test-owned outbox rows (`__it_*` customers) deleted — my own
pollution. Two corrupt `create_creative` rows remain, owned by real but
already-built campaigns (`free_beta test`, `Pisga — ארכיון`); they are inert,
since those campaigns are linked and cannot be rebuilt, and were left alone
rather than deleted from production without asking.

837/841 server tests pass. The 2 known pre-existing failures remain; 2 further
failures in that run were shared-DB timeout flakes, confirmed by re-running the
same files twice clean.

### 2026-08-19 — Rollback shipped: a failed build now leaves nothing behind
Implements the design decided earlier today, after a refused ad-set create
stranded an ACTIVE campaign on a real customer's ad account.

- `GraphCampaignAdapter.deleteObject` — Meta's `DELETE /{id}`, one call for
  campaign / ad set / ad.
- `buildCampaignOnMeta` records every id it creates; any failure deletes them
  newest-first (children before parents — Meta cascades a campaign delete, but
  relying on that strands the ad set if the campaign delete is the one to fail).
- `WriteOutbox.purgeForBuild` clears that build's rows. The half that is easy
  to miss: the outbox remembers each object's real Meta id, so deleting on Meta
  while leaving the rows makes the next attempt resume onto ids that no longer
  exist — the exact state repaired by hand this morning.
- Cleanup is best-effort and never masks the original error; undeleted ids land
  in `action_history` as `rollback_build` with `result: 'partial'`.
- The local shell row survives, unlinked, ceiling intact — the operator retries
  into the same row.

**Resume moved to the client.** `Builder.tsx` persists the wizard to
localStorage on every edit, keyed per customer, cleared on success and expiring
after 6h. Per-customer keying and the TTL are both safety properties: without
them a half-filled wizard from one call could restore into the next customer's
session.

**A test that was defending the old behaviour got rewritten, not patched.**
`campaign-create.integration.test.ts` asserted "resuming skips every
already-created object and only retries the failed step" — protecting exactly
what broke. It now asserts the rollback contract. Five new rollback tests cover
newest-first deletion, outbox purge, shell-row reuse, original-error-wins, and
no-op on success.

**Also fixed, same live report:** the wizard accepted a budget above the agreed
ceiling and only refused on the final click. `/builder/context` now returns
`agreedBudgetAgorot` and the budget step refuses it at the field, naming the
real ceiling. Server enforcement unchanged — the client check is convenience,
not the guarantee.

**AIC-50 corrected rather than closed.** Its PAUSED hard rule is dead
(AIC-106), but its partial-failure bullet asked for rollback all along; the
original implementation read "reconcilable" as *resume*, which was defensible
only while creates were PAUSED. Ticket updated, with read-back verify, the
N-ad-set criterion and the dogfood run left explicitly unchecked rather than
quietly claimed.

838 server + 27 web tests pass; the 2 failures are the known pre-existing pair.

### 2026-08-19 — Cleaned up a real orphan; new design decided: a failed build leaves nothing behind
**The incident.** A refused ad-set create (Meta: Page not linked to a WhatsApp
Business Account) left campaign `120250929135090544` ACTIVE with zero ad sets
on a real customer's ad account, unreferenced by our own `managed_campaigns`
row. Not spending — nothing delivers without an ad set — but stranded.

Removed at the user's instruction, and the cleanup had two halves, the second
being the one that is easy to miss:
- Deleted the campaign on Meta (`DELETE /{id}` → `{"success":true}`; account
  now reports zero campaigns).
- Deleted the 10 `meta_write_outbox` rows for that build. The outbox remembers
  each created object's real Meta id, so leaving them would have made the next
  attempt "resume" onto a campaign that no longer exists.

The `managed_campaigns` shell row was deliberately kept — `agreed_budget_agorot
= 2000`, `meta_campaign_id = null` — so the operator can retry cleanly.

**Also found: a permanent deadlock in the outbox.** A row sat at
`status='succeeded'` with `result=NULL`, which nothing can resolve —
`checkSettled` requires a result, the claim requires `pending`. Every retry
forever reported *"create already in progress — retry shortly"*, false on both
counts. Now fails with what is actually true and says to check Meta first.
Deliberately NOT auto-retried: we cannot know whether the original create
reached Meta, and re-creating blindly could duplicate a live spending object.

**The design decision (user).** AIC-50 kept partial creates as resume points.
That reasoning rested on creates being PAUSED — AIC-106 made them ACTIVE the
same day, turning every resume point into a live object. Replacement, now
written up in [campaign-builder.md](features/campaign-builder.md) and clearly
marked **decided, not yet built**:
- a failed build rolls back every object it created, on Meta *and* in the
  outbox — the ad account returns to its pre-attempt state;
- resume moves to the client: the wizard's entered fields persist in browser
  localStorage, cleared on successful submit and expiring after ~6 hours, so a
  stale wizard can never be resumed into a different customer's session.

**Also corrected:** AIC-50's section still stated the hard rule "every create
sends `status=PAUSED`; there is no code path that can create a live object" —
reversed by AIC-106 earlier the same day. Third stale-doc/spec correction
today; the CLAUDE.md rule now covers exactly this class.

### 2026-08-19 — The operator sees the REAL error; and why a WhatsApp "verify" button can't be built
Two findings from the same live incident.

**1. The error surfacing was still too narrow.** The previous entry only
surfaced errors Meta itself had LABELLED (`error_user_title`/`_msg`). Found
immediately after, on the same customer: a build failed with the
WriteOutbox's own `"create already in progress … retry shortly"` — perfectly
good operator copy — still flattened to `"failed to build campaign"`.

The admin build route now attaches `detail` (the real `Error.message`) and
`Builder.tsx` renders it. Deliberately ADMIN-ONLY: the customer-facing
builder route keeps the friendly generic message, because a customer can act
on none of it. AIC-105's "no raw codes in the operator UI" rule is about not
making an operator decode a NUMBER — a real sentence is what that rule
wants them to have.

**2. Researched the requested "verify WhatsApp number" button — it is NOT
buildable as a read, and was deliberately not faked.** Tested every candidate
against BOTH the Page that demonstrably works (Pisga, runs a live WhatsApp
campaign) and the one that fails (Ads Agent):

| Probe | Result |
| --- | --- |
| `whatsapp_business_account` | field does not exist |
| `connected_whatsapp_business_account` | field does not exist |
| `has_whatsapp_business_number` | accepted, returns NOTHING — even for the working Page |
| `/whatsapp_numbers`, `/linked_whatsapp_business_account` | unknown path |
| `owned_whatsapp_business_accounts` | `#200` permission denied |

The `has_whatsapp_business_number` result is decisive: it is silently empty
for a Page that IS correctly linked. A button built on it would report
"unknown" always, or "not linked" for a working Page — a control that looks
like verification while verifying nothing, which is the exact failure mode
this codebase keeps getting burned by. Meta only reveals this at ad-set
creation, which is a real write. So the honest answer to "warn me earlier"
is (1) above: make the failure legible the instant it happens.

**Flaky test recorded honestly, not waved through:**
`recommendation-oversight.integration.test.ts` failed on 2 of 4 full-suite
runs WITH these changes, passed on master's run, and passed in isolation
BOTH with and without the changes. It touches recommendations/oversight;
these changes touch builder routes + the Meta adapter. Most likely
shared-DB ordering sensitivity (the suite went 833→834 tests, shifting
timing). Calling it FLAKY-OBSERVED rather than "pre-existing, fine" — the
distinction AIC-109 exists to protect.

831 server + 27 web tests pass; the 3 known failures unchanged.

### 2026-08-19 — Meta's own error message reaches the operator, instead of a dead-end 502
Same real onboarding call as the ceiling gap: after fixing that, the build
failed again with the generic `"failed to build campaign"`. The Railway log
had the real cause — Meta REFUSED the write with a clear, specific,
already-translated reason:

    error_user_title: "Page With WhatsApp Business Account Required"
    error_user_msg: "Your Page is not linked to a WhatsApp account.
                      Connect a WhatsApp Business account to drive
                      traffic to WhatsApp."

The generic catch-all was discarding it. This is exactly AIC-105's "Meta API
failure — never surface a raw code, translate it" acceptance criterion,
built for the first time against a real live case instead of an invented
error shape.

`GraphWriteError` carries Meta's `error_user_title`/`error_user_msg`
structurally whenever Meta provides both; every write path in
`campaign-adapter.ts` throws it instead of a plain `Error(string)` in that
case. The build routes surface it as `502 meta_write_refused` with Meta's
real message, title, and `is_transient`.

**Caught a real test-hygiene bug while writing the test for this**: the new
test didn't stub `fetch` before its setup calls (start/creative), so those
silently hit the REAL Meta API over the network — a harmless GET, but wrong
and flaky. Fixed by stubbing `mockMetaFetch()` first, matching every other
test in the file, and swapping to the error stub only for the build call.

**Deliberately narrow, and said so in the code and the doc**: this is one
slice of AIC-105's error-handling scope — the cases Meta already labels
clearly for us. NOT built: the symptom-table translation for errors Meta
doesn't label this well, the 409/state-conflict category, the transient-vs-
real retry UX (the boolean rides along, nothing acts on it yet), inline
pre-submit field validation. AIC-105 still owns tracking those.

831 server tests pass (2 of the known 3 pre-existing failures tripped this
run — the third, write-outbox, is the flaky one and didn't; consistent with
prior observation). Typecheck and web build clean.

### 2026-08-19 — The agreed ceiling gets a place to be set, closing a live incident on a real call
User report: got `no agreed daily budget is set for this customer` on the
FINAL click of building a real customer's first campaign — after filling the
entire wizard (goal, destination, budget, category, audience, placements,
three ads). Confirmed live: `agreed_budget_agorot` was 0 for this customer's
shell row, and there was NO field anywhere in Branch A's flow to set it
before reaching that click.

Root cause: AIC-106 half 1 added the ceiling guard but only ever threaded
`agreedBudgetAgorot` through the hasCampaign (Branch B / adopt) provisioning
path. Branch A's "צור קמפיין חדש" provisions the connection alone — no
campaign, no budget field, ever — because the half-1 work assumed a budget
would already exist by build time. It didn't, for any brand-new customer.
The ₪20/day the operator typed in the builder's own budget step is the
PROPOSED spend, never the AGREED ceiling — conflating those two was half of
the ORIGINAL bug this module exists to prevent, and this gap would have
reintroduced the same conflation from the other direction if left as "just
use the wizard's number."

Fixed: a required "תקציב יומי שסוכם עם הלקוח" field next to "צור קמפיין חדש",
gating the button the same way the Page/Instagram checks already do.
`provisionConnection` now accepts the budget on the connect-only path and
pre-creates the builder's shell row with the ceiling already set;
`startBuilderCampaign`'s existing idempotent lookup finds and reuses it — no
change needed there. Omitting the budget is unchanged behaviour (no shell
row) — purely additive.

**Caught and fixed a bug in my own first pass at the route change**: the
`else if` branch I wrote for the connect-only budget validation initially
swallowed the `destinationType` block that must only run for `hasCampaign` —
typechecking passed but the logic was inverted. Caught before shipping by
re-reading the diff rather than trusting the type-check alone.

**Also fixed in the same unit of work**: `Builder.tsx`'s review-step subtitle
still read "כל מה שנוצר עכשיו יהיה במצב מושהה — לא יוצא כסף עד שתאשרו..." —
the OLD launch-gate copy — directly above the NEW confirmation card that says
the opposite. Missed during AIC-106 half 2 because this string sits in a
different part of the `review` block from `createCta`/`successTitle`, which
were corrected. Exactly the class of miss the CLAUDE.md spec-correction rule
exists to catch, this time inside code rather than a Linear ticket.

New tests: 3 DB-level (`customer-onboarding.integration.test.ts`) covering
budget-present, budget-absent (unchanged), and budget-on-retry; 2 route-level
(`onboarding.integration.test.ts`) covering the exact request the real button
sends, valid and invalid.

830 server tests pass (3 known pre-existing failures, unchanged); 27 web
tests pass; typecheck and build clean.

### 2026-08-19 — Instagram picker: also in steps 1 and 2, where the script already promised it
User report: "still dont see instagram picker" — while looking at step 1,
where it was never added. Real gap, not user error: step 1's own script text
says "אם נדרש, חוזרים על אותו תהליך עבור עמוד הפייסבוק (Page) / אינסטגרם
(Instagram) תחת דפים" — but only the Page had a matching field. Instagram was
only ever added to step 4's provisioning form (AIC-108 mirrored the `page_id`
TEXT FIELD that lived there before it became a picker), and nobody carried it
back to steps 1/2 the way the Page picker already had it in both places.

Added the same picker + check button to step 1 and step 2, reusing the
`igAccounts` list step 4 already loads (no new fetch) and the same
carry-over sync the Page field already had: a successful check in step 1/2
fills step 4's field automatically, so nothing is re-entered.

Verified live against the real customer (act_1573023157816786,
@ads_agent_il): both step-1 and step-4 dropdowns list the account; selecting
+ checking in step 1 shows "תקין" and carries the id into step 4's field.

Also confirmed while investigating: the earlier "not there" report was a
false alarm about STEP 4 specifically — that picker was correctly rendering,
just as a collapsed `<select>` showing its placeholder until opened. The real
gap was step 1/2 having no field at all, not step 4 being broken.

### 2026-08-19 — AIC-105 Branch A: the build refuses an incomplete campaign; spec corrected
Two things, one unit of work.

**The gap.** AIC-103 enforces the per-destination required-fields table at
provisioning, at use, and as a health check. AIC-105's Branch A slipped between
all three: it provisions the CONNECTION with no campaign, and the builder
creates the campaign afterwards — nothing re-ran the check. So the one path that
produces new campaigns was the one path whose end state was unverified. Pisga's
own missing `website_url`, reintroduced through the new route.

Confirmed by test before fixing, not assumed: a website build with no
`destinationUrl` and a WhatsApp build with no number both created a live
campaign. AIC-89 does not cover it — `resolveDestinationShape` only checks the
destination is KNOWN, not that its fields are present.

AIC-106 raised the cost rather than causing it: the campaign is ACTIVE on
creation, so an incomplete one starts spending while unable to attribute a
single lead. `CampaignConfigIncompleteError` now refuses before the first Meta
write, surfacing as `409 campaign_config_incomplete` with a `missingFields`
array — never 502, which would blame Meta for our precondition.

**The spec correction.** AIC-105's "Operator cannot activate a campaign — launch
gate intact and tested" was false the moment AIC-106 shipped. Struck and dated
on the ticket, with the Branch A section rewritten to describe what is actually
true. AIC-106 *predicted* this invalidation and shipped anyway, leaving the
correction to be found later.

That pattern is now a rule in `CLAUDE.md` alongside the docs rule: **if your
change makes another ticket's acceptance criteria false, correct that ticket in
the same unit of work** — predicting the staleness is not discharging it. Plus
two distinctions that kept collapsing this session: *unverified* is not *not
done*, and *pre-existing* is not *accepted*.

822 server + 27 web tests pass; the 3 failures are the known pre-existing set.

### 2026-08-19 — AIC-106 half 2: the launch gate is removed; creation goes live
Creation IS the go-live moment now. The builder creates campaign, ad set(s) and
ad(s) **ACTIVE**, and `launch_approved_at` is stamped in the same write.

This reverses AIC-50/AIC-53's original hard rule ("a create must never produce a
live, spending object"), deliberately. The governing distinction is now:
creating something new needs no approval; changing something already running
still does. Recommendation approvals (AIC-12/13) are untouched.

**Why the stamp matters.** `customer-overview.ts` gates its "approve launch"
state on `launch_approved_at IS NULL`. Without stamping it at build time, a
live, spending campaign would have kept prompting the customer to approve its
launch — the dashboard contradicting reality. Locked in by a test.

**What replaced the gate.** It was doing two jobs, only one of which was
approval. The spend ceiling is now the create-path budget guard (half 1). The
other job was incidental but real: catching a correctly-typed budget against
the WRONG customer, which no numeric check can catch. So creation now confirms
with the customer's name, the daily budget, and that it starts immediately —
the name sourced from the customer record via `BuilderContext.businessName`,
never from operator-entered text, since a name the operator typed would confirm
nothing.

**Consequence worth stating:** the AIC-18 first-campaign review still exists and
still moves `under_review → active`, but it no longer sits between creation and
spend. It is a management record, not a spend gate.

**Copy that was silently false is corrected:** the review step said
"יצירת הקמפיין (מושהה)" and "הקמפיין נוצר במצב מושהה".

**Deliberately NOT deleted:** the launch-approval path (`launch/activate.ts`,
`services/customer-launch.ts`, `/app/launch`, the Home modal). It is the only
way to activate a campaign created PAUSED under the old behaviour. Verified
against the DB that none remain (both live campaigns are already launched), so
it is unreachable for new work — but deleting it before that check would have
risked stranding an old campaign as permanently unactivatable. Removal is
cleanup, tracked separately.

818 server + 27 web tests pass; the 3 failures are the known pre-existing set.

### 2026-08-19 — AIC-106 half 1: the create path gets a real budget ceiling
Prerequisite for removing the launch gate. The gate is currently the only thing
between a mistyped budget and live spend, so the ceiling has to be real before
it comes out.

Found by tracing callers rather than trusting names — the gap was worse than
AIC-106's own description ("verify the guard applies to create, not just
update"):

- `assertWithinBudget` had exactly ONE caller, `safe-executor.ts`. Nothing
  bounded a CREATE.
- `builder/campaign-create.ts`'s closing UPDATE **wrote**
  `agreed_budget_agorot = input.dailyBudgetAgorot`. The builder proposed the
  budget AND rewrote the ceiling to match — in either direction. A build under
  the agreed figure silently ratcheted the customer's agreement DOWN, and later
  recommendations were then measured against a number nobody agreed to.

**A passing test was defending the bug.** `campaign-create.integration.test.ts`
asserted `agreed_budget_agorot === 4000` after a build, encoding the overwrite
as expected behaviour. That is most of why it survived a covered path.

Now: `assertCreateWithinBudget` runs before the first Meta call (an
over-ceiling campaign must not exist on Meta even PAUSED), and the create path
READS the ceiling — provisioning owns it.

**Fails closed on a missing ceiling.** Measured against the shared DB: 13 of 15
campaign rows carry `agreed = 0` (12 `__it_*` leftovers, one real customer
provisioned but unbuilt — an AIC-105 Branch A row). None are NULL, so 0 is the
state that actually occurs. Treating it as unlimited would make the most
dangerous state the most permissive one.

**And it says why.** Both refusals were previously 502 "failed to build
campaign" — "Meta is broken" about a precondition on our side, sending an
operator mid-call to inspect Meta instead of filling one field. Now 409 with
distinct codes, because the fixes differ: `budget_ceiling_missing` (agree a
budget at provisioning) vs `budget_over_ceiling` (lower the number).

Scope: the additions path needs no ceiling — budget is campaign-level (CBO) and
neither `AddAdInput` nor `AddAdSetInput` has a budget field, so added content
cannot raise spend. Verified by grep.

816 server tests pass; the 3 failures are the known pre-existing set
(write-outbox, operator-accounts, customer-overview lead-quality), confirmed
unchanged against master.

**Not done, deliberately:** the gate itself still stands. Removing it is the
irreversible half and wants its own review.

### 2026-08-19 — Instagram gets a picker, on the edge the scope fix uncovered
Follow-on from the entry below, now that there is a real IG account to build
against. `GET /admin/customers/:id/onboarding/instagram-accounts` +
`GraphCampaignAdapter.listInstagramAccounts`, wired into step 4 as a dropdown
in place of the free-text field.

The case for picking is sharper than it was for Pages: an IG id is 17 digits
with no human-readable part, so a typo is both easy to make and impossible to
spot by eye — and under AIC-108's gate a bad id flips the connection to
`revoked` and silently stops the engine.

Simpler than `listPages`, which needed a same-business ∪ promote_pages union
after two wrong turns: this edge is per-account by construction. Verified live
through the real adapter, not a mock —

    act_1573023157816786 -> [{17841447360487819, ads_agent_il}]
    act_2181076988590009 -> []

Locked in as tests: the scoping (never offer another account's IG), the
username fallback to the id, the 400 when unscoped, and the 503 with no token.
An empty list renders its reason — no IG account attached to this ad account,
fixed in Meta Business Settings — rather than an empty dropdown (AIC-98).

### 2026-08-19 — Instagram actually works: the entry below was wrong, and so was the scope table
**Corrects the block immediately following this one.** That entry concluded
Instagram was blocked by the Meta App lacking an Instagram use case. It was
measured wrong twice, and the customer granting partner access to the ad
account disproved it outright.

Verified live against the production System User token — whose scopes still
contain **no `instagram_*` entry at all**:

    act_1573023157816786/instagram_accounts -> [{id: 17841447360487819, username: ads_agent_il}]
    17841447360487819?fields=id,username    -> 200 OK
    act_2181076988590009/instagram_accounts -> []   (correctly scoped, no leak)

**Instagram rides on the ADS grant.** The IG account is attached to the ad
account, so partner access to that account carries it; `instagram_basic` was
never involved. Both earlier conclusions — "the token lacks the scope", then
"the App lacks the use case" — were reasoned from how Instagram usually works
rather than measured. Neither survived a probe.

**The real bug this exposed.** `REQUIRED_SCOPES.instagram` listed
`instagram_basic` (flagged at the time as reasoned-not-verified). Because
`classifyAccess` short-circuits on `directReadOk === true`, this never blocked
a working account — but on a FAILING read it made the verdict
`token_missing_scopes`, i.e. *"regenerate the System User token and rotate the
secret"*, for what is usually a typo. That is precisely the wild goose chase
`access-layers.ts`'s own header warns against. Fixed test-first; the entry is
now `["ads_management"]`, deliberately the minimal claim, since
under-requiring degrades to the honest `unreadable_unknown_cause` while
over-requiring sends someone to rotate production credentials.

Measured before and after, on the real accounts:

| IG id | before | after |
| --- | --- | --- |
| `17841447360487819` (real) | `ok` | `ok` |
| bogus id | `token_missing_scopes` ❌ | `unreadable_unknown_cause` ✅ |

**The field is re-enabled** — the `INSTAGRAM_SUPPORTED` flag and its
`instagramUnavailable` copy are deleted rather than flipped, since the premise
they encoded is false. Still true and unchanged: zero connections have
`instagram_id` set, and it has no live consumer.

Standing lesson, now paid for twice in one day: **the layer that grants access
is not always the one you would predict.** Probe the edge before writing the
rule.

### 2026-08-19 — Instagram: the field was impossible to complete, and the cause is an App setting
Follow-up to AIC-108, from the user asking why Instagram has no picker like
the Page now does. Traced it to the root rather than adding a picker:

- The System User token carries **no Instagram scopes** —
  `catalog_management, threads_business_basic, pages_show_list,
  ads_management, ads_read, business_management, pages_read_engagement,
  pages_manage_ads, public_profile`.
- And it cannot: the permission list shown when minting a token does **not
  offer** `instagram_basic` at all. Meta's own dialog says why — "an app
  admin may need to customize or add a use case to this app". So the blocker
  is the **Meta App's configuration**, one level above the token.
- Consequence, verified through the real classification path: any Instagram
  id typed in the wizard resolves to `{ ok: false, layer: 3, diagnosis:
  'token_missing_scopes' }` and AIC-108's gate refuses the save. The field
  was impossible to complete.
- Also confirmed: **zero** connections have `instagram_id` set, and it has no
  live consumer, so nothing is affected either way.

The field now renders disabled with that reason instead of letting an
operator type into a dead end mid-call (AIC-98). The verification and gate
underneath are unchanged — re-enabling is a one-line flip of
`INSTAGRAM_SUPPORTED` once the App has the use case and the token is
re-minted.

Honest caveat carried forward: `REQUIRED_SCOPES.instagram` lists
`instagram_basic` by reasoning, not verification — we have no real IG account
to test against. If the read turns out to need fewer scopes, that entry is
too strict. Harmless while nothing uses the field.

### 2026-08-19 — AIC-107 slices 5+6: Measurement Trust says "not applicable", and an existing engagement campaign can be adopted
**Tracking health.** An engagement campaign is counted on-platform by Meta —
there is no Pixel that could silently break — so AIC-88's Measurement Trust
question does not apply to it. `summarizeTracking` gained a FOURTH state,
`not_applicable`, deliberately folded into neither `ok` nor `unknown`: `ok`
would assert measurement health nobody checked, and `unknown` would imply a
check that could succeed later. Neither is true. The ticket calls this out
explicitly — report not-applicable with a reason, never a silent pass.

It is evaluated BEFORE the "no ad sets readable" branch on purpose: an
engagement campaign with zero readable ad sets still isn't a measurement
mystery, and `unknown` there would send someone hunting a Pixel problem that
cannot exist. `recordCampaignTracking` persists it as ok-with-a-reason (unlike
`unknown`, which only stamps `tracking_checked_at`), so a stale `broken` flag
from an earlier lead configuration can't linger.

**Picker.** `detectDestination` now recognises `POST_ENGAGEMENT` and returns
`{ destinationType: "engagement", leadEventTypes: ["post_engagement"] }` —
detected from Meta, never asked, the same rule the website type already
follows for its pixel/event. Checked before the lead-implication filter,
because POST_ENGAGEMENT deliberately implies no lead action and would
otherwise be discarded as `unrecognized_objective` — which was only true
while engagement was unsupported. Engagement + lead ad sets in one campaign
is `mixed_ad_sets`, the existing ambiguity reason: one campaign cannot have
two result definitions.

Provisioning accepts the third `destinationType` (the two-way ternary became
a lookup, so engagement can't be silently treated as website), and the wizard
STATES the detected type rather than offering a third radio an operator could
set against what Meta actually reports — with the WhatsApp/website field
groups correctly absent.

479 unit + 33 onboarding integration green; lead detection regression-tested
unchanged (whatsapp → whatsapp, pixel → website, traffic → unsupported).

This completes AIC-107's core. Not done, and deliberately so: the ticket's
evidence-gate recalibration (minimum-results-per-creative is noisier per unit
for engagement, and the ticket warns against inheriting the lead gates
unexamined) — that needs real engagement volume to calibrate against, not a
guessed constant.

### 2026-08-19 — AIC-107 slices 3+4: the dashboard stops calling engagements "פניות", and the engine stops offering to scale them
Two honesty gaps that would have shipped with an engagement campaign the
moment one existed.

**Copy.** The dashboard hardcoded `פניות` / `עלות לפנייה` everywhere. For an
engagement campaign both are simply false — there are no leads. KPI labels,
the weekly graph title, and the lead-quality card are now result-type aware,
keyed on `campaign.objective` (written from the destination at build time, so
the UI and the engine read the same fact rather than guessing separately).
The lead-quality card is not merely hidden: "how many were relevant?" has no
subject here, so it is REPLACED (per AIC-98) by a statement of what the
engine does and does not do for this type — comparison by cost-per-engagement,
no lead-quality question, no budget-increase recommendations.

**Engine.** `increase_budget` now refuses outright for an engagement campaign.
This is a rule-level refusal, not a UI omission, so the recommendation cannot
be produced at all: "cost per engagement is good, spend more" would push real
money at a metric with no business outcome behind it, which is exactly the
capability AIC-107 excludes on purpose. `isEngagement` rides the same carrier
as `thresholdOverrides` and `lastActionAtByType` (EvaluableCampaign →
CampaignEvidence), so both callers of `evaluateCampaign` inherit it rather
than one silently missing it — and it is derived via `isEngagementResult()`
from `lead_event_types`, the same single source of truth the metrics layer
uses.

Locked in by a test that runs the SAME evidence both ways: it must fire
`increase_budget` for a lead campaign and must not for an engagement one.
Creative comparison is deliberately untouched — cost-per-result is
cost-per-result, and that rule ports unchanged.

475 unit + 319 integration green (the 2 known pre-existing integration
failures — operator-accounts, write-outbox — unchanged).

Still open on AIC-107: engagement detection in the onboarding picker
(adopting an existing OUTCOME_ENGAGEMENT campaign), tracking-health reporting
"not applicable" rather than a silent pass, and recalibrated
minimum-results-per-creative gates for engagement volume.

### 2026-08-19 — AIC-108: an Instagram ID could silently stop the engine, with no way to check it
Confirmed the premise end to end before building, since the ticket flagged
that the risk had been read from the call site rather than traced:

`ConnectionService.verify()` folds the Instagram read into the SAME
worst-health-wins aggregation as the Page (`HEALTH_PRIORITY`: revoked=2 beats
ok=0), and `classifyGraphError` maps both realistic failures to `revoked` —
verified live against Meta on 2026-08-19: a typo'd id returns **code 100**, an
id not shared with us returns **code 10**, and both are in `PERMISSION_CODES`.
A revoked connection drops the campaign from `listEligibleForGeneration`. So
one mistyped Instagram ID silently stopped the recommendation engine —
identical to AIC-69's page_id incident, except page_id has a gate and
Instagram had none. The fix is NOT smaller than the ticket assumed.

Fixed by giving Instagram the same treatment as the Page, not by removing the
field (removing it would leave the column and the health check in place, so
existing rows would stay dangerous):

- `instagram` is now a real `CheckedAsset` end to end — probe, check route,
  stored check key. Layer 1 returns `null` (unknown) rather than a fabricated
  `false`: an IG account is shared THROUGH its Page, so there is no
  `client_instagram_accounts` edge to ask, and claiming "not shared" would be
  a fact we do not have. The direct read mirrors `verifyPath("instagram")`
  exactly, so a pass here really does mean the health check will pass.
- `InstagramNotReadableError`, mirroring `PageNotReadableError`, refuses the
  write before it happens; the route re-verifies immediately before saving
  and returns a 409 tagged `asset: "instagram"` so the client can point at the
  right field.
- Wizard: a `בדיקת אינסטגרם` button beside the field, a note stating the rule,
  and a client-side gate on BOTH write paths (provision and Branch A's
  "צור קמפיין חדש", which also writes a connection).

Blank stays completely safe — the health check skips a null instagram_id, so
a customer without Instagram carries no risk and needs no check.

Live-verified in the browser against the real bogus id: typed-but-unverified
blocks the save with a reason; running the check and having it FAIL leaves it
blocked; clearing the field unblocks it. 6 new DB tests cover blank-saves,
unverified-blocked, failed-blocked, verified-saves, atomicity (nothing
written on refusal), and a bad Instagram blocking even when the Page is fine.

### 2026-08-19 — AIC-107 slice 2: the builder can actually create an engagement campaign
User: "dont see option for engagement here" — correct, step 1's objective was
still a disabled field reading "פניות (Leads)".

Found on the way, and the more important half: `FIXED_OBJECTIVE` had **zero
consumers** while `createCampaign` re-hardcoded `objective: "OUTCOME_LEADS"`
inline — the exact constant-with-no-consumers shape AIC-89 already had to fix
for FIXED_DESTINATION/FIXED_CTA. Left alone, an engagement campaign would have
been created **on Meta as a Leads campaign**, and every number downstream
would have described the wrong thing. `objective` now lives on
`DestinationShape` alongside `optimizationGoal`, so it is resolved from the
destination in one place. Two adapter tests pin it: engagement sends
OUTCOME_ENGAGEMENT and must NOT contain OUTCOME_LEADS; whatsapp still sends
OUTCOME_LEADS.

A second trap in the same area: `asCreatingWriter` casts its payload
`as never`, so omitting `destination` from the create_campaign payload would
NOT have been a type error — it would just have silently produced Leads
campaigns. Passed explicitly, with a comment saying why.

UI: step 1 is a real two-way choice (Leads / Engagement) with per-option
hints, and — per AIC-98 — engagement states what the engine will NOT do for
it (no budget-increase recommendations, no lead-quality question) rather than
letting the customer find missing panels later. Step 2 (יעד הפנייה) explains
that engagement has no destination to pick instead of rendering an empty
panel. The creatives step drops the upload tab for engagement and says why:
an engagement ad promotes an existing Page post, and `createCreativeFromUpload`
now refuses a CTA-less destination outright rather than sending Meta
`call_to_action: { type: null }`.

`managed_campaigns.objective` also stops being the literal 'leads' — derived
from the destination, so our own records don't mislabel it either.

Live-verified in the browser end to end: engagement selectable, its limits
note shown, destination step self-explaining, upload tab correctly absent
with its reason, next-gating correct throughout. 474 server + 34 shared + 27
web tests green; lead campaigns regression-tested unchanged.

Still to come for full type support: result-type-aware dashboard copy
(פניות/עלות לפנייה are wrong for engagement), engine rules
(cost-per-engagement comparison, budget rules excluded, tracking-health
reporting N/A), and engagement detection in the onboarding picker.

### 2026-08-18 — Page picker bugfix #2: promote_pages is empty for a brand-new account — the exact case it served
The scoping fix below traded one bug for another, caught by the user within
minutes. `{ad_account}/promote_pages` only lists Pages the account has
ALREADY advertised through, so it returns `[]` for any account with no ads —
which is every account in the Branch A "create the first campaign" flow. The
user diagnosed it from the symptom ("it's empty because it doesn't have a
campaign yet") before the code did.

Sequence worth keeping, because both wrong turns were live-verified rather
than reasoned about:
1. `me/accounts` alone → unscoped, offered another customer's Page.
2. `promote_pages` alone → scoped, but blind to any account without ads.
3. Now: **union of** `me/accounts` filtered to the ad account's own
   `business.id`, **plus** `promote_pages`. The business filter is what makes
   a new account resolve (an account advertises only for Pages its business
   holds); `promote_pages` stays in the union because it also covers a Page
   shared in from outside that business, which the filter alone misses.

Verified live against both real accounts, in the browser and via Graph:
`act_1573023157816786` (business `1518507149596335`, zero ads) → `Ads Agent`;
`act_2181076988590009` (business `467328257419676`) → the Pisga Page. Neither
leaks into the other.

Also confirmed along the way, and worth recording as the canonical example of
the three-layer model: `Ads Agent` had been shared to our portfolio (layer 1,
the customer's step) but never assigned to our System User (layer 2, OUR step
in our own Business Settings). It was invisible to every read until the user
assigned it — which is precisely the distinction step 2 of the wizard exists
to surface, and why the empty-state copy names steps 1–2 rather than blaming
the customer.

### 2026-08-18 — Page picker bugfix: it offered another customer's Page
Caught by the user minutes after the picker shipped: with
`act_1573023157816786` selected, the dropdown still suggested
`פסגה הכנה חכמה לפסיכומטרי` — a Page that account cannot promote.

Root cause: `me/accounts` lists every Page the SYSTEM USER can manage,
across all customers — it has no notion of which ad account is in play. So
the picker reintroduced the exact "I don't want to accidentally choose
someone else's account" risk the ad-account picker was built to remove,
which is worse than the free-text field it replaced (typing at least
required knowing the id).

Fixed by scoping to `{ad_account}/promote_pages` — Meta's own "which Pages
can this account advertise for" edge. Confirmed against the two real
accounts before writing any code: `act_2181076988590009` → the Pisga Page,
`act_1573023157816786` → `[]`. The route now requires `metaAdAccountId`
(400s without it — an unscoped Page list is meaningless), the list refetches
when the account changes, and a Page selected under a previous account is
cleared if the new one can't promote it. Empty now states the specific
truth: "this ad account has no promotable Pages", not "no Pages found".

Live-verified both directions in the browser: the reported account shows an
empty picker with that message; switching to `act_2181076988590009` brings
the real Page back. 3 new route tests, including the cross-customer case
this bug was.

### 2026-08-18 — Page picker: "pick, don't type" for the Page too, and an honest answer to "is it חובה or not"
User asked why they should be typing a Page id at all when we can already
read which Pages were shared with us — the same objection AIC-105 Branch B
answered for ad accounts. Built the Page-side sibling.

`listPages()` on `GraphCampaignAdapter` reads `me/accounts?fields=id,name` —
the SELF-scoped "what can this System User actually manage" edge already
proven live in this codebase (`pageAccessToken`, and access-probe's layer-2
check both use it), deliberately NOT the layer-1-only `client_pages` share
list access-probe uses to DIAGNOSE a broken connection. A Page appearing in
this list has therefore already passed both access layers, exactly like the
ad-account picker's guarantee. New `GET .../onboarding/pages` route; both
step 1's and step 4's free-text Page fields are now `<select>`s. The
per-asset "בדיקת עמוד" check still runs on the picked id — picking proves
layers 1+2, not layer 3 (token scopes) or the direct read.

Also fixed the copy contradiction the user caught in the same breath: the
field was labeled "מזהה עמוד (לא חובה)" while Branch A had just started
REQUIRING it. Both are true, for different paths, so the label now says so
outright — "לחיבור קמפיין קיים — לא חובה. לבניית קמפיין חדש — חובה, כי כל
מודעה רצה דרך עמוד." Live-verified against the real shared Page
(`פסגה הכנה חכמה לפסיכומטרי`, 1216278568228263): it loads into both pickers
and the check passes on the picked value.

**Instagram deliberately NOT given the same treatment — it needs a decision
first, not a picker.** Found while answering "what about instagram?":
`meta_connections.instagram_id` is live-verified on every
`ConnectionService.verify()` (`client.ts`'s `verifyAssetAccess("instagram")`)
and folded into `worstHealth`, so an unreadable value degrades the WHOLE
connection — the exact AIC-69 failure class that silently stops the
recommendation engine. But unlike `page_id` it has **no save-gate**, and
`instagram_actor_id` appears nowhere in creative creation, so the field
currently carries that risk while doing nothing. A read-only probe of the
real Page also shows no linked Instagram account at all. Open question for
the owner: gate it like `page_id`, or drop the input until Instagram
placement is actually implemented.

### 2026-08-18 — AIC-105 Branch A bugfix #2: the button worked, then the builder said "not ready" with no reason why
User-reported, same live test session as the idempotency fix above: the
click succeeded this time, but the very next screen (the builder) showed the
generic "עוד לא מוכנים להתחיל" — no page, no ad account, or already-has-a-
campaign are all folded into that one message.

Root cause: `מזהה עמוד (לא חובה)` is genuinely optional for CONNECTING an
existing campaign, but building a FIRST one always needs a Page — the
operator had picked the real ad account (`act_1573023157816786`, the one
shared by `אבשלום אבורוס`) without ever verifying a page for it, so the
connect-only provision correctly succeeded with `page_id = NULL`, and the
builder then correctly refused — just with no way to tell, from where the
operator actually was, that a missing Page was the reason.

`startNewCampaign()` and the button's `disabled` now both check
`newCampaignPageMissing()` (empty `pageIdForm`) before `pageIdUnverified()`
runs — blocks with a specific, actionable message
(`errorPageRequiredForNewCampaign`, "לבניית קמפיין ראשון צריך קודם למלא ולאמת
מזהה עמוד") before any request leaves the browser, instead of letting the
operator discover it a screen later. Live-verified against the same real ad
account: button disabled + message shown with no page id typed; verifying
the page (step 1's "בדיקת עמוד") re-enables it; the full happy path through
to the builder's step 1 still works unchanged.

### 2026-08-18 — AIC-105 Branch A bugfix: re-clicking "צור קמפיין חדש" crashed instead of resuming
User hit this live minutes after the Branch A ship, on a real customer:
`duplicate key value violates unique constraint "meta_connections_customer_id_key"`.

Root cause: `meta_connections` is `UNIQUE(customer_id)` by design (P0 — one
connection per customer), but `provisionConnection`'s connect-only path
(Branch A) did a bare `INSERT`. The button is genuinely re-clickable — an
operator can land in the builder, go back, and land on step 4 again with the
same empty picker — so a customer who'd already been connected-only hit the
raw constraint violation as an unhandled 500 instead of a no-op resume.

Fixed with `ON CONFLICT (customer_id) DO UPDATE` (not `DO NOTHING`, so
`RETURNING id` still fires and a page id verified on a later click still
backfills a connection that didn't have one yet) and the matching
`ON CONFLICT (connection_id, meta_ad_account_id) DO UPDATE` on the
`ad_accounts` insert (migration 037 already made that pair the real unique
key; the write side hadn't caught up). Test-first: reproduced the exact
constraint violation via `provisionConnection` called twice for the same
customer, confirmed it failed for the right reason, then fixed. 3 new tests
in `customer-onboarding.integration.test.ts` (idempotent resume, a second
different ad account adds a row under the same connection, a page id
backfills once verified); all 66 relevant integration tests + 472 unit
tests green.

### 2026-08-18 — AIC-105 Branch A: "צור קמפיין חדש" — a customer with no campaigns gets the real builder, not a dead end
User reopened the wizard live and hit the exact spot the previous entry
flagged as the real remaining gap: step 4's campaign picker, empty, saying
"the wizard doesn't support this yet." Built Branch A.

**Backend.** `resolveBuilderContextForCustomer(pool, customerId)`
(`server/src/builder/session.ts`) — the customerId-keyed sibling of the
existing userId-keyed `resolveBuilderContext`, sharing the readiness check
(healthy connection, ad account + Page, no campaign yet) via one
`contextFromRow` helper so the two can't silently drift. `provisionConnection`
(`customer-onboarding.ts`) now treats every campaign field as optional AS A
UNIT, keyed on `metaCampaignId`'s presence: omitted means "connect the
account only" (skips the `managed_campaigns` insert, `campaignId: null` in
the result); provided without `campaignName` throws, never a half-written
campaign row. New `server/src/routes/admin-builder.ts` mirrors
`routes/builder.ts`'s 8 routes 1:1 (`/admin/customers/:id/builder/*`,
`requireAdmin`), resolving context via the new customerId-keyed resolver
instead of a JWT; `POST .../build` — the write that actually creates the
Meta campaign — is logged to the admin audit trail
(`customer.builder.build`), the one route in the mirror where "which
operator, for which customer" has to stay answerable.

**Frontend.** No second wizard was built. `Builder.tsx` and
`BuilderCreatives.tsx` both gained an optional `customerId` prop; every
builder call in `api.ts` gained a matching optional `customerId` that
switches its base path between `/app/builder` and
`/admin/customers/:id/builder` (`api()` already picks the right auth token
for any `/admin/*` path, so nothing else about auth changes). New
`AdminBuilder.tsx` wrapper mounts the same `<Builder>` at
`/admin/onboarding/:id/builder`, supplying `customerId` and an `onExit` that
returns to the onboarding wizard instead of `/app`. In `AdminOnboarding.tsx`,
when the campaign picker's list comes back empty for the picked ad account,
the campaign-specific fields (destination type, name, budget,
WhatsApp/website) hide and a single "צור קמפיין חדש" button replaces them —
click provisions the connection alone, then navigates into the builder.

**Verified live** against a real ad account with zero Meta campaigns
(`act_1573023157816786`, via the Pisga test customer): confirmed the button
appears exactly when the picker is empty; confirmed the connection-only
provision write (page-id-absent case correctly left the builder at "not
ready" — the same Page precondition the self-serve builder already
enforces; page-id-present case correctly proceeded to a real "step 1" render,
`SupportCard` correctly suppressed in admin mode); confirmed the local shell
row it created carries `meta_campaign_id = NULL` — no real Meta write
happened during verification. Backend: 5 new integration tests
(`admin-builder.integration.test.ts` + 2 added to
`onboarding.integration.test.ts` for the connection-only provision path); all
472 unit tests + every builder/onboarding/admin-builder integration test
green. Two pre-existing integration failures elsewhere
(`operator-accounts`'s "last full admin" demote guard,
`write-outbox`'s drain-once test) reproduce identically on unmodified `master`
against the shared dev DB — confirmed via `git stash` before writing this —
unrelated to this change.

### 2026-08-18 — AIC-105: page-ID save-gate made load-bearing on the client + budget split
User wrote a fuller spec into AIC-105 for step 4 after confirming Branch A
(no-campaign-yet) is the real remaining gap. Two pieces shipped now, both
scoped to the already-built existing-campaign path:

**Page-ID gate.** The ⚠️ AIC-69 banner explained the rule but didn't enforce
it client-side — a typed page id could reach the save request even if
`בדיקת עמוד` was never run or failed (the server already refused it, but only
after a round trip). `submitProvision` now blocks, and the submit button
disables, whenever `form.pageIdForm` is non-empty and doesn't match a
passing, SAME-id check in `state.checks.page` — catches both "never
checked" and "checked a different id after retyping."

**Budget split.** Picking an existing campaign no longer prefills the agreed-
budget field from Meta's live `daily_budget` — that was the exact circularity
AIC-106 flagged, just relocated into the picker. The live figure is now
shown read-only, separately, next to the field it used to silently fill;
`fieldBudget`'s label was reworded to make clear it's the AGREED ceiling,
never derived from what Meta happens to be spending right now. Live-verified:
picking `free_beta_signups_leads` shows "כרגע רץ ב-Meta: ₪20 ליום" while the
agreed field stays genuinely empty.

Also: three Hebrew phrases corrected in the shared connect-steps script
(`strings.he.app.connect.steps`, reused verbatim by this wizard) to match
Meta's actual Hebrew UI wording — "חשבונות פרסום"→"חשבונות של מודעות",
"הקצאת שותפים"→"הקצאת שותף" (Meta's own button is singular), "תחת עמודים
(Pages)"→"תחת דפים".

Not yet built (Branch A, the actual remaining gap): a "צור קמפיין חדש" path
for a customer with no existing campaign, reusing the customer builder under
an operator-acting-as-customer mode — tracked as the next piece of AIC-105.

### 2026-08-18 — AIC-101 follow-up: step 2's card has nowhere to click "verify" — now it does
User-reported: even after the previous fix made the ad-account layer-2 check
real, step 2's own card in `AdminOnboarding.tsx` had no check button at all —
the only way to see if the assignment worked was to scroll back up to step
1's button. Added a "בודקים שוב, אחרי ההקצאה" section directly in step 2's
card with its own ad-account/Page check buttons — reusing the exact same
`runCheck` calls and `CheckResult` display step 1 already has (same shared
`state.checks`, so a check run from either card updates both). Live-verified:
clicked the button from step 2's card, confirmed the same real "תקין" result
appeared in both cards.

### 2026-08-18 — AIC-105 follow-up #3: ad accounts get a real layer-2 check, not a permanent null
User asked "do we check step 2 (assign to System User) somewhere?" while
reviewing the wizard. Answer, from the actual code: yes for Pages (`GET
me/accounts`), but for ad accounts `assignedToSystemUser` was hardcoded
`null` — Meta has no self-scoped "which ad accounts am I on" edge, and no
alternative had been built, so a not-yet-assigned ad account could only ever
surface as the generic `unreadable_unknown_cause`, never the specific,
actionable `not_assigned` a Page in the same state gets.

Researched and found a real fix: `GET {ad_account}/assigned_users?business=
{portfolio}` — an object-scoped edge, checked from the other direction (does
THIS account's own assignment list include our System User) — live-verified
against the real `act_2181076988590009` account before writing any code,
confirmed it returns our System User id with its granted tasks. `AccessProbe`
now takes a `systemUserId` dependency and calls this edge for ad-account
checks; `classifyAccess` itself needed no changes (already asset-agnostic —
it just never received a real value for this asset kind before). Test-first:
rewrote the probe test that previously asserted "always null" into cases for
assigned/not-assigned/call-failure, confirmed they failed against the old
code, then implemented. Live-verified end-to-end through the real running
server: the check now returns `assignedToSystemUser: true` for real, not an
inferred null.

### 2026-08-18 — AIC-105 follow-up #2: the ad-account pre-select needed a live account list, not a stale one
User-reported: right after the prior fix shipped, the step-4 picker still
didn't auto-select — only after a full page reload. Root cause: `adAccounts`
was fetched once, at mount, before the operator had run the step-1 check; the
newly-verified account (sometimes only just visible to the System User) had
no way to appear in an already-fetched list. `runCheck`'s success handler
now re-fetches `loadAdAccounts()` immediately after a passing `ad_account`
check, so the pre-select effect has a fresh list to match against without
needing a reload. Live-verified: ran the check via the actual UI on a reset
test customer, confirmed the step-4 selection appeared with no reload.

### 2026-08-18 — AIC-105 follow-up: a passing check now remembers WHAT it checked
Found live on a real customer's onboarding (אבשלום אבורוס): the wizard's
step-1 ad-account check persisted `ok: true` forever but never the id it was
true OF, so reopening the wizard showed a green "תקין" pill next to an empty
field — `detail` was `null` on a passing check, so the id wasn't recoverable
from anywhere. `StoredCheck` (`server/src/services/customer-onboarding.ts`)
gains `assetId`; `recordCheck` takes it as a new parameter and all three
call sites in `routes/admin.ts` pass it through (`null` for the token/
connection checks, which have no single asset). Test-first: added a case to
`customer-onboarding.integration.test.ts`, confirmed it failed against the
pre-fix signature (the new arg landed in the old `at` parameter), then fixed.

Frontend: step 1's `acctId`/`pageId` fields now prefill from the persisted
`assetId` on load (never overwriting live typing), and — per an explicit
user request to minimize admin error — step 4's ad-account picker
auto-selects the SAME account already verified in step 1, once it's
confirmed present in the freshly-fetched list. An unverified id is never
forced into the picker; if it's not (yet) in the list, the field is simply
left for the operator to pick, same as before. Live-verified: ran a fresh
check via the actual UI, reloaded, confirmed both the step-1 field and the
step-4 selection populated from the persisted value.

### 2026-08-18 — AIC-105 Branch B: pick an existing campaign instead of typing its id
User-reported UX problem: the onboarding wizard's step 4 required typing a
raw Meta ad-account id and campaign id by hand, plus manually guessing the
destination type — every character a chance to attach the wrong customer's
campaign or mistype a digit. Replaced both free-text fields with live-fetched
pickers: `GraphCampaignAdapter.listAdAccounts`/`listCampaigns`
(`server/src/meta/campaign-discovery.ts`, new `GET
.../onboarding/ad-accounts` + `GET .../onboarding/campaigns` admin routes)
list what the System User can actually manage right now, and each campaign's
destination is DETECTED — `detectDestination`
(`server/src/meta/tracking-health.ts`) runs the same `getAdSetTracking` read
AIC-88's tracking-health check trusts through the ad sets' own
`optimization_goal`/`promoted_object`, never a question put to the operator.
An unsupported campaign (no ad sets yet, a non-lead objective, mixed ad sets)
is listed disabled with its specific reason, never hidden (AIC-98). Picking a
supported campaign prefills name/budget/destination/pixel/lead-event, still
editable. An ad account already used by a different customer is annotated,
not blocked — AIC-87's migration 038 deliberately allows sharing one Meta ad
account across customers.

Also fixed, same pass: the step-1 ad-account field's "act_" prefix is now a
fixed chip instead of something the operator has to type themselves
(defensive strip if pasted with the prefix already on it), and a Page
verified in step 1 now carries over into step 4 instead of being re-typed.

Live-verified against the real `act_2181076988590009` account: `GelNails |
Leads | WhatsApp` detected `whatsapp`; `free_beta_signups_leads` detected
`website` with the correct real pixel id and lead event, auto-filling the
real ₪20 budget; three Traffic/engagement campaigns on the same account
correctly disabled with reasons.

Explicitly NOT built this pass, tracked as the rest of
[AIC-105](https://linear.app/pisga-app/issue/AIC-105): Branch A (build a
first campaign during the call, via an operator-acting-as-customer mode —
touches AIC-66's 3-actor auth model, a separate and larger piece), and the
ticket's full 4-category operator-error-handling taxonomy across all 5 steps
(applied here only to the two new routes). Docs:
[ops-console.md](features/ops-console.md#meta-connection-onboarding-wizard-aic-101--aic-68).

### 2026-08-18 — AIC-106 (additions half): creating new content goes live immediately, no approval click
Product decision: approval gates belong only in the recommendation engine
(pausing/changing something already running) — creating something new
(campaign, ad, ad set) doesn't need one. Shipped the budget-neutral half
first: `addAdToExistingCampaign`/`addAdSetToExistingCampaign`
(`server/src/additions/add-content.ts`) now call `approveAddition`
internally right after create succeeds, in the same request — a customer
adding an ad no longer sees or clicks a separate approve step.
`pending_additions`/`approveAddition` stay, now as the retry path for the
one failure mode (create succeeded, the follow-up activate call didn't) —
still idempotent, still safe to retry. Confirmed via code investigation
(not assumption) that additions carry no spend risk: budget is
campaign-level CBO, and neither `AddAdInput` nor `AddAdSetInput` has a
budget field, so new content can only deliver within the campaign's
existing daily budget, never raise it.

**Held, not shipped, in the same investigation:** the customer launch gate
(AIC-53) and the admin first-campaign review (AIC-18) are two genuinely
different mechanisms — confirmed by tracing auth middleware and callers,
not by name. The admin review stays (an internal quality check, unrelated
to spend-consent). The launch gate is the other, harder half of AIC-106 and
is deliberately NOT touched yet: unlike additions, campaign creation
currently writes `agreed_budget_agorot` (the value that should be the
spend ceiling) FROM the same customer-typed `dailyBudgetAgorot` it should
constrain — fully circular, so removing the gate today would leave a
mistyped budget with no ceiling at all. AIC-106's remaining scope: make the
create path validate against `agreed_budget_agorot` instead of writing it,
plus a backfill for campaigns (including Pisga's own) already set
circularly — only then does removing the launch gate ship safely. Docs:
[add-content.md](features/add-content.md),
[campaign-builder.md](features/campaign-builder.md#the-launch-gate-aic-53).

### 2026-08-18 — AIC-103 follow-up: the fix-it surface the health check needed
Found immediately on using the shipped health check: the ops console
correctly reported "חסרים פרטי הגדרה לקמפיין (website_url)" but there was
nowhere to actually SET it — the gap the same-day entry below flagged as
"real gap, not built". Closed it: the customer-edit form
(`services/customer-admin.ts` + `AdminCustomers.tsx`) gains a campaign-
destination-config block for all four fields the required-fields table names
(`whatsapp_destination`/`website_url`/`tracking_pixel_id`/`lead_event_types`),
using the same propagate-by-column pattern the budget and threshold-override
edits already use. Each field independent; empty string clears (distinct from
omitting, which leaves unchanged); every changed field named individually in
the audit log. Deliberately NOT the onboarding wizard — it only INSERTs, so
running it on an already-provisioned customer would duplicate the
connection/campaign trio (`offersOnboarding` still excludes
`incomplete_config` for exactly that reason). Docs:
[ops-console.md](features/ops-console.md#customer-crud--admin-audit-log-aic-44),
[add-content.md](features/add-content.md).

### 2026-08-18 — AIC-103: campaign-type required fields — enforced at provisioning, at use, and as a health check
Found live verifying AIC-102: `free_beta_signups_leads` failed at SUBMIT with
a raw 409 after the customer filled out a whole ad — the refusal was
correct, the timing wasn't, and nothing had ever checked the campaign's
config was complete in the first place (provisioned by the AIC-87 script
before `website_url` existed). One declared table
(`shared/recommended-defaults.ts`'s `CAMPAIGN_TYPE_REQUIRED_FIELDS` +
`missingRequiredFields`), enforced three times: (1) **at use** —
`AdditionContext.missingConfigFields`, surfaced by `GET /additions/context`
as part of a normal 200 (never a 409 — folding it into the blanket
readiness gate would have re-broken AIC-102's existing-post fix, which
needs none of this data), rendered as an upfront `AddContent.tsx` banner;
(2) **at provisioning** — `provisionConnection` now asks an explicit
`destinationType` question and refuses (400, `IncompleteProvisioningError`)
an incomplete campaign before it's ever written; found in the process that
`whatsapp_destination` had never been a field on this form at all, so every
WhatsApp campaign provisioned through the wizard silently got `''`; (3) **as
a health check** — `services/customers.ts`/`users-admin.ts`'s admin fleet
views gain a fifth `connectionReadiness` reason, `incomplete_config`, plus a
`missingConfigFields` detail. Found and fixed in the process: offering the
(insert-only) onboarding wizard for `incomplete_config` would create a
duplicate connection/campaign trio — `offersOnboarding` now excludes it,
same as the fully-ready case. Also corrected AIC-68/AIC-101/AIC-89's Linear
statuses (Backlog/Todo/Backlog) to reflect what was actually shipped earlier
this session — AIC-68/101 to Done, AIC-89 to In Progress (its own live-verify
acceptance criterion is what this ticket unblocks). Docs:
[add-content.md](features/add-content.md),
[ops-console.md](features/ops-console.md). Real gap flagged, not built:
there is still no admin surface to edit an already-provisioned campaign's
fields — the health check finds the problem, fixing it is still manual.
free_beta_signups_leads' `website_url` still not set — blocked on the real
destination URL.

### 2026-08-18 — fix: existing-post creative 502'd on a real page post (double-prefixed object_story_id)
Found live while verifying AIC-102: the "existing post" path — designed to
need zero destination data — failed with a raw 502 on a real attempt.
Root cause: `listPromotablePosts` passed Meta's own `/posts` edge `id`
through unchanged, but that `id` already comes back in Meta's compound
`"{page-id}_{post-id}"` story-id form; `createCreativeFromExistingPost`
then re-prefixed `pageId` onto it, doubling the prefix into a malformed
`object_story_id`. Meta rejected it with `(#100) Invalid post_id parameter`,
which the route's generic catch-all turned into an opaque 502 — the real
Meta error was never visible to the customer or in the client-facing
message. Fixed at the source: `listPromotablePosts` now strips a leading
`"{pageId}_"` off Meta's `id` before returning it, so `postId` means "the
post's own id" everywhere downstream, matching what
`createCreativeFromExistingPost` already assumed.
[add-content.md](features/add-content.md). New regression test in
`meta/campaign-adapter.test.ts` mocks Meta's real compound id shape.

### 2026-08-18 — AIC-89: builder can create website/Pixel campaigns, not just WhatsApp
Destination becomes a real builder step (WhatsApp remains the recommended
default) — the create-path counterpart to AIC-102's additions fix. New
builder step 1 collects a destination URL, a Pixel (picked from
`GET /builder/pixels`, a new `listPixels` adapter method — no more free-text
entry for the create path), and a conversion event (a curated
`LEAD_CONVERSION_EVENTS` list — `LEAD`/`COMPLETE_REGISTRATION`/
`SUBMIT_APPLICATION`/`SCHEDULE`/`CONTACT` — each mapped to its exact Meta
Insights `action_type` via `resolveLeadActionType`, so
`managed_campaigns.lead_event_types` is never built from an inline string
transform). `createAdSet` now builds the full `pixel_id`/`custom_event_type`
`promoted_object` for the website destination, branching the same way
`createCreativeFromUpload`'s CTA already does (AIC-102). New build-time
guardrail: `checkPixelEventRecency` (three-valued — `true`/`false`/`null`,
never a confident "dead Pixel" from an ambiguous read) warns before creating
a campaign against a Pixel that hasn't recently seen the chosen event.
Switching destination mid-wizard clears the other branch's fields. Deliberately
NOT extended: `POST /additions/ad-set` (adding a new ad set to an *existing*
campaign) — still WhatsApp-only, a separate real gap if it's ever needed.
Docs: [campaign-builder.md](features/campaign-builder.md#the-destination-choice-aic-89)
(new section + corrected stale "always WhatsApp" sentences),
[add-content.md](features/add-content.md) (AIC-89 cross-references updated
now that it's shipped). 57 new/updated tests across
`shared/recommended-defaults.test.ts`, `meta/campaign-adapter.test.ts`,
`meta/destination.test.ts` (the AIC-102 destination-resolution logic moved
here, generalized, and shared with the builder — no longer additions-only),
`builder/campaign-create.integration.test.ts`,
`routes/builder.integration.test.ts`. Live-verify (an actual paused ad
created on Pisga's real campaign) still pending a real destination URL.

### 2026-08-17 — AIC-102: additions/creative flow supports website/Pixel campaigns
Found live: Pisga's own dogfood campaign (`free_beta_signups_leads`, a real
Pixel/website campaign) could not add an ad to its own campaign through its
own product — `additions/session.ts`'s `whatsappWriteBlock` refused ALL
non-WhatsApp campaigns unconditionally, with no alternative shape for the
type Pisga itself runs. New `resolveCreativeDestination` governs the creative
(add-ad) path only, branching on the same messaging-vs-not classification
AIC-87 already derives: WhatsApp unchanged; website/Pixel now builds a
`link_data` + `LEARN_MORE` creative from a new `managed_campaigns.website_url`
column (migration 040), set through the AIC-101 wizard's provisioning form.
Missing the needed field on either branch refuses with a distinct 409 reason
before any Meta call. Ad-set creation (`POST /additions/ad-set`) is
deliberately **unchanged** — still WhatsApp-only, still AIC-89's territory.

Second, independent fix in the same investigation: an existing-post creative
(`postId` given) needs no destination fields at all —
`createCreativeFromExistingPost` only ever sent `object_story_id`, reusing
whatever CTA the original Page post already has — but the old blanket refusal
ran before checking which creative kind was being built, so it was blocked
for no real reason. Both Meta-side ads on the flow's real regression test
(new-content and existing-post) were confirmed working against a real Meta
mock; new doc: [features/add-content.md](features/add-content.md) (no owning
doc existed for this area before).

Related, same session: 44 integration-test-artifact `customers` rows removed
(the DB-pollution cleanup below); Pisga's real Meta connection was
archived — not deleted — to a dedicated archive customer (preserving 50
insight_snapshots + 1 recommendation intact) so the AIC-101 onboarding wizard
could be tested end-to-end against a genuinely fresh account.

### 2026-08-16 — Fix: /admin/users offered onboarding to already-connected users
Reported live right after shipping the Users view (below): Pisga and
free_beta test — both fully connected — still showed "start onboarding,"
and clicking it would have run provisioning a second time, inserting a
duplicate connection/ad_account/campaign for a customer that already has a
working one (provisioning always inserts, never upserts). Added
`offersOnboarding` (`web/src/admin/user-row-status.ts`, unit-tested): withheld
once `connectionReadiness === null` (fully ready); still offered for no
business yet or any readiness gap short of that. A fully-connected row's
action now links to `/admin/customers?focus=<id>` instead.

### 2026-08-16 — Cleanup: removed 44 integration-test artifact customers
Deleted 44 `customers` rows (`__it_outbox` ×37, `__it_snap` ×4, `__it_readout`
×2, `__it_ro_today` ×1) left behind by the DB integration test suite, which
runs against the same Neon database as production rather than an isolated
test DB. None had a login attached; 41 even carried `is_test = false`, so
they'd have silently counted as real customers in growth stats. Deleted via
the real audited `deleteCustomer` path (confirm-to-type enforced server-side,
cascades through connections/ad accounts/campaigns, logged to
`admin_audit_log` with a before-state snapshot per row) — same mechanism the
admin UI's delete button uses. Only 2 real customers remain (Pisga,
free_beta test). Newly-added integration tests should clean up their own
`__it_*` rows same as the existing ones already do — this was pollution from
runs that didn't, not a gap in the cleanup convention itself.

### 2026-08-16 — Admin: separate Users view, entry point into onboarding
New `/admin/users` page — deliberately separate from `/admin/customers`,
not a replacement (explicit product decision): a **user** (`app_users`:
email/password/name) is the login, distinct from a **customer**
(`customers`: the business the Meta connection hangs off), and the customers
page can't show a real signup that has no business linked yet since it
queries `customers` first. This page queries `app_users` first instead, so
every login gets a row. Clicking one opens the AIC-101 onboarding wizard —
auto-creating and linking a bare business record on first click
(`ensureCustomerForUser`, idempotent) if the user doesn't have one yet.
Payment details and trial state are explicitly deferred — not built.
See [ops-console.md](features/ops-console.md#users-view-separate-from-customers-2026-08-16).

### 2026-08-16 — AIC-101 + AIC-68: admin Meta connection onboarding wizard
Replaced the "no console UI, hand-written SQL against prod" gap
[META_SETUP.md](features/ops-console.md#meta-connection-onboarding-wizard-aic-101--aic-68)
used to flag with `/admin/onboarding/:id` — a live, five-step, on-call wizard
covering the partner-grant script (reusing the customer Connect screen's copy
verbatim, not a third duplicate), a live three-layer Graph API access check
per asset (`server/src/meta/access-layers.ts` + `access-probe.ts`), token-scope
verification, provisioning (`server/src/services/customer-onboarding.ts`), and
a final connection-health verify. The AIC-69 page_id ordering rule is now
enforced in code: provisioning re-probes the Page live immediately before the
write and refuses to save an unreadable `page_id`, regardless of what an
earlier check reported. Internal-admin only, never customer-facing. 57 new
tests; live-verified against real Meta and the real DB.

### 2026-08-16 — Tweak: מצב icon 30% larger (10px → 13px)
Requested live once the size-vs-touch-target split (below) actually made
the dot controllable. Scaled both the dot and its mark proportionally
(10px→13px, 7px→9px font); touch-target padding recalculated to keep the
44px hit area: (44−13)/2 = 15.5px.

### 2026-08-16 — Fix (the actual bug, after two no-op attempts): מצב icon
The two previous size entries below (18px→13px, then 13px→10px) had zero
visible effect — reported live, correctly, as "still too big" both times.
Root cause: `border` + `border-radius: 50%` were on the SAME element that
also carried the 44px-touch-target `padding`. A border always draws around
the OUTER edge of padding, so the visible circle was pinned to the full
~44px box the entire time — changing `width` changed only the invisible
content box inside it, never what was actually rendered. Verified this
time with a real DOM measurement (`getBoundingClientRect()`), not a
screenshot eyeball: confirmed 10.0×10.0px before shipping.

Split into two elements: `.info-affordance` (the `<button>` — padding-only,
sizes the invisible 44px tap target, no border of its own) wrapping
`.info-affordance-dot` (a plain `<span>` — the actual small bordered circle,
carries no padding). The visible size now is exactly what the CSS says.

### 2026-08-16 — Fix: מצב row's info icon still read too large at 13px
Reported live again, right after the previous entry's 18px→13px shrink
shipped: still too big. Shrunk further to a 10px circle / 7px mark — sized
to roughly the label text's own x-height rather than picked by feel a
second time. Touch target recalculated again: 10 + 2×17 = 44px.

### 2026-08-16 — Fix: מצב row's info icon read too large next to the label
The previous entry's fix (below) turned out to be the wrong diagnosis,
corrected live within the hour: further feedback showed the clustered
label+pill layout was itself wrong — every OTHER summary row (תקציב,
מודעות, and every summary row across Builder/Connect/Settings/admin) keeps
label-right/value-left, and the מצב row should match them, not be the odd
one out. The actual problem was the new `i` circle itself reading too large
and heavy (18px, 12px bold serif) next to a two-letter label, competing
with the pill instead of sitting quietly beside the text.

Reverted the row back to plain `.summary-row` (pill left, label+icon right,
same as every sibling); fixed `.info-affordance` at the source instead —
shrunk to a 13px circle with a 9px mark, touch target unchanged at 44px
(padding/negative-margin trick recalculated: 13 + 2×15.5 = 44). Verified in
the same isolated static repro used for the entry below.

### 2026-08-16 — Fix: מצב row's label and pill stretched to opposite edges
Reported live right after AIC-97 shipped, screenshot showing the מצב label
and the status pill pulled to opposite ends of the rail card with a large
gap between them. Root cause: `.summary-row`'s `justify-content:
space-between` (shared by every summary row across the whole app — Builder,
Connect, Settings, admin screens, dozens of call sites) stretches its two
children to the row's edges, which reads fine for a text value naturally far
from its label ("תקציב ... ₪20 ביום") but wrong for a small badge sitting
right next to its own label — it read as two unrelated pieces of UI. Made
worse by the rail collapsing to full page width below 1024px (`.dash-grid`'s
single-column breakpoint), and more visible now that the label carries the
new `i` affordance too.

Fixed locally, only on this one row (`Home.tsx`) — `justifyContent:
"flex-start"` overrides the shared class via inline style rather than
touching `.summary-row` itself, which every other summary row across the
app still needs unchanged. Verified in an isolated static repro against the
real `ui.css` before and after.

**Superseded by the entry above within the hour**: further live feedback
showed this diagnosis was wrong — see above for what actually fixed it.

### 2026-08-16 — AIC-97: the rail's מצב badge explains itself on demand
The hero card already carries a title+body for whatever `HomeState` is
active; the rail's compact מצב summary row only ever showed the bare badge.
Three of the seven states share "צריך טיפול" with different causes, and
nothing said whether budget is being spent right now or who needs to act —
both real facts a customer paying for ads actually has, invisible without
navigating away from Home.

New `StatusInfo` (`Home.tsx`): an always-visible `i` affordance (never
hover-revealed — undiscoverable on the phones customers check campaigns on)
that opens on hover, tap, and keyboard focus; dismisses on Escape or a
pointer-down outside; positions itself in JS off the button's own
`getBoundingClientRect()` so it clamps against the real viewport and never
clips at an edge.

`statusTooltipKey` (new export in `state-copy.ts`) composes the exact same
branch `hero()` already uses — `attention`'s 3 causes, `no_campaign`'s 2 (still
onboarding vs. connected-and-ready) — into 10 real states, not 7, so the
tooltip and the hero can never describe two different situations for the
same badge. Every entry answers the same three questions in the same order:
what it means, is budget being spent right now, who acts next. `who acts
next` is a genuinely new fact — even the hero's own free-text body never
stated it explicitly before.

Enforced per AIC-98: `STATUS_TOOLTIP_COPY` is an exhaustive
`Record<StatusTooltipKey, …>`; `state-copy.test.ts` asserts every entry is
non-empty and that no two share the same meaning+whoActs.

Copy for `no_campaign`'s connected-and-ready state follows the ticket's own
table verbatim ("אנחנו" for who-acts) — flagged in the closing Linear
comment as possibly inconsistent with the state's own CTA ("בניית הקמפיין",
which asks the customer to act), since changing given copy unilaterally
risked introducing a different error than the one being fixed.

Full detail in [customer-overview.md](features/customer-overview.md).

### 2026-08-16 — AIC-100: an ad showed מפרסם while its ad set was paused
Real live bug: the פירוט panel showed an ad set as מושהה על ידך while an ad
inside it showed מפרסם — the fourth recurrence of AIC-70's exact shape (code
reading an object's OWN status instead of its resolved one). Root cause:
`isPaused("ad", id)` read only `ctl.adStatuses[id]`, never cross-referenced
against the ad's ad set or campaign.

Introduced the named accessors the AIC-70 doc note had flagged as remaining
scope: `intentStatus` (`server/src/controls/types.ts`) is now the one place
a raw Meta `status` string becomes `"active"|"paused"`, used for ad, ad set,
AND (new) campaign. `getCampaignState` now also returns `campaignStatus`.
`deliveryStatus` (new `web/src/app/delivery-status.ts`) composes all three
already-fresh own-statuses into one of four states — delivering / paused by
you / blocked by ad set / blocked by campaign — entirely client-side, with
no dependency on Meta's `effective_status` and therefore no read-after-write
lag risk. Ad's own pause always wins precedence; between the two parent
causes, campaign outranks ad set (resuming the ad set isn't the real fix
when the whole campaign is paused).

Copy is exhaustive per AIC-98 (`AD_DELIVERY_BADGE`/`AD_DELIVERY_TONE`,
tested non-empty + distinct). `PauseLink`'s pause button now states its
actual effect when offered on an ad that's already blocked by a parent —
previously read as an action with no effect.

Deliberately narrow, per the ticket's own scope: migrates this one card
onto the accessors; does not sweep the other pre-existing raw-status readers
(delivery-health.ts, generation.ts) that already answer a different question
correctly. Full detail in [manual-controls.md](features/manual-controls.md).

### 2026-08-16 — AIC-98: "never render a blank where a reason exists" is now a compile error
The same defect had shipped on four surfaces (AIC-64/85 no-rec reasons,
AIC-89 launch destination, AIC-95 audience panel, AIC-97 מצב badge), each
found by a customer in a screenshot, each fixed individually. Made it a rule
in CLAUDE.md (replacing the shorter version already there) **and** enforced
it, because a rule in a doc gets followed until someone is in a hurry.

Three layers: `Record<Enum, Copy>` maps in the new
`web/src/app/state-copy.ts` (missing variant = `tsc` failure);
`assertNever` (new `shared/src/assert-never.ts`) replacing the swallowing
`default:` in `Home.tsx`'s `hero()`; and `state-copy.test.ts` asserting every
variant's copy is non-empty and **distinct**, which `Record` alone cannot see
— it happily accepts `""` or copy pasted from the case above it, exactly how
the three `צריך טיפול` causes would re-collapse into one message. All three
were verified by deliberately breaking them: a new `HomeState` produced
`Argument of type '"suspended"' is not assignable to parameter of type 'never'`,
and duplicated/empty copy failed the test naming the offending key.

Two boundary types were stringly-typed and defeated the whole thing:
`noRecReason` was `string | null` on both the server interface and the web
mirror, so a new engine reason type-checked fine and rendered the generic
fallback. Now `NoActionReason`, with the DB row typed at the
CHECK-constrained boundary. `attentionKind` became a named `AttentionKind`.

`delivery_blocked` and `tracking_broken` gained real customer copy — both
previously fell through to "we're watching the campaign," which for them was
false. Both are unreachable today (they route to the `attention` hero first),
kept because "unreachable" is a routing detail a refactor changes silently.

Also: `npm run test:unit` now includes the web workspace (was shared + server
only, so a web test would not have run in CI at all). Deliberately narrow —
this sets the standard; AIC-95 and AIC-97 are its first two users.

### 2026-08-15 — Fix: a still-ACTIVE ad silently disappeared from the audience panel's selected window
Reported live on the newly-connected free_beta account: the campaign card
said "2 מודעות פעילות" but opening "הצג פירוט" showed only 1 ad. Root cause,
confirmed against the real DB: `pisga_vs_trad_course` (Meta status ACTIVE)
has had zero `insight_snapshot_daily` rows since 2026-07-21 — over three
weeks — while its sibling ad has data through today. Genuine staleness, not
attribution lag (an earlier hypothesis from before this account was
connected, now disproven).

`buildCampaignAudiences` (`server/src/services/campaign-audiences.ts`) now
additionally fetches each ad set's all-time creative-ID set and diffs it
against the selected window's set (skipped when the range already IS
all-time). The difference is a new `AudienceRow.moreCreativesCount` — a
DB-only count, explicitly never a liveness claim, since this view still never
makes a live Meta call. `Home.tsx` renders it as a note under the audience's
metrics ("עוד מודעה אחת / N מודעות עם נתונים מתקופה אחרת") whenever it's
above zero, so a creative with real historical data no longer just vanishes
with no acknowledgment. Test-first: `campaign-audiences.integration.test.ts`
gained a case seeding one recent + one stale creative under one ad set,
confirmed failing (`expected undefined to be 1`) before the fix.

### 2026-08-15 — Fix: partner-grant instructions described a flow Meta doesn't have; free_beta fully connected
The onboarding/missing-Page fix-step copy (`Connect.tsx`, `AddContent.tsx`)
described granting partner access via a single global **Partners → Add**
screen — the flow `META_SETUP.md` had documented as verified. Reported live,
mid-fix: walking the real Meta Business Settings UI just now showed that's
not how it works — partners are granted **per asset**, under **Accounts →
Ad Accounts / Pages → the specific asset → Assign Partner → Business
Partner → enter the ID**. Rewrote both copy blocks and `META_SETUP.md`'s own
runbook to match the confirmed-live flow; moved the Business ID copybox to
sit next to the step that actually asks for it (was step 1, now step 3, in
both `connect.steps` and `connect.fixSteps`).

Then completed the loop this same account had been blocked on since the
add-content fix earlier today: confirmed live that our System User can now
read Facebook Page `1216278568228263` directly (200, and it appears in
`me/accounts` as "פסגה הכנה חכמה לפסיכומטרי") — the real grant the corrected
flow above just walked through worked. Wrote `page_id` into
`meta_connections` for `test@test.com` and confirmed `resolveAdditionAvailability`
now returns a ready `ctx` with no reason — add-content, the pause buttons,
and ad thumbnails should all work for this account now. (No code path
auto-discovers a newly granted Page — `ConnectionService.verify` only
re-checks a `page_id` that's already on file, so this still needed a manual
write once the grant was confirmed; a real gap worth a dedicated ticket if
this needs to happen for other customers.)

### 2026-08-15 — Fix: pause buttons + ad thumbnails silently vanished, no explanation
Reported live: a customer's audience panel showed neither a pause button nor
ad images, on the same account whose add-content flow was already known to
be blocked by missing Page access. Root cause: `GET /api/app/controls/state`
and `GET /api/app/controls/media` both call `resolveAdditionContext`
(needing the caller's `metaCampaignId`) and, until this fix, 409'd with a
flat `{error: "no managed campaign"}` for every unavailable reason —
including `missing_page` on a real, active, spending campaign.
`AudienceDetails` (`Home.tsx`) wrapped both calls in a bare
`.catch(() => {})`, so the pause button and thumbnails just never rendered,
with nothing telling the customer why — indistinguishable from the feature
never existing.

Fixed the same way as the add-content fix earlier today: both routes now use
`resolveAdditionAvailability` and put the reason on the 409 body;
`AudienceDetails` reads `ApiError.body.reason` and shows a short honest note
+ Settings link only when the failure carries a real, known reason (a
transient network error still degrades silently — nothing specific to say
about that). Test-first: 2 new integration cases proving both routes 409
with `missing_page`. Full suite green (435 unit, 234/236 integration — only
the 2 known pre-existing flakes), typecheck + web build clean.
Docs: [manual-controls.md](features/manual-controls.md#customer-surface).

### 2026-08-15 — Admin console: surface the same connection-readiness reason before a customer hits it
Requested: see the add-content connection errors (no_campaign/not_launched/
missing_page/connection_issue) in the admin dashboard. The classification
moved out of `additions/session.ts` into a shared pure function
(`server/src/services/connection-readiness.ts`'s `classifyConnectionReadiness`)
so the customer-facing 409 and the admin console read one definition, not
two that could quietly drift apart. `listCustomers`/`getCustomerDetail` now
join `ad_accounts` (previously not joined at all in this view) and return
`connectionReadiness` per customer; `AdminCustomers.tsx` shows a `pill warn`
badge with the reason in both the list row and the detail card, plus a
fourth filter tab ("בעיית חיבור") to isolate exactly these customers.
`accessHealth` alone couldn't have shown this — it only reflects whether the
connection itself passed its health check, not whether every asset it needs
(ad account, Page) is actually on file, which is exactly the gap the same
day's add-content bug found live. Test-first: 7 unit cases on the pure
classifier + a new DB integration test proving `listCustomers` returns
`missing_page` for the real-shape row and flips to `null` once the Page is
filled in. Full suite green (435 unit, 232/234 integration — only the 2
known pre-existing flakes), typecheck + web build clean.
Docs: [ops-console.md](features/ops-console.md#customers-view-aic-16).

### 2026-08-15 — Fix: fake Business Portfolio ID shipped as real (AIC-33 closed) + enriched fix-step copy
Requested enrichment of the `missing_page` fix steps (English parentheticals
for every Meta UI term, e.g. "עמודים (Pages)", plus our actual Business ID
inline) surfaced a real, separate bug while implementing it: the onboarding
Connect screen's "BUSINESS ID" copybox — a working copy-to-clipboard button,
indistinguishable from real data — was reading `strings.he.app.mock.businessId`
("418 552 907 431"), an obviously-placeholder value from the same `mock`
object Review.tsx's still-mock screen and Auth.tsx's form placeholders use.
`customer-app.md` had this flagged as an explicit open gap since AIC-33
("business-portfolio-ID copybox is still a placeholder config value") — this
closes it. Added `META_BUSINESS_PORTFOLIO_ID = "2491237118040524"` (`web/src/strings.ts`,
matching META_SETUP.md's identifiers table) as a real constant, not inside
`strings` (it's a fixed ID, not translatable copy) and not `mock`. Both
Connect.tsx's onboarding steps and AddContent.tsx's `missing_page` fix steps
now render the same constant through the same copybox widget — one real ID,
one place it's defined, two places it's shown. Also rewrote both step lists
to follow the exact partner-grant flow META_SETUP.md documents as verified
(Business Settings → Partners → Add → enter the ID → share the asset) rather
than the previous "search the Page's own Partners list by name" path, which
risks exactly the "naming trap" META_SETUP.md warns about (our Business
Portfolio and app share the display name "AI Campaigner," so name search is
unreliable — partners must be added by ID). Full suite green, typecheck +
web build clean. Docs: [customer-app.md](features/customer-app.md#whats-not-wired-backend-per-ticket).

### 2026-08-15 — Fix: "connection issue" wasn't helpful either — split out missing_page with the real fix steps
Follow-up to the same day's add-content fix, reported live testing it: the
new `connection_issue` message ("check your connection in Settings") was
itself unhelpful for the most common real cause — it didn't say what was
wrong or how to fix it, even though onboarding's Connect screen already had
exactly that copy (`missingTitle`/`missingBody`/`howToFix`/`fixSteps`),
simply unreachable once onboarding is behind you. `resolveAdditionAvailability`
now checks `page_id` separately, giving `missing_page` its own reason;
`AddContent.tsx` renders the same `app.connect` strings Connect.tsx already
uses rather than duplicating them. Test-first: split the existing
"connection_issue" regression test into `missing_page` (the real production
case) and a genuine `connection_issue` case (unhealthy `access_health`).
Full suite green (428 unit, 15/15 on `additions.integration.test.ts`).
Docs: [campaign-builder.md](features/campaign-builder.md#add-to-an-existing-campaign-aic-63).

### 2026-08-15 — Rebrand: Ads Manager → Ads Agent
The live domain (`ads-agent.co.il`) already used the new name; the app's own
displayed name hadn't caught up. Renamed everywhere the product refers to
itself: `strings.he.appName`/`adminShell.brand` (and the two hardcoded
components that now read `appName` instead of duplicating the literal —
`components.tsx`'s `Brand`, `Sidebar.tsx`'s `.ap-brand`), the connect-flow
onboarding copy ("add Ads Agent as a business partner"), the SPA `<title>`,
the landing page (title/header/footer), and both legal pages (title, headers,
body text, footer, and the contact address — now `hello@ads-agent.co.il`).
Living docs describing current branding updated too (`INDEX.md`,
`landing.md`, `customer-app.md`).

**Left unchanged, deliberately:** every occurrence of "Ads Manager" that
refers to **Meta's own real Ads Manager tool** — jargon-avoidance comments
("no Ads Manager jargon" in `explainer.ts`/`action-history.ts`/`RULES.md`/
etc.), the landing page's "you don't need [Meta's] Ads Manager" pitch
section, the legal pages' "your Meta Ads Manager account" clauses, the
`METRICS.md`/`dogfood-readout.md` reconciliation notes (comparing our
numbers against Meta's own dashboard), and `META_SETUP.md`'s literal
external asset name ("AdPilot backend", the real, already-registered name of
our Meta System User — a live external identifier, not something a doc edit
can rename). Renaming our own product doesn't change what any of these
actually refer to. This STATE.md's own historical entries are untouched too
(append-only) — earlier dated blocks correctly still say "Ads Manager"
because that was the name at the time.

### 2026-08-15 — Fix: add-content collapsed six unavailable reasons into one wrong message
Reported live on production (ads-agent.co.il): a customer with an ACTIVE,
spending campaign saw "עוד אין קמפיין להוסיף לו תוכן — צריך קודם ליצור את
הקמפיין הראשון שלכם" (no campaign yet, build your first one). `resolveAdditionContext`
409s identically for six different preconditions (no customer/no campaign/
not linked to Meta/unhealthy connection/no ad account/no Page), and the
frontend always showed the "build your first campaign" copy with a CTA into
the builder — which itself refuses to run once a campaign exists, a dead
end. The real cause for this account: `meta_connections.page_id` was NULL
— confirmed live that the account's real Meta campaign ads use a Facebook
Page (`1216278568228263`) our System User doesn't hold read/write access to,
a Meta Business Manager permission gap outside what the app can self-heal.

Fixed with the same "distinct reasons, distinct copy" pattern as the earlier
WhatsApp-write refusal guard: new `resolveAdditionAvailability` classifies
`no_campaign` / `not_launched` / `connection_issue`, each with its own
Hebrew copy and destination (builder / Home / Settings).
`resolveAdditionContext` itself untouched — still the blunt null the eight
write routes need. Test-first: 3 integration cases on `GET /context`
(228/230 → still 228/230, no new flakes), full suite green (428 unit),
typecheck + web build clean. Docs: [campaign-builder.md](features/campaign-builder.md#add-to-an-existing-campaign-aic-63).

### 2026-08-15 — AIC-95: audience panel follows the range switcher, honest empty reasons
Product input on a real screenshot: the audience/per-ad detail panel always
read the engine's own fixed 7-day window regardless of the customer's
day/week/month/allTime selection above it, disclosed only via small-print
disclaimer (`D.windowNote`) rather than fixed — "a panel that opts out of
[following the switcher] and announces so in small print reintroduces
exactly what the switcher was built to fix." Fixed: `buildCampaignAudiences`
now resolves the same window as the KPI cards (`resolveRangeWindow`, shared
with `readout.ts`) and reads new per-object disjoint-daily aggregates
(`creativeRangeStats`/`adsetRangeStats`/`mostRecentObjectDataDate`,
`snapshot-store.ts`) instead of the engine's fixed rolling row. Empty windows
now return `{ reason, mostRecentDataDate }` (`started_today` /
`no_data_in_range` / `no_data_yet`) instead of a bare empty array — the
panel states why rather than rendering nothing, the third confirmed instance
of the "never blank when the reason is known" house rule (`CLAUDE.md`).

**A real gap surfaced live-verifying this against real accounts, not the
seeded fixture:** `GraphMetaClient.getDailyInsights` — the only thing that
writes the disjoint-daily rows this feature reads — pulled campaign grain
only. Real accounts had **zero** adset/creative-grain rows in the daily
table; the panel would have shown `no_data_yet` forever for every real
customer. Fixed (test-first, `client.test.ts`): `getDailyInsights` now pulls
all three levels with `time_increment=1`, deriving creative rows from ad
rows exactly like `getInsights` already does. Verified against the real
GelNails account: a live ingestion tick backfilled real per-day adset/ad/
creative rows for the first time, and the audience panel now shows real data
(₪81.27 / 7 leads / ₪11.61 CPL, matching the campaign-grain total exactly)
instead of the permanent empty state it would otherwise have shown.

Item #2 of the ticket ("separate describing from judging," suppress only a
comparison layer) was scoped out with a transparency comment on AIC-95 —
`campaign-audiences.ts` has no evidence-gate/ranking logic today, so there
was no such coupling to un-suppress.

Full suite green (428 unit, 228/230 integration — only the 2 known
pre-existing flakes), typecheck + web build clean. Docs:
[customer-overview.md](features/customer-overview.md#opt-in-audience-details-aic-37-redesigned-aic-73),
[insights-ingestion.md](features/insights-ingestion.md).

### 2026-08-15 — Fix: activation left the dashboard stale — no delivery/status refresh
Reported live on the real free_beta campaign, seconds after the first-ever
customer launch approval through this app: Meta genuinely showed 2 ads
ACTIVE, but Home said "לא מתפרסם / אין כרגע מודעות שמוצגות ללקוחות" (nothing
is showing). `activateCampaign` only writes to Meta — it never recomputes
`delivery_ok`/`delivering`/`delivering_ad_count`, which are otherwise only
refreshed on the hourly engine tick. The client-side half (`invalidateOverview()`
in `LaunchModal.approve()`) was already correct; only the server-side half was
missing — the exact other half of the lesson `manual-controls.md` already
documents for AIC-66's pause/resume routes.

`approveLaunch` now calls the same `refreshDeliveryNow` those routes already
use, on a genuine `"activated"` outcome. `buildLaunchReader` widened to
`LaunchStateReader & DeliveryReader` so one adapter instance serves both. Test-
first: seeds the exact stale-cache scenario (pre-launch tick's `delivering:
false, delivering_ad_count: 0`) and asserts a same-request refresh to the real
post-activation values. Full suite green (401 unit, 222/224 integration —
only the 2 known pre-existing flakes), typecheck clean. Verified live:
attempted a manual refresh against the real campaign and confirmed the
error-handling path is safe (a transient Meta rate limit — from this
session's own heavy probing — was logged and swallowed, leaving the stale
row rather than writing a guess; the next hourly tick will catch up
regardless). Docs: [campaign-builder.md](features/campaign-builder.md).

### 2026-08-14 — Fix: the ready_to_launch hero claimed work that wasn't done
Class B from the same sweep as the two fixes below: `readyToLaunch` was
derived purely from `status`/`launch_approved_at`/`meta_campaign_id`, with
nothing distinguishing a campaign our own builder made from one connected
from outside the app. Its hero body says "בנינו את הקמפיין והוא עבר בדיקה"
("we built the campaign and it passed review") — both false for a connected
campaign. Confirmed live on the real free_beta campaign.

`buildCustomerOverview` now derives `campaign.wasBuiltHere` from whether a
real, successful `create_campaign` `action_history` row exists — the actual
historical fact, not a new flag that could drift from it. `Home.tsx`'s hero
switches body copy on it (same badge/CTA either way): "we found your campaign
on Meta, it's still paused" instead of claiming work never done. Also fixed
a real doc gap found while writing this up — `ready_to_launch` was entirely
missing from `customer-overview.md`'s `homeState` precedence table.

Test-first: 3 new DB integration cases (no action_history row → `wasBuiltHere:
false` even though `readyToLaunch: true`; a real successful row → `true`; a
FAILED create attempt does NOT count). Full suite green (401 unit, 221/223
integration — only the 2 known pre-existing flakes), typecheck and web build
clean. Verified live: `test@test.com`'s hero now reads "הקמפיין ממתין לאישור
הפעלה" / "מצאנו את הקמפיין שלכם ב-Meta..." with no false claim; GelNails
(already launched) unaffected. Docs:
[customer-overview.md](features/customer-overview.md).

### 2026-08-14 — Fix: the WhatsApp Meta-write literals were re-hardcoded, not sourced from the constants
Root-cause pass on the bug the previous fix (below) refused rather than
fixed. `shared/src/recommended-defaults.ts`'s `FIXED_DESTINATION`/`FIXED_CTA`
had ZERO consumers — the literals they were meant to own
(`"CONVERSATIONS"`/`"WHATSAPP"`/`"WHATSAPP_MESSAGE"`) were re-hardcoded
directly in `campaign-adapter.ts`'s `createAdSet`/`createCreativeFromUpload`.
That's exactly how a Pixel campaign could reach a WhatsApp-shaped write in
the first place: the campaign's own lead type never entered the decision at
the point the literal was written.

New `resolveDestinationShape()` (`shared/src/recommended-defaults.ts`) makes
the constants the actual single source, and — the part that matters more
than tidiness — **throws** for an unrecognized destination instead of
silently falling back to the WhatsApp shape. `CreateAdSetParams` and
`CreateUploadCreativeParams` gain an explicit `destination: string`; every
caller (builder, additions) now passes `FIXED_DESTINATION` visibly rather
than the adapter assuming it three layers down. A second destination
(AIC-89) is added by extending one map, not by hunting down literals again.

Test-first: 4 new cases (the resolved shape matches the old literals exactly;
an unrecognized destination throws and is proven to make zero Meta calls,
for both `createAdSet` and `createCreativeFromUpload`). Full suite green
(401 unit, 218/220 integration — only the 2 known pre-existing flakes),
typecheck and web build clean. Docs:
[campaign-builder.md](features/campaign-builder.md).

### 2026-08-14 — Fix: refuse a Meta write the campaign's lead type can't support
Found by a sweep for the same bug class as the launch-modal fix (below): the
add-content flow (AIC-63) emits WhatsApp-shaped Meta objects unconditionally
— a `WHATSAPP_MESSAGE` call-to-action carrying `whatsapp_destination` (empty
for any non-messaging campaign) and a hardcoded `CONVERSATIONS`/`WHATSAPP` ad
set. Nothing has spent yet (no campaign is live through the app yet, and
there are no other customers), so this closes real exposure before it's
live rather than patching an active leak.

Refused at `resolveAdditionContext`, the single chokepoint every additions
route passes through. `AdditionContext.whatsappNumber` is `string | null`
rather than a coalesced `''` — the nullable type turned the one remaining
unguarded consumer into a compile error. Two distinct causes, not collapsed:
`not_whatsapp` (leads don't arrive over WhatsApp at all) vs `missing_number`
(genuinely a WhatsApp campaign, number never captured). Checking against the
real accounts surfaced the second case for real — GelNails hits
`missing_number`, not `not_whatsapp`, since it was connected outside the
builder. Collapsing them would have told a real WhatsApp customer their
leads don't come from WhatsApp, which is false.

Test-first: 4 route-level cases + 4 pure unit cases for `whatsappWriteBlock`.
Full suite green (399 unit, 218/220 integration — only the 2 known
pre-existing flakes), typecheck and web build clean. Verified against
GelNails: correctly reports `missing_number`. Docs:
[campaign-builder.md](features/campaign-builder.md).

### 2026-08-14 — Bugfix: the launch consent screen asserted a WhatsApp destination it didn't have
Reported live on the real connected Pixel campaign: the launch-approval modal
showed "פניות אל וואטסאפ" — a hardcoded label — with a **blank value**, and
"מודעות 0" for a campaign that really has one ad. Both on the screen where a
customer authorises ₪600/month.

Two independent root causes, both assumptions invalidated earlier the same
day: the destination was `whatsapp_destination` (`NOT NULL DEFAULT ''`, so
empty rather than null for any campaign AIC-87 made non-WhatsApp), and the ad
count was `COUNT(*)` over our own `action_history` `create_ad` rows — ads *we*
built — which reads 0 for any externally-connected campaign.

Fixed with two rules that apply because it's a consent surface. **Never render
a fact we don't have**: the destination resolves to `whatsapp` / `website` /
`unknown` (new pure `services/launch-destination.ts`), and an unknown row is
omitted rather than printed blank. **If we can't verify, block**: new
`LaunchBlocker` (`no_ads` / `unknown_destination` / `verification_unavailable`)
disables approval with the reason stated, and `approveLaunch` re-checks
server-side and returns 409 — the disabled button is a courtesy, not the gate.
The website value names the lead action in plain Hebrew plus the pixel's host
("הרשמה — pisga.app") rather than the Meta event id, because an SMB owner
can't verify `CompleteRegistration` and verification is the screen's purpose;
the mapping reuses AIC-88's `PIXEL_EVENT_ACTION` inverted, not a second copy.
Ad count now reads live `getCampaignState().adStatuses`.

Test-first (7 pure cases incl. the exact real-campaign shape, + 4 new route
integration cases). Full suite green (395 unit, 214/216 integration — only the
2 known pre-existing flakes), typecheck + web build clean. Verified against the
real campaign: destination resolves to `COMPLETE_REGISTRATION` + `pisga.app`.
Live ad count correctly reported `verification_unavailable` during a Meta
ad-account rate limit — the blocker behaving exactly as designed rather than
defaulting to a reassuring zero. Docs:
[campaign-builder.md](features/campaign-builder.md).

**Found while sweeping for the same bug class, NOT fixed here** — higher-severity
siblings, logged for AIC-89: `AddContent.tsx` seeds an empty WhatsApp number
into a real Meta creative write with a `WHATSAPP_MESSAGE` CTA (unvalidated),
and `addAdSetToExistingCampaign` hardcodes `CONVERSATIONS`/`WHATSAPP`, so
adding an ad set to a Pixel campaign would create one whose conversions can
never be counted. Also: the `ready_to_launch` hero copy claims "בנינו את
הקמפיין והוא עבר בדיקה" (we built it, it passed review) — false for a
connected campaign.

### 2026-08-14 — AIC-88: guard against a lead-definition/Meta-config mismatch
The blocker named in AIC-87's own investigation: a Pixel campaign can be
connected with the wrong `lead_event_types` (exactly what happened with
free_beta_signups_leads before that fix), silently reporting real
conversions as zero leads while the engine confidently reasons over the
wrong number.

The originally planned design (spend-with-zero-leads, confirmed against
`{pixel}/stats`) was designed, then discarded before any code was written,
after a Plan agent's adversarial review found it doesn't work: pixel stats
are pixel-scoped, so on a landing page with no other traffic "the event
never fired" is indistinguishable from "nobody converted yet" — the
confirmation step adds zero discriminating power exactly where it matters.
The review also proved the spend threshold is arithmetically unreachable on
a ₪20/day campaign (₪140/week < the existing ₪150 evidence gate) — it could
never have fired on the very account that motivated the ticket.

Built instead: the ad set's own Meta configuration
(`optimization_goal`/`promoted_object.custom_event_type`) deterministically
implies which Insights action type its conversions arrive as
(`impliedLeadActionType`, `server/src/meta/tracking-health.ts`). Comparing
that against the campaign's declared `lead_event_types` is exact — zero
false positives, no spend needed, no attribution lag — and works on a
**paused** campaign, catching the misconfiguration before a shekel is spent
(the statistical version structurally could not). Three-valued
(`ok`/`broken`/`unknown`); `unknown` never collapses into `ok` — a real,
cited bug in the delivery-health pattern this otherwise mirrors, where the
recorder writes its flag unconditionally. Ops alerting is idempotent
(keyed off an open ops item, not the ok→broken edge) — the edge-based
delivery-health version has a latent failure where a thrown `ops.create`
permanently loses the alert; this module deliberately avoids inheriting it.

Migration 038 (`tracking_ok`/`tracking_reason`/`tracking_detail`/
`tracking_checked_at` + widened `ops_queue_items` CHECK). Suppresses every
rule AND the AIC-86 pre-gate advisory ("add more ads" is wrong advice when
conversions aren't being counted at all) via `CampaignEvidence.trackingBroken`,
second only to `delivery_blocked` in `classifyNoAction`'s precedence.
Customer-facing (a config mismatch is deterministic, not a guess, so unlike
the discarded statistical version it's safe to show): `attentionKind:
"tracking"`, distinct Hebrew hero copy, no CTA.

Test-first throughout. Full server suite green (388 unit, 210/212
integration — only the 2 known pre-existing flakes), typecheck clean, web
build clean. **Verified live**: restored the exact original bug on the real
free_beta campaign (WhatsApp default on a Pixel campaign) and confirmed the
guard correctly flags it (`state: broken`, ops item raised, precise reason)
before restoring the correct config; then ran the real production
generation tick against both real campaigns and confirmed both correctly
verify `ok`. Docs: [tracking-health.md](features/tracking-health.md),
[RULES.md](RULES.md), [customer-overview.md](features/customer-overview.md).

### 2026-08-14 — Connected free_beta_signups_leads (real Pixel campaign) to test@test.com
The concrete instance AIC-87 was built for. Same Meta Business Portfolio and
ad account (`act_2181076988590009`) as Sharon's "Pisga"/GelNails customer, a
different real campaign (`120248236848650352`, objective OUTCOME_LEADS,
Pixel `984664453249037`, `COMPLETE_REGISTRATION`). `ad_accounts.meta_ad_account_id`
was globally UNIQUE, so a second customer couldn't reference the same Meta
account at all — migration 037 narrows it to `UNIQUE (connection_id,
meta_ad_account_id)`, verified safe first: every ownership lookup in the
codebase already scopes by `connection_id`, never by the Meta id alone.
Found and fixed one real lookup that would have broken under the new
constraint — `seed-pisga-owner.ts`'s ad-account query was unscoped and would
have matched the WRONG customer's row once a second one existed.

New `seed-test-freebeta.ts` (gated by `META_SEED_TEST_FREEBETA`, modeled
directly on `seed-pisga-owner.ts`) provisions test@test.com's own customer +
connection + ad-account row + managed campaign, with `lead_event_types` set
to the campaign's real Pixel action type (confirmed via read-only Graph probe
before writing anything — see AIC-87 above). Run once, idempotent.

**Verified live, end to end, through the real production code paths** — not
a seeded/faked scenario: ran the real `buildIngestionTick` and
`buildGenerationTick` against both campaigns together. free_beta's disjoint
daily snapshots sum to exactly 26 leads / ₪205.06 — a byte-for-byte match to
the real campaign's actual Meta performance from the original read-only
probe. `leads_to_date`/`spend_to_date` (the second lead-definition site)
landed the same 26/₪205.06. GelNails advanced from 6→7 leads / ₪82.49→₪82.57
between the two ticks (real ad spend continuing to accrue on a live account —
expected, not a regression) and its own `lead_event_types` stayed the
WhatsApp default throughout, completely unaffected by the new connection.
Browser-verified as test@test.com (a real pre-existing account — authenticated
via a minted JWT for its own user id, the same mechanism the HTTP integration
tests use, rather than touching its real password): the dashboard's "הכל"
(all-time) range shows ₪205.1 spend / 26 leads / ₪7.9 CPL, matching exactly.
The engine also produced its first real recommendation for this account
(`add_creatives_for_comparison` — correct, it has exactly one ad). Hero state
correctly reads "ready to launch, needs your approval" rather than "active" —
honest, since no launch-approval click ever happened and the campaign
genuinely stays PAUSED on Meta throughout (nothing spends, nothing was ever
at risk while this was verified).

### 2026-08-14 — AIC-87: the lead definition becomes per-campaign, not a global constant
Prompted by connecting a real Pixel-conversion campaign
(`free_beta_signups_leads`, objective OUTCOME_LEADS, `promoted_object.custom_event_type:
COMPLETE_REGISTRATION`) — read-only probed before touching anything, confirmed
its real Insights `actions` carry `offsite_conversion.fb_pixel_complete_registration: 26`
and zero `onsite_conversion.messaging_conversation_started`, the only thing
`extractLeads` counted. Connected as-is, 26 real registrations on ₪205.06 of
spend would have ingested as 0 leads — a working campaign rendered as a
catastrophically failing one.

New `managed_campaigns.lead_event_types TEXT[]` (migration 036, default
reproduces today's WhatsApp constant exactly) + `tracking_pixel_id`.
`extractLeads(actions, priority = LEAD_ACTION_PRIORITY)` gains an optional,
defaulted second parameter — same backward-compat trick as AIC-77a's
`resolveThresholds`, every existing call site unchanged. Threaded through the
TWO independent sites that turn raw actions into a leads count: ingestion
(`normalizeRow` → `ManagedCampaignRef`/`listManagedCampaigns`) and
`GraphCampaignAdapter.getLifetimeTotals` (→ `GenCampaign`/
`listEligibleForGeneration`, backing `leads_to_date` and the dashboard's
all-time range) — a real "missed consumer" risk, same class as AIC-70/75, now
closed at both sites with dedicated tests. Deliberately NOT threaded: the
operator explorer (would need a `Map<metaCampaignId, string[]>` across a whole
ad account — disproportionate for a diagnostic-only surface) and the env-gated
boot probe (account-level, no single campaign's definition applies) — both
left on the WhatsApp default with an explicit comment, a documented gap rather
than a silent one.

Test-first (the Pixel campaign's real action shape reproduced in a regression
test proving it counts 0 under the old default). Full server suite green (364
unit), typecheck clean. Docs:
[METRICS.md](METRICS.md#lead-aic-87-per-campaign-not-a-global-constant),
[DATA_MODEL.md](DATA_MODEL.md).

Companion tickets AIC-88 (tracking-health guard) and connecting the campaign
to a real customer follow in separate commits/pushes.

### 2026-08-14 — Bugfix: hero card and pending-rec card contradicted each other
Live user report: the dashboard hero said "הכל עובד כרגיל" (everything's
working normally, nothing needs your attention) directly above a second card
saying "כדאי להוסיף עוד מודעות" (worth adding more ads) — the product
contradicting itself on one screen. Root cause: `deriveHomeState` has never
known about `pendingRecommendations` — `homeState: "ok"`/`"collecting"`
always rendered fixed, generic hero copy regardless of whether a real
recommendation existed. The two cards were computed and rendered completely
independently and could always disagree; the specific screenshot just made it
visible for the first time.

Fixed by merging them (`Home.tsx`): `hero()` now takes `noRecReason` and,
for `ok`/`collecting`, sources title/body from `noRecCard()` — the SAME
engine-reason copy the reassurance card already used (only the badge stays
fixed). When a recommendation is pending for those two states, the hero is
replaced entirely by the pending-rec teaser (per-type headline, from the
AIC-86 dashboard-teaser fix below) instead of sitting in a second card below
a contradictory hero. `attention`/`paused`/`stopped`/`ready_to_launch` are
unaffected — those states already outrank a recommendation, so a pending rec
there (believed unreachable in practice) stays a small supplementary card,
not a merge candidate. Trimmed the now-dead `states.ok`/`.collecting`
title/body strings and the long-dead, never-reachable `states.rec` object
(`web/src/strings.ts`). Browser-verified both merged states live (pending
advisory rec → single teaser hero; no pending rec → single reassurance hero)
against seeded throwaway accounts, then deleted them. Web build clean
(no frontend unit tests for `Home.tsx` — browser-verified per convention).
Docs: [customer-overview.md](features/customer-overview.md).

### 2026-08-14 — Fix: audience-details panel window silently disagreed with the KPI cards
Live user report: top KPIs showed ₪78.6/6 leads, the "פירוט" (details) panel
just below showed ₪43.9/5 leads for the same account — no label explaining
why. Not a double-count bug (each number was independently correct for its
own window): the top KPIs follow the customer's range switcher (a *trailing*
window that includes today), while the details panel always reads the
engine's fixed 7-*complete*-day window (excluding today, the same one
recommendations are evaluated on) — completely unrelated to the switcher.
Two honest, differently-scoped numbers with no label read as broken. Fixed
by adding an explicit window note (`D.windowNote`, `web/src/strings.ts`)
whenever the panel is open, rather than changing the panel's window itself
(which must keep matching what the engine evaluated). Browser-verified live
against a seeded throwaway account reproducing the exact discrepancy, then
deleted it. Web build clean. Docs: [customer-overview.md](features/customer-overview.md).

### 2026-08-14 — Bugfix: dashboard teaser stated the wrong recommendation type
Live user report, right after AIC-86 shipped: the dashboard said "worth
pausing one of the ads," but the actual pending recommendation was "add more
ads." The teaser headline (`Home.tsx`) was a single hardcoded string shown
for *any* pending type — a leftover from when every acting type was a spend
change with roughly that shape. `pendingRecommendations` was only ever a
`count(*)`, never the type, so there was nothing else for the teaser to go
on. A second string, `recWaitingReason`, carried a fully fabricated example
(a made-up ₪184 figure) — never actually rendered, but deleted rather than
left to rot.

Fixed at the data layer: `buildCustomerOverview` now fetches the proposed
row's actual `type` (new `pendingRecommendationType` field) instead of a bare
count. `Home.tsx`'s teaser headline reads `recDetail.titles[type]` — the
exact same per-type copy the detail screen already uses — so the two
surfaces can't say different things again. The teaser's CTA changed from "view
and approve" to a neutral "view", since not every type has an approval step
(the advisory `add_creatives_for_comparison` never did). Test-first
(`customer-overview.integration.test.ts`). Verified live end-to-end with a
seeded pending `add_creatives_for_comparison` rec: dashboard, list, and
detail screen all now say "worth adding more ads," consistently. Full suite
green (352 unit, 204/206 integration — only the 2 known pre-existing flakes),
typecheck clean, web build clean. Docs:
[customer-overview.md](features/customer-overview.md).

### 2026-08-14 — Bugfix: creativeStats/adsetStats returned duplicate rows for one real object
Found live while browsing the customer's "audience details" disclosure on the
just-shipped AIC-85/86: one real ad rendered as three, each with different
spend/leads. Same overlapping-window class as `campaignTotals`'s AIC-75 fix,
at a third call site that fix explicitly (and it turns out incorrectly)
declared safe — "those grains have no daily rows written for them at all."
They do: the "today" extra-period ingestion (`scheduled-ingestion.ts`'s
`todayPeriod`) calls the full multi-grain `getInsights` for a single day,
leaving behind ad/adset/creative single-day rows nothing was designed to
consume. Those rows then matched `creativeStats`/`adsetStats`' plain
containment predicate right alongside the real rolling row for the same
object, with no dedup.

Not just cosmetic: `buildCampaignEvidence` (the engine's own evidence
builder) calls these same two methods, so `pauseWeakCreative`/
`pauseUnderperformingAudience` could in principle compare a real object
against a phantom "peer" that's really itself at a different point in time,
and AIC-85/86's brand-new `comparableCreatives`/`comparableAdsets` inherited
the bug immediately — GelNails' "3 comparable creatives" from the AIC-85/86
live verification just hours earlier was this exact corruption; there's
really 1.

Fixed at both `SnapshotStore` implementations (`PgSnapshotStore` via SQL —
`AND period_start != period_end` plus `DISTINCT ON (meta_object_id)`;
`InMemorySnapshotStore` via an equivalent shared JS helper, so the two can't
drift apart) — the complementary predicate to the disjoint-daily view, not
the same one: `campaignTotals` needed to sum disjoint days, these want a
single object's totals for the window, and a daily row is a slice, never the
answer. `readout.ts`'s per-creative breakdown had independently hand-rolled
the identical buggy query rather than calling `creativeStats()` — fixed by
routing it through the shared, now-corrected method instead of patching a
third copy of the same SQL.

Test-first (`snapshot-store.integration.test.ts`, `rule-evaluator.test.ts`).
Re-verified live on GelNails after the fix: `comparableCreativeCount` reads
1 (not 3), and `add_creatives_for_comparison` — the exact recommendation
AIC-85/86 was built to produce — fired for real in production for the first
time; the ops console's per-ad table dropped from 3 duplicate rows to the 1
real one. Full suite green (352 unit, 203/205 integration — only the 2 known
pre-existing flakes), typecheck clean, web build clean. Docs:
[DATA_MODEL.md](DATA_MODEL.md#the-disjoint-daily-view-migration-030) (the
corrected record).

### 2026-08-14 — AIC-85/86: "stable" honesty fix + the first advisory recommendation
Live investigation of GelNails (the same account across this whole session's
arc) found `no_rec_reason = "stable"` reporting "everything's fine" while the
truth was "the engine structurally can't judge this account" — one creative
with real spend (a flexible ad collapsing 4 posts into one comparable object,
AIC-36) and one dormant ad set. `stable` was a catch-all standing in for
three different situations at once, and `no_rec_detail` was empty, so the
nuance wasn't even stored.

**The insight that made this worth building immediately:** the honest
explanation and the single most valuable thing the engine could say are the
*same message* — "we can't compare because you only have one ad" converts
directly into "add 2–3 more ads," already the product's own recommended
range. Filed as two tickets, built together: AIC-85 (stop using `stable` as
a catch-all) and AIC-86 (turn "nothing comparable" into a real, actionable
recommendation).

**AIC-85 — honest comparability.** New `comparableCreatives`/
`comparableAdsets` (`rules.ts`) define "comparable" relative to campaign
spend via `shareOfCampaignSpend` (already existed, AIC-75) — an object is
comparable at ≥10% share, a chosen scale-free number rather than a fixed
shekel floor that would break across account sizes. Fixes a real bug: the
old `single_ad_set` check counted raw ad-set *presence*, letting a
₪2.35/week dormant ad set silently count as "comparable" and fall through to
`stable`. Three new/renamed `no_rec_reason` values: `no_comparable_audiences`
(replaces `single_ad_set`), `no_comparable_creatives`, and
`below_object_evidence_floor` — comparable objects exist but haven't
individually cleared the existing absolute spend gate yet, a genuinely
different fact from "nothing to compare at all." Migration 035 widens
`managed_campaigns_no_rec_reason_check`.

**AIC-86 — the advisory recommendation.** New type
`add_creatives_for_comparison` (migration 034 widens
`recommendations_type_check`) — the first recommendation that's advisory
only, never a Meta write. Fires **independent of the evidence gate**
(`hasMinimumEvidence`), a deliberate design decision: the gates exist for
*comparative* claims needing statistical power ("creative A underperforms
B"); "there is only one creative" is a *count*, and no amount of additional
data makes a count more true. Firing from day one means the advice arrives
*before* a customer burns weeks of budget on one untested creative, not
after — gating it behind 5 leads would have meant it only ever arrived once
the damage it warns against had already happened. Advisory + dismissible, so
the cost of firing early is mild redundancy. No new state-machine states
needed: the customer UI simply never calls approve for this type, linking to
the existing add-ad screen (AIC-63) instead; it self-resolves through the
*existing* staleness mechanism once a second real creative appears — zero
special-case expiry code. Copy has two variants (with real performance data
to open on vs. the day-one case with none yet) plus explicit flexible-ad
naming, per explicit correction during design review.

Verified live: the real production tick on GelNails now reports
`below_object_evidence_floor` (3 real comparable creatives, none past ₪150
yet) instead of `stable` — the account's shape had changed since the
investigation (comparability was no longer the blocker), itself live proof
the fix responds correctly to real data as it changes. Customer copy
rendered live: *"אין המלצה כרגע — יש מה להשוות, אבל עדיין לא מספיק נתונים
(מודעות: 0/3 עברו את סף ₪150)"* — not "הכל עובד כרגיל". `add_creatives_for_comparison`
itself is covered by 24+ direct unit/integration tests rather than
re-demonstrated live, since the account had already resolved past that
specific state by verification time.

Test-first for the dormant-ad-set miscount (the real bug). Full suite green
(351 unit tests, 202/204 integration — only the 2 known pre-existing
flakes), typecheck clean, web build clean. Docs:
[RULES.md](RULES.md#comparability--the-add_creatives_for_comparison-advisory-aic-8586)
(new section — the full design), [FEATURES.md](FEATURES.md),
[DATA_MODEL.md](DATA_MODEL.md), [recommendation-engine.md](features/recommendation-engine.md),
[ops-console.md](features/ops-console.md#recommendations-oversight-aic-46).

### 2026-08-14 — AIC-76: outcome measurement — did an executed recommendation help?
Closes the loop AIC-75/77a/77b opened: the engine proposes, the customer
approves, the change lands — and until now, nothing ever checked the result.
New `recommendation_outcomes` table (migration 033), the **first
engine-computed table** in this schema (every earlier computed cache is a
scalar column). One row per executed recommendation, comparing a fixed
before-window against a fixed after-window anchored on `executed_at`, with
the execution day itself excluded from both (contaminated by construction —
same discipline as the engine's other "complete days only" gates).

**The measurement window is `COOLDOWN_DAYS`** — AIC-77b's cooldown key,
reused rather than a second key defaulted to the same number. One policy:
the engine can't act again on a class until it knows whether the last action
worked, so "cooldown lifts" and "outcome measurable" are definitionally the
same moment. Pinned by a dedicated invariant test in `outcomes.test.ts` that
walks day-by-day and asserts the two conditions flip on the identical day —
so a future split into two keys breaks a build instead of drifting apart
silently. Full reasoning in
[outcome-measurement.md](features/outcome-measurement.md#the-window--and-why-its-the-same-key-as-the-cooldown).

Six verdicts (`improved`/`degraded`/`neutral`/`confounded`/
`insufficient_data`/`not_measurable`), resolved strictly can't-compute →
can't-attribute → bucket. The materiality band reuses `BUDGET_CPL_RISE_PCT`
(the engine's own existing "moved enough to act on" bar) rather than
inventing a second number against zero real outcomes — provisional,
recalibrated once real outcomes exist. **The raw delta is always stored
alongside the bucket** — the bucket is a view, the delta is the data, so a
real −11% stays visible as `neutral (−11%)` instead of being discarded.
`replace_creative` is `not_measurable`: it executes successfully but makes
**no Meta write** (files an ops ticket instead), so there is no event to
measure from — explicitly temporary, revisit once creative replacement gets
a real tracked execution. Attribution is correlation, never causation,
enforced in the Hebrew copy and the code comments throughout.

Caught mid-build: the DB round-trip on the new table's `DATE` columns —
`pg` parses `DATE` as a local-midnight JS `Date`, and `.toISOString()`
shifted it a day backward on a machine in `Asia/Jerusalem`. Fixed by reading
via `to_char(col, 'YYYY-MM-DD')`, the same convention
`insight_snapshots.dailySeries` already used for the identical reason —
applied in both the test and the new ops-console query.

Ops console (`AdminRecommendations.tsx`): a per-recommendation outcome block
in the detail panel (verdict, before/after CPL, raw delta, exact window,
confound detail), plus a fleet-wide aggregate-by-type card at the top —
its own query (`getOutcomeAggregate`), not a client-side rollup over the
300-row-capped list, which would silently undercount past 300 rows.

24 new pure unit tests (`outcomes.test.ts`, incl. the invariant), 12 new DB
integration tests (`outcome-measurement.integration.test.ts` — the due-query,
the `executed_at`-stamped-on-the-failed-path trap, confound detection, a full
measured run, tick idempotency), 4 new oversight integration tests
(measured outcome + confound detail + the aggregate, list + HTTP). Full
suite green (328 unit tests, 202/204 integration — only the 2 known
pre-existing flakes), typecheck clean, web build clean. Ships **unexercised
in production** (zero recommendations have ever executed on the one live
account) — verified instead by a seeded end-to-end run against the real DB:
throwaway executed rec + engineered before/after snapshots → the real tick →
persisted verdict/delta matched the arithmetic → ops console rendered both
surfaces → every throwaway row deleted. Docs:
[outcome-measurement.md](features/outcome-measurement.md) (new),
[RULES.md](RULES.md#precedence--cooldown-aic-77b),
[DATA_MODEL.md](DATA_MODEL.md), [ops-console.md](features/ops-console.md#recommendations-oversight-aic-46).

### 2026-08-14 — AIC-77b: cooldown + already-paused exclusion + precedence docs
Two provable flaws, both reachable the moment the engine fires its first
recommendation ever (`recommendations` had zero rows; every one of production
`action_history`'s 12 rows was a manual AIC-66 control). (1) An **executed**
recommendation was invisible to the dedup check (`listProposed` filters
`state = 'proposed'`), so the engine re-proposed the identical change on the
very next tick. (2) No rule filtered on live delivery status, so an ad
already paused (by us, or manually) still carried its historical spend and
stayed eligible to be flagged "weak" — on the only live account, whose real
`action_history` is entirely manual pauses, the single most likely first
recommendation was "pause this ad you already paused."

Fixed both. **Cooldown**: a 14th `RULE_THRESHOLDS` key, `COOLDOWN_DAYS`
(default 7, Meta's learning-phase length), resolvable per account through
the same `resolveThresholds` mechanism AIC-77a shipped. After an
engine-authored action executes, its class (creative/audience/budget) is
suppressed for that many days — tried, not skipped: a genuinely different
class still fires and takes precedence; `cooling_down` is reported only when
something would have fired and every candidate was suppressed, never as a
placeholder. Sourced from `action_history`
(`getLatestEngineActionByType`, new in `services/action-history.ts`) —
`recommendation_id IS NOT NULL AND result = 'success'` is a verified
engine/manual discriminator (every non-engine writer hardcodes `NULL`).
Threaded through `EvaluableCampaign.lastActionAtByType`, the same carrier
AIC-77a used for `thresholdOverrides`, so both callers of `evaluateCampaign`
inherit it automatically. New `no_rec_reason` value `cooling_down` required
widening the migration-024 CHECK constraint (migration 032) — confirmed the
one step that fails *silently* if skipped (the write sits inside a
swallowing try/catch). **Already-paused exclusion**: `isJudgeable`
(`features.ts`) — Meta's live `adStatuses`/`adSetStatuses`
(`getCampaignState`, already fetched every tick for the budget, previously
discarded) applied once in `buildCampaignEvidence`, so every rule inherits
it. `insight_snapshots.delivery_status` was verified NOT to be a usable
status source (empty for nearly every ad/adset-grain row in production).
**Precedence**: verified already structurally true (first-match-wins +
staleness's replace-on-divergence guarantee exactly one proposed rec per
campaign) — only the rationale needed documenting.

Test-first for the paused-ad bug, per the repo's rule. 15 new tests (rules/
staleness/generation/features unit + action-history DB integration); full
suite green (304 unit tests, 34/36 integration files — only the 2 known
pre-existing flakes), typecheck clean, web build clean. Docs:
[RULES.md](RULES.md#precedence--cooldown-aic-77b),
[FEATURES.md](FEATURES.md#judgeable--the-centrally-owned-already-paused-exclusion-aic-77b),
[DATA_MODEL.md](DATA_MODEL.md), [recommendation-engine.md](features/recommendation-engine.md).

### 2026-08-14 — AIC-77a: configurable per-account rule thresholds
`RULE_THRESHOLDS` (`rules.ts`) is no longer a single frozen global — every
threshold now resolves per campaign via `resolveThresholds`: an explicit
account override (`managed_campaigns.threshold_overrides`, migration 031)
wins outright; the two minimum-evidence spend gates
(`MIN_CREATIVE_SPEND_AGOROT`, `AUDIENCE_MIN_SPEND_AGOROT`) additionally scale
up with a large campaign's own daily budget (`max(default, 1.5× daily
budget)`) so a ₪300/day account isn't judged on the same flat ₪150 a
₪30/day account is; everything else stays the flat global default. Every
rule function takes an explicit `thresholds` parameter defaulted to
`RULE_THRESHOLDS`, so every pre-existing test across `rules.test.ts`,
`rules.adset.test.ts`, `rule-evaluator.test.ts`, `staleness.test.ts`,
`generation.test.ts`, `features.test.ts` (101 tests total, including 9 new
for this change) passes unchanged — zero behaviour change for any call site
that doesn't explicitly pass a resolved `thresholds` object. Deliberately did
**not** build a per-category default tier (the
ticket's original "per account → per category → global default" language) —
no rule has evidence yet that a business vertical needs different gates;
revisit once AIC-76 produces real outcomes. Admin UI: 13 grouped threshold
fields on the customer edit form (`AdminCustomers.tsx`), reusing the exact
`agreedBudgetAgorot` write-and-audit pattern (`customer-admin.ts`). Verified
live (throwaway admin account + customer, cleaned up after): override set →
persisted → survives reload → correctly shown as inherited-vs-overridden in
the placeholder → cleared → falls back to the resolved default. Docs:
[RULES.md](RULES.md#configurable-thresholds-aic-77a),
[DATA_MODEL.md](DATA_MODEL.md), [ops-console.md](features/ops-console.md).

### 2026-08-13 — AIC-75d/e: feature layer (features.ts) — rules refactored onto named functions, zero behaviour change
Added `server/src/recommendations/features.ts`: named, independently-tested
functions (`campaignCpl`/`adCpl`, `spendWithoutLead`, `shareOfCampaignSpend`,
`daysActive`/`deliveryDaysActive`, `bestPeerCpl`, `groupCreativesByAdSet`,
`periodOverPeriodDeltaPct`, `leadQualityRate`) replacing math that used to be
written inline, and in two cases duplicated, inside `rules.ts`'s rule bodies.
Wired `daysActive`/`deliveryDaysActive` into `rule-evaluator.ts`, replacing the
two v1 approximations (window-length-as-days, binary delivery) noted in
`RULES.md` since AIC-9. Refactored `pauseWeakCreative`/`weakestInGroup`/
`pauseUnderperformingAudience` to call the named functions instead of
reimplementing them — **no behaviour change**: 6 characterization tests
(`rules.test.ts`) pinned the exact existing precedence/tie-break/asymmetry
behaviour before the refactor, and all 27 pass unchanged after. New
`features.test.ts` (27 tests: zero-lead, zero-spend, single-sibling,
partial-window cases) plus the full existing suite (273 unit + 34/36
integration files, the 2 remaining failures pre-existing and unrelated) stay
green. Verified against real production data (read-only): the real
under-evaluation campaign now correctly evaluates to `current: {spendAgorot:
3921, leads: 4, days: 3}`, `no_action` / `collecting` — the real per-day gate
counts (not the old length-7 approximation) working correctly on a real
partial-history campaign. Docs: new [FEATURES.md](FEATURES.md), updated
[RULES.md](RULES.md), [features/recommendation-engine.md](features/recommendation-engine.md).

### 2026-08-13 — AIC-75a/b: real double-count bug fixed — disjoint-daily view + honest `collecting` (not `stable`)
Found while starting AIC-75/77 (Engine V2): `PgSnapshotStore.campaignTotals`'s
window `SUM()` matched both a rolling 7-day campaign row and the disjoint
per-day rows covering the same days — the exact overlapping-window class
already fixed once for `leads_to_date` (migration 028), missed here. A real
production campaign's engine evidence read **8 leads / ₪78.42** against a
truth of **4 leads / ₪39.21**. The doubled figure (8) passed `MIN_CAMPAIGN_LEADS`
(5) where the true figure (4) should have failed it, so the campaign's cached
`no_rec_reason` read `stable` ("הכל עובד כרגיל") when the honest state was
`collecting`. Fixed structurally, not with a read-side filter: new view
`insight_snapshot_daily` (migration 030) exposes only disjoint rows;
`campaignTotals`/`dailySeries` now read the view — see
[DATA_MODEL.md](DATA_MODEL.md#the-disjoint-daily-view-migration-030). Blast
radius checked before fixing: operator readout was also doubled; customer
dashboard KPIs were **not** affected (already reading the disjoint
`dailySeries` from the AIC-55 ranges work); zero stored recommendation
`evidence` blocks were affected (the `recommendations` table has never had a
row — this is why AIC-77/76 are sequenced after AIC-75, not before). Test-first:
`snapshot-store.integration.test.ts`'s new regression test seeds a rolling row
alongside its own overlapping daily rows and asserts the sum reads the real
total, not double it; confirmed failing (`expected 8 to be 4`) before the fix.

### 2026-08-12 — Real terms-of-use + privacy-policy pages, linked from footer + signup
Built `web/public/terms.html` and `web/public/privacy.html` from the real
lawyer-provided documents (not placeholder text), normalized to the
**Ads Manager** name and `hello@ads-manager.co.il` contact. Static, self-contained
pages served the same way `favicon.png` is (Vite `public/` → `dist/` root →
`express.static`) — no server route needed. Landing footer's `תקנון`/`פרטיות`
now point at them instead of `#`; the signup checkbox's "תנאי השירות" and
"מדיניות הפרטיות" are real links too (`strings.he.app.auth.terms` split into
labeled parts so the copy stays in the strings file while still rendering
actual `<a>` tags). Verified live: both pages render correctly RTL, and both
sets of links resolve.

### 2026-08-12 — Rebrand: AdPilot / AI Campaigner → Ads Manager, real logo added
Resolves the naming ambiguity landing.md had flagged as an open decision (the
design said "AdPilot", the code's `appName` default said "AI Campaigner").
Both retired — the product's consumer-facing name is now **Ads Manager**
everywhere: page titles, the customer sidebar, the admin sidebar, the
pre-shell `Brand` component (Connect/Review/Checkout/Onboarding), and the
landing header/footer. The real logo icon (provided, not generated) is now
the site favicon and renders beside the wordmark at every one of those
brand marks.

### 2026-08-12 — Real blocker found: "use existing post" ad creation needs our Meta app in Live mode
Live usage: creating an ad creative from an existing IG/FB post failed with a
raw 502. The real error underneath (`code 100, subcode 1885183`): "Ads
creative post was created by an app that is in development mode. It must be
in public to create this ad." Our Meta app is still in Development mode.
Only the existing-post path (`object_story_id`) is gated — a fresh
image/video upload builds its own creative object and is unaffected. Not a
code bug; no code fix exists. Requires an operator to toggle App Mode →
Live in developers.facebook.com (documented in [META_SETUP.md](META_SETUP.md)).

### 2026-08-12 — Manual pause/resume: fix the lagging-read bug, add success feedback (AIC-70)
Real bug: a customer clicked resume, the write succeeded and was read-back
verified, and the row kept showing paused until a manual refresh.
`GraphCampaignAdapter.getCampaignState` (backs `GET /api/app/controls/state`)
was the one consumer commit `556cbcb` missed when it fixed the three
read-back verifiers to read `status` instead of the lagging, Meta-computed
`effective_status` — fixed the same way here. `onToggle` (`Home.tsx`) no
longer re-fetches state after a write either; it trusts the verified
`newStatus` the write already returned and shows an inline success
confirmation, which didn't exist before (silence was the only outcome of a
successful action). Test-first: a unit test reproduces the exact lagging-read
scenario before the fix. Board sweep also closed 7 stale Linear tickets
(AIC-51/52/53/55/63/67/73) whose work had already shipped this session but
wasn't reflected there.

### 2026-08-12 — Range switcher + weekly graph: exact design match
Follow-up to the range-switcher ship below. The first pass approximated the
switcher's look; corrected against the extracted reference markup: track
`rgba(23,23,23,.06)`, selected chip plain white with no shadow, inline with
the page title instead of stacked below the hero. The weekly graph now shows
its total in a mono-font header label and uses top-rounded-only bars, matching
the reference exactly instead of an approximation. The lead-quality card's
black styling stays conditional on the "asking" state (matches the reference,
which is also white in its saved/caught-up states) — confirmed, not changed.

### 2026-08-12 — One range switcher replaces the today/7-day split; per-day ingestion
"Very very confusing" — the dashboard showed a "today" card next to separate
7-day KPIs, two sets of numbers for one campaign. Replaced with a single
explicit **day / שבוע / חודש / הכל** switcher, so the window is a choice
rather than an unstated assumption.

That required fixing the data foundation first. Snapshots were stored ONLY as
overlapping rolling-7-day windows — the same flaw behind "1 lead read as 3" —
so no arbitrary range could be summed from them. Ingestion now also writes
**disjoint per-day rows** (`getDailyInsights`, `time_increment=1`), and every
bounded range sums those. "All time" comes from the cached lifetime read
(`leads_to_date`/`spend_to_date`, migration 029) because per-day rows only
reach back `DAILY_LOOKBACK_DAYS` (45). Pinned by a test that plants an
overlapping window alongside the daily rows and asserts the ranges ignore it.

The same disjoint series powers a new **פניות לפי שבוע** bar graph in the rail.
Thin data is handled honestly: a campaign that started 4 days ago says so
rather than implying a flat empty month.

Visual pass to the design reference: dashboard cards are now **white** on the
cream page, and the lead-quality ask is the one deliberately loud card (ink
background, cream text, orange eyebrow + primary button). Caught quickly in
the browser that `.dash .card`'s white background out-specified a bare
`.lq-card` rule, which would have shipped cream text on white.

Verified live on desktop and 375px: day 3 / week 4 / month 4 / all-time 4,
with all-time matching Meta's lifetime figure exactly.

### 2026-08-12 — Details panel round 2 + a confidently-wrong audience label (AIC-73)
Round-2 review of the redesigned panel. The important find was a **data** bug,
not a layout one: the label read **18–65** for an ad set actually targeting
**21–46**. With Advantage+ audience expansion on (the default for
builder-created ad sets) Meta reports `age_min`/`age_max` as the EXPANSION
CEILING, while the configured range lives in `age_range`. We were reading the
ceiling — showing customers an audience they never chose, which is worse than
showing a raw name. Fixed in `audience-label.ts` (+ the ops explorer, same
bug). The ad set's own NAME said "18-46" while the truth was 21–46, so names
stay untrusted.

Also corrected an assumption in the review itself: it asked for "מודעה אחת ·
4 קרייטיבים" on the basis that the ad named `almond green, french, video,
pink lines` was a flexible ad with four creatives. The live API says one
creative, no `asset_feed_spec` — the name is just a label someone typed. So
`assetCount` comes from Meta and the UI says "מודעה אחת"; it only claims N
creatives when `asset_feed_spec` genuinely carries them.

Rest of the round: nested disclosure REMOVED (one click reveals everything;
hierarchy from layout, with adaptive collapse only above 3 audiences), geo
localised to Hebrew, real creative thumbnails (new `meta/ad-media.ts` +
`GET /api/app/controls/media`, live-on-open like `/state`), per-row status
chips, pause demoted to a quiet link, metrics pulled under their row title,
matching metric sets at both levels, and 18px SVG chevrons that rotate inside
a ≥44px hit target.

Full detail: [features/customer-overview.md](features/customer-overview.md).

### 2026-08-12 — Dashboard shows today; engine still evaluates complete days (AIC-67 follow-up #2)
Reported live: "I see 1 and 4." Both numbers were individually correct and
still contradicted each other. The KPI window (`rollingPeriods().current`)
deliberately **stops at yesterday**, and nothing ever ingested today at all —
so today's 3 leads and ₪26.74 were invisible everywhere on the page, while
the lead-quality card (all-time) correctly said 4.

These are two different questions and now get two windows. The **engine**
keeps complete-days-only: a half-finished day looks like underperformance and
acting on it would move real money on bad evidence. The **dashboard** gets
today, ingested as its own snapshot row (`todayPeriod` +
`runIngestionTick`'s `extraPeriods`, display-only — its failure never marks a
campaign failed) and surfaced as `readout.today`. Shown as its own "היום עד
עכשיו" line rather than blended in: folding a partial day into a 7-day CPL
makes that ratio noisy mid-day without helping anyone. Labelled provisional,
since Meta's same-day conversion data revises upward. The two surfaces can
now legitimately disagree, so AIC-64's no-rec card explains why ("we evaluate
on complete days") instead of leaving it to read as self-contradiction.

Also fixed the labels: `kpiSpend` read **"הוצאה החודש"** (*this month*) on a
7-day value. Every KPI now states its window; deliberately NOT switched to
month-to-date (resets each 1st, and mixing windows across adjacent tiles
makes them non-comparable) — a real budget-pacing month element belongs with
AIC-55's range work.

Numbers now reconcile: 1 (7-day, complete) + 3 (today) = 4 (all-time to review).

Full detail: [features/customer-overview.md](features/customer-overview.md).

### 2026-08-12 — leadsToDate over-counted from overlapping snapshots (AIC-67 follow-up)
Found live within minutes of shipping AIC-67: a customer saw "1 פניות" on the
main KPI and "3 לדירוג" on the new lead-quality card for the same campaign
with exactly 1 real lead. Root cause: `leadsToDate` was computed by summing
`leads` across every campaign-grain `insight_snapshots` row for the campaign
— but those rows are NOT disjoint. The ingestion tick writes a new snapshot
every day for a ROLLING 7-day window (`today-7..today-1`, shifting by one day
per tick), so overlapping snapshots re-report the same real leads. Three
daily ticks of the same 1 lead summed to 3.

Fixed the same way `delivery_ok`/`live_budget_agorot`/`delivering` already
are: one Meta Insights call per generation tick
(`level=campaign&date_preset=maximum`, verified live to return a true
non-overlapping lifetime range) cached onto a new `managed_campaigns.leads_to_date`
column (migration 028). The lead-quality read now uses that column only —
never a live call, never a snapshot sum. Also corrected the real account's
already-wrong value immediately rather than waiting for the next hourly tick.

Full detail: [features/customer-overview.md](features/customer-overview.md).

### 2026-08-12 — Lead-quality feedback: incremental delta review, double-counting fixed (AIC-67)
The weekly lead-quality question asked for a cumulative total ("of your N
leads this week, how many were relevant?") with no memory of what was already
reviewed — a customer answering twice in the same week (2 leads → 5 leads)
had to remember they'd already counted the first 2, or double-count. Two
compounding flaws: a moving denominator and no reviewed-so-far state.

Replaced with an append-only review log (migration 027,
`lead_quality_reviews`: `leads_delta`/`relevant_delta` per review action).
The all-time watermark is `SUM()` over that table; the customer is only ever
asked about `pending = max(0, leadsToDate - reviewedSoFar)` — computed
SERVER-SIDE from the caller's own watermark, never client-supplied, so
re-rating already-reviewed leads is structurally impossible, not just
avoided. `max(0, ...)` also makes attribution lag safe for free: a
retroactive downward revision to `leadsToDate` just reads as caught-up
instead of going negative. Existing per-week values migrated forward as the
initial watermark (no data loss) — a customer who'd already answered the old
form isn't re-asked. Deliberately left the operator's manual admin-console
entry untouched (a distinct, adequate mechanism for phone-reported data, not
the thing that caused double-counting).

Full detail: [features/customer-overview.md](features/customer-overview.md).

### 2026-08-12 — Audience details panel redesign + the real root cause of the raw-name leak (AIC-73)
Observed live: the opt-in "הצג פירוט" panel showed the raw Meta ad-set name
(`"IL | Ramat Gan, Givatayim | Women 18-46 | Advantage+"`, pipes and all) —
an AIC-37 spec violation, not cosmetic. Root cause: `deriveAudienceLabels`
only labeled a dimension when it DIFFERED across sibling ad sets; with
exactly one ad set (the common single-audience small-business shape), nothing
ever differs, so every real account fell through to the name. Fixed by
composing every ad set's OWN gender/age/geo unconditionally
(`"נשים · 18–46 · רמת גן, Givatayim"`); the only true fallback (no structured
targeting at all) is a neutral phrase, never the name, and identical-label
collisions get a disambiguating suffix.

Also redesigned the panel itself: labeled metrics (no more bare repeated
numbers), an explicit nested audience→ad hierarchy, a collapsed-state preview
built from data Home already has (no prefetch), a labeled + explained
creative list, consistent pause-button placement, and `<bdi>`-wrapped mixed
Hebrew/Latin text so nothing renders reversed. Verified live on desktop and
375px against the real GelNails account.

Full detail: [features/customer-overview.md](features/customer-overview.md).

### 2026-08-12 — The above server fix needed a frontend half too (AIC-71 follow-up #2)
Reported live immediately after the previous fix shipped: "after I click הפעלת
קהל I need a full refresh before seeing the status updated." The server was
already correct (previous entry) — `AudienceDetails`' `onToggle` (`Home.tsx`)
refreshed the per-row live status but never invalidated the shared overview
cache (`overview-store.ts`) the headline "מצב" actually reads from. One line:
call `invalidateOverview()` after a successful toggle, the same pattern
AIC-53's launch-approval flow already uses. Full detail:
[features/manual-controls.md](features/manual-controls.md).

### 2026-08-12 — Manual pause/resume now updates the Home headline immediately (AIC-71 follow-up)
Found minutes after AIC-71 shipped: paused the only ad set live and Home kept
reading "פעיל" — `managed_campaigns.delivering` was only ever recomputed on
the hourly engine tick, so a customer's own pause left the headline stale for
up to an hour, directly undermining the "stopped" state just shipped to fix
exactly this kind of staleness. `POST /pause`/`/resume` (customer) and the
operator object-control route now call a new `refreshDeliveryNow` right after
a write actually changes something — same computation as the engine tick,
run synchronously instead of waiting. Caught a real test-mock gap in the
process: `controls.integration.test.ts`'s shared Meta mock never returned
`adset_id` on ad rows (nothing had needed it before AIC-71's ad-level
rollup), silently zeroing every ad-count assertion until fixed.

Full detail: [features/manual-controls.md](features/manual-controls.md).

### 2026-08-12 — Honest delivery state on Home: "stopped" + a real active-ad count (AIC-71)
Real GelNails case, seen live right after AIC-66 shipped: the customer paused
their only ad set via the new manual controls — zero delivery, zero spend —
and Home still read **פעיל** with **1 מודעות פעילות**. Neither number ever
reflected live Meta state: `homeState`'s `ok`/`paused` split only knew
`managed_campaigns.status`, an operator DB flag meaning "we manage this,"
unrelated to whether anything is actually running; the active-ad count came
from `insight_snapshots`, i.e. historical spend, so a since-paused ad kept
counting.

Fix reuses the existing per-tick delivery-health read (AIC-39) rather than
adding a new Meta call or a new staleness mode: `getDeliveryHealth`'s
ad-level rollup now also counts each ad set's currently-delivering ads
(`deliveringAdCount`), and `summarize()` exposes `delivering: deliveringAdCount
> 0` — a fact orthogonal to `ok` (a fully, correctly paused campaign is
`ok: true, delivering: false`, not a problem). Persisted alongside
`delivery_ok` every tick (migration 026: `managed_campaigns.delivering`,
`delivering_ad_count`). New `homeState = "stopped"` checks `!delivering`
after the real delivery-problem check and before `collecting` — a campaign
with everything paused will never accumulate data no matter how long you
wait. Home's "מודעות פעילות" now reads `deliveringAdCount` when the engine has
ticked at least once, falling back to the old historical count only before
that.

Full detail: [features/customer-overview.md](features/customer-overview.md),
[features/delivery-health.md](features/delivery-health.md).

### 2026-08-12 — Manual pause/resume/archive/delete of ads + ad sets (AIC-66)
Until now the only way an object changed state was an approved engine
recommendation — a management product that can't manually turn an ad off was
missing table stakes. Adds direct human control on both surfaces, settling a
three-actor authorization model: the engine proposes and the customer
approves; a **customer acting on their own object is self-authorized** (adding
an approval step there would be incoherent — approval exists because the
*engine* proposed something); an **operator** may do the same plus
archive/delete, audited.

Deliberately does NOT reuse `SafeExecutor` (AIC-12), which is
recommendation-bound at every step — reusing it would mean inserting a fake
`recommendations` row and walking it through `proposed → approved`, inventing
an approval that never happened in the one part of the system whose value is
that its records are true. Follows AIC-63's `activateOne` shape instead: read
→ no-op if already at target → write → read-back verify → log.

New `setAdStatus`/`setAdSetStatus` are the first adapter writes taking a
caller-supplied status; the create-always-PAUSED (AIC-50) and
activate-always-ACTIVE (AIC-53/63) invariants they sit next to are unaffected
and the code says so. Destructive actions are operator-only with server-side
confirm-to-type (the bar AIC-44 set for deleting a whole customer), archive
preferred over delete, and the object then drops out of counts via AIC-65's
filtering. First action to write **both** `action_history` and
`admin_audit_log` — the "no current overlap to cross-link" note in `admin.ts`
is now updated.

Full detail: [features/manual-controls.md](features/manual-controls.md).

### 2026-08-12 — Meta setup runbook rewritten around the three layers of access
Investigating why add-content (AIC-63) couldn't be fixed produced a much more
useful finding than the bug itself: **Meta access is three independent layers**,
and Business Settings can look entirely correct while the backend has zero
access. (1) asset shared to our Business Portfolio — customer's action;
(2) asset assigned to our System User — our action, a *separate* step;
(3) the token carries the matching scopes — **frozen at token-generation time**.

Layer 3 is the trap: our token was minted with `ads_management, ads_read,
business_management` only. Assigning Page assets later does not retroactively
add `pages_*` scopes, so every Page call keeps failing with `(#100) … requires
the 'pages_read_engagement' permission` no matter how correct layers 1–2 look.
Adding a new asset type means regenerating the token and rotating the Railway
secret.

[META_SETUP.md](META_SETUP.md) now records our real identifiers (Business
Portfolio **`2491237118040524`** "AI Campaigner" — previously undocumented
anywhere, which cost a live round-trip; app `1762330388097443`; System User
`122103498795426897`), a step-by-step per-customer onboarding runbook with the
exact tasks to grant per asset, a copy-paste verification block that tests each
layer separately, and a symptom→layer→fix table. Also documents the hard-won
ordering rule: **confirm the Page is readable before writing `page_id`** — a
`page_id` the backend can't read flips the connection to `revoked` and silently
stops the recommendation engine (AIC-69).

### 2026-08-12 — Exclude deleted/archived/draft ad sets (AIC-65)
GelNails' "second ad set" turned out to be a never-published draft: real
historical spend (an ad that ran and was later removed), but `effective_status`
still reports `ACTIVE` with zero ads today. The product was treating it as a
real, managed ad set everywhere — a false 2-ad-set count, a false
needs-attention item from its leftover `issues_info`, a confused audience
rule, and a `delivery_blocked` no-rec reason (AIC-64) that was really "this
object doesn't exist."

`AdSetMeta.isManaged` (`audience-label.ts`) is now false for a deleted/
archived `effective_status`, or for zero ads (`getAdSetMeta` now requests
`ads.limit(1){id}`). `runGenerationTick` fetches ad-set metadata first each
tick, excludes unmanaged ad sets from delivery-health, the audience/creative
rule evidence, the cached labels (so the customer's opt-in audience view
never shows it), and the audience count — tracked SEPARATELY from real
delivery problems so AIC-64's `delivery_blocked` reason is never
misattributed to a dead object. Also fixed a real ordering bug in
`delivery-health.ts`: a deleted ad set's stale leftover `issues_info` was
checked before the deleted/archived branch, so it could still be flagged.
Ops explorer (AIC-45) still shows a dead ad set for operator visibility, but
clearly marked "נמחק / לא פורסם," never as active or a problem.

Full detail: [delivery-health.md](features/delivery-health.md#excluding-deaddraft-ad-sets-not-just-unhealthy-ones-aic-65).

### 2026-08-12 — Two real bugs found by Sharon dogfooding: stale budget + broken add-content
Sharon (real customer + operator) reported the dashboard showing ₪10/day after
raising the real Meta budget to ₪30, and "הוספת תוכן" claiming she had no
campaign despite GelNails being live and healthy.

**Stale budget**: `agreed_budget_agorot` is a safety ceiling for the engine's
own automated proposals ([safe-execution.md](features/safe-execution.md)),
not a live mirror of Meta — but the dashboard displayed it as if it were
"today's budget." The engine already reads the live budget every generation
tick (needs it to evaluate rules) but was discarding it after use. Fixed:
`server/src/services/live-budget.ts` caches the read every tick
(`managed_campaigns.live_budget_agorot`, migration 025) for display, and
auto-**raises** (never lowers) the ceiling to match — closing a latent bug
where a live budget above the stale ceiling would make the engine's own next
`decrease_budget` proposal throw `BudgetLimitError` at execution.

**Broken add-content**: root-caused to `meta_connections.page_id` being blank
on Sharon's row — `resolveAdditionContext` requires it and fails with a
generic "no campaign yet" message that doesn't say why. The blank value
traces to how the row was created: hand-written SQL back on 2026-08-08, not
through any console feature (because none exists — see
[AIC-68](https://linear.app/pisga-app/issue/AIC-68)). Extended the admin Meta
explorer (`server/src/meta/explorer.ts`) to read `object_story_spec.page_id`
off a live ad's creative — the one place in the app that can recover a Page
id without a new endpoint — used it to find GelNails' real Page id, then
corrected the DB row directly.

**Deeper gap tracked separately**: there is no admin UI to provision a real
customer's `meta_connections`/`ad_accounts`/`managed_campaigns` rows — every
real customer today is onboarded via hand-written SQL, which is exactly what
produced the blank `page_id`. Filed [AIC-68](https://linear.app/pisga-app/issue/AIC-68)
to build it; user explicitly deferred building it in this session.

### 2026-08-12 — Honest "why no recommendation" reasons (AIC-64)
"No recommendation" was one undifferentiated `no_action` state — the customer
saw identical copy whether the campaign was genuinely stable or the engine was
structurally blind at the current budget. Grounded in a real diagnosis this
session (GelNails: ₪10/day budget → 7-day rolling window maxes at ₪70, under
every rule's spend gate — no amount of *time* fixes that, only raising the
budget does): `classifyNoAction` (`server/src/recommendations/rules.ts`) now
splits the old `insufficient_evidence` into five priority-ordered reasons —
`delivery_blocked`, `budget_below_threshold` (newly computed: 7×daily budget
vs the smallest actionable rule threshold), `collecting`, `single_ad_set`,
`stable` — never the same message for genuinely different situations.

Cached per campaign (`managed_campaigns.no_rec_reason`/`no_rec_detail`,
migration 024) every generation tick, mirroring the `delivery_ok`/
`delivery_reason` pattern (AIC-39) rather than a new table, since it's current
per-campaign state, not an event log. Customer dashboard shows distinct
honest Hebrew per reason with a raise-budget CTA where actionable
(`web/src/app/Home.tsx`); the ops console's customer-detail panel shows the
operator the exact numbers that blocked (`web/src/admin/AdminCustomers.tsx`).

Full detail: [RULES.md](RULES.md#why-theres-no-recommendation-aic-64).

### 2026-08-12 — Add ad / ad set to an existing managed campaign (AIC-63)
The builder only ever handles a customer's *first* campaign
(`resolveBuilderContext` 409s once one exists). Until now that meant
there was no in-app way to add a creative or test a new audience
afterward — the everyday management action — short of Ads Manager. New
`/api/app/additions/*` route family + `/app/add-content` screen add it,
reusing AIC-50/51/53's primitives rather than duplicating them: the same
idempotent outbox (`WriteOutbox.applyIdempotent`, `add-`-prefixed
`builderKey`s), the same `asCreatingWriter` (exported for reuse), the same
creative upload/validation pipeline. New `pending_additions` table
(migration 023) generalizes AIC-53's single-campaign launch gate to a
per-object, repeatable approval — every add lands PAUSED and stays that
way until explicitly approved. New `AdditionWriter.activateAdSet`/
`activateAd` mirror `activateCampaign`'s hard rule (no caller-supplied
status; can only ever send `ACTIVE`), and approval checks each object's
live status before writing so a retry after partial failure never
double-activates. `POST /additions/ad` re-validates the client-supplied ad
set ID against a **live** `getAdSetMeta` fetch (not the hourly cache) —
both to prevent adding to an ad set that isn't the caller's, and so an ad
set created earlier in the same visit is immediately usable.

Two real bugs caught dogfooding, not just described: the add-ad-set
audience step loaded the business category but never derived age/gender
from it (stayed at a hardcoded 18–65/all default); and a pre-existing,
app-wide mobile bug — CSS Grid's default `min-width: auto` on grid items
silently forced every `.grid-2`/`.grid-3` screen to ~497px at a 375px
viewport (via `SupportCard`, present on nearly every screen) — fixed
generically (`.grid-2 > *, .grid-3 > * { min-width: 0; }`), not just
patched at the one button that surfaced it.

Full detail: [features/campaign-builder.md](features/campaign-builder.md).

### 2026-08-11 — Builder honesty pass: business-type selector, fixed placements, no dead radius (AIC-52 follow-up)
Three defects surfaced by dogfooding the builder against a seeded customer,
all the same class ("a control/badge implying a choice the customer doesn't
actually have"):

1. **Audience business type was invisible.** The one input driving the whole
   audience recommendation (age/gender) was read silently from
   `customers.category` — an operator-only free-text field the customer never
   sees or confirms, so a wrong/blank value confidently mis-targets with no
   way to notice. Now the audience step leads with an editable business-type
   `<select>` (pre-selected from the onboarding category via
   `normalizeBusinessCategory`; changing it re-derives age/gender + rationale
   live). "לפי מה שסיפרתם לנו. לא מדויק? אפשר לשנות כאן."
2. **Placements pretended to be a recommendation.** `createAdSet` sends no
   placement field (Meta uses automatic/Advantage+; no path to narrow), yet
   the step had a מומלץ badge + "the tradeoff of narrowing" copy. Now
   presented as fixed like the goal step; `RECOMMENDED_PLACEMENTS` →
   `FIXED_PLACEMENTS`.
3. **The radius input went nowhere.** It accepted a value that never left the
   browser (targeting is age+gender+`countries=["IL"]`). Removed, replaced
   with a plain "targets all of Israel; area/radius coming later" note.
   `CATEGORY_AUDIENCE_DEFAULTS.radiusKm` kept as the seed for real
   geo-targeting, filed as **AIC-60** (business location + geocoding + Meta
   `custom_locations`) — the AC-accurate version of what radius was faking.

The category rationales were also rewritten to justify age/gender only (they
previously claimed "local radius" targeting P0 doesn't apply). Browser-verified
(selector re-derives home_services → 28–60/all; placements shows no badge).
No new automated test — no web component-test infra exists, and the
server/Meta payload is unchanged (radius never reached it); the builder route
integration test already covers the age/gender/country build.

### 2026-08-11 — Launch gate: PAUSED → review → customer approval → ACTIVE (AIC-53)
The controlled path from "built (paused)" to "spending (active)" — a
builder-created campaign never spends without an explicit customer approval.
New `launch_approved_at` column (migration 022, existing rows backfilled
non-NULL since they were already live) distinguishes "review-approved +
managed" (`status='active'`) from "customer approved going live." New
`server/src/launch/activate.ts` `activateCampaign` is its own small
validate→write→read-back-verify→log pipeline (deliberately NOT AIC-12's
SafeExecutor, which is recommendation-bound, nor AIC-50's create-writes,
which hardcode PAUSED). The single adapter method that can send
`status=ACTIVE` takes no status parameter — the create-writes' "always
PAUSED" invariant in reverse, pinned by a unit test.

"No builder path activates directly" is enforced, not just intended:
`buildCampaignOnMeta` never touches status, a fresh build lands
`under_review`, and `activateCampaign` refuses anything not already
review-`active`. Customer surface: a new `ready_to_launch` home state + a
`LaunchModal` (`web/src/app/Home.tsx`) showing budget + estimated monthly
max spend + ad count + WhatsApp destination before the single approve
button (AIC-23 informed-approval pattern). Routes `/api/app/launch` +
`/api/app/launch/approve`.

Tests: `server/src/launch/activate.integration.test.ts` (6) +
`server/src/routes/launch.integration.test.ts` (7) +
`campaign-adapter.test.ts` (+3), all green. Live-verified in a real browser:
the ready-to-launch hero, the modal's spend summary (₪40/day → ₪1200/mo max),
and honest 503 degradation with no token (error shown, DB confirmed not
marked launched). The real PAUSED→ACTIVE flip on a live account is part of
AIC-50's still-pending dogfood, gated behind explicit human go-ahead.

### 2026-08-11 — Guided campaign builder UI + HTTP routes (AIC-52)
The 8-step wizard (goal/WhatsApp/budget/special-ad-category/audience/
placements/creatives/review) implementing "recommended default already
filled in + why + every real choice visible" — `web/src/app/Builder.tsx` +
`web/src/app/BuilderCreatives.tsx`. New HTTP surface `server/src/routes/builder.ts`
(`/api/app/builder/{context,start,upload,posts,creative,build}`, `multer`
for uploads) is a thin layer over AIC-50/51's already-built service code;
`server/src/builder/session.ts`'s `resolveBuilderContext` is the real
precondition gate (healthy connection + ad account + Page + no existing
campaign), not just a UI nicety — every write route re-resolves it and
checks `localCampaignId` ownership server-side.

Bug caught by the route integration tests: the "customer already has a
campaign" check originally matched the UNLINKED shell row `/start` itself
creates, so calling `/start` a second time (the normal resume path) 409'd
instead of resuming — fixed by requiring `meta_campaign_id IS NOT NULL`.

Corrected an AIC-49 precedent flagged as debt in AIC-51's entry below:
`recommended-defaults.ts`'s rationale strings (budget/placements/special-
category-question/per-category audience rationale) moved into
`web/src/strings.ts`'s `builder` section, since AIC-52's own AC requires
"all copy in the strings file" and this ticket is what actually builds the
UI that displays them. `shared/recommended-defaults.ts` is now genuinely
copy-free.

Home's `no_campaign` state now branches: ready-to-build → new CTA to
`/app/builder`; still onboarding → the pre-existing `/onboarding` CTA,
unchanged.

Tests: `server/src/routes/builder.integration.test.ts` (7, mocked-fetch
through the real adapter and real HTTP routes). Also walked the full wizard
in a real browser against a locally-seeded customer — confirmed the
audience step's category-based prefill and every step's validation gating
work correctly. That pass also surfaced that `server/.env` carries a real
`META_SYSTEM_USER_TOKEN` picked up automatically by local dev — one
unintended real (read-only, nonsense-target) Meta call happened before this
was caught; no writes occurred. AIC-50's live dogfood test (and AIC-51's
WhatsApp-creative field-shape verification riding with it) is still the
pending real-Meta-write checkpoint.

### 2026-08-11 — Creative handling: upload/existing-post → Meta ad creative (AIC-51)
The builder's content step, split the same way as AIC-50: platform-
independent spec in `shared/src/creative-handling.ts` (limits,
`validateCreativeCopy` — returns error CODES only, e.g. `missing_headline`,
never Hebrew text), Meta API calls in `GraphCampaignAdapter` via a new
`CreativeWriter` interface (`server/src/builder/creative-types.ts`):
`uploadImage`/`uploadVideo` (video upload polls Meta, bounded, until a
thumbnail is ready), `listPromotablePosts`, `createCreativeFromUpload`/
`createCreativeFromExistingPost`. Idempotent the same way as AIC-50's
creates (`server/src/builder/creative-create.ts`, migration 021 widens the
outbox's kind check for `create_creative`) — except the raw upload step
itself, deliberately left one-shot (a file buffer isn't a resumable
payload the way small JSON creates are).

Corrected an AIC-49 precedent while building this: AIC-51's own AC requires
"copy/labels in the strings file," so — unlike `recommended-defaults.ts`'s
rationale strings — no Hebrew lives in `creative-handling.ts`. The
responsibility notice and every validation error message moved to
`web/src/strings.ts`'s new `builder` section (`creativeValidationMessage()`
maps a code to its text, same pattern as `connectionMessage()`).
AIC-49's existing rationale-strings-in-shared/ is now flagged as the same
class of debt, deferred to AIC-52 rather than retrofitted mid-ticket.

No HTTP route was built — AIC-51's AC never requires one, and nothing calls
one without AIC-52's UI to exist yet; building disconnected endpoints now
would be guessing at a shape AIC-52 should actually determine.

Tests: `shared/creative-handling.test.ts` (7, asserting error codes now
instead of Hebrew substrings), `campaign-adapter.test.ts` gained 8
(upload/video-poll/list-posts/create-creative, mocked fetch), new
`creative-create.integration.test.ts` (5: upload path, existing-post path,
idempotent-per-key, failure-then-resume, distinct creatives per clientKey).
Live-verification of the WhatsApp creative field shape rides along with
AIC-50's still-pending dogfood test.

### 2026-08-11 — Meta create-writes: createCampaign/createAdSet/createAd, always PAUSED (AIC-50)
The builder's write surface. New `BuilderWriter` interface
(`server/src/builder/types.ts`), implemented by `GraphCampaignAdapter`
alongside its existing `MetaReader`/`ExecWriter`/`DeliveryReader` roles —
deliberately kept off `ExecWriter` itself, since create-writes aren't part of
the recommendation-approval flow. Every create hardcodes `status=PAUSED`, no
caller-controllable path to a live object — pinned directly with a mocked-
fetch unit test (`campaign-adapter.test.ts`), the first `GraphCampaignAdapter`
method to get one (every prior write was live-dogfooded only).

Idempotency extends the AIC-13 outbox rather than duplicating it: migration
020 widens `meta_write_outbox.kind` for the three create kinds + adds a
`result` column. New `WriteOutbox.applyIdempotent` is a synchronous
claim-then-create-or-resume path (atomic `pending`→`in_progress` claim
blocks a concurrent double-submit from creating two objects) — `drainOnce`
is untouched for the existing async budget/pause writes. New
`server/src/builder/campaign-create.ts`: `startBuilderCampaign` creates (or
resumes) the local `managed_campaigns` shell row every create-write anchors
to (`status='under_review'`, `meta_campaign_id=NULL` until every step
lands — invisible to `listEligibleForGeneration` until then);
`buildCampaignOnMeta` walks campaign→ad-sets→ads with a deterministic
idempotency key per object, logs `action_history` per success, and links the
local row on completion. A mid-build failure is reconcilable by resuming the
same call with the same keys — already-created PAUSED objects are the
resume point, never orphans to clean up.

**Honest field-shape caveat**: the ad-set WhatsApp-destination fields
(`optimization_goal`/`destination_type`/`promoted_object`) are a best-effort
reading of Meta's API, not yet live-verified the way `setDailyBudget`/
`pauseAdSet` were — the AC's own "dogfood on an account we control" step is
what actually confirms this shape, pending as of this entry. Tests: 4 unit +
10 integration (`write-outbox.integration.test.ts` +4,
`campaign-create.integration.test.ts` new file, 4 tests). Doc:
`campaign-builder.md`.

### 2026-08-10 — Recommended-defaults spec (AIC-49), P1 Campaign Builder begins
Kicks off the new P1 phase: creating a customer's first campaign in-product
instead of a founder walking them through Ads Manager by hand (what actually
happened for GelNails). `shared/src/recommended-defaults.ts` is the single
documented source of truth for what the future builder (AIC-52) recommends
at every step: the 3 P0-fixed choices (objective/buying-type/destination —
not presented as a choice), the AIC-38 single-ad-set structure recommendation,
Advantage+ placements, a ₪30–50/day ("₪40 recommended") budget starting
range framed honestly as a data-gathering point rather than a guaranteed
number, Meta's Special Ad Category compliance question (always defaults to
`NONE`, always asked explicitly, never silently inferred — a small
category→hint map only prompts a more careful honest answer), and a
business-category → audience-defaults map (age/gender/local-radius) for a
curated set of common Israeli-SMB categories, each with a plain-Hebrew
rationale. `customers.category` stays free text (set during AIC-44's manual
onboarding); unrecognized categories resolve to an honest broad `other`
default rather than guessing. New owning doc `campaign-builder.md` (added to
INDEX.md) covers this ticket live and AIC-50–53 as planned. Tests:
`recommended-defaults.test.ts` (9 tests).

## Changelog

### 2026-08-10 — Thin approve surface verified + doc rot fixed (AIC-22/23/37)
No app-code change — this closes out three tickets (AIC-22 Home, AIC-23
recommendation approve/dismiss, AIC-37 audience opt-in details) that were
built in an earlier session but never marked Done in Linear, with a full live
QA pass against prod Neon: real hero states (incl. the AIC-39
delivery-vs-connection distinction), real KPIs+deltas, the audience-details
toggle (correctly falling back to the ad set's real Meta name since GelNails'
actual targeting doesn't structurally differ by age despite the descriptive
names), the weekly lead-quality stepper+submit, and — seeding two realistic
recommendations since GelNails has none real yet — the full approve flow
(hit the real 503 "Meta not configured locally" path, confirmed a clean
Hebrew message with zero leaked technical detail, confirmed the DB never
false-marked the rec as approved) and dismiss flow, both against the live
API. Mobile viewport confirmed no horizontal overflow. All QA-seeded data
(2 recommendations + one real-but-unwanted weekly-feedback row written via
the actual UI flow) cleaned up afterward.

Also fixed real doc rot found along the way: `customer-app.md`'s status line
still said the recommendations flow, onboarding, and connect were "mock" —
they've been live since AIC-21/23 (2026-08-08); only the review screen
(AIC-32) still is. `customer-overview.md` never documented `attentionKind`
(AIC-39) or the audience opt-in view (AIC-37) at all, and `RULES.md` linked
to a doc section that didn't exist. AIC-23's one genuinely unbuilt AC
("approval-rate instrumented for the metrics funnel") and AIC-37's ("toggle
open-rate instrumented") both stay honestly deferred — blocked on AIC-28
(metrics/activation-funnel instrumentation), which doesn't exist yet; no
event sink to write to, so neither is half-built.

### 2026-08-10 — Audience-aware rules: flexible/Advantage+ creative exclusion (AIC-36)
Closes out AIC-36 — the creative-vs-audience conflation fix, the audience rule,
errored-ad-set exclusion, and the pauseAdSet write were already live from
earlier work; the one remaining AC was detecting Meta's Dynamic/Advantage+
creative and skipping `pause_weak_creative`'s per-asset comparison for it
(Meta doesn't expose reliable per-asset CPL for a dynamic-creative ad set —
comparing its "peers" and pausing the apparent loser would be the engine's
first live recommendation being wrong, on someone else's ad spend). New
`is_dynamic_creative` fetched per ad set (`getAdSetMeta`, alongside the
AIC-37 targeting fields), cached in `ad_set_meta` (migration 019).
`CampaignEvidence` gained `flexibleCreativeAdSetIds`; `pause_weak_creative`
skips those ad sets' groups entirely while every other rule (including
`pause_underperforming_audience`, which reads `ev.adsets` not `ev.creatives`)
is unaffected — the ad-set-level CPL is still real, only the per-asset
breakdown inside a flexible ad set isn't. Threaded end-to-end through
`runGenerationTick` → `refreshRecommendations` → `buildCampaignEvidence`.
Tests: `rules.adset.test.ts` (+3, pure rule logic), `generation.test.ts` (+2,
wiring through the real audienceMetaReader → cache → set-building path),
`audience-label.test.ts` fixture updated. Doc: `RULES.md`.

### 2026-08-09 — Operator accounts + full admin audit log (AIC-47)
The last ops-console-v2 ticket — all five admin sections are now live. New
`app_users.admin_role` (`full_admin`|`operator`, migration 018, backfilled
from today's `is_admin` accounts) is the one deliberate role gate: every
admin route still runs on `requireAdmin` alone, except operator-account
management itself, which additionally requires `requireFullAdmin` — a
general per-route RBAC overhaul was explicitly out of scope, only the
concrete "only a full-admin can manage operators" AC. `services/
operator-accounts.ts` add/promote/remove an operator (promotion of an
existing signed-up account only — no invite-by-email, same P0 gap as
password reset); both role-demotion and removal refuse to touch the last
remaining full_admin. Removing revokes console access without deleting the
login. The full filterable audit log reuses AIC-44's `admin_audit_log` table
(no new table) — `listAuditLog` gained an `entityType` filter; new writers
`operator.add/.role_change/.remove` and `campaign.control.<action>` (closed a
real gap: emergency-control use was silently unlogged before this, despite
being explicitly listed in the AIC-47 spec). Web: `AdminOperators.tsx` at
`/admin/operators` (nav item now live — the console's last "בקרוב" row is
gone). Live-verified end to end on prod Neon: added/promoted/removed a real
test operator, the last-full-admin guard correctly blocked a demotion, and a
real reversible emergency-control round trip on Pisga's campaign logged both
actions truthfully — cleaned up afterward. Tests: `middleware/admin.test.ts`
(requireFullAdmin), `operator-accounts.integration.test.ts` (10 tests). Also
removed a stale doc section (`ops-console.md`'s "Web ops console") that still
referenced the pre-shell `OpsConsole.tsx`/`/admin/ops`, deleted back in
AIC-43 but left undocumented as gone.

### 2026-08-09 — Recommendations oversight (AIC-46)
PRD §23's cross-account recommendations surface: every rec the engine has
produced, any customer, filterable by state/type/customer, with its evidence
and full lifecycle status. `services/recommendation-oversight.ts`
`listRecommendationsForAdmin` joins recommendations→campaigns→customers +
the latest linked `action_history` row (outcome + a link back). Deliberately
**read + flag only** — no operator-initiated approve/execute: the product's
core trust model is customer-approval-gated spend changes, and a side-channel
execute button for operators would undercut that for a feature the ticket
itself marked optional. New `flagged_for_review`/`flag_note` on
`recommendations` (migration 017) lets an operator flag a rec for review,
orthogonal to the AIC-8 state machine — logged to `admin_audit_log` (AIC-44's
table, `entity_type: 'recommendation'`). Failed recs surface via the state
filter, consistent with the needs-attention queue. Web: `AdminRecommendations.
tsx` at `/admin/recommendations` (nav item now live). Verified with realistic
seeded-then-cleaned-up data on prod — GelNails hasn't produced a real
recommendation yet (thin data / the delivery-health exclusion), so this is
honestly not yet re-verifiable against real engine output. Tests:
`recommendation-oversight.integration.test.ts`. Doc: `ops-console.md`.

### 2026-08-09 — Full Meta data explorer (AIC-45)
The operator's unrestricted deep view — the exact opposite of the customer's
opt-in audience view (AIC-37): every node (campaign→ad-set→ad→creative) with
every metric Meta gives us, including the ones hidden from customers per PRD
§14 (CPM/CTR/CPC/reach/frequency/quality-engagement-conversion rankings),
targeting, budgets + bid strategy, and delivery issues. New
`server/src/meta/explorer.ts` (`GraphExplorerReader`, its own small read-only
Graph client) + `services/campaign-explorer.ts` fetch live from Meta on every
open/refresh — no new storage table, honest degradation via
`unavailableReason` (`no_meta_campaign`/`no_token`/`meta_error`) instead of a
500 or a fabricated tree. This is the one deliberate exception to "never a
live Meta call at render time" (AIC-7's rule protects the normal navigation
path; this is a gated, explicit operator action). Recognizes flexible/dynamic
creatives (`asset_feed_spec`) instead of rendering them as broken. Web:
`AdminMeta.tsx` at `/admin/meta` (nav item now live); `AdminCustomers.tsx`
links straight in via `?campaign=<id>`. Tests: `explorer.test.ts` (pure
normalizers incl. the flexible-creative shape),
`campaign-explorer.integration.test.ts` (DB+HTTP, injected fake reader).
Doc: `ops-console.md`.

### 2026-08-09 — Customer CRUD + admin audit log (AIC-44)
The operator's actual daily onboarding/support tool: `AdminCustomers.tsx`
gains create ("+ לקוח חדש"), an inline edit form (business fields; budget
edits write straight to `managed_campaigns.agreed_budget_agorot`, which the
engine's safety check already reads live), deactivate/reactivate (reversible;
deactivating marks the managed campaign `unmanaged` — stops both generation
and execution via the existing AIC-14 controls, without touching Meta), and a
gated hard-delete (confirm-to-type, enforced server-side too, cascades the
customer's rows, never touches Meta assets). New `customers.is_active`/
`deactivated_at` + append-only `admin_audit_log` (migration 016;
`services/admin-audit.ts` + `services/customer-admin.ts`) — every write is
logged (who/what/entity/before→after), with `entity_id` deliberately not a
foreign key so a hard-deleted customer's own delete is still legible in its
audit trail. Search + active/deactivated filter over the roster; the
drill-down now shows the full record (business+contact+subscription) plus
lead-quality and condensed action-history via existing endpoints, plus the new
per-customer audit trail. QA'd live end-to-end against prod Neon (create →
edit → deactivate → reactivate → delete, confirm-to-type rejected then
accepted, audit trail survived the cascade) then cleaned up. Tests:
`customer-admin.integration.test.ts`. Doc: `ops-console.md`.

### 2026-08-09 — Admin console nav shell + fleet overview (AIC-43)
The admin console gets a proper multi-section frame — the base the rest of
ops-console-v2 (AIC-44…47) hangs off. New `AdminShell.tsx` (right-side sidebar,
reusing the customer app's shell CSS) + `AdminSidebar.tsx`: **סקירה כללית**
(Overview, `/admin`) and **לקוחות** (Customers, `/admin/customers`, the
pre-shell single dashboard's queue+customers+drill-down content, moved and
restyled to the `.dash`/`.card`/`op-table` system) are live; **נתוני Meta** /
**המלצות** / **מפעילים** show as disabled "בקרוב" rows until AIC-45/46/47 land.
New `GET /api/admin/overview` (`services/fleet-overview.ts`): campaigns-by-status,
delivering-vs-needs-attention (AIC-39 `delivery_ok`), spend/leads for the
managed fleet (all campaigns, incl. dogfood), open ops-queue depth, and
billing/conversion (excludes test customers — honest "no real customers yet" at
current scale). A client-side global search (business name + campaign name)
jumps to `/admin/customers?focus=<id>`, which auto-selects that customer's
drill-down. `CustomerListRow`/`CustomerDetail` gained `campaignName`. Old
`/admin/ops`+`/admin/readout` now redirect to `/admin/customers`. QA'd live:
real GelNails delivery-problem queue item, real fleet numbers, search→jump-to
end-to-end. Tests: `fleet-overview.integration.test.ts`. Doc: `ops-console.md`.

### 2026-08-09 — Design-system roll-out + shared overview fetch + a11y pass (AIC-42)
Recommendations (list + detail) and Settings now use the same tighter type +
lifted cards as the dashboard (`.dash`/`.dash-title`) — one visual system across
`/app*`. New `web/src/app/overview-store.ts`: a single `useSyncExternalStore`
cache for `GET /api/app/overview`, consumed by the sidebar, Home, and Settings —
confirmed via the Performance API that a page load now fires exactly **one**
overview request (was up to 3, one per component). A11y: the account menu opens
with focus on its first item, ↑/↓ cycle entries, Escape closes and returns focus
to the trigger; the mobile drawer closes on Escape; visible `:focus-visible`
rings on nav items/gear/FAB/menu entries; `aria-current="page"` on the active nav
item (via React Router's `NavLink`). Verified live: all three keyboard behaviors
tested end-to-end in the browser. Doc: `customer-app.md`.

### 2026-08-09 — Opt-in per-audience/per-creative details view (AIC-37)
Progressive disclosure for the multi-ad-set campaigns AIC-38 established as
normal: Home stays the 4-number roll-up by default; a collapsed **"הצג פירוט"**
expander reveals the per-audience breakdown, each expandable to its own
per-creative rows. New `GET /api/app/audiences`
(`server/src/services/campaign-audiences.ts`, ownership-scoped, DB-only). Audience
labels are derived from what actually differs between a campaign's ad sets — age
→ gender → geo, else the ad set's own name — never "ad set N"
(`server/src/meta/audience-label.ts`, `deriveAudienceLabels`). Labels are fetched
+ cached (`ad_set_meta`, migration 015) by the engine tick (alongside delivery
health) and threaded into `pause_underperforming_audience`'s evidence, so the
explainer now names the audience by its human dimension instead of generic
phrasing. Home's active-creative count is de-duplicated by creative name (the
same design under two ad sets is one "creative," not two). QA'd live on GelNails:
opened the details, saw "18–35" / "35–45" with the Almond creative under each.
Deferred: instrumenting the toggle as a product signal (needs AIC-28, which
doesn't exist yet). Docs: `RULES.md`, `customer-app.md`.

### 2026-08-09 — Dashboard two-column layout (AIC-41)
Restructured Home (`/app`) into a Pisga-style **rail + main** dashboard: left rail
= the campaign at-a-glance card; main = hero (status) + KPI row + recommendation
nudge + weekly feedback + activity. The status hero no longer spans full width.
Tighter type (smaller title/hero/KPI) and lifted cards (soft shadow) via a new
`.dash*` scope in `ui.css`; collapses to one column ≤1024px. Same `getOverview`
data — no backend change. (Known follow-up for AIC-42: overview is fetched twice —
Sidebar + Home — worth deduping via context.) Doc: customer-app.md.

### 2026-08-09 — App shell: right-side sidebar nav (AIC-40)
Replaced the signed-in app's top header with a Pisga-style **right-side sidebar
shell** in AdPilot's palette (ink sidebar, orange accent). New `AppShell.tsx`
(React Router layout route) + `Sidebar.tsx`; `/app*` nested under it in `App.tsx`;
per-screen `AppHeader` dropped from Home/Recommendations/Settings. Sidebar =
brand → nav sections (ראשי / המלצות+badge / הגדרות) → user card (real name/email +
account menu with logout). Off-canvas drawer + right-side FAB below 860px. Shell
CSS = `.ap-*` in `ui.css`; icons via `lucide-react`. Chrome only — no backend/data
changes. First of the 3-part /app redesign (AIC-40/41/42). Doc: customer-app.md.

### 2026-08-09 — Admin routing + entry-screen redirects (UX)
Single admin dashboard: `/admin` now renders one `AdminDashboard` (queue +
customers + a per-customer drill-down that folds in the campaign readout);
the old `/admin/ops` and `/admin/readout` routes redirect to `/admin`
(`OpsConsole.tsx`/`Readout.tsx` removed). Fixed bare `/admin` bouncing to `/login`.
Authenticated visitors on `/login` `/signup` `/register` `/forgot` `/reset` now
redirect to the dashboard (`/app`); `/onboarding` self-redirects to `/app` once
`onboarding_status = ready`.

### 2026-08-09 — Ad-set delivery-health detection; audience rule now live (AIC-39)
Detects not-delivering / disapproved ad sets (invisible in Insights) via a
separate `effective_status` + `issues_info` read. New `meta/delivery-health.ts`
(normalize/summarize) + adapter `getDeliveryHealth`; `services/delivery-monitor.ts`
persists `managed_campaigns.delivery_ok`/`delivery_reason` (migration 014) and
raises a `campaign_not_delivering` ops item on the ok→not-ok transition (deduped),
recovering on heal. Wired into the engine tick: errored ad sets are recorded and
**excluded** from the rules' evidence (ad sets + their creatives) — which lets
**AIC-36's `pause_underperforming_audience` go live** (re-inserted into `RULES`).
Customer surface: `overview.attentionKind = "delivery"` → Home shows a distinct
plain-Hebrew "needs attention" message; campaign `status` stays `active` so the
engine keeps optimizing the healthy ad sets. New owning doc
`features/delivery-health.md`. Tests: delivery-health, delivery-monitor, generation
exclusion, overview delivery-attention. 122 unit + 45 integration green.

### 2026-08-09 — Audience-aware rules + pauseAdSet write (AIC-36)
The rules now reason at the audience (ad-set) grain. **Creative fix (live):**
`pause_weak_creative` compares creatives WITHIN an ad set (grouped by
`parent_meta_id`), so the same creative under two audiences is never pitted
against itself. **Audience rule (implemented, NOT live):**
`pause_underperforming_audience` proposes pausing the worse ad set when its CPL is
≥2× the best over a stricter evidence gate; held out of the live `RULES` array
until AIC-39 can exclude errored/not-delivering ad sets (else it would recommend
pausing an errored audience). **New execution capability:** `pause_adset` rec type
(migration 013 widens the type CHECK) + `ExecWriter.pauseAdSet` + adapter
`pauseAdSet`/`setAdSetStatus`; the executor does external-change + read-back verify
on the ad set's status. `getCampaignState` now returns `adSetStatuses`. Snapshot
store gained `adsetStats` + `adSetId` on creatives. Budget rules stay
campaign-level (CBO). Docs: `RULES.md`. Tests: `rules.adset.test.ts`,
`safe-executor.test.ts` (pause_adset happy + external-change).

### 2026-08-09 — Managed shape = 1 campaign → N ad sets (AIC-38)
Definition/anchor for the multi-ad-set arc the GelNails dogfood surfaced (a real
campaign with 2 ad sets split by age). Codified the supported shape — **1 campaign
→ N ad sets → 3–5 creatives** — in `DATA_MODEL.md`; the single-ad-set ideal is an
onboarding *recommendation*, not a system/engine/review assumption. First-campaign
review criteria (`ops-console.md` + a `campaign-review.ts` comment): a legitimate
multi-ad-set **audience split** is `approved`/managed-as-is, never
`changes_requested`/"rebuild" or `unsupported` — those are reserved for genuinely
unmanageable structures. Docs + comment only; no behavior change. Anchors AIC-36
(audience-aware engine) and AIC-37 (surfacing).

### 2026-08-09 — Per-user admin role for the ops console
Admin access is now an attribute of the account, not a shared token. New
`app_users.is_admin` (migration 012); `requireAdmin` accepts a valid customer JWT
whose user is admin (403 for a valid non-admin, 401 otherwise — fail-closed in
every environment; the old "open in non-prod" convenience is gone). `ADMIN_TOKEN`
stays as an optional break-glass. `GET /auth/me` now returns `isAdmin`; the web
`AdminGate` renders the console only for a signed-in admin account and `api()`
sends the user's JWT for `/admin/*`. sharon.mishayev@gmail.com set as the sole
admin. Owning doc: `features/ops-console.md`. Tests: `admin.test.ts` (rewritten),
`admin-auth.integration.test.ts`.

### 2026-08-09 — Scheduled recommendation evaluator — closes the engine loop (AIC-9)
The rules engine was built + tested but nothing invoked it at runtime — the
scheduler only ran ingestion, so no recommendation was ever produced. Added
`server/src/recommendations/generation.ts`: `listEligibleForGeneration` (active +
automation-on + linked + healthy-connection campaigns) and `runGenerationTick`
(reads each campaign's live daily budget, then runs the canonical
`refreshRecommendations` staleness tick to create/expire `proposed` recs).
`buildGenerationTick` is inert without a Meta token. Wired into `index.ts` to run
**after** ingestion in the same "engine" tick. Also fixed `startScheduler` to run
one tick immediately on boot (was waiting a full hour after each deploy). It only
proposes — nothing executes without a customer approval. Owning doc updated
(`features/recommendation-engine.md`). Tests: `generation.test.ts`,
`generation.integration.test.ts`. Sharon's customer was also repointed from the
mis-seeded beta to the real **GelNails | Leads | WhatsApp | 2026-08** campaign
(meta 120249004871310352, ₪10/day) so the loop dogfoods on live data.

### 2026-08-08 — Onboarding/Connect + Settings actions wired — AIC-21/24
Onboarding now renders the real `onboarding_status` (→ card + stepper) and the
signed-in name; Connect shows the real connection state and "check connection"
calls `POST /api/app/connection/recheck` (live per-asset verify with a Meta
token, else the stored health). Settings gained three real actions: budget-change
request (`POST /api/app/budget-request` → ops item, `server/src/services/customer-actions.ts`),
check-connection (shared recheck), and change-password
(`POST /api/auth/change-password` — verifies the current password, then
`updatePassword`; new `findByIdWithHash`/`updatePassword` on the user store). The
header self-fetches the name once (`getMe`) so every screen shows it. Deferred to
tickets: the campaign-review screen (AIC-32, schema-vs-design mismatch) and the
real connect config — business-portfolio ID + WhatsApp/booking links (AIC-33).
Tests: `customer-actions.integration.test.ts`, change-password cases in
`auth-service.test.ts`.

### 2026-08-08 — Recommendation approve/dismiss wired over the pipeline — AIC-23
The customer recommendation surface is live: `GET /api/app/recommendations`
(+ `/:id`), `POST …/approve`, `POST …/dismiss` (`server/src/services/customer-recommendations.ts`),
all JWT-scoped to the caller's campaign. Approve transitions proposed → approved
and hands off to the AIC-12 `SafeExecutor` (no execution logic re-implemented);
outcomes map to plain-Hebrew customer messages, and a missing Meta token yields a
503 with the rec untouched. `Recommendations.tsx` list + detail render the
deterministic `explain()` text, exact current→proposed budget, and max spend
impact; the dev type-switcher is gone. `overview.pendingRecommendations` drives
the Home badge + nudge. The app header now fetches the signed-in name once
(`getMe`) so every screen shows it (loader, never the mock). New owning doc
`features/customer-recommendations.md`; lock-in test
`customer-recommendations.integration.test.ts`.

### 2026-08-08 — Home + Settings wired to live customer data — AIC-22/24
New JWT-scoped `GET /api/app/overview` (+ `POST /api/app/lead-quality`) assembles
the caller's account → customer → connection → campaign → subscription, the
snapshot-based readout, and condensed action history — reading only the caller's
own rows. `Home.tsx` and `Settings.tsx` now render from it (real KPIs, deltas,
budget, Meta connection, billing, activity); the Home dev state-switcher is gone
and the headline `homeState` is derived server-side. Honest empty states
(`collecting`, `—`, "nothing changed yet") instead of sample numbers. New owning
doc `features/customer-overview.md`. First real customer (sharon.mishayev@…, the
Pisga dogfood account) now loads end-to-end.

### 2026-08-08 — Customer auth backend wired (email+password + JWT) — AIC-21
Built the auth backend: `app_users` table (migration 011, case-insensitive unique
email), bcrypt passwords, our own JWT sessions (`JWT_SECRET`), `/api/auth/signup|
login|me` + `requireAuth`. Wired the frontend auth screens to the real endpoints
(store JWT, redirect), added `AuthGate` on signed-in routes + logout. Google
sign-in stays deferred (AIC-30); forgot/reset still frontend-only. Verified: 4 unit
+ 5 DB/HTTP integration tests; a real `app_users` row is created end-to-end. Owning
doc: `features/customer-auth.md`.

### 2026-08-08 — AIC-1 spike PASS (live) + admin API auth + Railway live
Live-verified the whole partner-access model on Pisga's real account: a read-only
probe + a no-op budget write routed through the full AIC-12 safe-execute pipeline
both PASSED under **Standard Access** — reads and writes on a partner-owned ad
account work without Advanced Access. AIC-1 Done; AIC-12/13 live-verified; AIC-25
descoped to a scale concern. Added `GraphCampaignAdapter` (real MetaReader/
ExecWriter) + gated probe/write-test tools. Closed the admin-API hole: `requireAdmin`
now **fails closed in production** when `ADMIN_TOKEN` is unset and requires a bearer
otherwise; web console gated via `AdminGate`. Also fixed two Railway deploy blockers
(NODE_ENV skipping devDeps → `NPM_CONFIG_PRODUCTION=false`; cwd-relative web/dist →
`resolveWebDist`); the app is **live** at aicserver-production.up.railway.app serving
landing + SPA + API with Neon migrations applied.

### 2026-08-04 — Customer app screens (frontend, AdPilot design) — AIC-21/22/23/24
Built every customer-facing screen as frontend on mock data, from the AdPilot
Product Phase 1/2 design directions: auth (signup/login/forgot/reset), checkout,
onboarding (6 states + stepper), connect-Meta (4 outcomes), first-campaign review,
home dashboard (5 states + weekly lead-quality + activity), recommendations list +
detail (3 types × approve/dismiss/executed), settings & support. Added the AdPilot
design system (`web/src/ui.css`), shared components (`web/src/app/components.tsx`),
centralized copy (`strings.he.app`), and full routing (`App.tsx`). No backend yet —
screens navigate/switch via in-component state; wiring lands per ticket. Verified:
typecheck + build green; login/home/onboarding render faithfully. Owning doc:
`features/customer-app.md`. Open decision: the design's self-serve **checkout**
diverges from P0 manual billing — tracked separately.

### 2026-08-04 — Landing page (AdPilot design) — AIC-20
Replaced the placeholder `landing/index.html` with the full AdPilot marketing page
from the provided design directions: fluid responsive RTL Hebrew, brand palette
(orange/cream/ink/green/indigo) + Rubik/IBM Plex Mono, and all sections — hero
collage, dark ₪299-vs-₪1,200 comparison, how-it-works, dashboard mock, creative +
lead-quality + support, pricing, 8-question FAQ (native accordion), final CTA,
footer. CSS-only mockups (no external images). Verified: builds into
`web/dist/index.html`, renders at desktop + 375px with no horizontal overflow.
Contact CTAs + brand alignment (AdPilot vs AI Campaigner) flagged as open.

### 2026-08-03 — Ops console: manual billing + weekly lead-quality — AIC-19
Added the manual billing ledger (`updateBilling` + `conversionSummary` for
setup→subscription conversion, no payment gateway) and weekly campaign-level
lead-quality capture (`upsertLeadQuality` idempotent per campaign+week,
`listLeadQuality`, `leadQualityResponseRate`), routes under `/api/admin/*`.
Verified: 2 DB integration tests (billing + conversion; lead-quality upsert +
response rate).

### 2026-08-03 — Ops console: first-campaign review — AIC-18
Added the review workflow (`campaign_reviews` table): `submitReview` records
outcome + reviewer + timestamp + §11 checklist and moves status (approved →
active, unsupported → unmanaged, changes_requested → stays under_review). The §11
hard rule is enforced — a changes_requested campaign is not activated until
`recordCustomerDecision(true)` records explicit customer approval. Routes under
`/api/admin/campaigns/:id/review` + `/reviews/:id/customer-decision`. Verified: 4
DB integration tests (all outcomes + no-activation-without-approval).

### 2026-08-03 — Ops console: needs-attention queue — AIC-17
Added `OpsQueue` over `ops_queue_item`: one prioritized worklist across all
accounts (high severity first, then oldest; resolved fall away), a canonical
`create` (high-sev logged for the alert hook), and triage (`claim` → in_progress +
claimed_by; `resolve(note)`). Routes under `GET/POST /api/admin/ops-queue`.
Verified: DB integration (severity sort, claim, resolve).

### 2026-08-03 — Ops console: customers view — AIC-16
Added `listCustomers` / `getCustomerDetail` assembling each account's info +
subscription + connection health + campaign + agreed budget + outstanding
recommendation + open ops-item count from the real tables, at
`GET /api/admin/customers[/:id]`. Migration 010 adds ops-queue triage columns +
the `campaign_reviews` table for the rest of P0.4. Verified: DB + HTTP integration.

### 2026-08-03 — Action history surface — AIC-15
Added the per-campaign audit surface reading only from `action_history`:
`listCampaignActionHistory` / `listCustomerActionHistory` (newest-first, full PRD
§23 fields, automated-vs-human), and `condense()` — a jargon-free plain-Hebrew
projection for customer reuse. Exposed at `GET /api/admin/campaigns/:id/history`
(`?condensed=true`). Verified: DB + HTTP integration test. Completes P0.3.

### 2026-08-03 — Emergency controls + failure handling — AIC-14
Added per-account kill-switches (disable/enable automation, freeze/unfreeze
execution, mark unmanaged, pause management) as immediate DB flags (migration 009
adds `execution_frozen`), exposed at `POST /api/admin/campaigns/:id/controls`.
`ControlService.assertExecutable` is the control gate the SafeExecutor already
calls — flipping any switch halts execution on the next attempt (rec stays
approved). Failure handling (ops item + plain-Hebrew customer message + failed
action_history, never a silent success) is enforced in the AIC-12 pipeline.
Verified: 6 tests (gate per flag; kill-switch halts a batch mid-way). Telegram
alerting + ops-console surfacing land with P0.4.

### 2026-08-03 — Safe-execute pipeline — AIC-12
Added `SafeExecutor.execute`: the ordered pipeline for executing an approved
recommendation — relevance → access-health hold → emergency-control hold → claim
executing → external-change detection (cancel, never overwrite) → budget-safety
block → execute → read-back verify (mismatch = failure) → log to action_history.
Access-lost and automation-stop are holds (rec stays approved); external-change,
over-budget, write-fail, and verify-mismatch are failures with an ops item + a
plain-Hebrew customer message. A failed execution never looks succeeded.
replace_creative escalates to ops as a human task. Verified: 10 scenario tests.

### 2026-08-03 — Budget safety + idempotent write outbox — AIC-13
Added `assertWithinBudget` (agreed budget is a hard ceiling; ≤0 or over-ceiling
rejected; null/non-budget passes) and `meta_write_outbox` (migration 008): a
durable queue with a unique idempotency key per intended change (repeat enqueue =
no-op), `FOR UPDATE SKIP LOCKED` draining, backoff/retry to MAX_ATTEMPTS, and
terminal succeeded rows. Only absolute-set idempotent ops (set_daily_budget,
pause_ad) are enqueued, so a lost-response retry re-applies to the same end state.
Verified: 4 budget unit tests + 3 DB integration tests (enqueue idempotency,
exactly-once drain, backoff-then-succeed).

### 2026-08-03 — LLM explainer (plain-Hebrew, never decides) — AIC-10
Added the explainer: `explain(rec)` renders each recommendation type + a weekly
status as plain business Hebrew from a centralized copy table, injecting figures
from the structured record by code (deterministic fallback, always works).
`explainWithLlm` optionally rephrases but accepts the model's text only if every
figure survives verbatim and no Ads Manager jargon appears — the "LLM explains,
never decides" boundary, enforced structurally. Documented in `docs/RULES.md`.
Verified: 10 tests (number-fidelity, jargon-absence, fallback, rejection of a
number-changing or jargon-introducing rephrase). P0.2 recommendation engine
complete.

### 2026-08-03 — Recommendation staleness + expiry — AIC-11
Added `refreshRecommendations` as the canonical eval tick: a proposed rec is valid
iff the same gated rules still produce an equivalent rec from current evidence;
otherwise it's expired (and replaced when a different action is now warranted). An
expired rec is un-approvable by construction (AIC-8 state machine). "Material
divergence" is defined as rules-no-longer-yield-it. Verified: 4 tests
(evidence-holds → stays; diverged → expires; expired → un-approvable; replaced).

### 2026-08-03 — Deterministic recommendation rules v1 — AIC-9
Added the rules engine: `evaluateCampaign` runs five rule types
(pause_weak_creative, replace_creative, decrease_budget, increase_budget,
no_action) over per-campaign evidence, gated by named minimum-evidence thresholds
(`RULE_THRESHOLDS`) — below the gate it emits `no_action`, never a forced change.
Zero LLM involvement; output fully structured. `rule-evaluator.ts` assembles
evidence from `insight_snapshot`, persists an acting draft as `proposed` (deduped;
`no_action` not stored). Thresholds + priority documented in `docs/RULES.md`.
Verified: 14 rule fixture tests (fires when it should, does NOT on thin evidence) +
3 evaluator tests.

### 2026-08-03 — Recommendation state machine — AIC-8
Added the recommendation lifecycle as an explicit state machine
(`proposed→approved→executing→executed|failed`, plus `dismissed`/`expired`),
illegal transitions rejected before any write. `RecommendationService` wraps every
transition with the state-machine check + an optimistic store guard
(`StaleRecommendationError` on a lost race); `completeExecution` writes the PRD §23
audit row to `action_history`. `no_action` is a first-class type. pg + in-memory
stores. Verified: 9 unit + 1 DB integration test.

### 2026-08-03 — Dogfood readout (admin) — AIC-7
Added the internal readout: `buildCampaignReadout` (status + current/previous
7-day totals + per-creative rows + period deltas, read only from
`insight_snapshot`), the `/api/admin` routes behind a `requireAdmin` guard, and
the `/admin/readout` React screen (Hebrew, RTL; `formatShekel`, NULL CPL → "—").
Verified: deltaPct unit test + DB/HTTP integration test, and rendered end-to-end
against seeded Pisga snapshots on a local Postgres (status active, ₪734 spend
+8%, 18 leads +20%, CPL ₪40.78 −10%, 3-creative table). Reconciliation vs Ads
Manager gated on real ingestion.

### 2026-08-03 — Insights ingestion → insight_snapshot — AIC-6
Added the ingestion pipeline: `getInsights` on the Meta client (4 grains, creative
derived from ad rows), pure metric functions (`extractLeads` — 7d-preferred, never
double-counted; `computeCpl` — NULL at 0 leads; `normalizeRow` — spend→agorot), the
snapshot store (idempotent upsert per (campaign, grain, object, period) + period
totals), and `runIngestionTick` (per-campaign isolation: a Meta error is caught,
logged, retried next tick, never crashes the run). Wired an inert-until-token
scheduler into `index.ts`. Lead/CPL documented in `docs/METRICS.md`. Verified: 12
new unit tests + 2 DB integration tests (idempotency, period totals). Live against
Pisga gated on a real System User token + linked campaign.

### 2026-08-03 — Meta connection + access-loss detection — AIC-5
Added the Meta client abstraction (`GraphMetaClient` + `FakeMetaClient`), a Graph
error → access-health classifier, the connection store (pg + in-memory), and
`ConnectionService`: verify folds per-asset access into one health, persists
transitions, and raises a single `meta_connection_failure` ops item on loss.
`assertExecutable` throws `AccessHaltedError` unless health is `ok` — the P0.3
execution-halt safety rule. Customer-facing reconnect copy added to `strings.ts`
(plain Hebrew, no Meta jargon; `connectionMessage()` maps every non-ok state to
one prompt). Verified: 8 service + 3 classifier unit tests, and a DB integration
test proving persistence + ops item + halt end-to-end. Live-against-Pisga is
gated on a real System User token (AIC-3 operator steps) and AIC-1.

### 2026-08-03 — Meta setup runbook — AIC-3
Added `docs/META_SETUP.md`: the one-time Meta-side configuration (Business
Portfolio, app, System User + token scopes, partner-asset assignment, token
storage/rotation posture) in the accurate access framing (partner access +
System User, subject to Meta's required Marketing API tier; no customer OAuth in
P0). Added `META_*` env placeholders to `server/.env.example`. The operator steps
(mint token, assign Pisga's ad account) are executed in Meta's UI by a person and
are checklisted in the doc; the app only consumes the resulting token + asset IDs.

### 2026-08-03 — Core data model: 10 P0 entities — AIC-4
Added migrations `002`–`007` creating the ten P0 tables (customers,
subscriptions, meta_connections, ad_accounts, managed_campaigns,
insight_snapshots, recommendations, action_history, lead_quality_feedback,
ops_queue_items) with FKs, indexes, and CHECK-enum columns mirrored in
`shared/src/domain.ts`. Money is integer agorot; `action_history` is append-only;
the snapshot idempotency key is `(campaign, grain, object, period)`. Added the
Pisga dogfood seed (idempotent) and a DB integration test (self-skips without
`DATABASE_URL`). RLS deliberately not adopted (Neon has no PostgREST surface;
rationale in DATA_MODEL.md). Verified against a local Postgres: 7 migrations
apply, seed idempotent, 4/4 integration tests green.

### 2026-08-03 — Stack scaffold (server / web / shared) — AIC-2
Scaffolded the monorepo from Pisga's proven stack: npm workspaces
(`shared` / `server` / `web`), TypeScript throughout, Neon Postgres via a
numbered-migration runner (`001_init.sql` creates the `_migrations` ledger only;
the P0 entities land in AIC-4), an Express API with a root `/health` for Railway
and an `/api` mount point, a Vite + React SPA with the static landing served at
root, the `strings.ts` copy file, `railway.json`, and a GitHub `ci` workflow
(typecheck + build + unit tests). `shared/money.ts` enforces integer-agorot money.
Verified locally: typecheck, build, and 5/5 unit tests green. No DB/e2e in CI yet
(waiting on a Neon dev-branch `DATABASE_URL`).

### 2026-08-02 — Repo bootstrap: governance layer
Created the standalone AI Campaigner repo with its operating rules
([CLAUDE.md](../CLAUDE.md)), the `feature-docs` skill, and the docs system
(INDEX routing table + this changelog + the feature-doc template). Establishes the
docs-travel-with-code and ship discipline before any feature work, so every later
change inherits it. Stack scaffold (server/web/CI/Railway/Neon) lands separately.
