import { assertNever } from "@aic/shared";
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

// AIC-97 — the "מצב" badge's info popover. Not simply HomeState: `attention`
// carries 3 distinguishable causes and `no_campaign` carries 2 (still
// onboarding vs. connected-and-ready-to-build) — 10 real states, not 7. This
// mirrors hero()'s own branching in Home.tsx exactly, so the badge and its
// popover can never describe two different situations.
export type StatusTooltipKey =
  | "ok" | "collecting" | "paused" | "stopped" | "ready_to_launch"
  | "no_campaign_setup" | "no_campaign_ready_to_build"
  | "attention_connection" | "attention_tracking" | "attention_delivery";

export function statusTooltipKey(
  state: HomeState,
  attentionKind: AttentionKind | null,
  readyToBuild: boolean,
): StatusTooltipKey {
  switch (state) {
    case "ok": return "ok";
    case "collecting": return "collecting";
    case "paused": return "paused";
    case "stopped": return "stopped";
    case "ready_to_launch": return "ready_to_launch";
    case "no_campaign": return readyToBuild ? "no_campaign_ready_to_build" : "no_campaign_setup";
    case "attention": {
      const kind = attentionKind ?? "connection";
      switch (kind) {
        case "connection": return "attention_connection";
        case "tracking": return "attention_tracking";
        case "delivery": return "attention_delivery";
        default: return assertNever(kind, "AttentionKind");
      }
    }
    default:
      return assertNever(state, "HomeState");
  }
}

export interface StatusTooltipCopy {
  meaning: string;
  spend: string;
  whoActs: string;
}

const st = strings.he.app.home.statusTooltip;

// Every tooltip answers the same three questions in the same order (the
// ticket's own design constraint): what it means, is budget being spent
// right now, and who acts next. The three `attention` causes and the two
// `no_campaign` variants each get distinct meaning+whoActs text — same
// underlying badge, genuinely different situations.
export const STATUS_TOOLTIP_COPY: Record<StatusTooltipKey, StatusTooltipCopy> = {
  ok: st.ok,
  collecting: st.collecting,
  paused: st.paused,
  stopped: st.stopped,
  ready_to_launch: st.readyToLaunch,
  no_campaign_setup: st.noCampaignSetup,
  no_campaign_ready_to_build: st.noCampaignReadyToBuild,
  attention_connection: st.attentionConnection,
  attention_tracking: st.attentionTracking,
  attention_delivery: st.attentionDelivery,
};
