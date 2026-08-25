import { hashPassword, verifyPassword } from "./passwords.js";
import { signAuthToken } from "./tokens.js";
import { DuplicateEmailError, type AppUser, type UserStore } from "./user-store.js";

export class EmailTakenError extends Error {
  constructor() { super("email already registered"); this.name = "EmailTakenError"; }
}
export class InvalidCredentialsError extends Error {
  constructor() { super("invalid credentials"); this.name = "InvalidCredentialsError"; }
}

// A valid bcrypt-12 digest of a random string kept nowhere else, so no supplied
// password can match it. Its only job is to cost the same as a real comparison.
const DUMMY_HASH = "$2a$12$C6UzMDM.H6dfI/f/IKcEe.9x0Xg6YkkVv3lUxV2XKDbSXbjqzYRnq";

export interface AuthResult {
  user: AppUser;
  token: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class AuthService {
  constructor(private readonly store: UserStore) {}

  async signup(input: { email: string; password: string; name?: string }): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    if (await this.store.findByEmail(email)) throw new EmailTakenError();
    const passwordHash = await hashPassword(input.password);
    try {
      const user = await this.store.create({ email, passwordHash, name: (input.name ?? "").trim() });
      return { user, token: signAuthToken(user.id) };
    } catch (e) {
      if (e instanceof DuplicateEmailError) throw new EmailTakenError(); // lost the race
      throw e;
    }
  }

  // Change the password of an already-authenticated user (AIC-24). Requires the
  // current password to match — a wrong one is InvalidCredentialsError.
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const rec = await this.store.findByIdWithHash(userId);
    if (!rec) throw new InvalidCredentialsError();
    if (!(await verifyPassword(currentPassword, rec.passwordHash))) throw new InvalidCredentialsError();
    await this.store.updatePassword(userId, await hashPassword(newPassword));
  }

  async login(input: { email: string; password: string }): Promise<AuthResult> {
    const rec = await this.store.findByEmail(normalizeEmail(input.email));
    // security audit 2026-08-25: user enumeration by TIMING. The old code returned immediately on
    // an unknown email and ran bcrypt (~100ms at 12 rounds) on a known one, so
    // the response time answered "does this address have an account here?" for
    // anyone willing to time it — worth real money to a competitor and a
    // ready-made target list for a phishing run.
    //
    // The comment here used to describe this exact fix as "would be ideal…
    // kept simple for P0", which is how a known gap becomes a permanent one.
    //
    // Hashing against a dummy on the miss path makes both branches pay the same
    // cost. The hash is a real bcrypt digest of a value nothing can equal, so
    // the comparison always fails and always takes the full time.
    if (!rec) {
      await verifyPassword(input.password, DUMMY_HASH);
      throw new InvalidCredentialsError();
    }
    if (!(await verifyPassword(input.password, rec.passwordHash))) throw new InvalidCredentialsError();
    const { passwordHash, ...user } = rec;
    void passwordHash;
    return { user, token: signAuthToken(user.id) };
  }
}
