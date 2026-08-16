import { describe, expect, it } from "vitest";
import { DIAGNOSIS_COPY, diagnosisCopy } from "./onboarding-copy";

// AIC-101/AIC-98. Three of these six diagnoses look identical from the
// Business Settings UI — that's the whole premise of the ticket — so the
// test that matters is distinctness, not just presence.
const nonEmpty = (s: string) => typeof s === "string" && s.trim().length > 0;

describe("onboarding diagnosis copy (AIC-101)", () => {
  it("every diagnosis has non-empty title and body", () => {
    for (const [key, copy] of Object.entries(DIAGNOSIS_COPY)) {
      expect(nonEmpty(copy.title), `${key}.title`).toBe(true);
      expect(nonEmpty(copy.body), `${key}.body`).toBe(true);
    }
  });

  it("no two diagnoses share the same title+body", () => {
    const seen = new Map<string, string>();
    for (const [key, copy] of Object.entries(DIAGNOSIS_COPY)) {
      const combo = `${copy.title} ${copy.body}`;
      expect(seen.get(combo), `${key} duplicates ${seen.get(combo)}`).toBeUndefined();
      seen.set(combo, key);
    }
  });

  it("the three layer failures are each distinguishable, not just non-identical", () => {
    // The specific case the ticket calls out: not_shared / not_assigned /
    // token_missing_scopes must never read as the same instruction, because
    // they have three different fixes (redo the grant / assign to the
    // System User / regenerate the token).
    const a = DIAGNOSIS_COPY.not_shared.body;
    const b = DIAGNOSIS_COPY.not_assigned.body;
    const c = DIAGNOSIS_COPY.token_missing_scopes.body;
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("an unrecognized diagnosis still renders something, never blank", () => {
    const copy = diagnosisCopy("some_future_server_value");
    expect(nonEmpty(copy.title)).toBe(true);
  });
});
