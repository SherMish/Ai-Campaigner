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

  it("maps an unrecognised 4xx to needs_reconnect", () => {
    expect(
      classifyGraphError(400, { error: { code: 99999, message: "?" } }).health,
    ).toBe("needs_reconnect");
  });

  // AIC-150. `needs_reconnect` is not a log level — it puts "איבדנו גישה
  // לחשבון Meta" and a reconnect button on a paying customer's dashboard, and
  // it halts execution. Only an answer about our ACCESS may produce it.
  describe("things that are not access verdicts must be unknown", () => {
    it("a 5xx is Meta being broken, not our grant being gone", () => {
      expect(classifyGraphError(500, undefined).health).toBe("unknown");
      expect(classifyGraphError(503, { error: { code: 2, message: "oops" } }).health).toBe("unknown");
    });

    it("rate limiting says we asked too often, nothing about access", () => {
      for (const code of [4, 17, 32, 613]) {
        expect(classifyGraphError(400, { error: { code, message: "limit" } }).health, `code ${code}`).toBe("unknown");
      }
      expect(classifyGraphError(429, undefined).health).toBe("unknown");
    });

    it("a real revocation still classifies definitely, on the first look", () => {
      // The alarm must stay loud for the case it exists for.
      expect(classifyGraphError(400, { error: { code: 190 } }).health).toBe("invalid");
      expect(classifyGraphError(403, { error: { code: 200 } }).health).toBe("revoked");
    });
  });
});
