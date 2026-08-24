// AIC-92: are the leads INFLATED?
//
// Every other measurement check in this codebase assumes UNDER-counting — we
// see fewer leads than really happened, the engine gets too cautious, and the
// damage is bounded. Over-counting is the opposite and it compounds:
//
//   inflated leads → CPL looks excellent → the engine recommends MORE budget
//                 → more money against conversions that never happened
//                 → CPL still looks excellent → recommend more again
//
// The product would be confidently, expensively wrong while the customer's own
// phone stays silent. This is the asymmetry the ticket exists to encode: when
// measurement trust is uncertain, FAIL TOWARD NOT SPENDING.
//
// TWO SIGNALS, DELIBERATELY UNEQUAL:
//
//  A. Implausible conversion rate (decisive). leads ÷ link_clicks above a wide
//     bound. Self-contained, computed from snapshots we already store, no extra
//     Graph call.
//
//  B. Browser AND server events on the same pixel (contextual only). CAPI
//     running alongside the browser pixel is where dedup failures happen — but
//     plenty of CAPI setups dedupe correctly, so this is recorded as a probable
//     CAUSE when A fires and NEVER raises an alarm on its own. Flagging every
//     CAPI account would be a false alarm on healthy ones, the same rule
//     cta-health applies to destinations it does not model.

// The ceiling. Deliberately wide and obviously-wrong-side rather than tuned:
// the real campaigns on this account convert at 21.1% and 14.6% of link clicks,
// so 50% sits at 2.4× the highest observed healthy rate. A landing page turning
// half its clicks into leads is almost always a tracking artefact — most often
// a Lead event firing on page load instead of form submit, which produces a
// plausible-looking stream of leads at a suspiciously good CPL that nobody ever
// hears from.
export const IMPLAUSIBLE_CONVERSION_RATE = 0.5;

// Below this there is not enough traffic to judge: 2 leads on 2 clicks is 100%
// and means nothing.
export const MIN_CLICKS_TO_JUDGE = 20;

export interface OvercountInput {
  leads: number;
  linkClicks: number;
  // From aggregation=event_source. Both present ⇒ CAPI alongside the browser
  // pixel ⇒ a dedup failure is the likely explanation if the rate is also
  // implausible. Undefined when not checked (a WhatsApp campaign has no pixel).
  hasBrowserEvents?: boolean;
  hasServerEvents?: boolean;
}

export type OvercountState = "ok" | "suspected" | "unknown";

export interface OvercountSummary {
  state: OvercountState;
  reason: string | null;
  detail: Record<string, unknown>;
}

export function summarizeOvercount(input: OvercountInput): OvercountSummary {
  const { leads, linkClicks } = input;

  if (!Number.isFinite(linkClicks) || linkClicks < MIN_CLICKS_TO_JUDGE) {
    return {
      state: "unknown",
      reason: `only ${linkClicks} link clicks — too little traffic to judge the conversion rate`,
      detail: { leads, linkClicks },
    };
  }

  const rate = leads / linkClicks;
  const bothSources = input.hasBrowserEvents === true && input.hasServerEvents === true;
  const detail = {
    leads, linkClicks,
    conversionRate: Math.round(rate * 1000) / 1000,
    ceiling: IMPLAUSIBLE_CONVERSION_RATE,
    hasBrowserEvents: input.hasBrowserEvents ?? null,
    hasServerEvents: input.hasServerEvents ?? null,
    // Named only when the rate is ALSO implausible — on its own, CAPI presence
    // is not evidence of anything.
    likelyCause: null as string | null,
  };

  if (rate <= IMPLAUSIBLE_CONVERSION_RATE) {
    return { state: "ok", reason: null, detail };
  }

  detail.likelyCause = bothSources
    ? "browser and server events on the same pixel — likely a deduplication failure (event_id not matched)"
    : "a single event source — likely the lead event firing on page load rather than form submit, or a duplicate pixel install";

  return {
    state: "suspected",
    reason: `${Math.round(rate * 100)}% of link clicks are being counted as leads (${leads}/${linkClicks}) — above the ${Math.round(
      IMPLAUSIBLE_CONVERSION_RATE * 100,
    )}% plausibility ceiling`,
    detail,
  };
}
