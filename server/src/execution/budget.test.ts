import { describe, it, expect } from "vitest";
import { assertWithinBudget, isWithinBudget, BudgetLimitError } from "./budget.js";

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
