import { describe, it, expect } from "vitest";
import { summarizeCta, type AdCreativeDestination } from "./cta-health.js";

function ad(over: Partial<AdCreativeDestination> = {}): AdCreativeDestination {
  return {
    adId: "ad_1", adName: "מודעה 1", adSetId: "as_1",
    destinationType: "WHATSAPP", ctaType: "WHATSAPP_MESSAGE",
    whatsappNumber: "972526964069", link: null,
    ...over,
  };
}

describe("CTA health (AIC-128)", () => {
  // THE LIVE BUG, exactly as it appeared: ad set promises WHATSAPP, Meta
  // reports a CTA *type* it inferred, and the creative carries no number — so
  // the button opens nothing and renders as a generic "See more".
  it("flags a WhatsApp ad whose creative has a CTA type but no number", () => {
    const s = summarizeCta([ad({ whatsappNumber: null })]);
    expect(s.state).toBe("broken");
    expect(s.brokenAdIds).toEqual(["ad_1"]);
    expect(s.reason).toMatch(/missing_whatsapp_number/);
  });

  it("passes a WhatsApp ad that has the number", () => {
    expect(summarizeCta([ad()]).state).toBe("ok");
  });

  it("treats an empty/whitespace number as missing, not present", () => {
    expect(summarizeCta([ad({ whatsappNumber: "   " })]).state).toBe("broken");
  });

  it("distinguishes no CTA at all from a CTA with no destination", () => {
    expect(summarizeCta([ad({ whatsappNumber: null, ctaType: null })]).detail.broken).toMatchObject([
      { reason: "missing_cta" },
    ]);
    expect(summarizeCta([ad({ whatsappNumber: null })]).detail.broken).toMatchObject([
      { reason: "missing_whatsapp_number" },
    ]);
  });

  it("applies the same rule to a website destination via its link", () => {
    const base = { destinationType: "WEBSITE", ctaType: "LEARN_MORE", whatsappNumber: null };
    expect(summarizeCta([ad({ ...base, link: null })]).state).toBe("broken");
    expect(summarizeCta([ad({ ...base, link: "https://x.co" })]).state).toBe("ok");
  });

  // A number on a website ad (or a link on a WhatsApp ad) is leftover data,
  // not a working button — judging on the ad set's promise, not on whatever
  // happens to be populated, is the whole point.
  it("judges against the ad set's destination, not whichever value is present", () => {
    expect(summarizeCta([ad({ destinationType: "WEBSITE", link: null, whatsappNumber: "972500000000" })]).state).toBe("broken");
  });

  it("reports one broken ad among healthy ones, and names how many", () => {
    const s = summarizeCta([ad({ adId: "a" }), ad({ adId: "b", whatsappNumber: null }), ad({ adId: "c" })]);
    expect(s.state).toBe("broken");
    expect(s.brokenAdIds).toEqual(["b"]);
    expect(s.reason).toMatch(/1 of 3/);
  });

  // not_applicable is deliberately NOT ok: an engagement ad has no
  // destination by design, and claiming "healthy" would imply a check we
  // never ran.
  it("reports not_applicable for an engagement campaign rather than a silent pass", () => {
    const s = summarizeCta([ad({ destinationType: "UNDEFINED", ctaType: null, whatsappNumber: null })]);
    expect(s.state).toBe("not_applicable");
  });

  // unknown must never be a soft ok — it must not overwrite a real prior
  // verdict (the bug this module's sibling, delivery-health, actually has).
  it("reports unknown when there are no ads to check", () => {
    expect(summarizeCta([]).state).toBe("unknown");
  });

  // Found while answering "how do I fix it?" — the honest fix is to replace the
  // broken ad and archive it, and that must actually CLEAR the alert. Without
  // this filter an archived ad stays in Meta's /ads response and keeps the
  // campaign flagged forever, making the advice self-defeating.
  it("ignores archived and deleted ads — so replacing a broken ad clears the alert", () => {
    const broken = { whatsappNumber: null };
    expect(summarizeCta([ad({ ...broken, effectiveStatus: "ARCHIVED" })]).state).not.toBe("broken");
    expect(summarizeCta([ad({ ...broken, effectiveStatus: "DELETED" })]).state).not.toBe("broken");

    // The realistic end state: the broken pair archived, a healthy replacement live.
    const s = summarizeCta([
      ad({ adId: "old_1", ...broken, effectiveStatus: "ARCHIVED" }),
      ad({ adId: "old_2", ...broken, effectiveStatus: "ARCHIVED" }),
      ad({ adId: "new_1", effectiveStatus: "ACTIVE" }),
    ]);
    expect(s.state).toBe("ok");
    expect(s.brokenAdIds).toEqual([]);
  });

  // PAUSED is deliberately still judged: it can be resumed, and it is the exact
  // state the live failure was found in (the customer paused both ads).
  it("still flags a PAUSED ad, which can be resumed at any time", () => {
    expect(summarizeCta([ad({ whatsappNumber: null, effectiveStatus: "PAUSED" })]).state).toBe("broken");
  });

  // Destinations whose payload shape isn't modelled must not be judged on the
  // WhatsApp rule — a false alarm on a working ad is worse than a known gap.
  it("leaves unmodelled destinations alone rather than guessing them broken", () => {
    for (const dest of ["MESSENGER", "INSTAGRAM_DIRECT", "PHONE_CALL"]) {
      const s = summarizeCta([ad({ destinationType: dest, whatsappNumber: null, link: null })]);
      expect(s.state, dest).toBe("ok");
    }
  });
});
