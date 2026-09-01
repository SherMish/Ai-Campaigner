import { describe, it, expect, vi } from "vitest";
import { GraphWriteError } from "./campaign-adapter.js";
import { isMetaThrottled, respondIfMetaThrottled } from "./throttle-response.js";

function res() {
  const r = { code: 0, body: null as unknown };
  return {
    status(c: number) { r.code = c; return this; },
    json(b: unknown) { r.body = b; return this; },
    _: r,
  };
}

const throttle = () =>
  new GraphWriteError(
    "GET x/adsets → 400 …", 400, 17, 2446079, false,
    "Ad Account Has Too Many API Calls",
    "There have been too many calls from this ad-account. Please wait a bit and try again.",
  );

describe("Meta throttle responses (AIC-168)", () => {
  it("answers 429 with Meta's own sentence and a code the UI can localize", () => {
    // The reported case: a customer clicked הפעלת המודעה during a throttle and
    // got "לא הצלחנו לבצע את השינוי" — no reason, no sense of how long, and
    // the reasonable conclusion that the product is broken.
    const r = res();
    expect(respondIfMetaThrottled(r as never, throttle())).toBe(true);
    expect(r._.code).toBe(429); // NOT 502 — Meta is not broken, it is busy
    expect(r._.body).toMatchObject({ code: "meta_rate_limited" });
    expect(String((r._.body as { error: string }).error)).toContain("wait a bit");
  });

  it("leaves every other failure to the route's own handling", () => {
    const r = res();
    // A different Graph error…
    expect(respondIfMetaThrottled(r as never, new GraphWriteError("x", 400, 100, null, false, "t", "m"))).toBe(false);
    // …a plain Error…
    expect(respondIfMetaThrottled(r as never, new Error("boom"))).toBe(false);
    // …and a non-error.
    expect(respondIfMetaThrottled(r as never, "boom")).toBe(false);
    expect(r._.code).toBe(0); // never answered
  });

  it("isMetaThrottled keys on the CODE, not the message", () => {
    // Meta's wording is not ours to depend on; the numeric code is the
    // contract, and it is the only thing separating "wait" from "something is
    // wrong" — two situations needing opposite responses.
    expect(isMetaThrottled(throttle())).toBe(true);
    expect(isMetaThrottled(new GraphWriteError("User request limit reached", 400, 100, null, false, "t", "m"))).toBe(false);
  });
});
