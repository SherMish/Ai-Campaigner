import { describe, it, expect } from "vitest";
import {
  canTransition,
  assertTransition,
  isTerminal,
  IllegalTransitionError,
} from "./state-machine.js";

describe("recommendation state machine", () => {
  it("allows the legal lifecycle", () => {
    expect(canTransition("proposed", "approved")).toBe(true);
    expect(canTransition("proposed", "dismissed")).toBe(true);
    expect(canTransition("proposed", "expired")).toBe(true);
    expect(canTransition("approved", "executing")).toBe(true);
    expect(canTransition("executing", "executed")).toBe(true);
    expect(canTransition("executing", "failed")).toBe(true);
  });

  it("rejects the dangerous illegal transitions", () => {
    expect(canTransition("expired", "approved")).toBe(false); // can't approve a stale rec
    expect(canTransition("dismissed", "executing")).toBe(false); // can't execute a dismissed one
    expect(canTransition("executed", "executing")).toBe(false); // can't re-run
    expect(canTransition("proposed", "executing")).toBe(false); // must be approved first
    expect(() => assertTransition("expired", "approved")).toThrow(IllegalTransitionError);
  });

  it("marks the right terminal states", () => {
    for (const s of ["executed", "failed", "dismissed", "expired"] as const) {
      expect(isTerminal(s)).toBe(true);
    }
    for (const s of ["proposed", "approved", "executing"] as const) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});
