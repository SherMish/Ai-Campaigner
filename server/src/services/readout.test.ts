import { describe, it, expect } from "vitest";
import { deltaPct } from "./readout.js";

describe("deltaPct", () => {
  it("computes rounded percent change", () => {
    expect(deltaPct(120, 100)).toBe(20);
    expect(deltaPct(80, 100)).toBe(-20);
  });
  it("is null with no baseline (avoids a fake +100%)", () => {
    expect(deltaPct(50, 0)).toBeNull();
  });
});
