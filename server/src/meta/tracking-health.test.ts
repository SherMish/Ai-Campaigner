import { describe, it, expect } from "vitest";
import {
  impliedLeadActionType,
  summarizeTracking,
  deriveIsMessaging,
  detectDestination,
  type AdSetTrackingConfig,
} from "./tracking-health.js";

// The two REAL shapes, read live from Meta before this module was written.
const PIXEL_ADSET: AdSetTrackingConfig = {
  adSetId: "120248238539100352",
  name: "18-28_university-admission,student_website",
  optimizationGoal: "OFFSITE_CONVERSIONS",
  destinationType: "UNDEFINED",
  pixelId: "984664453249037",
  customEventType: "COMPLETE_REGISTRATION",
};
const WHATSAPP_ADSET: AdSetTrackingConfig = {
  adSetId: "120249004871300352",
  name: "GelNails audience",
  optimizationGoal: "CONVERSATIONS",
  destinationType: "WHATSAPP",
  pixelId: null,
  customEventType: null,
};

const WHATSAPP_DEFAULT = [
  "onsite_conversion.messaging_conversation_started_7d",
  "onsite_conversion.messaging_conversation_started",
];
const PIXEL_REGISTRATION = ["offsite_conversion.fb_pixel_complete_registration"];

// AIC-103: pulled out of additions/session.ts's toContext, previously
// inlined there and re-derived (differently, riskier) inline in the admin
// readiness classifiers — one definition now.
describe("deriveIsMessaging", () => {
  it("true for the WhatsApp default lead types, regardless of the number", () => {
    expect(deriveIsMessaging(WHATSAPP_DEFAULT, "+972500000000")).toBe(true);
    expect(deriveIsMessaging(WHATSAPP_DEFAULT, "")).toBe(true);
  });

  it("false for a Pixel lead type, regardless of a leftover number", () => {
    expect(deriveIsMessaging(PIXEL_REGISTRATION, null)).toBe(false);
    expect(deriveIsMessaging(PIXEL_REGISTRATION, "+972500000000")).toBe(false);
  });

  it("an empty lead-type list falls back to whether a number is on file (hand-made rows predate AIC-87)", () => {
    expect(deriveIsMessaging([], "+972500000000")).toBe(true);
    expect(deriveIsMessaging([], "")).toBe(false);
    expect(deriveIsMessaging(null, null)).toBe(false);
  });
});

describe("impliedLeadActionType — Meta config deterministically implies the action type", () => {
  it("OFFSITE_CONVERSIONS + COMPLETE_REGISTRATION → the pixel registration action", () => {
    expect(impliedLeadActionType(PIXEL_ADSET)).toBe(
      "offsite_conversion.fb_pixel_complete_registration",
    );
  });

  it("CONVERSATIONS → the messaging-conversation action", () => {
    expect(impliedLeadActionType(WHATSAPP_ADSET)).toBe(
      "onsite_conversion.messaging_conversation_started",
    );
  });

  it("a CUSTOM conversion is NOT judgeable — null, never a guess", () => {
    // offsite_conversion.custom.<id> has no derivable name from this config.
    // Guessing would flag every custom-conversion campaign as broken.
    expect(impliedLeadActionType({ ...PIXEL_ADSET, customEventType: "CUSTOM" })).toBeNull();
    expect(impliedLeadActionType({ ...PIXEL_ADSET, customEventType: null })).toBeNull();
  });

  it("a non-lead optimization goal is not judgeable", () => {
    expect(impliedLeadActionType({ ...PIXEL_ADSET, optimizationGoal: "LINK_CLICKS" })).toBeNull();
    expect(impliedLeadActionType({ ...PIXEL_ADSET, optimizationGoal: null })).toBeNull();
  });
});

describe("summarizeTracking", () => {
  // THE BUG THIS EXISTS FOR: the real free_beta campaign connected with the
  // default WhatsApp lead definition. Every real conversion counts as zero.
  it("BROKEN: a Pixel campaign carrying the WhatsApp default lead definition", () => {
    const s = summarizeTracking([PIXEL_ADSET], WHATSAPP_DEFAULT);
    expect(s.state).toBe("broken");
    expect(s.reason).toContain("offsite_conversion.fb_pixel_complete_registration");
    expect(s.detail.mismatchedAdSets).toHaveLength(1);
  });

  it("OK: the same Pixel campaign once its real lead type is declared", () => {
    const s = summarizeTracking([PIXEL_ADSET], PIXEL_REGISTRATION);
    expect(s.state).toBe("ok");
    expect(s.reason).toBeNull();
  });

  it("OK: a WhatsApp campaign on the default (the regression case — must never flag)", () => {
    const s = summarizeTracking([WHATSAPP_ADSET], WHATSAPP_DEFAULT);
    expect(s.state).toBe("ok");
  });

  it("OK: matches the base action type even when only the _7d variant is declared", () => {
    // extractLeads' priority list prefers the 7d variant; either makes the
    // conversions countable, so neither is a mismatch.
    const s = summarizeTracking([WHATSAPP_ADSET], ["onsite_conversion.messaging_conversation_started_7d"]);
    expect(s.state).toBe("ok");
  });

  it("BROKEN: a WhatsApp campaign mis-declared with a Pixel lead type", () => {
    const s = summarizeTracking([WHATSAPP_ADSET], PIXEL_REGISTRATION);
    expect(s.state).toBe("broken");
  });

  // Three-valued: `unknown` is never a soft `ok`.
  it("UNKNOWN when no ad sets could be read (never 'ok', never 'broken')", () => {
    expect(summarizeTracking([], WHATSAPP_DEFAULT).state).toBe("unknown");
  });

  it("UNKNOWN when no ad set's goal implies a countable lead event", () => {
    const s = summarizeTracking(
      [{ ...PIXEL_ADSET, optimizationGoal: "LINK_CLICKS", customEventType: null, destinationType: null, pixelId: null }],
      WHATSAPP_DEFAULT,
    );
    expect(s.state).toBe("unknown");
  });

  it("UNKNOWN for a custom conversion — never flagged broken on a guess", () => {
    const s = summarizeTracking([{ ...PIXEL_ADSET, customEventType: "CUSTOM" }], WHATSAPP_DEFAULT);
    expect(s.state).toBe("unknown");
  });

  // Real campaigns have several ad sets; free_beta has two.
  it("OK when every judgeable ad set matches (free_beta's real two-ad-set shape)", () => {
    const s = summarizeTracking(
      [PIXEL_ADSET, { ...PIXEL_ADSET, adSetId: "120248238539100353" }],
      PIXEL_REGISTRATION,
    );
    expect(s.state).toBe("ok");
  });

  it("BROKEN when ANY judgeable ad set's conversions would go uncounted", () => {
    // A mixed campaign: the WhatsApp ad set counts, the Pixel one silently doesn't.
    const s = summarizeTracking([WHATSAPP_ADSET, PIXEL_ADSET], WHATSAPP_DEFAULT);
    expect(s.state).toBe("broken");
    expect(s.detail.mismatchedAdSets).toHaveLength(1);
    expect((s.detail.mismatchedAdSets as Array<{ adSetId: string }>)[0].adSetId).toBe(PIXEL_ADSET.adSetId);
  });

  it("a non-judgeable ad set alongside a matching one does NOT make it broken", () => {
    const s = summarizeTracking(
      [WHATSAPP_ADSET, { ...PIXEL_ADSET, optimizationGoal: "LINK_CLICKS", customEventType: null, destinationType: null, pixelId: null }],
      WHATSAPP_DEFAULT,
    );
    expect(s.state).toBe("ok");
  });

  it("carries enough detail for an operator to act without re-reading Meta", () => {
    const s = summarizeTracking([PIXEL_ADSET], WHATSAPP_DEFAULT);
    expect(s.detail.declaredLeadEventTypes).toEqual(WHATSAPP_DEFAULT);
    const m = (s.detail.mismatchedAdSets as Array<Record<string, unknown>>)[0];
    expect(m.optimizationGoal).toBe("OFFSITE_CONVERSIONS");
    expect(m.customEventType).toBe("COMPLETE_REGISTRATION");
    expect(m.impliedLeadActionType).toBe("offsite_conversion.fb_pixel_complete_registration");
  });
});

// AIC-105 Branch B — adopting an existing campaign detects its destination
// from the SAME config summarizeTracking already trusts, rather than asking
// the operator to guess (and rather than re-deriving a second, driftable copy
// of impliedLeadActionType's mapping).
describe("detectDestination", () => {
  it("a WhatsApp (Click-to-WhatsApp) campaign is detected, no pixel involved", () => {
    expect(detectDestination([WHATSAPP_ADSET])).toEqual({ supported: true, destinationType: "whatsapp" });
  });

  it("a Pixel campaign is detected with its pixel id and implied lead event", () => {
    expect(detectDestination([PIXEL_ADSET])).toEqual({
      supported: true,
      destinationType: "website",
      trackingPixelId: "984664453249037",
      leadEventTypes: ["offsite_conversion.fb_pixel_complete_registration"],
    });
  });

  it("an empty ad-set list is 'no_ad_sets', not 'unrecognized_objective' — a real, distinct reason to show", () => {
    expect(detectDestination([])).toEqual({ supported: false, reason: "no_ad_sets" });
  });

  it("ad sets that exist but imply nothing (e.g. a Traffic objective) are 'unrecognized_objective'", () => {
    const traffic: AdSetTrackingConfig = { ...PIXEL_ADSET, optimizationGoal: "LINK_CLICKS", customEventType: null };
    expect(detectDestination([traffic])).toEqual({ supported: false, reason: "unrecognized_objective" });
  });

  it("a secondary ad set that implies nothing is ignored, not disqualifying — same filtering as summarizeTracking", () => {
    const noise: AdSetTrackingConfig = { ...PIXEL_ADSET, adSetId: "noise", optimizationGoal: "REACH", customEventType: null, pixelId: null };
    expect(detectDestination([WHATSAPP_ADSET, noise])).toEqual({ supported: true, destinationType: "whatsapp" });
  });

  it("ad sets implying genuinely different actions are 'mixed_ad_sets'", () => {
    expect(detectDestination([WHATSAPP_ADSET, PIXEL_ADSET])).toEqual({ supported: false, reason: "mixed_ad_sets" });
  });

  it("a custom (unrecognized) pixel event maps to nothing — still 'unrecognized_objective', never a guess", () => {
    const custom: AdSetTrackingConfig = { ...PIXEL_ADSET, customEventType: "CUSTOM" };
    expect(detectDestination([custom])).toEqual({ supported: false, reason: "unrecognized_objective" });
  });
});

// AIC-107: an engagement campaign is counted on-platform by Meta. There is no
// Pixel that could silently break, so the Measurement Trust question does not
// apply — and the ticket is explicit that this must be REPORTED, never a
// silent pass.
describe("engagement campaigns — not applicable, never a silent pass (AIC-107)", () => {
  const ENGAGEMENT = ["post_engagement"];

  it("reports not_applicable with a reason, not ok", () => {
    const r = summarizeTracking(
      [{ adSetId: "as_1", optimizationGoal: "POST_ENGAGEMENT", customEventType: null, destinationType: null, pixelId: null }],
      ENGAGEMENT,
    );
    expect(r.state).toBe("not_applicable");
    // The distinction that matters: `ok` would assert measurement health we
    // never checked; not_applicable says the check doesn't apply.
    expect(r.state).not.toBe("ok");
    expect(r.reason).toBeTruthy();
  });

  it("stays not_applicable even with NO readable ad sets — that is not a measurement mystery", () => {
    // Deliberately ordered before the "no ad sets readable" branch: reporting
    // `unknown` here would send someone hunting for a Pixel problem that
    // cannot exist for this campaign type.
    expect(summarizeTracking([], ENGAGEMENT).state).toBe("not_applicable");
  });

  it("never reports broken for an engagement campaign, whatever the ad sets say", () => {
    const r = summarizeTracking(
      [{ adSetId: "as_1", optimizationGoal: "OFFSITE_CONVERSIONS", customEventType: "LEAD", destinationType: null, pixelId: "px_1" }],
      ENGAGEMENT,
    );
    expect(r.state).toBe("not_applicable");
  });

  it("REGRESSION: a real lead campaign is judged exactly as before", () => {
    const ok = summarizeTracking(
      [{ adSetId: "as_1", optimizationGoal: "CONVERSATIONS", customEventType: null, destinationType: null, pixelId: null }],
      ["onsite_conversion.messaging_conversation_started"],
    );
    expect(ok.state).toBe("ok");

    const broken = summarizeTracking(
      [{ adSetId: "as_1", optimizationGoal: "OFFSITE_CONVERSIONS", customEventType: "LEAD", destinationType: null, pixelId: "px_1" }],
      ["onsite_conversion.messaging_conversation_started"],
    );
    expect(broken.state).toBe("broken");
  });
});
