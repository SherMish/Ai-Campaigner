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

// AIC-106 — the ceiling missing entirely is NOT the same failure as a budget
// over the ceiling, and must not share its message. Over-ceiling means "the
// number is too big"; this means "nobody ever agreed a number", which is
// fixed by the operator setting one at provisioning, not by lowering a bid.
export class BudgetCeilingMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetCeilingMissingError";
  }
}

// The create-path guard (AIC-106). Distinct from assertWithinBudget because
// creation has an extra precondition update never had: on an UPDATE the
// campaign is already running under an agreed ceiling, so one necessarily
// exists. On a CREATE it may never have been set — measured 2026-08-19,
// 13 of 15 campaign rows carry `agreed = 0` — and once the launch gate is
// removed there is no human checkpoint left to catch it.
//
// So this fails CLOSED on a missing ceiling rather than treating 0/null as
// "unlimited". The alternative is that the single most dangerous state
// (no agreed budget) becomes the single most permissive one.
export function assertCreateWithinBudget(
  agreedBudgetAgorot: number | null | undefined,
  proposedBudgetAgorot: number,
): void {
  if (agreedBudgetAgorot === null || agreedBudgetAgorot === undefined || agreedBudgetAgorot <= 0) {
    throw new BudgetCeilingMissingError(
      `no agreed budget ceiling is set for this campaign (got ${agreedBudgetAgorot}); set it at provisioning before building`,
    );
  }
  assertWithinBudget(agreedBudgetAgorot, proposedBudgetAgorot);
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
