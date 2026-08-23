// Pure filter/group logic for the ops-queue view (AIC-121). Extracted for the
// same reason onboarding-step4.ts and user-row-status.ts are: this repo has
// no component-test tooling, so a pure function is the only way to lock in
// the decision logic without hand-verifying it in the browser every time.
import type { OpsQueueType, OpsSeverity } from "@aic/shared";

export type SeverityFilter = "all" | OpsSeverity;
export type TypeFilter = "all" | OpsQueueType;

export interface QueueFilters {
  severity: SeverityFilter;
  type: TypeFilter;
}

export interface QueueGroup<T> {
  type: OpsQueueType;
  items: T[];
}

// Groups the FILTERED result by type, in first-seen order — not alphabetical,
// not re-sorted. The server already orders items severity-first then oldest-
// first (OpsQueue.list), and that ordering is what decides which group appears
// first and which item leads each group. Re-sorting here would silently
// undo the server's own triage priority.
export function filterAndGroup<T extends { type: OpsQueueType; severity: OpsSeverity }>(
  items: T[],
  filters: QueueFilters,
): Array<QueueGroup<T>> {
  const filtered = items.filter(
    (i) =>
      (filters.severity === "all" || i.severity === filters.severity) &&
      (filters.type === "all" || i.type === filters.type),
  );
  const order: OpsQueueType[] = [];
  const byType = new Map<OpsQueueType, T[]>();
  for (const item of filtered) {
    if (!byType.has(item.type)) {
      byType.set(item.type, []);
      order.push(item.type);
    }
    byType.get(item.type)!.push(item);
  }
  return order.map((type) => ({ type, items: byType.get(type)! }));
}

// The type filter's own option list: only types PRESENT in the current queue,
// in the order they first appear (severity-first from the server) — not the
// full 9-value enum, which would offer to filter by types that have zero
// items right now.
export function presentTypes<T extends { type: OpsQueueType }>(items: T[]): OpsQueueType[] {
  const seen: OpsQueueType[] = [];
  for (const item of items) {
    if (!seen.includes(item.type)) seen.push(item.type);
  }
  return seen;
}
