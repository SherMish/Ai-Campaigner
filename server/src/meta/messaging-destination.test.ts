import { describe, it, expect } from "vitest";
import { messagingChannel, acceptsWhatsappAdSets } from "./messaging-destination.js";

describe("messagingChannel (AIC-197)", () => {
  it("names the single-app destinations exactly", () => {
    expect(messagingChannel("CONVERSATIONS", "WHATSAPP")).toBe("whatsapp");
    expect(messagingChannel("CONVERSATIONS", "INSTAGRAM_DIRECT")).toBe("instagram");
    expect(messagingChannel("CONVERSATIONS", "MESSENGER")).toBe("messenger");
  });

  it("refuses to pick one app when Meta chooses among several", () => {
    // GelNails' own engagement campaign is this one. There is no single answer
    // to "where did the conversation happen", and inventing one is the
    // overclaim this exists to remove.
    for (const d of [
      "MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP",
      "MESSAGING_MESSENGER_WHATSAPP",
      "MESSAGING_INSTAGRAM_DIRECT_MESSENGER",
      "MESSAGING_INSTAGRAM_DIRECT_WHATSAPP",
    ]) {
      expect(messagingChannel("CONVERSATIONS", d)).toBe("multi");
    }
  });

  it("reads an UNRECOGNISED destination as multi, never as whatsapp", () => {
    // Meta keeps adding destination types. The safe reading of a new one is
    // "some messaging app" — naming a specific one to a customer is how they
    // get told to check the wrong inbox.
    expect(messagingChannel("CONVERSATIONS", "SOMETHING_NEW")).toBe("multi");
    expect(messagingChannel("CONVERSATIONS", null)).toBe("multi");
  });

  it("is not_messaging for any other optimization goal", () => {
    expect(messagingChannel("POST_ENGAGEMENT", "ON_POST")).toBe("not_messaging");
    expect(messagingChannel("OFFSITE_CONVERSIONS", "WEBSITE")).toBe("not_messaging");
    expect(messagingChannel(null, "WHATSAPP")).toBe("not_messaging");
  });
});

describe("acceptsWhatsappAdSets (AIC-197)", () => {
  it("allows a WhatsApp ad set only into an all-WhatsApp campaign", () => {
    expect(acceptsWhatsappAdSets(["whatsapp"])).toBe(true);
    expect(acceptsWhatsappAdSets(["whatsapp", "whatsapp"])).toBe(true);
  });

  it("refuses one into a multi-app or Instagram-Direct campaign", () => {
    // A WhatsApp phone number id inside an Instagram-Direct campaign asks Meta
    // for something that campaign cannot do.
    expect(acceptsWhatsappAdSets(["multi"])).toBe(false);
    expect(acceptsWhatsappAdSets(["instagram"])).toBe(false);
    expect(acceptsWhatsappAdSets(["whatsapp", "instagram"])).toBe(false);
  });

  it("refuses when there is no messaging ad set to judge", () => {
    expect(acceptsWhatsappAdSets([])).toBe(false);
    expect(acceptsWhatsappAdSets(["not_messaging"])).toBe(false);
  });
});
