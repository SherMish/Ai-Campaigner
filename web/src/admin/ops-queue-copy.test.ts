import { describe, expect, it } from "vitest";
import { OPS_QUEUE_TYPE } from "@aic/shared";
import { strings } from "../strings";

const labels = strings.he.ops.queueTypeLabel;

// AIC-121: exhaustive over the shared enum, not a snapshot of it — a type
// added to OPS_QUEUE_TYPE without a label here would otherwise render its
// raw snake_case key to the operator, silently, the next time it fires.
describe("ops-queue type labels (AIC-121) cover every OPS_QUEUE_TYPE", () => {
  it("every type has a non-empty Hebrew label", () => {
    for (const type of OPS_QUEUE_TYPE) {
      const label = labels[type];
      expect(typeof label === "string" && label.trim().length > 0, `missing label for "${type}"`).toBe(true);
    }
  });

  it("no stray keys beyond the real enum", () => {
    const extra = Object.keys(labels).filter((k) => !(OPS_QUEUE_TYPE as readonly string[]).includes(k));
    expect(extra).toEqual([]);
  });

  it("no two types share a label — a shared label would hide which is which in the queue", () => {
    const seen = new Map<string, string>();
    for (const type of OPS_QUEUE_TYPE) {
      const label = labels[type];
      expect(seen.get(label), `"${type}" duplicates "${seen.get(label)}"'s label`).toBeUndefined();
      seen.set(label, type);
    }
  });
});
