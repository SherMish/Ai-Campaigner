import { describe, it, expect, beforeAll } from "vitest";
import { InMemoryUserStore } from "./user-store.js";
import { AuthService, EmailTakenError, InvalidCredentialsError } from "./auth-service.js";
import { verifyAuthToken } from "./tokens.js";

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret-for-auth-unit-padding-to-32-chars-minimum";
});

function svc() {
  return new AuthService(new InMemoryUserStore());
}

describe("AuthService", () => {
  it("signup creates a user and returns a valid JWT", async () => {
    const s = svc();
    const { user, token } = await s.signup({ email: "Lilach@Studio.co.il", password: "hunter2!!", name: "לילך" });
    expect(user.email).toBe("lilach@studio.co.il"); // normalized
    expect(user.name).toBe("לילך");
    expect((user as { passwordHash?: string }).passwordHash).toBeUndefined();
    expect(verifyAuthToken(token)).toEqual({ userId: user.id });
  });

  it("rejects a duplicate email (case-insensitive)", async () => {
    const s = svc();
    await s.signup({ email: "a@b.co", password: "password1" });
    await expect(s.signup({ email: "A@B.CO", password: "password2" })).rejects.toBeInstanceOf(EmailTakenError);
  });

  it("login verifies the password and returns a token", async () => {
    const s = svc();
    await s.signup({ email: "c@d.co", password: "correcthorse" });
    const { token, user } = await s.login({ email: "c@d.co", password: "correcthorse" });
    expect(user.email).toBe("c@d.co");
    expect(verifyAuthToken(token)?.userId).toBe(user.id);
  });

  it("rejects a wrong password and an unknown email", async () => {
    const s = svc();
    await s.signup({ email: "e@f.co", password: "rightpass1" });
    await expect(s.login({ email: "e@f.co", password: "wrongpass" })).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(s.login({ email: "nobody@x.co", password: "whatever1" })).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("changePassword swaps the password when the current one matches", async () => {
    const s = svc();
    const { user } = await s.signup({ email: "g@h.co", password: "oldpass12" });
    await s.changePassword(user.id, "oldpass12", "newpass34");
    // old no longer works, new does
    await expect(s.login({ email: "g@h.co", password: "oldpass12" })).rejects.toBeInstanceOf(InvalidCredentialsError);
    const ok = await s.login({ email: "g@h.co", password: "newpass34" });
    expect(ok.user.id).toBe(user.id);
  });

  it("changePassword rejects a wrong current password", async () => {
    const s = svc();
    const { user } = await s.signup({ email: "i@j.co", password: "oldpass12" });
    await expect(s.changePassword(user.id, "wrongcurrent", "newpass34")).rejects.toBeInstanceOf(InvalidCredentialsError);
  });
});

// AIC-133: user enumeration by timing. An unknown email used to return
// immediately while a known one paid ~100ms of bcrypt, so response time
// answered "does this address have an account here?" for anyone timing it.
describe("login does not leak whether an email exists", () => {
  it("takes comparable time for an unknown email and a wrong password", async () => {
    const store = new InMemoryUserStore();
    const svc = new AuthService(store);
    await svc.signup({ email: "real@example.com", password: "correct-horse", name: "R" });

    const time = async (fn: () => Promise<unknown>) => {
      const t0 = performance.now();
      await fn().catch(() => {});
      return performance.now() - t0;
    };
    const known = await time(() => svc.login({ email: "real@example.com", password: "wrong-password" }));
    const unknown = await time(() => svc.login({ email: "nobody@example.com", password: "wrong-password" }));

    // Both must actually hash. The old code returned in well under a
    // millisecond on the miss; the assertion that matters is that the unknown
    // path is no longer trivially faster, not that the two match exactly —
    // bcrypt timing varies and a strict ratio would be a flaky test.
    expect(unknown).toBeGreaterThan(known / 3);
  });
});
