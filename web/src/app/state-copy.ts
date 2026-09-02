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
  not_spending: { badge: h.states.notSpending.badge, title: h.states.notSpending.title, body: h.states.notSpending.body },
  delivery: { badge: h.states.delivery.badge, title: h.states.delivery.title, body: h.states.delivery.body },
  tracking: { badge: h.states.tracking.badge, title: h.states.tracking.title, body: h.states.tracking.body },
  cta: { badge: h.states.cta.badge, title: h.states.cta.title, body: h.states.cta.body },
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
  unbuilt: h.states.unbuilt.badge,
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
/**
 * The `collecting` card, told with the actual numbers.
 *
 * The engine stores exactly which minimum-evidence gate is unmet and by how
 * much (`evidenceGapDetail`); the copy used to discard all of it and say "עוד
 * קצת פעילות ונוכל להמליץ בביטחון" — a sentence that can sit unchanged on the
 * screen for three weeks while the customer has no idea whether anything is
 * moving. A number they can watch approach is the difference between waiting
 * and being strung along.
 *
 * The gate named is the one FURTHEST from being met, measured as a share of
 * what it needs — naming the nearest would promise an answer sooner than it
 * can arrive.
 *
 * Falls back to the generic copy when the detail is absent (an older row, or a
 * reason recorded before this existed), rather than inventing a number.
 */
export function collectingCopy(
  detail: Record<string, unknown> | null | undefined,
  // The lead count the customer can SEE on this screen. The engine evaluates
  // complete days only, so a lead that arrived today is real, visible in the
  // KPI, and still absent from `leadsSoFar` — which rendered "יש 0 מתוך 5
  // פניות" directly above a card reading "1 פנייה". Caught in the browser on a
  // live account.
  //
  // The visible number wins when it is higher. The engine will act a day later
  // than this sentence implies, and that is the right way round: telling a
  // customer they have none of the leads they can see on the screen destroys
  // trust in every other number we show, while being a day early costs
  // nothing.
  visibleLeads?: number | null,
): NoRecCopy {
  const num = (k: string): number | null => (typeof detail?.[k] === "number" ? (detail[k] as number) : null);
  const storedLeads = num("leadsSoFar");
  const leadsSoFar =
    storedLeads === null ? null : typeof visibleLeads === "number" ? Math.max(storedLeads, visibleLeads) : storedLeads;
  const gaps = [
    { kind: "leads" as const, have: leadsSoFar, need: num("leadsNeeded") },
    { kind: "days" as const, have: num("daysSoFar"), need: num("daysNeeded") },
    { kind: "delivery" as const, have: num("deliveryDaysSoFar"), need: num("deliveryDaysNeeded") },
  ].filter((g): g is { kind: "leads" | "days" | "delivery"; have: number; need: number } =>
    g.have !== null && g.need !== null && g.need > 0 && g.have < g.need,
  );
  if (gaps.length === 0) return h.noRec.collecting;

  const worst = gaps.reduce((a, b) => (a.have / a.need <= b.have / b.need ? a : b));
  return h.noRec.collectingSpecific[worst.kind](worst.have, worst.need);
}

/**
 * AIC-143 — the third line: what has to be true before we can say anything,
 * with its number.
 *
 * "עוד מוקדם" is a non-answer in polite clothes. A shekel figure is a
 * commitment the customer can hold us to, and it turns "is this working?" from
 * a feeling into a countdown. The engine's evidence gates already carry these
 * numbers — until now they simply never reached the screen.
 *
 * Returns null where no numeric threshold exists for the reason, rather than
 * inventing one. `collecting` returns null too: its own copy already carries
 * the gate and the number, and repeating it would read as two demands.
 */
export function thresholdLine(
  reason: NoActionReason | null,
  detail: Record<string, unknown> | null | undefined,
  shekels: (agorot: number) => string,
): string | null {
  const required = typeof detail?.requiredSpendAgorot === "number" ? (detail.requiredSpendAgorot as number) : null;
  if (required === null) return null;
  if (reason === "below_object_evidence_floor") return h.heroThresholdSpendPerAd(shekels(required));
  if (reason === "budget_below_threshold") return h.heroThresholdBudget(shekels(required));
  return null;
}

/**
 * How loudly a no-recommendation state should be presented.
 *
 * AIC-143, second pass. The first pass kept a full-size hero card for every
 * reason and worked on making its sentence better. That was the wrong lever:
 * a big card is a claim on the customer's attention, and most of these reasons
 * have no claim to make. "Nothing should change right now" is a legitimate
 * engine conclusion, and it should read as calm professional judgement — not
 * as a product waiting for a counter to reach five.
 *
 *   problem — something is broken or costing money. Prominent.
 *   action  — the customer has to do something. Prominent, with a CTA.
 *   quiet   — nothing for them to do. One line, no card.
 *
 * Exhaustive on purpose: a new reason cannot ship without someone deciding how
 * much of the customer's attention it deserves.
 */
export type HeroTone = "problem" | "action" | "quiet";

export const HERO_TONE: Record<NoActionReason, HeroTone> = {
  // Money is being spent into a hole, or the numbers themselves are wrong.
  account_cannot_spend: "problem",
  lead_event_stopped: "problem",
  // Routed to the attention badge before they reach here, but classified
  // anyway — reachability is a routing detail a refactor can change.
  delivery_blocked: "problem",
  tracking_broken: "problem",
  cta_broken: "problem",
  // The one thing on this list the customer alone can fix.
  budget_below_threshold: "action",
  // Ours to fix, not theirs — so it does not get to interrupt them.
  profile_incomplete: "quiet",
  // All of these mean "we are watching and it is fine / too early". None of
  // them is worth a card.
  stable: "quiet",
  collecting: "quiet",
  cooling_down: "quiet",
  no_comparable_creatives: "quiet",
  no_comparable_audiences: "quiet",
  below_object_evidence_floor: "quiet",
};

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
  cta_broken: h.noRec.ctaBroken,
  account_cannot_spend: h.noRec.accountCannotSpend,
  lead_event_stopped: h.noRec.leadEventStopped,
  profile_incomplete: h.noRec.profileIncomplete,
  no_comparable_audiences: h.noRec.noComparableAudiences,
  cooling_down: h.noRec.coolingDown,
  below_object_evidence_floor: h.noRec.belowObjectEvidenceFloor,
  no_comparable_creatives: h.noRec.noComparableCreatives,
};

// `null` is legitimately "the engine hasn't classified anything yet" (before
// its first tick for this campaign) — a real state with its own honest copy,
// not an unknown value being swallowed.
export function noRecCopy(
  reason: NoActionReason | null,
  detail?: Record<string, unknown> | null,
  visibleLeads?: number | null,
): NoRecCopy {
  if (reason === null) return { title: h.noActionTitle, body: h.noAction };
  // `collecting` is the one reason whose honest wording depends on HOW MUCH is
  // still missing — every other reason is the same sentence whatever the
  // numbers behind it.
  if (reason === "collecting") return collectingCopy(detail, visibleLeads);
  return NO_REC_COPY[reason];
}

// AIC-97 — the "מצב" badge's info popover. Not simply HomeState: `attention`
// carries 3 distinguishable causes and `no_campaign` carries 2 (still
// onboarding vs. connected-and-ready-to-build) — 10 real states, not 7. This
// mirrors hero()'s own branching in Home.tsx exactly, so the badge and its
// popover can never describe two different situations.
export type StatusTooltipKey =
  | "ok" | "collecting" | "paused" | "stopped" | "ready_to_launch"
  | "no_campaign_setup" | "no_campaign_ready_to_build" | "unbuilt"
  | "attention_connection" | "attention_tracking" | "attention_delivery" | "attention_cta"
  | "attention_not_spending"; // AIC-182

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
    case "unbuilt": return "unbuilt";
    case "attention": {
      const kind = attentionKind ?? "connection";
      switch (kind) {
        case "connection": return "attention_connection";
        case "not_spending": return "attention_not_spending";
        case "tracking": return "attention_tracking";
        case "cta": return "attention_cta";
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
  unbuilt: st.unbuilt,
  no_campaign_setup: st.noCampaignSetup,
  no_campaign_ready_to_build: st.noCampaignReadyToBuild,
  attention_not_spending: st.attentionNotSpending, // AIC-182
  attention_connection: st.attentionConnection,
  attention_tracking: st.attentionTracking,
  attention_cta: st.attentionCta,
  attention_delivery: st.attentionDelivery,
};
