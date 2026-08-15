// AIC-88: does this campaign's DECLARED lead definition actually match what
// Meta is configured to optimize for?
//
// The failure this exists to catch, found live: a campaign whose ad sets
// optimize for OFFSITE_CONVERSIONS/COMPLETE_REGISTRATION reports its
// conversions as `offsite_conversion.fb_pixel_complete_registration`, but was
// connected with the default Click-to-WhatsApp lead definition. Every real
// conversion then counts as ZERO — a working campaign rendered as a
// catastrophically failing one, and the engine would confidently reason over
// (and eventually recommend cutting) a campaign that was fine.
//
// WHY A CONFIG COMPARISON, NOT A STATISTICAL TEST. The obvious design —
// "spent real money, recorded zero leads, and the pixel hasn't fired" — was
// designed and then discarded after review, for three reasons worth writing
// down so it isn't re-proposed:
//   1. `{pixel}/stats` is PIXEL-scoped, not campaign-scoped. For a landing
//      page whose only traffic is this campaign, "the event never fired" is
//      logically identical to "nobody converted yet" — it adds no
//      discriminating power in exactly the case it was meant to resolve. And
//      once the pixel has ANY other traffic (organic, a second campaign, a QA
//      test), the event fires and a genuinely broken campaign goes unnoticed.
//   2. Attribution lag makes "spent with zero leads" normal for a young
//      campaign, so any spend threshold either cries wolf or arrives late.
//   3. A spend threshold near the existing evidence gates is unreachable on a
//      small budget anyway (₪20/day × 7 complete days = ₪140 < ₪150), so it
//      would never fire on the very account that motivated the ticket.
//
// The ad set's own configuration DETERMINISTICALLY implies which Insights
// action type its conversions arrive as. Comparing that against the campaign's
// stored `lead_event_types` is exact: zero false positives, no spend required,
// no attribution lag, and it works on a PAUSED campaign — i.e. it can catch
// the misconfiguration BEFORE a shekel is spent, which the statistical version
// structurally could not.
//
// The trade-off, stated honestly: this catches a WRONG or MISSING declared
// lead type. It does NOT catch a correctly-declared type whose pixel silently
// stopped firing. That's a real gap, deliberately left for a follow-up rather
// than papered over with a low-precision signal — see docs/features/tracking-health.md.

// One ad set's tracking-relevant Meta configuration.
export interface AdSetTrackingConfig {
  adSetId: string;
  name?: string | null;
  optimizationGoal: string | null; // e.g. OFFSITE_CONVERSIONS, CONVERSATIONS
  destinationType: string | null; // e.g. WHATSAPP, UNDEFINED
  pixelId: string | null; // promoted_object.pixel_id
  customEventType: string | null; // promoted_object.custom_event_type
}

// The narrow reader the adapter implements (mirrors DeliveryReader).
export interface TrackingReader {
  getAdSetTracking(metaCampaignId: string): Promise<AdSetTrackingConfig[]>;
}

// THREE-valued on purpose. `unknown` is not a soft `ok`: it means "we could
// not determine this", and it must never overwrite a real prior verdict or
// re-arm an alert. Collapsing it into `ok` is a live bug in the shape this
// module otherwise mirrors (delivery-health writes its flag unconditionally),
// so `recordCampaignTracking` deliberately does NOT persist `tracking_ok` on
// `unknown`.
export type TrackingState = "ok" | "broken" | "unknown";

export interface TrackingSummary {
  state: TrackingState;
  reason: string | null;
  detail: Record<string, unknown>;
}

// Meta's `custom_event_type` → the Insights `action_type` its conversions are
// reported under. Only standard events have a derivable name; a CUSTOM event
// (a custom conversion, `offsite_conversion.custom.<id>`) has no stable
// mapping from this config alone, so it resolves to null → `unknown`, never
// to "broken". Guessing there would flag every custom-conversion campaign.
const PIXEL_EVENT_ACTION: Record<string, string> = {
  COMPLETE_REGISTRATION: "offsite_conversion.fb_pixel_complete_registration",
  LEAD: "offsite_conversion.fb_pixel_lead",
  PURCHASE: "offsite_conversion.fb_pixel_purchase",
  ADD_TO_CART: "offsite_conversion.fb_pixel_add_to_cart",
  INITIATED_CHECKOUT: "offsite_conversion.fb_pixel_initiate_checkout",
  CONTENT_VIEW: "offsite_conversion.fb_pixel_view_content",
  SUBMIT_APPLICATION: "offsite_conversion.fb_pixel_submit_application",
  CONTACT: "offsite_conversion.fb_pixel_contact",
  SCHEDULE: "offsite_conversion.fb_pixel_schedule",
  SUBSCRIBE: "offsite_conversion.fb_pixel_subscribe",
  START_TRIAL: "offsite_conversion.fb_pixel_start_trial",
};

// The messaging-conversation event, the P0 Click-to-WhatsApp lead. The base
// type — `extractLeads`' priority list also accepts the _7d variant, and
// membership of EITHER counts as a match (see `matches` below).
export const MESSAGING_ACTION = "onsite_conversion.messaging_conversation_started";

// The inverse of PIXEL_EVENT_ACTION: given an Insights action type we COUNT,
// which standard Meta event is it? Exported so the launch gate can name the
// lead action for the customer without a second, drifting copy of this table
// (`services/launch-destination.ts`). Returns null for a custom conversion —
// there is no standard name to give, and inventing one would be a guess shown
// on a consent screen.
export function standardEventForAction(actionType: string): string | null {
  for (const [event, action] of Object.entries(PIXEL_EVENT_ACTION)) {
    if (action === actionType) return event;
  }
  return null;
}

// Is this action type the Click-to-WhatsApp messaging lead (either attribution
// variant)? Shared with the launch gate so "is this a WhatsApp campaign" has
// one definition.
export function isMessagingAction(actionType: string): boolean {
  return actionType === MESSAGING_ACTION || actionType === `${MESSAGING_ACTION}_7d`;
}

// What Insights action type will this ad set's conversions arrive as?
// Returns null when the configuration doesn't determine one — an ad set that
// isn't optimizing for a lead at all, or a custom conversion. Null means
// "not judgeable", never "broken".
export function impliedLeadActionType(cfg: AdSetTrackingConfig): string | null {
  const goal = (cfg.optimizationGoal ?? "").toUpperCase();

  if (goal === "OFFSITE_CONVERSIONS") {
    const ev = (cfg.customEventType ?? "").toUpperCase();
    return PIXEL_EVENT_ACTION[ev] ?? null; // CUSTOM / unrecognized → not judgeable
  }

  // Click-to-WhatsApp / Messenger: Meta reports a started conversation.
  if (goal === "CONVERSATIONS") return MESSAGING_ACTION;

  // Anything else (LINK_CLICKS, REACH, LANDING_PAGE_VIEWS, Instant Forms,
  // …) either doesn't produce a lead or doesn't map from this config alone.
  return null;
}

// Does the campaign's declared priority list actually contain this action
// type? Accepts the `_7d` attribution variant as the same event — the
// WhatsApp default lists both, and either one makes the conversions countable.
function matches(implied: string, leadEventTypes: readonly string[]): boolean {
  return leadEventTypes.some((t) => t === implied || t === `${implied}_7d`);
}

// Compare what Meta is configured to optimize for against what we declared we
// count. Pure — no I/O, no DB, no clock.
export function summarizeTracking(
  configs: AdSetTrackingConfig[],
  leadEventTypes: readonly string[],
): TrackingSummary {
  if (configs.length === 0) {
    return { state: "unknown", reason: "no ad sets readable", detail: {} };
  }

  const judged = configs
    .map((c) => ({ cfg: c, implied: impliedLeadActionType(c) }))
    .filter((x): x is { cfg: AdSetTrackingConfig; implied: string } => x.implied !== null);

  if (judged.length === 0) {
    return {
      state: "unknown",
      reason: "no ad set's optimization goal implies a countable lead event",
      detail: {
        adSetGoals: configs.map((c) => ({
          adSetId: c.adSetId,
          optimizationGoal: c.optimizationGoal,
          customEventType: c.customEventType,
        })),
      },
    };
  }

  const mismatched = judged.filter((x) => !matches(x.implied, leadEventTypes));
  if (mismatched.length === 0) {
    return {
      state: "ok",
      reason: null,
      detail: { impliedLeadActionTypes: [...new Set(judged.map((x) => x.implied))] },
    };
  }

  // At least one ad set's real conversions will not be counted at all.
  return {
    state: "broken",
    reason:
      `ad set(s) optimize for ${[...new Set(mismatched.map((x) => x.implied))].join(", ")}, ` +
      `which the campaign's lead definition does not count`,
    detail: {
      declaredLeadEventTypes: [...leadEventTypes],
      mismatchedAdSets: mismatched.map((x) => ({
        adSetId: x.cfg.adSetId,
        name: x.cfg.name ?? null,
        optimizationGoal: x.cfg.optimizationGoal,
        customEventType: x.cfg.customEventType,
        impliedLeadActionType: x.implied,
      })),
    },
  };
}
