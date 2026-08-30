import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { WA, WA_NUMBER } from "./components";

// The signed-in app's WhatsApp link shipped as `wa.me/972500000000` behind a
// TODO — a fictional number, on all 13 "talk to us" links a customer could
// press. For a product whose onboarding and support are deliberately human,
// that is the support channel itself being broken, silently: the link opens
// WhatsApp and goes nowhere.
describe("WhatsApp contact", () => {
  it("is not a placeholder", () => {
    expect(WA_NUMBER).not.toMatch(/0{6,}/);
    expect(WA).toBe(`https://wa.me/${WA_NUMBER}`);
  });

  it("is a plausible Israeli mobile in wa.me form", () => {
    // 972 + 5x + 7 digits, no +, no leading zero — wa.me rejects the rest.
    expect(WA_NUMBER).toMatch(/^9725\d{8}$/);
  });

  it("matches the landing page, which is static HTML and cannot import it", () => {
    // The only real safeguard against the company's contact number existing in
    // two versions. If the landing number changes, this fails here rather than
    // being noticed by a customer who cannot reach anyone.
    const landing = readFileSync(
      path.resolve(__dirname, "../../../landing/index.html"),
      "utf8",
    );
    const numbers = [...landing.matchAll(/wa\.me\/(\d+)/g)].map((m) => m[1]);
    expect(numbers.length).toBeGreaterThan(0);
    expect([...new Set(numbers)]).toEqual([WA_NUMBER]);
  });
});
