// Budget safety (AIC-13, PRD §24). The customer's agreed budget is a hard
// ceiling: no write may ever push daily budget above it, and no budget may be
// non-positive. Non-budget actions (pause/replace) pass through (null proposed).

export class BudgetLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetLimitError";
  }
}

// Throws unless the proposed daily budget is within (0, agreedBudgetAgorot].
// A null proposed means "not a budget change" and is always allowed.
export function assertWithinBudget(
  agreedBudgetAgorot: number,
  proposedBudgetAgorot: number | null,
): void {
  if (proposedBudgetAgorot === null) return;
  if (!Number.isInteger(proposedBudgetAgorot) || proposedBudgetAgorot <= 0) {
    throw new BudgetLimitError(`proposed budget must be a positive integer (agorot), got ${proposedBudgetAgorot}`);
  }
  if (proposedBudgetAgorot > agreedBudgetAgorot) {
    throw new BudgetLimitError(
      `proposed budget ${proposedBudgetAgorot} exceeds agreed ceiling ${agreedBudgetAgorot}`,
    );
  }
}

export function isWithinBudget(
  agreedBudgetAgorot: number,
  proposedBudgetAgorot: number | null,
): boolean {
  try {
    assertWithinBudget(agreedBudgetAgorot, proposedBudgetAgorot);
    return true;
  } catch {
    return false;
  }
}
