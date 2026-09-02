import { describe, it, expect } from "vitest";
import { pauseAction, pauseNote } from "./pause-control";

describe("pauseAction (AIC-179)", () => {
  it("offers PAUSE when the status could not be read — never resume", () => {
    // The lived case: Meta throttled /controls/state, ctl was null, and the
    // control disappeared. Pausing never needed the status; only the toggle
    // direction did.
    //
    // Resume is the dangerous guess: it spends real money against a customer
    // who may have paused deliberately. Pause on something already paused is
    // idempotent and costs nothing.
    expect(pauseAction({ paused: false, statusUnknown: true })).toBe("pause");
    expect(pauseAction({ paused: true, statusUnknown: true })).toBe("pause");
  });

  it("toggles normally when the status is known", () => {
    expect(pauseAction({ paused: false, statusUnknown: false })).toBe("pause");
    expect(pauseAction({ paused: true, statusUnknown: false })).toBe("resume");
  });
});

describe("pauseNote (AIC-179)", () => {
  it("says the status is unreadable before anything else", () => {
    // Every other note asserts a state we know. Having just admitted we could
    // not read it, claiming one would be the contradiction AIC-169 fixed for
    // the badge directly above this control.
    expect(pauseNote({ kind: "ad_set", paused: true, statusUnknown: true })).toBe("status_unknown");
    expect(pauseNote({ kind: "ad", paused: false, statusUnknown: true, alreadyNotDelivering: true })).toBe("status_unknown");
  });

  it("keeps the existing notes when the status is known", () => {
    expect(pauseNote({ kind: "ad_set", paused: false, statusUnknown: false })).toBe("ad_set_scope");
    expect(pauseNote({ kind: "ad", paused: true, statusUnknown: false })).toBe("resume");
    expect(pauseNote({ kind: "ad", paused: false, statusUnknown: false, alreadyNotDelivering: true })).toBe("already_not_delivering");
    expect(pauseNote({ kind: "ad", paused: false, statusUnknown: false })).toBeNull();
  });
});
