import { describe, it, expect } from "vitest";
import { readImpersonation } from "./impersonation";

// Builds a token the way jsonwebtoken does — the signature is irrelevant here,
// because this parser is for DISPLAY and the server checks the real thing.
function tok(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "HS256" })}.${b64(payload)}.sig`;
}

const future = Math.floor(Date.now() / 1000) + 900;
const past = Math.floor(Date.now() / 1000) - 60;

describe("readImpersonation", () => {
  it("reads an impersonation token", () => {
    expect(readImpersonation(tok({ sub: "u1", imp: "admin1", exp: future })))
      .toEqual({ userId: "u1", adminId: "admin1" });
  });

  it("is null for a normal session — no bar for a customer's own login", () => {
    expect(readImpersonation(tok({ sub: "u1", exp: future }))).toBeNull();
    expect(readImpersonation(tok({ sub: "u1", imp: "", exp: future }))).toBeNull();
  });

  it("is null for an EXPIRED impersonation — a warning about nothing is noise", () => {
    expect(readImpersonation(tok({ sub: "u1", imp: "admin1", exp: past }))).toBeNull();
  });

  it("survives garbage without throwing", () => {
    for (const bad of [null, undefined, "", "a", "a.b", "a.b.c.d", "not.base64!.sig"]) {
      expect(readImpersonation(bad)).toBeNull();
    }
  });

  it("handles a non-ASCII payload", () => {
    // Hebrew names go through this path; a naive atob would mangle them.
    expect(readImpersonation(tok({ sub: "שרון", imp: "admin1", exp: future })))
      .toEqual({ userId: "שרון", adminId: "admin1" });
  });
});
