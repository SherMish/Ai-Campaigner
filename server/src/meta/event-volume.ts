// AIC-91: the pixel is alive, but the LEAD EVENT stopped firing.
//
// The gap tracking-health explicitly left open. That check compares the
// campaign's declared lead definition against the ad sets' Meta configuration —
// it catches a WRONG or MISSING lead type, and cannot catch a CORRECTLY
// declared one whose event silently stopped (a deploy that dropped the pixel
// call from the thank-you page, a consent banner change, a broken form).
//
// WHY THIS IS TRACTABLE WHERE THE ORIGINAL STATS IDEA WAS NOT. The AIC-88
// review rejected a stats-based signal because "the lead event hasn't fired" is
// indistinguishable from "nobody has converted yet" — true, and fatal, for a
// bare zero. The distinction that makes it real is comparative, and needs BOTH
// halves:
//
//   1. the pixel is demonstrably ALIVE right now — other events are firing —
//      which rules out "no traffic" and "pixel removed entirely";
//   2. the lead event DID fire in the earlier window, which rules out "never
//      worked yet" and "campaign too young".
//
// Only when both hold does a zero mean something stopped. Absent either, the
// answer is `unknown` or `not_applicable` — never `broken`.
//
// WINDOW LENGTH IS THE WHOLE DESIGN, and it was chosen against real data rather
// than picked. On the live Pisga pixel, CompleteRegistration fired 2/2/8/6 on
// Aug 18–22 and then zero on the 23rd and 24th while PageView kept firing. A
// 2-day window calls that broken; it is far more likely an ordinary quiet
// stretch. Three COMPLETE days is the shortest window that stays quiet on that
// real sequence, and today is excluded because a partial day always under-reads.

export interface EventDayCount {
  day: string; // YYYY-MM-DD
  event: string;
  count: number;
}

export interface EventVolumeReader {
  // Per-event daily counts for a pixel, oldest first.
  getPixelEventCounts(pixelId: string, sinceUnix: number): Promise<EventDayCount[]>;
}

export type EventVolumeState = "ok" | "broken" | "unknown" | "not_applicable";

export interface EventVolumeSummary {
  state: EventVolumeState;
  reason: string | null;
  detail: Record<string, unknown>;
}

export interface EventVolumeInput {
  counts: EventDayCount[];
  // The event that IS the lead for this campaign, derived from the campaign's
  // lead_event_types (AIC-87) — e.g. "CompleteRegistration".
  leadEvent: string | null;
  // Complete days to judge; today is deliberately excluded by the caller.
  recentDays?: number;
  priorDays?: number;
  // "today" for window math, injectable for tests.
  ref?: Date;
}

const DEFAULT_RECENT_DAYS = 3;
const DEFAULT_PRIOR_DAYS = 14;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBack(ref: Date, n: number): string {
  return isoDay(new Date(ref.getTime() - n * 24 * 60 * 60 * 1000));
}

export function summarizeEventVolume(input: EventVolumeInput): EventVolumeSummary {
  const leadEvent = input.leadEvent;
  // A Click-to-WhatsApp campaign has no pixel event to watch. Not "ok" — there
  // is no check to have passed.
  if (!leadEvent) {
    return { state: "not_applicable", reason: "campaign has no pixel lead event", detail: {} };
  }
  if (input.counts.length === 0) {
    return { state: "unknown", reason: "no pixel data available", detail: {} };
  }

  const ref = input.ref ?? new Date();
  const recentDays = input.recentDays ?? DEFAULT_RECENT_DAYS;
  const priorDays = input.priorDays ?? DEFAULT_PRIOR_DAYS;

  // Complete days only: yesterday back through `recentDays`. Today is excluded
  // because a partial day always under-reads and would fire this check every
  // morning.
  const recentStart = daysBack(ref, recentDays);
  const recentEnd = daysBack(ref, 1);
  const priorStart = daysBack(ref, recentDays + priorDays);
  const priorEnd = daysBack(ref, recentDays + 1);

  const inRange = (day: string, a: string, b: string) => day >= a && day <= b;

  let recentLead = 0, recentOther = 0, priorLead = 0;
  for (const c of input.counts) {
    if (inRange(c.day, recentStart, recentEnd)) {
      if (c.event === leadEvent) recentLead += c.count;
      else recentOther += c.count;
    } else if (inRange(c.day, priorStart, priorEnd)) {
      if (c.event === leadEvent) priorLead += c.count;
    }
  }

  const detail = { leadEvent, recentLead, recentOther, priorLead, recentStart, recentEnd, priorStart, priorEnd };

  // The lead event is still arriving — nothing to say.
  if (recentLead > 0) return { state: "ok", reason: null, detail };

  // Nothing at all is firing. That is a dead or removed pixel, not a stopped
  // event — a different failure, and one this check must not claim to have
  // diagnosed.
  if (recentOther === 0) {
    return { state: "unknown", reason: "the pixel recorded no events at all in the window", detail };
  }

  // It never fired in the earlier window either, so there is no "stopped" to
  // report — the campaign may simply not have converted yet.
  if (priorLead === 0) {
    return { state: "unknown", reason: `no ${leadEvent} in either window — nothing to compare against`, detail };
  }

  return {
    state: "broken",
    reason: `${leadEvent} fired ${priorLead}× in the previous ${priorDays} days but 0× in the last ${recentDays}, while the pixel recorded ${recentOther} other events — the lead event has stopped`,
    detail,
  };
}
