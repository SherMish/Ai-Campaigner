import { describe, it, expect } from "vitest";
import { campaignIdParam } from "./campaign-selection.js";

describe("campaignIdParam (AIC-186)", () => {
  it("accepts a real uuid", () => {
    expect(campaignIdParam("4e2fd1fb-d31c-43bb-822a-311a037cefb0")).toBe("4e2fd1fb-d31c-43bb-822a-311a037cefb0");
  });

  it("drops anything that is not one, rather than handing it to Postgres", () => {
    // A non-uuid in a ::uuid cast is a 500, which is a worse answer to a
    // malformed id than falling back to the customer's default campaign.
    for (const bad of ["", "abc", "1; DROP TABLE customers", null, undefined, 42, {}]) {
      expect(campaignIdParam(bad)).toBeNull();
    }
  });
});
