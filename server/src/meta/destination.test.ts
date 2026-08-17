import { describe, expect, it } from "vitest";
import { resolveCreativeDestination } from "./destination.js";

describe("resolveCreativeDestination", () => {
  it("resolves to whatsapp when messaging with a real number", () => {
    expect(
      resolveCreativeDestination({ isMessaging: true, whatsappNumber: "972501234567", websiteUrl: null }),
    ).toEqual({ kind: "whatsapp", number: "972501234567" });
  });

  it("resolves to website when non-messaging with a real URL on file", () => {
    expect(
      resolveCreativeDestination({ isMessaging: false, whatsappNumber: null, websiteUrl: "https://pisga.app/signup" }),
    ).toEqual({ kind: "website", url: "https://pisga.app/signup" });
  });

  it("blocks with missing_number when messaging but no number", () => {
    expect(
      resolveCreativeDestination({ isMessaging: true, whatsappNumber: null, websiteUrl: null }),
    ).toEqual({ kind: "blocked", reason: "missing_number" });
  });

  it("blocks with missing_website_url when non-messaging but no URL", () => {
    expect(
      resolveCreativeDestination({ isMessaging: false, whatsappNumber: null, websiteUrl: null }),
    ).toEqual({ kind: "blocked", reason: "missing_website_url" });
  });
});
