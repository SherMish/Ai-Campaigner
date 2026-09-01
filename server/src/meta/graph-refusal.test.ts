import { describe, it, expect } from "vitest";
import { GraphWriteError } from "./campaign-adapter.js";
import { metaRefusal, respondIfMetaRefused } from "./graph-refusal.js";

function res() {
  const r = { code: 0, body: null as unknown };
  return {
    status(c: number) { r.code = c; return this; },
    json(b: unknown) { r.body = b; return this; },
    _: r,
  };
}

// The live failure, verbatim from Railway on 2026-09-01.
const whatsappRefusal = () =>
  new GraphWriteError(
    "POST act_2181076988590009/adsets → 400 …", 400, 100, 2446885, false,
    "Page With WhatsApp Business Account Required",
    "The WhatsApp number linked to your Page is a personal account. You must connect a WhatsApp Business account to drive traffic to WhatsApp.",
  );

describe("Meta refusals (AIC-174)", () => {
  it("answers 400 with Meta's sentence and the reason the UI localizes", () => {
    // The customer saw "משהו השתבש בהוספה" while this exact, actionable
    // sentence sat in the log.
    const r = res();
    expect(respondIfMetaRefused(r as never, whatsappRefusal())).toBe(true);
    expect(r._.code).toBe(400); // NOT 502 — Meta understood us and said no
    expect(r._.body).toMatchObject({
      code: "meta_refused",
      reason: "whatsapp_business_required",
      title: "Page With WhatsApp Business Account Required",
    });
    expect(String((r._.body as { error: string }).error)).toContain("WhatsApp Business account");
  });

  it("surfaces an UNMAPPED refusal with reason null, never swallows it", () => {
    // The whole point of passing Meta's own text through: a refusal we have no
    // Hebrew for is still a refusal the customer can act on.
    const e = new GraphWriteError("x", 400, 100, 999999, false, "Some Title", "Your ad account is disabled.");
    const r = res();
    expect(respondIfMetaRefused(r as never, e)).toBe(true);
    expect(r._.body).toMatchObject({ reason: null, error: "Your ad account is disabled." });
  });

  it("leaves OUR OWN bad payloads to the route's 502", () => {
    // Meta populates error_user_msg only when a person can fix it. Without one
    // this is our bug, and the raw Graph message + fbtrace_id must not reach a
    // customer's screen.
    const r = res();
    expect(respondIfMetaRefused(r as never, new GraphWriteError("(#100) bad field xyz", 400, 100, null, false, null, null))).toBe(false);
    expect(r._.code).toBe(0);
    expect(respondIfMetaRefused(r as never, new Error("boom"))).toBe(false);
    expect(respondIfMetaRefused(r as never, "boom")).toBe(false);
  });

  it("does not claim a reason for a subcode it does not know", () => {
    expect(metaRefusal(whatsappRefusal())?.reason).toBe("whatsapp_business_required");
    const other = new GraphWriteError("x", 400, 100, null, false, "t", "m");
    expect(metaRefusal(other)?.reason).toBeNull();
  });
});
