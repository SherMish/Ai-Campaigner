import { describe, it, expect } from "vitest";
import { validateCreativeCopy, HEADLINE_MAX_CHARS, PRIMARY_TEXT_MAX_CHARS } from "./creative-handling.js";

const OK = { headline: "מבצע קיץ", primaryText: "20% הנחה על הטיפול הראשון", hasMedia: true };

describe("validateCreativeCopy", () => {
  it("passes with a headline, primary text, and media", () => {
    expect(validateCreativeCopy(OK)).toEqual({ valid: true, errors: [] });
  });

  it("fails when no media was provided (upload or existing post)", () => {
    const r = validateCreativeCopy({ ...OK, hasMedia: false });
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("missing_media");
  });

  it("fails on an empty or whitespace-only headline", () => {
    expect(validateCreativeCopy({ ...OK, headline: "" }).errors).toContain("missing_headline");
    expect(validateCreativeCopy({ ...OK, headline: "   " }).errors).toContain("missing_headline");
  });

  it("fails on an empty or whitespace-only primary text", () => {
    expect(validateCreativeCopy({ ...OK, primaryText: "" }).errors).toContain("missing_primary_text");
    expect(validateCreativeCopy({ ...OK, primaryText: "   " }).errors).toContain("missing_primary_text");
  });

  it("flags a headline over the soft length limit, but never for content/claims accuracy (PRD §8 stays the customer's responsibility)", () => {
    const r = validateCreativeCopy({ ...OK, headline: "a".repeat(HEADLINE_MAX_CHARS + 1) });
    expect(r.valid).toBe(false);
    expect(r.errors).toContain("headline_too_long");
  });

  it("flags primary text over the soft length limit", () => {
    const r = validateCreativeCopy({ ...OK, primaryText: "a".repeat(PRIMARY_TEXT_MAX_CHARS + 1) });
    expect(r.errors).toContain("primary_text_too_long");
  });

  it("accumulates every problem at once rather than stopping at the first", () => {
    const r = validateCreativeCopy({ headline: "", primaryText: "", hasMedia: false });
    expect(r.errors).toHaveLength(3);
  });
});
