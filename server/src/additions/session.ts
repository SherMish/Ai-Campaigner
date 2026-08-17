import type pg from "pg";
import { GraphCampaignAdapter } from "../meta/campaign-adapter.js";
import type { BuilderWriter } from "../builder/types.js";
import type { CreativeWriter } from "../builder/creative-types.js";
import type { AdditionWriter } from "./types.js";
import type { DeliveryReader } from "../meta/delivery-health.js";
import type { AdMediaReader } from "../meta/ad-media.js";
import { isMessagingAction, deriveIsMessaging } from "../meta/tracking-health.js";
import { classifyConnectionReadiness, type ConnectionReadinessReason } from "../services/connection-readiness.js";
import { resolveCreativeDestination, type CreativeDestination, type CreativeBlockReason } from "../meta/destination.js";
import { FIXED_DESTINATION, WEBSITE_DESTINATION, missingRequiredFields, type CampaignRequiredField } from "@aic/shared";

// Re-exported for existing consumers (routes/additions.ts, session.test.ts) —
// the classification itself now lives in meta/destination.ts (AIC-89), shared
// with the builder's create-path, since AdditionContext already structurally
// satisfies DestinationInputs (isMessaging/whatsappNumber/websiteUrl).
export { resolveCreativeDestination, type CreativeDestination, type CreativeBlockReason };

// The inverse precondition of builder/session.ts's resolveBuilderContext:
// that one requires NO managed campaign (first-time build only); this one
// requires an EXISTING, linked campaign with a healthy connection — the
// normal P0 state for a customer we already manage.
export interface AdditionContext {
  customerId: string;
  localCampaignId: string;
  metaCampaignId: string;
  metaAdAccountId: string; // "act_..." — what every real Meta API call needs
  pageId: string;
  // NULL when this campaign's leads do NOT arrive over WhatsApp — the type is
  // deliberately nullable so every consumer has to decide what to do about it
  // rather than silently passing '' into a real Meta write.
  //
  // The bug this prevents: `whatsapp_destination` is `NOT NULL DEFAULT ''`, so
  // a Pixel campaign carried an EMPTY STRING through to
  // `call_to_action: { type: "WHATSAPP_MESSAGE", value: { whatsapp_number: "" } }`
  // — `validateCreativeCopy` checks media/headline/text but never the number,
  // so the empty value reached Meta.
  whatsappNumber: string | null;
  // AIC-102: the website/Pixel counterpart to whatsappNumber — non-null only
  // when this campaign's leads do NOT arrive over WhatsApp AND a destination
  // URL is on file (managed_campaigns.website_url). Same nullable-on-purpose
  // discipline as whatsappNumber: every consumer must decide what to do about
  // a missing one rather than building a creative with an empty link.
  websiteUrl: string | null;
  // The messaging-vs-not classification itself, computed once here so
  // resolveCreativeDestination doesn't re-derive it from leadEventTypes a
  // second time (AIC-102's own "share AIC-87's resolution, don't duplicate").
  isMessaging: boolean;
  // What this campaign actually counts as a lead (AIC-87). Present so callers
  // can reason about destination without re-querying.
  leadEventTypes: string[];
  campaignName: string;
  category: string; // for the add-ad-set audience step's business-type prefill, same as the builder
  // AIC-103: which of THIS destination's required fields (shared/recommended-
  // defaults.ts's CAMPAIGN_TYPE_REQUIRED_FIELDS) are missing — empty when the
  // campaign is fully configured. Deliberately does NOT gate resolveAdditionContext
  // itself (unlike the four connection-readiness reasons): an existing-post
  // creative needs none of these fields at all (AIC-102), so blocking the
  // whole context on a missing website_url would silently regress that fix —
  // the customer couldn't even browse their own Page posts. Consumers that
  // need destination data (the new-content upload path, ad-set creation)
  // check this themselves; GET /context surfaces it so the customer learns
  // about it on load rather than after filling out a form (the actual bug).
  missingConfigFields: CampaignRequiredField[];
}

// Why this campaign can't accept the WhatsApp-shaped writes the additions flow
// currently emits (a `WHATSAPP_MESSAGE` CTA and `CONVERSATIONS`/`WHATSAPP` ad
// sets). `null` = it can.
//
// TWO distinct causes, deliberately not collapsed — they are different facts
// and need different copy. Found by checking the guard against the real
// accounts: GelNails IS a Click-to-WhatsApp campaign, but it was connected
// from outside our builder so we never captured its number
// (`whatsapp_destination` is `''`). Telling that customer "your leads don't
// arrive over WhatsApp" would be simply untrue — the honest statement is that
// WE are missing the number.
export type WhatsappWriteBlock =
  // Leads arrive some other way (e.g. Pixel conversions). Not supported yet.
  | "not_whatsapp"
  // Genuinely a WhatsApp campaign, but we don't hold the number, so any ad we
  // built would carry an empty `whatsapp_number`. Fixable by capturing it.
  | "missing_number";

export function whatsappWriteBlock(ctx: AdditionContext): WhatsappWriteBlock | null {
  if (ctx.whatsappNumber) return null;
  const messaging = ctx.leadEventTypes.length === 0 || ctx.leadEventTypes.some(isMessagingAction);
  return messaging ? "missing_number" : "not_whatsapp";
}

export function acceptsWhatsappWrites(ctx: AdditionContext): boolean {
  return whatsappWriteBlock(ctx) === null;
}

// (resolveCreativeDestination now lives in meta/destination.ts, re-exported
// above — AdditionContext already satisfies its DestinationInputs shape.)
// Deliberately separate from whatsappWriteBlock above: that guard is
// unchanged and still gates AD-SET creation (`POST /ad-set`), which genuinely
// still only knows how to build a WhatsApp-shaped ad set (AIC-89's territory).
// resolveCreativeDestination governs `POST /creative`'s upload path only,
// which supports two shapes. The existing-post creative path needs neither
// branch at all — createCreativeFromExistingPost carries no destination
// fields; Meta reuses whatever CTA/link the original Page post already has.

type AdditionContextRow = {
  customer_id: string | null;
  category: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  meta_campaign_id: string | null;
  whatsapp_destination: string | null;
  website_url: string | null;
  tracking_pixel_id: string | null;
  lead_event_types: string[] | null;
  access_health: string | null;
  meta_ad_account_id: string | null;
  page_id: string | null;
};

async function fetchAdditionContextRow(pool: pg.Pool, userId: string): Promise<AdditionContextRow | undefined> {
  const { rows } = await pool.query<AdditionContextRow>(
    `SELECT u.customer_id, c.category, mc.id AS campaign_id, mc.name AS campaign_name,
            mc.meta_campaign_id, mc.whatsapp_destination, mc.website_url, mc.tracking_pixel_id, mc.lead_event_types,
            conn.access_health, aa.meta_ad_account_id, conn.page_id
     FROM app_users u
     LEFT JOIN customers c ON c.id = u.customer_id
     LEFT JOIN managed_campaigns mc ON mc.customer_id = u.customer_id
     LEFT JOIN meta_connections conn ON conn.customer_id = u.customer_id
     LEFT JOIN ad_accounts aa ON aa.connection_id = conn.id
     WHERE u.id = $1
     LIMIT 1`,
    [userId],
  );
  return rows[0];
}

// Deliberately still just the original four connection checks — see
// AdditionContext.missingConfigFields above for why AIC-103's per-type
// completeness check is NOT folded in here: doing so would gate every
// additions route (including the existing-post path, which needs none of
// this) on a piece of config only the upload path actually needs.
function readinessRow(r: AdditionContextRow | undefined) {
  return {
    campaignId: r?.campaign_id ?? null,
    metaCampaignId: r?.meta_campaign_id ?? null,
    accessHealth: r?.access_health ?? null,
    metaAdAccountId: r?.meta_ad_account_id ?? null,
    pageId: r?.page_id ?? null,
  };
}

function toContext(r: AdditionContextRow): AdditionContext {
  const leadEventTypes = r.lead_event_types ?? [];
  const number = (r.whatsapp_destination ?? "").trim();
  const url = (r.website_url ?? "").trim();
  const isMessaging = deriveIsMessaging(leadEventTypes, r.whatsapp_destination);
  return {
    customerId: r.customer_id!,
    localCampaignId: r.campaign_id!,
    metaCampaignId: r.meta_campaign_id!,
    metaAdAccountId: r.meta_ad_account_id!,
    pageId: r.page_id!,
    whatsappNumber: isMessaging && number ? number : null,
    websiteUrl: !isMessaging && url ? url : null,
    isMessaging,
    leadEventTypes,
    campaignName: r.campaign_name ?? "",
    category: r.category ?? "",
    missingConfigFields: missingRequiredFields(isMessaging ? FIXED_DESTINATION : WEBSITE_DESTINATION, {
      whatsappDestination: r.whatsapp_destination ?? null,
      websiteUrl: r.website_url ?? null,
      trackingPixelId: r.tracking_pixel_id ?? null,
      leadEventTypes,
    }),
  };
}

export async function resolveAdditionContext(pool: pg.Pool, userId: string): Promise<AdditionContext | null> {
  const r = await fetchAdditionContextRow(pool, userId);
  const reason = classifyConnectionReadiness(readinessRow(r));
  return reason ? null : toContext(r!);
}

// Why additions aren't available yet — the customer-facing counterpart to
// resolveAdditionContext's blunt null. A real live bug: a customer with an
// active, spending campaign got "you don't have a campaign yet — go build
// one", which is both false and a dead end (the builder itself refuses to
// run when a campaign already exists). resolveAdditionContext collapses SIX
// different preconditions into one null because every write route just
// needs a yes/no; this function exists for the ONE place (GET /context) that
// has to tell the customer the truth about which one failed. The actual
// classification is shared with the admin console (connection-readiness.ts)
// so the two surfaces can't drift onto different definitions of "ready" —
// see that file for what each reason means. (No separate "no customer_id"
// check needed here: a user with no customer_id can never join to a
// campaign_id either, so the shared classifier's no_campaign already
// covers it.)
export type AdditionUnavailableReason = ConnectionReadinessReason;

export async function resolveAdditionAvailability(
  pool: pg.Pool,
  userId: string,
): Promise<{ ctx: AdditionContext } | { ctx: null; reason: AdditionUnavailableReason }> {
  const r = await fetchAdditionContextRow(pool, userId);
  const reason = classifyConnectionReadiness(readinessRow(r));
  if (reason) return { ctx: null, reason };
  return { ctx: toContext(r!) };
}

// Same token-gated factory pattern as buildBuilderWriter/buildLaunchWriter.
// Also a DeliveryReader (AIC-71 follow-up): the manual-controls routes reuse
// this same adapter instance to recompute delivery state right after a write,
// instead of waiting for the next hourly engine tick.
export function buildAdditionWriter(): (BuilderWriter & CreativeWriter & AdditionWriter & DeliveryReader & AdMediaReader) | null {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!token) return null;
  const ver = process.env.META_GRAPH_VERSION || "v21.0";
  return new GraphCampaignAdapter(token, ver);
}
