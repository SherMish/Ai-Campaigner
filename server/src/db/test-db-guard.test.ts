import { describe, it, expect } from "vitest";
import { describeTarget, refusalMessage } from "./test-db-guard.js";

describe("describeTarget (AIC-84)", () => {
  it("recognises the local throwaway databases the suite is meant to use", () => {
    for (const url of [
      "postgresql://me@localhost:5432/aic_test",
      "postgresql://postgres:postgres@127.0.0.1:5432/aic_test",
      "postgres://user@localhost/aic_test",
    ]) {
      expect(describeTarget(url).local).toBe(true);
    }
  });

  it("treats the production Neon host as remote", () => {
    const t = describeTarget("postgresql://u:p@ep-cool-name-123.eu-central-1.aws.neon.tech/neondb?sslmode=require");
    expect(t.local).toBe(false);
    expect(t.host).toContain("neon.tech");
    expect(t.database).toBe("neondb");
  });

  it("treats an unparseable URL as REMOTE, never local", () => {
    // The failure mode of guessing wrong in the other direction is a test
    // suite writing to production, so the ambiguous case must refuse.
    expect(describeTarget("not a url").local).toBe(false);
    expect(describeTarget("").local).toBe(false);
  });

  it("names the target in the refusal, so the message is actionable", () => {
    const msg = refusalMessage(describeTarget("postgresql://u:p@ep-x.neon.tech/neondb"));
    expect(msg).toContain("ep-x.neon.tech/neondb");
    expect(msg).toContain("db:test:prepare");
  });
});
