import { describe, it, expect } from "vitest";
import { decodeReceipt, RECEIPT_TTL_MS, type AdditionReceipt } from "./addition-receipt";

const NOW = 1_756_000_000_000;
const ok: AdditionReceipt = { kind: "ad_set", ads: 3, live: false, at: NOW - 60_000 };
const raw = (v: unknown) => JSON.stringify(v);

describe("decodeReceipt (AIC-175)", () => {
  it("returns a fresh receipt", () => {
    // The reported case: 3 ads created, 2 still in Meta review, and the
    // customer asking "was it successful?" after the page reloaded.
    expect(decodeReceipt(raw(ok), NOW)).toEqual(ok);
  });

  it("expires rather than showing a stale success", () => {
    expect(decodeReceipt(raw({ ...ok, at: NOW - RECEIPT_TTL_MS - 1 }), NOW)).toBeNull();
    expect(decodeReceipt(raw({ ...ok, at: NOW - RECEIPT_TTL_MS + 1 }), NOW)).toEqual({ ...ok, at: NOW - RECEIPT_TTL_MS + 1 });
  });

  it("rejects a receipt dated in the future", () => {
    // A clock change, not a success.
    expect(decodeReceipt(raw({ ...ok, at: NOW + 1 }), NOW)).toBeNull();
  });

  it("rejects anything malformed instead of rendering it", () => {
    // This value survives across builds and can be hand-edited; trusting it is
    // how a banner ends up saying "undefined מודעות".
    expect(decodeReceipt(null, NOW)).toBeNull();
    expect(decodeReceipt("", NOW)).toBeNull();
    expect(decodeReceipt("{not json", NOW)).toBeNull();
    expect(decodeReceipt(raw(null), NOW)).toBeNull();
    expect(decodeReceipt(raw("nope"), NOW)).toBeNull();
    expect(decodeReceipt(raw({ ...ok, kind: "campaign" }), NOW)).toBeNull();
    expect(decodeReceipt(raw({ ...ok, ads: 0 }), NOW)).toBeNull();
    expect(decodeReceipt(raw({ ...ok, ads: "3" }), NOW)).toBeNull();
    expect(decodeReceipt(raw({ ...ok, live: "yes" }), NOW)).toBeNull();
    expect(decodeReceipt(raw({ kind: "ad", ads: 1, live: true }), NOW)).toBeNull();
  });
});
