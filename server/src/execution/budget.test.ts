import { describe, it, expect } from "vitest";
import {
  assertWithinBudget, isWithinBudget, BudgetLimitError,
  assertCreateWithinBudget, BudgetCeilingMissingError,
} from "./budget.js";

describe("budget safety", () => {
  it("allows a proposed budget at or below the agreed ceiling", () => {
    expect(isWithinBudget(8000, 8000)).toBe(true);
    expect(isWithinBudget(8000, 7000)).toBe(true);
  });

  it("rejects a proposed budget above the agreed ceiling", () => {
    expect(() => assertWithinBudget(8000, 9000)).toThrow(BudgetLimitError);
    expect(isWithinBudget(8000, 9000)).toBe(false);
  });

  it("rejects a non-positive or non-integer budget", () => {
    expect(() => assertWithinBudget(8000, 0)).toThrow(BudgetLimitError);
    expect(() => assertWithinBudget(8000, -100)).toThrow(BudgetLimitError);
    expect(() => assertWithinBudget(8000, 70.5)).toThrow(BudgetLimitError);
  });

  it("passes non-budget actions through (null proposed)", () => {
    expect(isWithinBudget(8000, null)).toBe(true);
  });
});

// AIC-106 — the create-path guard. Separate from assertWithinBudget because
// creation has a precondition update never had: on an update the campaign is
// already running under an agreed ceiling, so one exists by definition. On a
// create it may never have been set.
describe("assertCreateWithinBudget (AIC-106)", () => {
  it("allows a create at or below the agreed ceiling", () => {
    expect(() => assertCreateWithinBudget(5000, 5000)).not.toThrow();
    expect(() => assertCreateWithinBudget(5000, 1200)).not.toThrow();
  });

  it("refuses a create above the agreed ceiling", () => {
    expect(() => assertCreateWithinBudget(2000, 9900)).toThrow(BudgetLimitError);
  });

  // The heart of it. 0 and null must NOT read as "unlimited" — that would make
  // the single most dangerous state (nobody agreed a budget) the single most
  // permissive one, at exactly the moment AIC-106 removes the human checkpoint.
  it("fails CLOSED when no ceiling was ever agreed", () => {
    expect(() => assertCreateWithinBudget(0, 1000)).toThrow(BudgetCeilingMissingError);
    expect(() => assertCreateWithinBudget(null, 1000)).toThrow(BudgetCeilingMissingError);
    expect(() => assertCreateWithinBudget(undefined, 1000)).toThrow(BudgetCeilingMissingError);
  });

  // A missing ceiling and an over-ceiling budget are different problems with
  // different fixes (set one at provisioning vs. lower the number), so they
  // must not share an error type — the ops copy has to be able to tell them apart.
  it("distinguishes a missing ceiling from an exceeded one", () => {
    expect(() => assertCreateWithinBudget(0, 1000)).not.toThrow(BudgetLimitError);
    expect(() => assertCreateWithinBudget(1000, 5000)).not.toThrow(BudgetCeilingMissingError);
  });

  it("still rejects a non-positive proposed budget under a valid ceiling", () => {
    expect(() => assertCreateWithinBudget(5000, 0)).toThrow(BudgetLimitError);
    expect(() => assertCreateWithinBudget(5000, -1)).toThrow(BudgetLimitError);
  });
});
