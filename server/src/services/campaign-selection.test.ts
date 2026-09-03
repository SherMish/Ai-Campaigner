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

describe("campaignIdParam and duplicated query params (AIC-195)", () => {
  const ID = "7e7a7340-aad5-4dd9-b32b-4ff901db879f";

  it("accepts the ARRAY Express builds from a repeated parameter", () => {
    // ?campaignId=X&campaignId=X arrives as ["X","X"]. Returning null here is
    // what made the dashboard serve the DEFAULT campaign while the switcher
    // showed another one — a wrong campaign's numbers under the right name.
    expect(campaignIdParam([ID, ID])).toBe(ID);
  });

  it("takes the LAST value when they differ", () => {
    // Last-wins matches how a client that appends after an injection behaves,
    // and picking one deliberately beats rejecting the whole request.
    expect(campaignIdParam(["4e2fd1fb-d31c-43bb-822a-311a037cefb0", ID])).toBe(ID);
  });

  it("still rejects an array of junk", () => {
    expect(campaignIdParam(["nope", "also-nope"])).toBeNull();
    expect(campaignIdParam([])).toBeNull();
  });
});
