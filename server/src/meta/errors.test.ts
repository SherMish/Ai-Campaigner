import { describe, it, expect } from "vitest";
import { classifyGraphError } from "./errors.js";

describe("classifyGraphError", () => {
  it("maps code 190 to invalid (dead/expired token)", () => {
    const r = classifyGraphError(400, {
      error: { code: 190, error_subcode: 463, message: "expired" },
    });
    expect(r.health).toBe("invalid");
  });

  it("maps permission errors to revoked (grant removed)", () => {
    for (const code of [100, 200, 10, 3, 298, 294]) {
      const r = classifyGraphError(403, { error: { code, message: "no perm" } });
      expect(r.health).toBe("revoked");
    }
  });

  it("maps unknown/5xx to needs_reconnect", () => {
    expect(classifyGraphError(500, undefined).health).toBe("needs_reconnect");
    expect(
      classifyGraphError(400, { error: { code: 99999, message: "?" } }).health,
    ).toBe("needs_reconnect");
  });
});
