import { standardEventForAction, isMessagingAction } from "../meta/tracking-health.js";

// Where will this campaign's leads actually arrive, stated for a consent
// screen? (AIC-89 slice.)
//
// The bug this replaces: the launch modal rendered a hardcoded "פניות אל
// וואטסאפ" label whose value was `managed_campaigns.whatsapp_destination` —
// which is '' (empty string, never null) for any campaign that isn't
// Click-to-WhatsApp. On the real connected Pixel campaign that printed a
// WhatsApp label with a blank value beside it: the screen asserted a
// destination it did not have, at the exact moment someone approves ₪600/month.
//
// Three-valued deliberately. `unknown` is not a soft default to fall back to —
// it BLOCKS launch (see LaunchBlocker), because "we can't tell you where your
// leads will go" is not a state in which anyone should be approving spend.
export type LaunchDestination =
  | { kind: "whatsapp"; whatsappNumber: string }
  // `eventKey` is a STANDARD Meta event name (COMPLETE_REGISTRATION, LEAD, …)
  // when we can derive one, else the raw action type for a custom conversion.
  // The web layer maps standard keys to plain Hebrew ("הרשמה") and falls back
  // to showing the raw string — deliberately NOT translated here: all
  // user-facing copy lives in web/src/strings.ts.
  | { kind: "website"; eventKey: string; domain: string | null }
  | { kind: "unknown" };

export interface LaunchDestinationInput {
  whatsappDestination: string;
  leadEventTypes: readonly string[];
  // The host the pixel actually fires on, when known. Confirming context, not
  // the load-bearing fact — losing it must not lose the action name.
  domain: string | null;
}

export function resolveLaunchDestination(input: LaunchDestinationInput): LaunchDestination {
  const number = (input.whatsappDestination ?? "").trim();
  const lead = input.leadEventTypes.find((t) => t.length > 0);

  // A real WhatsApp number is the destination regardless of how the lead
  // types are listed — it's the thing the customer can verify.
  if (number) return { kind: "whatsapp", whatsappNumber: number };

  if (!lead) return { kind: "unknown" };

  // Declared as a messaging campaign but no number stored: internally
  // inconsistent, and we cannot name the destination. Not a fact we have.
  if (isMessagingAction(lead)) return { kind: "unknown" };

  return {
    kind: "website",
    eventKey: standardEventForAction(lead) ?? lead,
    domain: input.domain,
  };
}
