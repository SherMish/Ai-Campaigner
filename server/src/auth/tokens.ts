import jwt from "jsonwebtoken";

// Our own JWT session (email+password now; Google later, AIC-30, reuses this).
// JWT_SECRET must be set — read lazily so tests can inject one.
const EXPIRES_IN = "30d";

// security audit 2026-08-25: the signing algorithm is pinned on BOTH sides. jsonwebtoken v9
// already refuses `alg: none`, so this is not the classic bypass — it is that
// a verifier which accepts whatever the TOKEN says it is has no business being
// a security boundary. Pinning makes the guarantee independent of the
// library's defaults surviving the next major version.
const ALG = "HS256" as const;

// A short secret makes HS256 brute-forceable offline from a single captured
// token, and every session in the product is one signature. Checked at first
// use rather than at import so tests can inject their own.
const MIN_SECRET_LENGTH = 32;

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  if (s.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET is too short (${s.length} chars). Use at least ${MIN_SECRET_LENGTH} ` +
        "random characters — a short HMAC secret can be brute-forced offline from one captured token.",
    );
  }
  return s;
}

export function signAuthToken(userId: string): string {
  return jwt.sign({ sub: userId }, secret(), { expiresIn: EXPIRES_IN, algorithm: ALG });
}

// AIC-189 — an admin viewing a customer's own dashboard.
//
// Half an hour, not thirty days. This token grants a real customer's data to
// somebody who is not them; it exists for the length of a look, and there is no
// reason for it to survive in a browser overnight.
//
// `imp` carries WHO is impersonating, not merely that someone is. Every refusal
// downstream can then name the admin, and an action log has something real to
// record beyond "an impersonated session".
const IMPERSONATION_EXPIRES_IN = "30m";

export function signImpersonationToken(targetUserId: string, adminUserId: string): string {
  return jwt.sign({ sub: targetUserId, imp: adminUserId }, secret(), {
    expiresIn: IMPERSONATION_EXPIRES_IN,
    algorithm: ALG,
  });
}

export interface VerifiedToken {
  userId: string;
  /** The admin viewing as this user, or null for a real session. */
  impersonatedBy: string | null;
}

export function verifyAuthToken(token: string): VerifiedToken | null {
  try {
    const payload = jwt.verify(token, secret(), { algorithms: [ALG] }) as {
      sub?: string;
      imp?: unknown;
    };
    if (!payload.sub) return null;
    return {
      userId: payload.sub,
      impersonatedBy: typeof payload.imp === "string" && payload.imp ? payload.imp : null,
    };
  } catch {
    return null;
  }
}
