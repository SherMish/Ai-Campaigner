import Mixpanel from "mixpanel";

// AIC-28 — the measurement layer, server side.
//
// WHY THE SERVER OWNS THE FUNNEL. The ticket carries a scar from Pisga
// (PIS-27): activation milestones were fired from the UI at the moment a
// customer *reached a phase*, so they counted intentions rather than outcomes
// and over-reported activation for a month. Every funnel event here is
// therefore emitted from the code path that performs the real state
// transition — after the row is written, never on a click — so the numbers are
// reconstructable from the database and cannot disagree with it.
//
// The browser SDK still exists (web/src/analytics.ts) for identity and page
// views. It is deliberately NOT where the funnel is measured.
//
// THREE RULES THIS MODULE ENFORCES SO CALL SITES CANNOT GET THEM WRONG:
//
//   1. Never throws, never blocks. Analytics failing must never fail a
//      customer's request. Every call is fire-and-forget inside a catch.
//   2. Never sends PII. Emails, names, phone numbers and WhatsApp numbers are
//      all over this domain, and they must not land in event properties —
//      those cannot be selectively deleted later. Enforced by a scrubber, not
//      by remembering.
//   3. Never counts our own accounts. `is_test` already excludes Pisga and the
//      beta rows from growth stats; analytics honours the same boundary, or
//      our dogfooding becomes the activation funnel.
//
// Inert without MIXPANEL_TOKEN, like every other integration in this codebase
// (Telegram, Meta): no token → no client → every call is a silent no-op, so
// local and CI runs never emit anything.

let client: Mixpanel.Mixpanel | null = null;
let initialised = false;

function mp(): Mixpanel.Mixpanel | null {
  if (initialised) return client;
  initialised = true;
  const token = process.env.MIXPANEL_TOKEN;
  if (!token) return null;
  client = Mixpanel.init(token, {
    // Server-side events carry no browser context, so let Mixpanel geolocate
    // from nothing rather than attributing every customer to Railway's region.
    geolocate: false,
  });
  return client;
}

/** Exported for tests — the module caches its client on first use. */
export function __resetMixpanelForTest(): void {
  client = null;
  initialised = false;
}

// Property keys that must never leave our database, matched case-insensitively
// against the whole key so `contact_email`, `businessName` and `whatsapp` are
// all caught. A blocked key is DROPPED, and its name recorded under
// `scrubbed_properties` so the omission is visible in Mixpanel rather than
// silent.
const PII_PATTERN = /email|phone|whatsapp|name|address|token|password|secret/i;

// `businessCategory` is a legitimate analytic dimension that happens to match
// /name/. Allow-listed explicitly rather than weakening the pattern.
const ALLOWED_DESPITE_PATTERN = new Set(["business_category", "campaign_objective"]);

export type EventProps = Record<string, string | number | boolean | null | undefined>;

export function scrubProps(props: EventProps): EventProps {
  const clean: EventProps = {};
  const scrubbed: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (!ALLOWED_DESPITE_PATTERN.has(k) && PII_PATTERN.test(k)) {
      scrubbed.push(k);
      continue;
    }
    clean[k] = v;
  }
  if (scrubbed.length > 0) clean.scrubbed_properties = scrubbed.join(",");
  return clean;
}

export interface TrackInput {
  /** snake_case, past tense: `recommendation_approved`, not `Approve Rec`. */
  event: string;
  /**
   * The CUSTOMER id — a stable uuid, never an email. One Mixpanel profile per
   * business, which is the unit this product is actually about: a customer is
   * an account with a campaign, and its several logins are the same subject.
   */
  customerId: string;
  /** True for our own rows (Pisga, betas). Their events are dropped. */
  isTest?: boolean;
  props?: EventProps;
}

/**
 * Record one funnel event. Safe to call from anywhere: no token, a test
 * customer, or a Mixpanel outage all end in the same place — nothing happens
 * and the caller is never affected.
 */
export function track({ event, customerId, isTest, props = {} }: TrackInput): void {
  try {
    if (isTest) return;
    const c = mp();
    if (!c) return;
    c.track(event, { distinct_id: customerId, ...scrubProps(props) }, (err) => {
      if (err) console.warn(`[analytics] ${event} failed: ${err.message}`);
    });
  } catch (e) {
    // Deliberately swallowed. An analytics bug must never surface to a
    // customer as a failed approval or a 500.
    console.warn(`[analytics] ${event} threw: ${(e as Error).message}`);
  }
}

/**
 * Set profile properties for a customer.
 *
 * This is the ONE place PII is allowed, and only because Mixpanel profiles can
 * be deleted on request while event properties effectively cannot — which is
 * exactly the distinction the skill's guidance draws. Kept to the minimum an
 * operator needs to recognise a row.
 */
export function identifyCustomer(input: {
  customerId: string;
  isTest?: boolean;
  businessName?: string | null;
  createdAt?: Date | null;
  category?: string | null;
}): void {
  try {
    if (input.isTest) return;
    const c = mp();
    if (!c) return;
    c.people.set(input.customerId, {
      $name: input.businessName ?? undefined,
      $created: input.createdAt?.toISOString() ?? undefined,
      business_category: input.category ?? undefined,
    });
  } catch (e) {
    console.warn(`[analytics] identify threw: ${(e as Error).message}`);
  }
}
