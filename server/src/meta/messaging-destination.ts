// AIC-197 — WHICH messaging app a click-to-message ad set actually opens.
//
// `detectDestination` read only `optimization_goal`, so every one of Meta's
// seven messaging destinations collapsed into "whatsapp". An ad set that opens
// Instagram Direct and one that opens WhatsApp were indistinguishable to us,
// and a campaign was stored with `whatsapp_destination` and its results
// labelled "פניות" — implying a channel we had never checked.
//
// Meta reports the same `messaging_conversation_started` action for all of
// them, so the COUNT was never wrong. What was wrong is the claim about where
// the conversation happened.
//
// The distinction is not cosmetic. Writing a WhatsApp-shaped ad set
// (promoted_object carrying a phone number id) into an Instagram-Direct
// campaign asks Meta for something that campaign cannot do, and telling a
// customer to check WhatsApp for a message that arrived in Instagram Direct
// costs them the lead.

/** Meta's messaging destination_type values, and what they actually open. */
export type MessagingChannel =
  | "whatsapp"        // WhatsApp only
  | "instagram"       // Instagram Direct only
  | "messenger"       // Messenger only
  | "multi"           // Meta picks among several apps
  | "not_messaging";  // not a click-to-message ad set at all

const SINGLE: Record<string, MessagingChannel> = {
  WHATSAPP: "whatsapp",
  INSTAGRAM_DIRECT: "instagram",
  MESSENGER: "messenger",
};

// Meta chooses per person among these. There is no single answer to "where did
// this land", and inventing one is exactly the overclaim this module removes.
const MULTI = new Set([
  "MESSAGING_MESSENGER_WHATSAPP",
  "MESSAGING_INSTAGRAM_DIRECT_MESSENGER",
  "MESSAGING_INSTAGRAM_DIRECT_WHATSAPP",
  "MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP",
]);

/**
 * Which app this ad set's messages open in.
 *
 * An UNKNOWN destination on a CONVERSATIONS ad set is reported as "multi"
 * rather than "whatsapp": Meta keeps adding destination types, and the safe
 * reading of an unrecognised one is "some messaging app", never a specific
 * one we would then name to a customer.
 */
export function messagingChannel(
  optimizationGoal: string | null | undefined,
  destinationType: string | null | undefined,
): MessagingChannel {
  if ((optimizationGoal ?? "").toUpperCase() !== "CONVERSATIONS") return "not_messaging";
  const d = (destinationType ?? "").toUpperCase();
  if (SINGLE[d]) return SINGLE[d];
  if (MULTI.has(d)) return "multi";
  return "multi";
}

/**
 * Can we write a WhatsApp-specific ad set into this campaign?
 *
 * Only when every messaging ad set is WhatsApp-only. A multi-app or
 * Instagram-Direct campaign takes a Page-backed messaging ad set instead —
 * asking Meta for a WhatsApp phone number id inside an Instagram-Direct
 * campaign is asking for something it cannot do.
 */
export function acceptsWhatsappAdSets(channels: readonly MessagingChannel[]): boolean {
  const messaging = channels.filter((c) => c !== "not_messaging");
  return messaging.length > 0 && messaging.every((c) => c === "whatsapp");
}
