import { describe, it, expect } from "vitest";
import type { OpsQueueType, OpsSeverity } from "@aic/shared";
import { filterAndGroup, presentTypes } from "./ops-queue-view.js";

interface Row { id: string; type: OpsQueueType; severity: OpsSeverity; }

function row(id: string, type: OpsQueueType, severity: OpsSeverity): Row {
  return { id, type, severity };
}

// Server order (OpsQueue.list): high severity first, then oldest-first within
// a severity — mirrored here as the input order, since that's what a real
// caller passes in.
const QUEUE: Row[] = [
  row("1", "meta_connection_failure", "high"),
  row("2", "meta_connection_failure", "high"),
  row("3", "campaign_not_delivering", "high"),
  row("4", "campaign_rejected", "medium"),
  row("5", "support_request", "low"),
];

describe("ops queue: filter + group (AIC-121)", () => {
  it("with no filters, groups everything by type in first-seen order — the server's own triage order", () => {
    const groups = filterAndGroup(QUEUE, { severity: "all", type: "all" });
    expect(groups.map((g) => g.type)).toEqual([
      "meta_connection_failure", "campaign_not_delivering", "campaign_rejected", "support_request",
    ]);
    expect(groups[0].items.map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("filters by severity across all types", () => {
    const groups = filterAndGroup(QUEUE, { severity: "high", type: "all" });
    expect(groups.map((g) => g.type)).toEqual(["meta_connection_failure", "campaign_not_delivering"]);
    expect(groups.flatMap((g) => g.items).map((i) => i.id)).toEqual(["1", "2", "3"]);
  });

  it("filters by type — single group, or none at all", () => {
    const one = filterAndGroup(QUEUE, { severity: "all", type: "campaign_rejected" });
    expect(one).toHaveLength(1);
    expect(one[0].items.map((i) => i.id)).toEqual(["4"]);

    const none = filterAndGroup(QUEUE, { severity: "all", type: "account_restriction" });
    expect(none).toEqual([]);
  });

  it("combines both filters", () => {
    const groups = filterAndGroup(QUEUE, { severity: "high", type: "meta_connection_failure" });
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("an empty queue produces no groups, not an error", () => {
    expect(filterAndGroup([], { severity: "all", type: "all" })).toEqual([]);
  });

  it("presentTypes lists only types actually in the queue, not the full enum", () => {
    expect(presentTypes(QUEUE)).toEqual([
      "meta_connection_failure", "campaign_not_delivering", "campaign_rejected", "support_request",
    ]);
    expect(presentTypes([])).toEqual([]);
    // Never offers a type filter option with zero matching items — the
    // whole point of restricting to what's present.
    expect(presentTypes(QUEUE)).not.toContain("account_restriction");
  });
});
