import { describe, it, expect } from "vitest";
import {
  impliedLeadActionType,
  summarizeTracking,
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
      [{ ...PIXEL_ADSET, optimizationGoal: "LINK_CLICKS", customEventType: null }],
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
      [WHATSAPP_ADSET, { ...PIXEL_ADSET, optimizationGoal: "LINK_CLICKS", customEventType: null }],
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
