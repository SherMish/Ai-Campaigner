# Add content to an existing campaign (AIC-63)

**Status:** live — adding an ad or a new ad set to a campaign we already
manage. The inverse precondition of the campaign builder
([campaign-builder.md](campaign-builder.md)): this flow requires an existing,
linked, healthy campaign and never creates one.

**Source of truth:** `server/src/additions/session.ts` (context resolution +
destination decisions), `server/src/additions/add-content.ts` (orchestration),
`server/src/routes/additions.ts` (HTTP), `server/src/builder/creative-create.ts`
+ `server/src/meta/campaign-adapter.ts` (creative/ad-set Meta writes, shared
with the builder), `web/src/app/AddContent.tsx` (customer UI).

**Lock-in tests:** `server/src/additions/session.test.ts`,
`server/src/routes/additions.integration.test.ts`,
`server/src/meta/campaign-adapter.test.ts`.

---

## How it works today

`resolveAdditionContext` is the single chokepoint every additions route
passes through — it resolves the caller's existing campaign, connection, and
lead-type shape fresh from their own JWT-scoped rows, and every route 404/409s
through it rather than trusting anything client-supplied.

Two separate writes exist, with two separate destination policies:

### Adding an ad (creative) — supports two destinations (AIC-102)

`POST /additions/creative` builds one of two Meta creative shapes, chosen by
`resolveCreativeDestination` (`additions/session.ts`), which reuses the same
messaging-vs-not classification AIC-87 already derives for reading leads
(`ctx.isMessaging`) — one source of truth for "what kind of campaign is this,"
never re-derived per feature:

| The campaign's leads arrive via | Creative shape | Needs |
| --- | --- | --- |
| Messaging (`onsite_conversion.messaging_conversation_started*`) | `call_to_action: { type: WHATSAPP_MESSAGE, value: { whatsapp_number } }` | `managed_campaigns.whatsapp_destination` on file |
| Anything else (Pixel/website conversion) | `object_story_spec.link_data.link` + `call_to_action: { type: LEARN_MORE, value: { link } }` | `managed_campaigns.website_url` on file |

Missing the one piece of data the resolved shape needs refuses with a
distinct 409 reason (`missing_number` / `missing_website_url`) **before any
Meta call** — never a malformed write. Both fields are set through the AIC-101
onboarding wizard's provisioning step
([ops-console.md](ops-console.md#meta-connection-onboarding-wizard-aic-101--aic-68)),
never hand-SQL.

**An existing-post creative (`postId` given) needs neither field at all** —
`createCreativeFromExistingPost` sends only `object_story_id`; Meta reuses
whatever CTA/link the original Page post already has. This path was never
actually blocked by anything other than the pre-AIC-102 blanket refusal, which
ran before checking which creative kind was being built.

**Found live, 2026-08-16:** Pisga's own dogfood campaign
(`free_beta_signups_leads`, a Pixel/website campaign) could not add an ad to
its own campaign through its own product — the primary account failing the
primary workflow. Root cause: the guard refused ALL non-WhatsApp campaigns
unconditionally, with no alternative shape for the type Pisga itself runs.

### Adding an ad set — WhatsApp only, unchanged (still AIC-89's territory)

`POST /additions/ad-set` still gates on `whatsappWriteBlock` alone — a
narrower, unchanged function returning `not_whatsapp` / `missing_number` /
`null`. Building a new ad set for a website/Pixel campaign needs
`optimization_goal` / `destination_type` / `promoted_object` fields this flow
doesn't build yet — deliberately left for
[AIC-89](https://linear.app/pisga-app/issue/AIC-89), which will extend
`resolveDestinationShape`'s consumers rather than this guard. The two guards
are intentionally separate now (AIC-102) so fixing the creative path didn't
have to wait on the harder ad-set one, and so ad-set creation can't
accidentally inherit a shape it isn't ready to build.

### Both writes

Idempotent through `WriteOutbox` (same mechanism as the builder) keyed by a
per-item `clientKey`/`additionKey` — a resubmitted request never creates a
second Meta object. Every ad/ad set is created **PAUSED**; going live is a
separate approval (`approveAddition`, `pending_additions` table) — never
automatic.

**Ad-set targeting** (age/gender/country) reuses `AudienceFields`, the same
component and defaults the builder uses (`resolveAudienceDefault`) — one
audience-input surface, not two.

## Destination shapes, shared with the builder

`shared/src/recommended-defaults.ts`'s `DESTINATION_SHAPES` map is the single
source for every Meta field a destination needs
(`optimizationGoal`/`destinationType`/`ctaType`), consumed by both this flow
and the builder's create-writes. `resolveDestinationShape` throws for an
unrecognized destination rather than silently falling back to the WhatsApp
shape — the specific defect class (`WEBSITE_DESTINATION` added AIC-102,
`FIXED_DESTINATION`/WhatsApp original P0). `createAdSet` passes through
whatever shape resolves for ANY destination (proven by test), but this flow
never calls it for a non-WhatsApp campaign yet — resolving the shape and
using it to create an ad set are deliberately still separate, until AIC-89.
