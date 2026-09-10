import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AIC-186 — encryption at rest for customer Meta tokens.
//
// A Meta system-user access token obtained through Business Login is a live
// write credential for someone else's ad account, and it does not expire. A
// leaked database backup is therefore indefinitely exploitable, which is the
// specific reason this is not stored as plaintext.
//
// AES-256-GCM rather than CBC because GCM authenticates: a token whose
// ciphertext was tampered with fails to decrypt rather than decrypting to
// garbage we would then send to Meta as a Bearer credential.

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96 bits — the size GCM is specified for.
const TAG_BYTES = 16;

// Serialised as iv.ciphertext.tag, each base64url. Three fields rather than one
// blob so a malformed value is rejected by shape before any crypto runs, and so
// the format is readable enough to debug without decrypting anything.
const PARTS = 3;

export class TokenCryptoError extends Error {}

function key(): Buffer {
  const raw = process.env.META_TOKEN_ENC_KEY;
  if (!raw) throw new TokenCryptoError("META_TOKEN_ENC_KEY is not set");
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    throw new TokenCryptoError("META_TOKEN_ENC_KEY is not valid base64");
  }
  // A short key is the failure that looks like it works: Node would happily
  // derive something from 8 bytes and we would ship a credential store with
  // 64 bits of entropy behind it.
  if (buf.length !== KEY_BYTES) {
    throw new TokenCryptoError(
      `META_TOKEN_ENC_KEY must decode to exactly ${KEY_BYTES} bytes, got ${buf.length}. ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }
  return buf;
}

export function encryptToken(plaintext: string): string {
  if (!plaintext) throw new TokenCryptoError("refusing to encrypt an empty token");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, ciphertext, tag].map((b) => b.toString("base64url")).join(".");
}

export function decryptToken(stored: string): string {
  const parts = stored.split(".");
  if (parts.length !== PARTS) {
    throw new TokenCryptoError("stored token is not in iv.ciphertext.tag form");
  }
  const [iv, ciphertext, tag] = parts.map((p) => Buffer.from(p, "base64url"));
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new TokenCryptoError("stored token has a malformed iv or auth tag");
  }
  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // GCM's whole point. Wrong key, or altered ciphertext — both mean we do not
    // have the token, and neither is a case where returning something is safe.
    throw new TokenCryptoError("token failed authentication — wrong key or tampered ciphertext");
  }
}

// Whether encryption is configured at all. The OAuth routes refuse to start a
// flow they could not finish: discovering at the CALLBACK that we cannot store
// the token means the customer has already granted access we then throw away.
export function tokenCryptoReady(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}
