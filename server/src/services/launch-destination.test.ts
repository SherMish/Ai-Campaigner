import { describe, it, expect } from "vitest";
import { resolveLaunchDestination } from "./launch-destination.js";

// The launch modal is a CONSENT surface — the customer authorises real spend
// based on what it says. Before this, it rendered a hardcoded "leads to
// WhatsApp" label whose value was `whatsapp_destination`, which is '' (empty
// string, not null) for any campaign that isn't Click-to-WhatsApp. On the real
// connected Pixel campaign that printed a WhatsApp label with a BLANK value:
// asserting a destination we don't have, at the exact moment someone approves
// ₪600/month.

const WA_7D = "onsite_conversion.messaging_conversation_started_7d";
const WA = "onsite_conversion.messaging_conversation_started";
const PIXEL_REG = "offsite_conversion.fb_pixel_complete_registration";

describe("resolveLaunchDestination", () => {
  it("a Click-to-WhatsApp campaign keeps its number", () => {
    expect(
      resolveLaunchDestination({
        whatsappDestination: "+972501234567",
        leadEventTypes: [WA_7D, WA],
        domain: null,
      }),
    ).toEqual({ kind: "whatsapp", whatsappNumber: "+972501234567" });
  });

  it("REGRESSION: a Pixel campaign is NOT reported as WhatsApp", () => {
    // The exact shape of the real free_beta_signups_leads campaign.
    const d = resolveLaunchDestination({
      whatsappDestination: "",
      leadEventTypes: [PIXEL_REG],
      domain: "pisga.app",
    });
    expect(d.kind).toBe("website");
    expect(d).toEqual({ kind: "website", eventKey: "COMPLETE_REGISTRATION", domain: "pisga.app" });
  });

  it("degrades honestly when the domain can't be determined", () => {
    // The action is the part that costs money if wrong; the domain is
    // confirming context. Losing the domain must not lose the action.
    expect(
      resolveLaunchDestination({ whatsappDestination: "", leadEventTypes: [PIXEL_REG], domain: null }),
    ).toEqual({ kind: "website", eventKey: "COMPLETE_REGISTRATION", domain: null });
  });

  it("a custom conversion keeps its raw event name rather than inventing one", () => {
    const d = resolveLaunchDestination({
      whatsappDestination: "",
      leadEventTypes: ["offsite_conversion.custom.123456"],
      domain: "shop.example.com",
    });
    expect(d).toEqual({
      kind: "website",
      eventKey: "offsite_conversion.custom.123456",
      domain: "shop.example.com",
    });
  });

  it("is `unknown` — never a blank WhatsApp row — when nothing is declared", () => {
    expect(
      resolveLaunchDestination({ whatsappDestination: "", leadEventTypes: [], domain: null }),
    ).toEqual({ kind: "unknown" });
  });

  it("is `unknown` when a WhatsApp lead type is declared but no number is set", () => {
    // Internally inconsistent: we'd count messaging conversations, but we
    // cannot tell the customer which number they arrive at. Not a fact we have.
    expect(
      resolveLaunchDestination({ whatsappDestination: "", leadEventTypes: [WA_7D, WA], domain: null }),
    ).toEqual({ kind: "unknown" });
  });

  it("treats a whitespace-only number as missing, not as a destination", () => {
    expect(
      resolveLaunchDestination({ whatsappDestination: "   ", leadEventTypes: [WA], domain: null }),
    ).toEqual({ kind: "unknown" });
  });
});
