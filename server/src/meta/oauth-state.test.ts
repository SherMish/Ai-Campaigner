import { describe, it, expect, beforeAll } from "vitest";
import { mintState, parseState, StateError } from "./oauth-state.js";

const USER = "3f4c1a2b-0000-4000-8000-000000000001";

describe("oauth-state", () => {
  beforeAll(() => { process.env.JWT_SECRET = "x".repeat(48); });

  it("round-trips the user id it was minted for", () => {
    const { state } = mintState(USER);
    expect(parseState(state).userId).toBe(USER);
  });

  it("mints a distinct nonce every time", () => {
    expect(mintState(USER).nonce).not.toBe(mintState(USER).nonce);
  });

  it("expires 15 minutes out", () => {
    const now = new Date("2026-09-10T12:00:00Z");
    expect(mintState(USER, now).expiresAt.toISOString()).toBe("2026-09-10T12:15:00.000Z");
  });

  it("refuses a state whose user id was swapped", () => {
    // The attack this exists to stop: take your own valid state, edit the user
    // id, and have the callback attach YOUR Meta account to someone else.
    const { state } = mintState(USER);
    const [nonce, , mac] = state.split(".");
    const forged = [nonce, "3f4c1a2b-0000-4000-8000-00000000dead", mac].join(".");
    expect(() => parseState(forged)).toThrow(/signature/);
  });

  it("refuses a state signed with a different secret", () => {
    const { state } = mintState(USER);
    process.env.JWT_SECRET = "y".repeat(48);
    expect(() => parseState(state)).toThrow(StateError);
    process.env.JWT_SECRET = "x".repeat(48);
  });

  it("refuses malformed states without throwing something unexpected", () => {
    for (const bad of ["", "a", "a.b", "a.b.c.d", "..", "a..c"]) {
      expect(() => parseState(bad)).toThrow(StateError);
    }
  });

  it("refuses a truncated signature rather than crashing on length", () => {
    // timingSafeEqual throws on mismatched lengths; that must not surface as a 500.
    const { state } = mintState(USER);
    const [nonce, userId, mac] = state.split(".");
    expect(() => parseState([nonce, userId, mac.slice(0, 8)].join("."))).toThrow(/signature/);
  });
});
