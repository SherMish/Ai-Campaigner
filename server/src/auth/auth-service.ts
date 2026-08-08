import { hashPassword, verifyPassword } from "./passwords.js";
import { signAuthToken } from "./tokens.js";
import { DuplicateEmailError, type AppUser, type UserStore } from "./user-store.js";

export class EmailTakenError extends Error {
  constructor() { super("email already registered"); this.name = "EmailTakenError"; }
}
export class InvalidCredentialsError extends Error {
  constructor() { super("invalid credentials"); this.name = "InvalidCredentialsError"; }
}

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

  async login(input: { email: string; password: string }): Promise<AuthResult> {
    const rec = await this.store.findByEmail(normalizeEmail(input.email));
    // Verify even on a miss would be ideal to avoid user enumeration by timing;
    // bcrypt.compare against a dummy keeps timing closer. Kept simple for P0.
    if (!rec) throw new InvalidCredentialsError();
    if (!(await verifyPassword(input.password, rec.passwordHash))) throw new InvalidCredentialsError();
    const { passwordHash, ...user } = rec;
    void passwordHash;
    return { user, token: signAuthToken(user.id) };
  }
}
