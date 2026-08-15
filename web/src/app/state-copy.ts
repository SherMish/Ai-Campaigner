import { strings } from "../strings";
import type { AttentionKind, HomeState, NoActionReason } from "../api";

// AIC-98 — the enforcement half of CLAUDE.md's "never render a blank where a
// reason exists". Every customer-visible enum binds to its copy through an
// EXHAUSTIVE `Record`, so adding a variant without its message is a `tsc`
// failure rather than a blank card someone finds in a screenshot months later.
//
// The Hebrew still lives in strings.ts (house rule: no hard-coded copy in
// components). What lives here is the reason → copy BINDING, which is the part
// that silently rots: strings.ts can't tell you a key is missing, and a
// `switch` with a `default:` will happily absorb a brand-new variant into the
// generic fallback. See state-copy.test.ts for the non-empty/distinct guard —
// `Record` catches a missing key, not an empty or copy-pasted one.

const h = strings.he.app.home;

export interface HeroCopy {
  badge: string;
  title: string;
  body: string;
}

// The three causes behind the `attention` state. They all wear the same
// "צריך טיפול" badge, which is exactly why their titles/bodies must stay
// distinct — collapsing them destroys the only actionable part (a lost
// connection is the customer's to fix; the other two are ours).
export const ATTENTION_COPY: Record<AttentionKind, HeroCopy> = {
  connection: { badge: h.states.attention.badge, title: h.states.attention.title, body: h.states.attention.body },
  delivery: { badge: h.states.delivery.badge, title: h.states.delivery.title, body: h.states.delivery.body },
  tracking: { badge: h.states.tracking.badge, title: h.states.tracking.title, body: h.states.tracking.body },
};

// Badge per home state. `ok`/`collecting` take their title+body from
// NO_REC_COPY instead (so the hero and the "why (not)" card can never
// disagree — see Home.tsx), but every state still owns its own badge.
export const HOME_STATE_BADGE: Record<HomeState, string> = {
  ok: h.states.ok.badge,
  collecting: h.states.collecting.badge,
  paused: h.states.paused.badge,
  attention: h.states.attention.badge,
  no_campaign: h.states.setup.badge,
  ready_to_launch: h.states.readyToLaunch.badge,
  stopped: h.states.stopped.badge,
};

export interface NoRecCopy {
  title: string;
  body: string;
  cta?: { to: string; label: string };
}

// Why the engine proposed nothing. Previously a `switch` whose `default:`
// swallowed anything unrecognised into a generic "we're watching the
// campaign" — so `delivery_blocked` and `tracking_broken` (both real, both
// reachable) rendered a message that was, for them, false: we are NOT simply
// watching, something is broken and we know what. Now exhaustive.
export const NO_REC_COPY: Record<NoActionReason, NoRecCopy> = {
  stable: h.noRec.stable,
  collecting: h.noRec.collecting,
  budget_below_threshold: {
    ...h.noRec.budgetBelowThreshold,
    cta: { to: "/app/settings", label: h.noRec.budgetBelowThreshold.cta },
  },
  // Both of these route the campaign to `attention` before this card renders
  // (deriveHomeState). Kept honest rather than absent: the rule is that a
  // reason ALWAYS has copy — "unreachable today" is a routing detail that a
  // future refactor can quietly change.
  delivery_blocked: h.noRec.deliveryBlocked,
  tracking_broken: h.noRec.trackingBroken,
  no_comparable_audiences: h.noRec.noComparableAudiences,
  cooling_down: h.noRec.coolingDown,
  below_object_evidence_floor: h.noRec.belowObjectEvidenceFloor,
  no_comparable_creatives: h.noRec.noComparableCreatives,
};

// `null` is legitimately "the engine hasn't classified anything yet" (before
// its first tick for this campaign) — a real state with its own honest copy,
// not an unknown value being swallowed.
export function noRecCopy(reason: NoActionReason | null): NoRecCopy {
  if (reason === null) return { title: h.noActionTitle, body: h.noAction };
  return NO_REC_COPY[reason];
}
