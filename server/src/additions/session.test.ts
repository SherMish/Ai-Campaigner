import { describe, it, expect } from "vitest";
import { whatsappWriteBlock, acceptsWhatsappWrites, resolveCreativeDestination, type AdditionContext } from "./session.js";

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
    websiteUrl: null,
    isMessaging: false,
    leadEventTypes: [],
    campaignName: "Test",
    category: "beautician",
    ...overrides,
  };
}

// whatsappWriteBlock now gates ONLY the ad-SET creation path (POST
// /additions/ad-set) — building a new ad set for a website/Pixel campaign
// still needs full AIC-89 destination-shape work, so this stays exactly as
// narrow as before. The creative (add-ad) path's own decision moved to
// resolveCreativeDestination below (AIC-102).
describe("whatsappWriteBlock", () => {
  it("is null (allowed) for a real WhatsApp campaign with its number", () => {
    expect(whatsappWriteBlock(ctx({ whatsappNumber: "972501234567", isMessaging: true, leadEventTypes: WA_TYPES }))).toBeNull();
    expect(acceptsWhatsappWrites(ctx({ whatsappNumber: "972501234567", isMessaging: true, leadEventTypes: WA_TYPES }))).toBe(true);
  });

  it("a Pixel campaign is 'not_whatsapp', never allowed to create a new ad set", () => {
    expect(
      whatsappWriteBlock(ctx({ whatsappNumber: null, leadEventTypes: PIXEL_TYPES })),
    ).toBe("not_whatsapp");
  });

  it("GelNails' real shape — messaging lead type, no captured number — is 'missing_number', not 'not_whatsapp'", () => {
    expect(
      whatsappWriteBlock(ctx({ whatsappNumber: null, isMessaging: true, leadEventTypes: WA_TYPES })),
    ).toBe("missing_number");
  });

  it("empty lead_event_types (pre-AIC-87 row) with a real number is allowed", () => {
    expect(whatsappWriteBlock(ctx({ whatsappNumber: "972501234567", isMessaging: true, leadEventTypes: [] }))).toBeNull();
  });
});

// AIC-102: the creative (add-ad) path supports TWO destinations now, unlike
// ad-set creation above. Root cause of the original bug: Pisga's own
// free_beta_signups_leads campaign (the exact PIXEL_TYPES shape below)
// couldn't add content to its own campaign through its own product.
describe("resolveCreativeDestination", () => {
  it("resolves to whatsapp when messaging with a real number", () => {
    expect(
      resolveCreativeDestination(ctx({ isMessaging: true, whatsappNumber: "972501234567", leadEventTypes: WA_TYPES })),
    ).toEqual({ kind: "whatsapp", number: "972501234567" });
  });

  it("REGRESSION: a Pixel campaign WITH a website URL on file resolves to website, not blocked", () => {
    // The exact shape of the real free_beta_signups_leads campaign, once
    // website_url is set — this is what was broken: Pisga's own dogfood
    // account couldn't add an ad to its own campaign.
    expect(
      resolveCreativeDestination(ctx({ isMessaging: false, websiteUrl: "https://pisga.app/signup", leadEventTypes: PIXEL_TYPES })),
    ).toEqual({ kind: "website", url: "https://pisga.app/signup" });
  });

  it("a Pixel campaign with NO website URL on file is blocked with 'missing_website_url', not 'not_whatsapp'", () => {
    // Distinct from the old blanket refusal: the campaign type IS supported
    // now — it's just missing the one piece of data it needs, same as a
    // WhatsApp campaign missing its number.
    expect(
      resolveCreativeDestination(ctx({ isMessaging: false, websiteUrl: null, leadEventTypes: PIXEL_TYPES })),
    ).toEqual({ kind: "blocked", reason: "missing_website_url" });
  });

  it("a messaging campaign with no number is blocked with 'missing_number'", () => {
    expect(
      resolveCreativeDestination(ctx({ isMessaging: true, whatsappNumber: null, leadEventTypes: WA_TYPES })),
    ).toEqual({ kind: "blocked", reason: "missing_number" });
  });
});
