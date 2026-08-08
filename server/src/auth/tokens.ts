import jwt from "jsonwebtoken";

// Our own JWT session (email+password now; Google later, AIC-30, reuses this).
// JWT_SECRET must be set — read lazily so tests can inject one.
const EXPIRES_IN = "30d";

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return s;
}

export function signAuthToken(userId: string): string {
  return jwt.sign({ sub: userId }, secret(), { expiresIn: EXPIRES_IN });
}

export function verifyAuthToken(token: string): { userId: string } | null {
  try {
    const payload = jwt.verify(token, secret()) as { sub?: string };
    return payload.sub ? { userId: payload.sub } : null;
  } catch {
    return null;
  }
}
