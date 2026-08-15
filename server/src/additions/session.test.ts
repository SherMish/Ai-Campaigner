import { describe, it, expect } from "vitest";
import { whatsappWriteBlock, acceptsWhatsappWrites, type AdditionContext } from "./session.js";

const WA_TYPES = ["onsite_conversion.messaging_conversation_started_7d", "onsite_conversion.messaging_conversation_started"];
const PIXEL_TYPES = ["offsite_conversion.fb_pixel_complete_registration"];

function ctx(overrides: Partial<AdditionContext>): AdditionContext {
  return {
    customerId: "c1",
    localCampaignId: "camp1",
    metaCampaignId: "meta1",
    metaAdAccountId: "act_1",
    pageId: "page1",
    whatsappNumber: null,
    leadEventTypes: [],
    campaignName: "Test",
    category: "beautician",
    ...overrides,
  };
}

// AIC-89 sub-fix: the additions flow (creative + ad-set writes) hardcodes
// WhatsApp-shaped Meta objects. Before this, that reached Meta unconditionally
// — an empty `whatsapp_number` on a Pixel campaign, or a CONVERSATIONS ad set
// inside an OFFSITE_CONVERSIONS campaign. This is the pure decision the route
// guard is built on.
describe("whatsappWriteBlock", () => {
  it("is null (allowed) for a real WhatsApp campaign with its number", () => {
    expect(whatsappWriteBlock(ctx({ whatsappNumber: "972501234567", leadEventTypes: WA_TYPES }))).toBeNull();
    expect(acceptsWhatsappWrites(ctx({ whatsappNumber: "972501234567", leadEventTypes: WA_TYPES }))).toBe(true);
  });

  it("REGRESSION: a Pixel campaign is 'not_whatsapp', never allowed", () => {
    // The exact shape of the real free_beta_signups_leads campaign.
    expect(
      whatsappWriteBlock(ctx({ whatsappNumber: null, leadEventTypes: PIXEL_TYPES })),
    ).toBe("not_whatsapp");
  });

  it("REGRESSION: GelNails' real shape — messaging lead type, no captured number — is 'missing_number', not 'not_whatsapp'", () => {
    // Connected from outside the builder, so whatsapp_destination was never
    // written. Telling this customer "your leads don't come from WhatsApp"
    // would be false.
    expect(
      whatsappWriteBlock(ctx({ whatsappNumber: null, leadEventTypes: WA_TYPES })),
    ).toBe("missing_number");
  });

  it("empty lead_event_types (pre-AIC-87 row) with a real number is allowed", () => {
    // Every row defaulted to the WhatsApp pair before AIC-87; a hand-edited
    // row with an empty array but a real number should still be judged as
    // WhatsApp-capable rather than blocked on a technicality.
    expect(whatsappWriteBlock(ctx({ whatsappNumber: "972501234567", leadEventTypes: [] }))).toBeNull();
  });
});
