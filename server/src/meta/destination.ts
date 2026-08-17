// The creative-destination decision (AIC-102, generalized for AIC-89) — what
// Meta creative/ad-set shape a campaign's lead type implies, and whether the
// one piece of data that shape needs (a WhatsApp number, or a website URL) is
// on file. Originally lived only in additions/session.ts for the "add
// content to an existing campaign" flow; pulled out here so the builder's
// "create a brand-new campaign" flow (AIC-89) can share the exact same
// classification rather than re-deriving it a second time — one source of
// truth for "what kind of campaign is this," per the AIC-102 doc note.

export interface DestinationInputs {
  isMessaging: boolean;
  whatsappNumber: string | null;
  websiteUrl: string | null;
}

export type CreativeDestination =
  | { kind: "whatsapp"; number: string }
  | { kind: "website"; url: string };

export type CreativeBlockReason = "missing_number" | "missing_website_url";

export function resolveCreativeDestination(
  ctx: DestinationInputs,
): CreativeDestination | { kind: "blocked"; reason: CreativeBlockReason } {
  if (ctx.isMessaging) {
    return ctx.whatsappNumber ? { kind: "whatsapp", number: ctx.whatsappNumber } : { kind: "blocked", reason: "missing_number" };
  }
  return ctx.websiteUrl ? { kind: "website", url: ctx.websiteUrl } : { kind: "blocked", reason: "missing_website_url" };
}
