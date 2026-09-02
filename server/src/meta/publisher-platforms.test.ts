import { describe, it, expect } from "vitest";
import { publisherPlatforms } from "./campaign-adapter.js";

describe("publisherPlatforms (AIC-177)", () => {
  it("sends NOTHING for advantage — the absence is the instruction", () => {
    // Supplying publisher_platforms at all is what turns Advantage+
    // placements off. There is no "automatic" value to send, so an empty
    // object (spreadable to nothing) is the only correct answer.
    expect(publisherPlatforms("advantage")).toEqual({});
    expect(publisherPlatforms(undefined)).toEqual({});
  });

  it("restricts to the one chosen platform", () => {
    expect(publisherPlatforms("instagram")).toEqual({ publisher_platforms: ["instagram"] });
    expect(publisherPlatforms("facebook")).toEqual({ publisher_platforms: ["facebook"] });
  });

  it("never emits an undefined key, which would serialize and be refused", () => {
    for (const p of ["advantage", undefined] as const) {
      expect(Object.keys(publisherPlatforms(p))).toHaveLength(0);
    }
  });
});
