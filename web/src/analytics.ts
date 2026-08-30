import mixpanel from "mixpanel-browser";

// AIC-28 — the browser half of the measurement layer.
//
// SCOPE, DELIBERATELY NARROW. The activation funnel is measured on the SERVER
// (server/src/analytics/mixpanel.ts), at the code paths that perform the real
// state transitions. That is the PIS-27 lesson: milestones fired from the UI
// when a customer *reaches a screen* count intentions, not outcomes, and they
// over-reported activation for a month.
//
// So this file does only what the server cannot:
//   * identity — tie a browser session to the customer it belongs to
//   * page views — which screens get used, which never do
//
// It deliberately does NOT emit funnel events. If you are about to add
// `mixpanel.track("something_important")` here, check whether the server
// already knows it happened; it almost always does, and it knows it truthfully.

let ready = false;

/**
 * Called once at boot with the token from /api/config. No token (local dev,
 * any environment where it is unset) → every function here is a no-op, which
 * is how every other integration in this codebase behaves.
 */
export function initAnalytics(token: string | null): void {
  if (!token || ready) return;
  try {
    mixpanel.init(token, {
      // Derived from the host rather than a build-time env flag: this repo's
      // web tsconfig has no vite/client types, and a hostname check needs no
      // build plumbing to be right.
      debug: /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname),
      // The SPA owns its own routing, so autocapture would record the first
      // load and nothing after it. `trackPage` is called from the router.
      track_pageview: false,
      persistence: "localStorage",
      // Customers are Israeli businesses, but the dashboard is a public URL
      // and we cannot prove no EU resident ever opens it. IP collection is the
      // one piece of personal data Mixpanel takes by default, and we have no
      // analytic use for it — turning it off removes the question entirely
      // rather than answering it with a consent banner nobody wants.
      ip: false,
    });
    ready = true;
  } catch {
    // Analytics must never break the app it measures.
  }
}

/**
 * Tie this browser to the CUSTOMER, not the login.
 *
 * One profile per business is the right subject for this product: a customer
 * is an account with a campaign, and its several logins are the same subject.
 * It also matches the server's `distinct_id`, so browser and server events
 * land on one profile instead of two halves of a funnel that never join.
 *
 * Never the email — emails change, ids do not.
 */
export function identifyCustomer(customerId: string | null): void {
  if (!ready || !customerId) return;
  try {
    mixpanel.identify(customerId);
  } catch {
    /* ignore */
  }
}

/**
 * On logout. Without this, the next person to sign in on the same device
 * inherits the previous customer's distinct_id — their events merge into
 * someone else's profile. That is a privacy incident, not just bad data.
 */
export function resetAnalytics(): void {
  if (!ready) return;
  try {
    mixpanel.reset();
  } catch {
    /* ignore */
  }
}

/**
 * A screen view. Takes the ROUTE PATTERN, never the resolved URL: a path like
 * `/app/recommendations/9f3c…` would put a real recommendation id into an
 * event property, and ids of customer-owned objects do not belong there.
 */
export function trackPage(routePattern: string): void {
  if (!ready) return;
  try {
    mixpanel.track("page_viewed", { route: routePattern });
  } catch {
    /* ignore */
  }
}
