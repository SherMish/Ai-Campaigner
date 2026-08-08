import bcrypt from "bcryptjs";

// Passwords are bcrypt-hashed (pure-JS bcryptjs — no native build). Never store
// or log plaintext.
const ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
