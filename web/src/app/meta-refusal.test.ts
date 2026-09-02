import { describe, it, expect } from "vitest";
import { metaRefusalOf, localRefusalOf } from "./meta-refusal";

const refusal = (reason: unknown, error: unknown) => ({
  body: { code: "meta_refused", reason, error },
});

describe("metaRefusalOf (AIC-174)", () => {
  it("reads the reason we have copy for", () => {
    // The reported case: adding an ad set failed and the customer was shown
    // "משהו השתבש", while Meta had already said exactly what to fix.
    expect(
      metaRefusalOf(refusal("whatsapp_business_required", "The WhatsApp number linked to your Page is a personal account.")),
    ).toEqual({
      reason: "whatsapp_business_required",
      message: "The WhatsApp number linked to your Page is a personal account.",
    });
  });

  it("degrades an UNKNOWN reason to Meta's own sentence, never to blank", () => {
    // The important one. Selecting copy by an unrecognized key is how a screen
    // ends up rendering nothing at all — worse than English truth.
    expect(metaRefusalOf(refusal("some_future_subcode", "Ad account is disabled."))).toEqual({
      reason: null,
      message: "Ad account is disabled.",
    });
  });

  it("is null for every other failure, so the caller keeps its own copy", () => {
    expect(metaRefusalOf({ body: { code: "meta_rate_limited", error: "too many calls" } })).toBeNull();
    expect(metaRefusalOf({ body: { error: "failed to add ad set" } })).toBeNull();
    expect(metaRefusalOf(new Error("network"))).toBeNull();
    expect(metaRefusalOf(null)).toBeNull();
  });

  it("is null when the body claims a refusal but carries no sentence", () => {
    // A refusal with nothing to say is not a refusal worth showing; the route's
    // own message is more useful than an empty red box.
    expect(metaRefusalOf(refusal("whatsapp_business_required", ""))).toBeNull();
    expect(metaRefusalOf(refusal(null, undefined))).toBeNull();
  });
});

describe("localRefusalOf (AIC-177)", () => {
  it("names our own placement refusals", () => {
    expect(localRefusalOf({ body: { code: "placement_no_instagram" } })).toBe("placement_no_instagram");
    expect(localRefusalOf({ body: { code: "bad_placement" } })).toBe("bad_placement");
  });

  it("does not claim Meta's refusals or anything unknown", () => {
    // A Meta refusal has its own reader and its own copy; conflating the two
    // would tell the customer to fix their Page when the problem is ours.
    expect(localRefusalOf({ body: { code: "meta_refused" } })).toBeNull();
    expect(localRefusalOf({ body: { code: "something_new" } })).toBeNull();
    expect(localRefusalOf(new Error("network"))).toBeNull();
    expect(localRefusalOf(null)).toBeNull();
  });
});
