import { describe, it, expect } from "vitest";
import { validateBusinessDetails, MAX_NAME, MAX_URL } from "./business-details.js";

const ok = (i: Parameters<typeof validateBusinessDetails>[0]) => {
  const r = validateBusinessDetails(i);
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.value;
};
const refusal = (i: Parameters<typeof validateBusinessDetails>[0]) => {
  const r = validateBusinessDetails(i);
  if (r.ok) throw new Error("expected a refusal");
  return r.reason;
};

describe("validateBusinessDetails", () => {
  it("accepts a name alone — a business without a website is normal", () => {
    // Requiring a site would block the step for exactly the small businesses
    // this product exists for.
    expect(ok({ businessName: "לק ג'ל" })).toEqual({ businessName: "לק ג'ל", websiteUrl: "" });
  });

  it("trims the name", () => {
    expect(ok({ businessName: "  Lak Gel  " }).businessName).toBe("Lak Gel");
  });

  it("refuses a missing or blank name, distinctly from a short one", () => {
    expect(refusal({})).toBe("name_required");
    expect(refusal({ businessName: "   " })).toBe("name_required");
    expect(refusal({ businessName: 42 })).toBe("name_required");
    expect(refusal({ businessName: "a" })).toBe("name_too_short");
  });

  it("bounds the name", () => {
    expect(ok({ businessName: "x".repeat(MAX_NAME) }).businessName).toHaveLength(MAX_NAME);
    expect(refusal({ businessName: "x".repeat(MAX_NAME + 1) })).toBe("name_too_long");
  });

  it("assumes https for a bare domain, because that is what people type", () => {
    expect(ok({ businessName: "Lak Gel", websiteUrl: "lakgel.co.il" }).websiteUrl)
      .toBe("https://lakgel.co.il/");
  });

  it("does NOT downgrade an explicit https, and keeps an explicit http", () => {
    expect(ok({ businessName: "Biz", websiteUrl: "https://a.co.il/x" }).websiteUrl).toBe("https://a.co.il/x");
    expect(ok({ businessName: "Biz", websiteUrl: "http://a.co.il/" }).websiteUrl).toBe("http://a.co.il/");
  });

  it("refuses a javascript: url", () => {
    // This value is stored and later rendered as a link — in the admin console,
    // among other places. A javascript: href is script execution in whoever
    // clicks it.
    expect(refusal({ businessName: "Biz", websiteUrl: "javascript:alert(1)" })).toBe("url_not_http");
    expect(refusal({ businessName: "Biz", websiteUrl: "JavaScript:alert(1)" })).toBe("url_not_http");
    expect(refusal({ businessName: "Biz", websiteUrl: "data:text/html,<script>" })).toBe("url_not_http");
  });

  it("refuses something that is not a host at all", () => {
    expect(refusal({ businessName: "Biz", websiteUrl: "not a url" })).toBe("url_not_http");
    expect(refusal({ businessName: "Biz", websiteUrl: "localhost" })).toBe("url_not_http");
  });

  it("bounds the url", () => {
    expect(refusal({ businessName: "Biz", websiteUrl: "a.co/" + "x".repeat(MAX_URL) })).toBe("url_too_long");
  });

  it("ignores a non-string website instead of failing the whole form", () => {
    expect(ok({ businessName: "Biz", websiteUrl: null }).websiteUrl).toBe("");
  });
});
