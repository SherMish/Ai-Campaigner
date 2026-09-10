import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptToken, decryptToken, tokenCryptoReady, TokenCryptoError } from "./token-crypto.js";

const KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");

describe("token-crypto", () => {
  const saved = process.env.META_TOKEN_ENC_KEY;
  beforeEach(() => { process.env.META_TOKEN_ENC_KEY = KEY; });
  afterEach(() => {
    if (saved === undefined) delete process.env.META_TOKEN_ENC_KEY;
    else process.env.META_TOKEN_ENC_KEY = saved;
  });

  it("round-trips a token", () => {
    const token = "EAAG" + "x".repeat(180);
    expect(decryptToken(encryptToken(token))).toBe(token);
  });

  it("produces different ciphertext each time for the same token", () => {
    // A deterministic ciphertext would leak that two customers connected the
    // same account, and would make the store vulnerable to replay comparison.
    const token = "EAAGsame";
    expect(encryptToken(token)).not.toBe(encryptToken(token));
  });

  it("refuses a token encrypted under a different key", () => {
    const stored = encryptToken("EAAGsecret");
    process.env.META_TOKEN_ENC_KEY = OTHER_KEY;
    expect(() => decryptToken(stored)).toThrow(TokenCryptoError);
  });

  it("refuses tampered ciphertext rather than returning garbage", () => {
    const [iv, ct, tag] = encryptToken("EAAGsecret").split(".");
    const flipped = Buffer.from(ct, "base64url");
    flipped[0] ^= 0xff;
    const tampered = [iv, flipped.toString("base64url"), tag].join(".");
    expect(() => decryptToken(tampered)).toThrow(/authentication/);
  });

  it("rejects a key that is not 32 bytes, naming the fix", () => {
    process.env.META_TOKEN_ENC_KEY = Buffer.from("too short").toString("base64");
    expect(() => encryptToken("EAAG")).toThrow(/exactly 32 bytes/);
    expect(() => encryptToken("EAAG")).toThrow(/openssl rand -base64 32/);
  });

  it("rejects a malformed stored value by shape, before decrypting", () => {
    expect(() => decryptToken("not-three-parts")).toThrow(/iv.ciphertext.tag/);
  });

  it("refuses to encrypt an empty token", () => {
    // An empty string round-trips fine and stores a credential that is not one.
    expect(() => encryptToken("")).toThrow(TokenCryptoError);
  });

  it("tokenCryptoReady reflects whether a usable key is configured", () => {
    expect(tokenCryptoReady()).toBe(true);
    delete process.env.META_TOKEN_ENC_KEY;
    expect(tokenCryptoReady()).toBe(false);
  });
});
