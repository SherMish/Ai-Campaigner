import { describe, it, expect, beforeAll } from "vitest";
import { InMemoryUserStore } from "./user-store.js";
import { AuthService, EmailTakenError, InvalidCredentialsError } from "./auth-service.js";
import { verifyAuthToken } from "./tokens.js";

beforeAll(() => {
  process.env.JWT_SECRET = "test-secret-for-auth-unit";
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
