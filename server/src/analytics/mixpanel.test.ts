import { describe, it, expect } from "vitest";
import { scrubProps } from "./mixpanel.js";

// AIC-28. This domain is full of PII — customer emails, contact phones, the
// WhatsApp number every ad routes to, business names. Event properties in
// Mixpanel cannot be selectively deleted later, so the rule cannot rely on
// every future call site remembering it.
describe("scrubProps — PII never reaches an event property", () => {
  it("drops the things this product actually holds", () => {
    const out = scrubProps({
      contact_email: "a@b.com",
      contactPhone: "0526964069",
      whatsapp_destination: "972526964069",
      business_name: "אבשלום אבורוס",
      leads: 5,
    });
    expect(out.contact_email).toBeUndefined();
    expect(out.contactPhone).toBeUndefined();
    expect(out.whatsapp_destination).toBeUndefined();
    expect(out.business_name).toBeUndefined();
    expect(out.leads).toBe(5); // the analytic value survives
  });

  it("records WHAT it dropped, so the omission is visible", () => {
    // A silently shorter payload is indistinguishable from a call site that
    // never sent the field. Naming them makes the scrub auditable in Mixpanel.
    const out = scrubProps({ contact_email: "a@b.com", spend_agorot: 100 });
    expect(out.scrubbed_properties).toBe("contact_email");
  });

  it("keeps the analytic dimensions that merely LOOK like PII", () => {
    // business_category matches /name/ by accident; it is a legitimate
    // dimension and is allow-listed explicitly rather than by loosening the
    // pattern, which would let real names through.
    const out = scrubProps({ business_category: "beauty", campaign_objective: "leads" });
    expect(out.business_category).toBe("beauty");
    expect(out.campaign_objective).toBe("leads");
    expect(out.scrubbed_properties).toBeUndefined();
  });

  it("drops undefined without reporting it as scrubbed", () => {
    const out = scrubProps({ leads: 1, cpl_agorot: undefined });
    expect("cpl_agorot" in out).toBe(false);
    expect(out.scrubbed_properties).toBeUndefined();
  });

  it("catches a key nobody thought about, because it matches the shape", () => {
    // The point of a pattern over an allow-list: a field added next year that
    // carries an email is caught without anyone updating this file.
    expect(scrubProps({ owner_email_address: "x@y.z" }).owner_email_address).toBeUndefined();
    expect(scrubProps({ api_token: "sk-123" }).api_token).toBeUndefined();
  });
});
