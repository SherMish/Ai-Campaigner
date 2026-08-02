import { describe, it, expect } from "vitest";
import { shekelToAgorot, agorotToShekel, formatShekel } from "./money.js";

describe("money (agorot)", () => {
  it("converts shekel to integer agorot", () => {
    expect(shekelToAgorot(73.4)).toBe(7340);
    expect(Number.isInteger(shekelToAgorot(0.1))).toBe(true);
    expect(shekelToAgorot(299)).toBe(29900);
  });

  it("round-trips agorot → shekel", () => {
    expect(agorotToShekel(7340)).toBe(73.4);
    expect(agorotToShekel(29900)).toBe(299);
  });

  it("formats whole and fractional shekels", () => {
    expect(formatShekel(7300)).toBe("₪73");
    expect(formatShekel(7340)).toBe("₪73.40");
    expect(formatShekel(29900)).toBe("₪299");
  });
});
