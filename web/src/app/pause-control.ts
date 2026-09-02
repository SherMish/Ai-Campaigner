// AIC-179 — what the pause control offers when we could not read the status.
//
// Found live: the whole control VANISHED. `/controls/state` is a live Meta
// read, Meta throttled the ad account (code 17), `ctl` came back null — and
// Home rendered the badge "לא ידוע כרגע" with no button beside it at all.
//
// So at the exact moment an operator most wants to stop spend, the product
// silently removed the ability to. That is the AIC-155/163/173 shape again,
// in its most expensive place: not a control that refuses without saying why,
// but a control that is not there to refuse.
//
// The insight is that PAUSING NEVER NEEDED THE STATUS. Reading is what failed;
// writing is unaffected, and pausing something already paused is harmless and
// idempotent. Only the toggle DIRECTION depended on the read, so only the
// direction should degrade.

export type PauseAction = "pause" | "resume";

/**
 * Which direction the control offers.
 *
 * Unknown status ⇒ "pause", deliberately, and never "resume": pausing an
 * already-paused object costs nothing, while resuming something the customer
 * had deliberately paused — because we guessed at a status we admit we could
 * not read — spends real money against their intent.
 */
export function pauseAction(input: { paused: boolean; statusUnknown: boolean }): PauseAction {
  if (input.statusUnknown) return "pause";
  return input.paused ? "resume" : "pause";
}

export type PauseNote = "status_unknown" | "ad_set_scope" | "resume" | "already_not_delivering";

/**
 * The one line under the control, or null. Ordered by what most changes the
 * customer's expectation of what the click will do.
 *
 * `status_unknown` outranks everything: every other note describes a state we
 * are claiming to know, and we have just admitted we do not.
 */
export function pauseNote(input: {
  kind: "ad" | "ad_set";
  paused: boolean;
  statusUnknown: boolean;
  alreadyNotDelivering?: boolean;
}): PauseNote | null {
  if (input.statusUnknown) return "status_unknown";
  if (input.paused) return "resume";
  if (input.kind === "ad_set") return "ad_set_scope";
  if (input.alreadyNotDelivering) return "already_not_delivering";
  return null;
}
