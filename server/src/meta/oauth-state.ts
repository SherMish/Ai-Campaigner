import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// AIC-186 — the `state` parameter, which here carries identity as well as CSRF.
//
// Our session is a JWT in an Authorization header. A browser sends no such
// header on a top-level navigation, so when Meta redirects the customer back to
// us there is nothing in the request that says who they are — except `state`.
//
// That makes `state` load-bearing in a way the usual CSRF-nonce advice does not
// cover, and it has to resist three separate things:
//
//   forgery  — HMAC over (nonce, userId) with our own secret.
//   replay   — the nonce is spent in the database on first use (see the store).
//   staleness— a TTL, because an abandoned consent screen should not leave a
//              valid credential-binding token lying in someone's history.
//
// Signing is HMAC rather than a JWT deliberately: a JWT here would be a second
// token format that looks like our session token, and the failure mode of
// confusing the two is a session forged from an OAuth state.

const TTL_MINUTES = 15;
const NONCE_BYTES = 24;
const SEP = ".";

export interface StatePayload {
  nonce: string;
  userId: string;
}

export class StateError extends Error {}

function secret(): string {
  // Reuses JWT_SECRET's guarantees (present, ≥32 chars — enforced in
  // auth/tokens.ts) rather than adding a second secret to rotate. Domain-
  // separated below so a state can never be presented as a session.
  const s = process.env.JWT_SECRET;
  if (!s) throw new StateError("JWT_SECRET is not set");
  return s;
}

function sign(nonce: string, userId: string): string {
  return createHmac("sha256", secret())
    .update(`meta-oauth-state${SEP}${nonce}${SEP}${userId}`)
    .digest("base64url");
}

export function mintState(userId: string, now = new Date()): {
  state: string;
  nonce: string;
  expiresAt: Date;
} {
  const nonce = randomBytes(NONCE_BYTES).toString("base64url");
  const state = [nonce, userId, sign(nonce, userId)].join(SEP);
  return { state, nonce, expiresAt: new Date(now.getTime() + TTL_MINUTES * 60_000) };
}

// Signature-checks the state and returns what it claims. Says nothing about
// whether the nonce has already been spent — that is the store's answer, and
// keeping the two separate is what lets this half be a pure function.
export function parseState(state: string): StatePayload {
  const parts = state.split(SEP);
  if (parts.length !== 3) throw new StateError("state is malformed");
  const [nonce, userId, mac] = parts;
  if (!nonce || !userId || !mac) throw new StateError("state is malformed");

  const expected = Buffer.from(sign(nonce, userId));
  const given = Buffer.from(mac);
  // Length check first: timingSafeEqual throws on a length mismatch rather
  // than returning false, and an exception here would be a 500 for input an
  // attacker controls.
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new StateError("state signature does not verify");
  }
  return { nonce, userId };
}
